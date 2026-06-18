// Post-compilation script: injects @z-assistant/* V2 packages into out/vendor/
// so that bootstrap.js can resolve require('@z-assistant/*') at runtime.
// This makes both F5 and VSIX work.

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, '..');
const v2Root = join(extRoot, '..', '..');
const outDir = join(extRoot, 'out');
const vendorDir = join(outDir, 'vendor', '@z-assistant');

// Map of package name → relative path from repo root
const pkgMap = {
  'contracts':    'packages/contracts',
  'trace':        'packages/trace',
  'runtime':      'packages/runtime',
  'infra-errors':  'packages/infra/errors',
  'infra-cost':   'packages/infra/cost',
  'infra-storage': 'packages/infra/storage',
  'infra-permission': 'packages/infra/permission',
  'infra-config': 'packages/infra/config',
};

// Step 1: Copy V2 package outputs into out/vendor/@z-assistant/*
console.log('  [postcompile] Copying V2 dependencies to out/vendor/@z-assistant/...');
if (!existsSync(vendorDir)) mkdirSync(vendorDir, { recursive: true });

function copyRecursive(src, dst) {
  if (!existsSync(src)) return;
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dstPath, { recursive: true });
      copyRecursive(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

for (const [pkgName, pkgPath] of Object.entries(pkgMap)) {
  const srcOut = join(v2Root, pkgPath, 'out');
  const tgtDir = join(vendorDir, pkgName);
  if (!existsSync(tgtDir)) mkdirSync(tgtDir, { recursive: true });
  copyRecursive(srcOut, tgtDir);
  // Also copy package.json (needed for "main" field resolution by Node module system)
  const srcPkg = join(v2Root, pkgPath, 'package.json');
  if (existsSync(srcPkg)) copyFileSync(srcPkg, join(tgtDir, 'package.json'));
  console.log(`    @z-assistant/${pkgName}`);
}

// Also copy third-party deps needed by V2 packages (e.g., js-yaml for infra-config)
console.log('  [postcompile] Copying third-party dependencies...');
const thirdPartyDeps = ['js-yaml'];
const rootNodeModules = join(v2Root, 'node_modules');
const vendorNodeModules = join(outDir, 'vendor', 'node_modules');
for (const dep of thirdPartyDeps) {
  const src = join(rootNodeModules, dep);
  const dst = join(vendorNodeModules, dep);
  if (existsSync(src)) {
    if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
    copyRecursive(src, dst);
    console.log(`    ${dep}`);
  }
}

// Step 2: Create out/bootstrap.js
console.log('  [postcompile] Creating out/bootstrap.js...');
const bootstrapCode = `
// Bootstrap - resolve @z-assistant/* from vendor/@z-assistant/,
// and other third-party modules from vendor/node_modules/ as fallback.
const Module = require('module');
const path = require('path');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent) {
  // @z-assistant/* → vendor/@z-assistant/*
  if (request.startsWith('@z-assistant/')) {
    const vendorPath = path.join(__dirname, 'vendor', request);
    try { return originalResolve.call(this, vendorPath, parent); } catch {}
  }
  // Try normal resolve first
  try {
    return originalResolve.call(this, request, parent);
  } catch (e) {
    // Fallback: vendor/node_modules/
    const vendorPath = path.join(__dirname, 'vendor', 'node_modules', request);
    try { return originalResolve.call(this, vendorPath, parent); } catch {}
    throw e;
  }
};
`.trimStart();
writeFileSync(join(outDir, 'bootstrap.js'), bootstrapCode, 'utf-8');

// Step 3: Prepend require('./bootstrap') to out/extension.js if not already present
console.log('  [postcompile] Patching out/extension.js...');
const extJsPath = join(outDir, 'extension.js');
if (existsSync(extJsPath)) {
  let extJs = readFileSync(extJsPath, 'utf-8');
  if (!extJs.startsWith("require('./bootstrap')")) {
    extJs = "require('./bootstrap');\n" + extJs;
    writeFileSync(extJsPath, extJs, 'utf-8');
  }
}

console.log('  [postcompile] Done.');
