<#
.SYNOPSIS
One-click build Ziner Desktop Windows installer (.exe)
#>

param(
  [switch]$SkipInstall,
  [string]$OutDir = ""
)

$RootDir = Split-Path -Parent $PSScriptRoot
$DesktopDir = Join-Path $RootDir "apps\desktop"

# Guard against callers passing switches as positional arguments (e.g. --SkipPython).
# Only treat $OutDir as a directory when it is not empty and does not look like a switch.
$resolvedOutDir = if ($OutDir -and -not $OutDir.StartsWith('-')) {
  $OutDir
} else {
  ""
}

$DistDir = if ($resolvedOutDir) {
  Resolve-Path $resolvedOutDir -ErrorAction SilentlyContinue
  if (-not $DistDir) { $DistDir = $resolvedOutDir }
} else {
  Join-Path $DesktopDir "dist"
}

function Write-Step($Title) {
  Write-Host ""
  Write-Host ">> $Title" -ForegroundColor Yellow
}

# -- 1. Check environment --
Write-Step "[1/5] Check environment"

$nodeVer = node --version 2>$null
if (-not $nodeVer) {
  Write-Host "  ERROR: Node.js not found, install Node.js 18+" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] Node.js $nodeVer" -ForegroundColor Green

$npmVer = npm --version 2>$null
if (-not $npmVer) {
  Write-Host "  ERROR: npm not found" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] npm v$npmVer" -ForegroundColor Green

# -- 2. Install dependencies --
if (-not $SkipInstall) {
  Write-Step "[2/5] Install dependencies"

  # Use Chinese mirror for Electron if available (much faster in CN)
  if ([string]::IsNullOrEmpty($env:ELECTRON_MIRROR)) {
    $electronMirror = "https://npmmirror.com/mirrors/electron/"
    Write-Host "  Set ELECTRON_MIRROR=$electronMirror (CN mirror)" -ForegroundColor Gray
    $env:ELECTRON_MIRROR = $electronMirror
  }

  Write-Host "  npm install (root) - installing all workspace deps..." -ForegroundColor Gray
  Push-Location $RootDir
  npm install --loglevel=error 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: npm install root failed (exit $LASTEXITCODE)" -ForegroundColor Red; Pop-Location; exit 1 }
  Pop-Location

  Write-Host "  [OK] Dependencies installed" -ForegroundColor Green
} else {
  Write-Step "[2/5] Skip dependency installation"
}

# -- 3. Build workspace dependencies --
Write-Step "[3/5] Build workspace dependencies"

Push-Location $RootDir

# Build in strict dependency order (TypeScript project references)
$buildOrder = @(
  "@ziner/contracts",
  "@ziner/infra-errors",
  "@ziner/infra-storage",
  "@ziner/infra-cost",
  "@ziner/infra-config",
  "@ziner/infra-permission",
  "@ziner/trace",
  "@ziner/runtime-core",
  "@ziner/runtime",
  "@ziner/platform-node",
  "@ziner/app-shared",
  "@ziner/agent-coding",
  "@ziner/agent-browser",
  "@ziner/agent-planner",
  "@ziner/agent-research",
  "@ziner/agent-synthesizer",
  "@ziner/agent-office",
  "@ziner/app-vscode-connector"
)

foreach ($pkg in $buildOrder) {
  Write-Host "  Building $pkg..." -ForegroundColor Gray
  npm run build --workspace=$pkg 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: $pkg build failed" -ForegroundColor Red; Pop-Location; exit 1 }
  Write-Host "  [OK] $pkg" -ForegroundColor Green
}

Pop-Location

# -- 4. Build desktop --
Write-Step "[4/5] Build Desktop TypeScript"

Push-Location $DesktopDir
npm run build 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: Desktop build failed" -ForegroundColor Red; Pop-Location; exit 1 }
Write-Host "  [OK] Desktop TypeScript compiled" -ForegroundColor Green
Pop-Location

# -- 5. Manual portable EXE (bypass app-builder.exe blocked by antivirus) --
Write-Step "[5/5] Package portable EXE (manual)"

Push-Location $DesktopDir

# Step A: ensure we have a clean Electron base
$unpackedDir = Join-Path $DistDir "win-unpacked"
$appDir = Join-Path $unpackedDir "resources\app"
# Electron dist is hoisted to the root node_modules (npm workspace)
$electronDist = Join-Path $RootDir "node_modules\electron\dist"

# Kill any running instances BEFORE copying files
# Also terminate the legacy executable name in case an old build is still running.
taskkill /f /im "Z Assistant.exe" 2>$null
taskkill /f /im "Ziner.exe" 2>$null
taskkill /f /im electron.exe 2>$null
Start-Sleep -Seconds 3

# Clean old build artifacts to avoid dll locking issues.
# Remove the whole $DistDir so no stale files (e.g. legacy @z-assistant packages)
# survive between runs. Use the node rm-rf helper because PowerShell's Remove-Item
# can be very slow on large nested directories.
if (Test-Path $DistDir) {
  Write-Host "  Cleaning old build artifacts..."
  $rmRf = Join-Path $RootDir "tools\rm-rf.js"
  & node $rmRf $DistDir
}
Start-Sleep -Seconds 1

Write-Host "  Copying Electron base..."
if (-not (Test-Path $electronDist\electron.exe)) {
  Write-Host "  ERROR: electron dist not found at $electronDist" -ForegroundColor Red
  Pop-Location; exit 1
}
# Full copy of Electron binaries
New-Item -ItemType Directory -Force -Path $unpackedDir | Out-Null
Copy-Item -Path "$electronDist\*" -Destination $unpackedDir -Recurse -Force
# Also ensure resources/app exists
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# Step C: copy app code into resources/app
Write-Host "  Copying app code..."
# Ensure clean app directory
Remove-Item -Path "$appDir\*" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
# Copy compiled output (use robocopy for reliability with mixed files/dirs)
robocopy "$DesktopDir\out" "$appDir\out" /E /NJH /NJS /NDL /NP 2>&1 | Out-Null
# Copy package.json (for Electron to find main entry)
Copy-Item -Path "$DesktopDir\package.json" -Destination "$appDir\package.json" -Force
# Copy build config (icon etc.)
if (Test-Path "$DesktopDir\build") {
  New-Item -ItemType Directory -Force -Path "$appDir\build" | Out-Null
  robocopy "$DesktopDir\build" "$appDir\build" /E /NJH /NJS /NDL /NP 2>&1 | Out-Null
}

# Step D: copy workspace packages (@ziner/*) into app's node_modules
Write-Host "  Copying workspace packages..."
$appNodeModules = Join-Path $unpackedDir "resources\app\node_modules"
$zinerDst = Join-Path $appNodeModules "@ziner"
$neededPackages = @(
  @{Name="app-vscode-connector"; Source="apps\vscode-connector"}
  @{Name="app-shared";          Source="packages\app-shared"}
  @{Name="agent-browser";       Source="packages\agents\browser-agent"}
  @{Name="agent-coding";        Source="packages\agents\coding-agent"}
  @{Name="agent-planner";       Source="packages\agents\planner-agent"}
  @{Name="agent-research";      Source="packages\agents\research-agent"}
  @{Name="agent-synthesizer";   Source="packages\agents\synthesizer-agent"}
  @{Name="agent-office";        Source="packages\agents\office-agent"}
  @{Name="runtime";             Source="packages\runtime"}
  @{Name="runtime-core";        Source="packages\runtime-core"}
  @{Name="trace";               Source="packages\trace"}
  @{Name="platform-node";       Source="packages\platform-node"}
  @{Name="infra-storage";       Source="packages\infra\storage"}
  @{Name="infra-cost";          Source="packages\infra\cost"}
  @{Name="infra-errors";        Source="packages\infra\errors"}
  @{Name="infra-config";        Source="packages\infra\config"}
  @{Name="infra-permission";    Source="packages\infra\permission"}
  @{Name="contracts";           Source="packages\contracts"}
)

New-Item -ItemType Directory -Force -Path $zinerDst | Out-Null
foreach ($pkg in $neededPackages) {
  $srcDir = Join-Path $RootDir $pkg.Source
  $dstDir = Join-Path $zinerDst $pkg.Name
  if (Test-Path "$srcDir\out") {
    New-Item -ItemType Directory -Force -Path "$dstDir\out" | Out-Null
    # Copy compiled JS output
    Copy-Item -Path "$srcDir\out\*" -Destination "$dstDir\out\" -Recurse -Force -ErrorAction SilentlyContinue
    # Copy package.json (needed for main field resolution)
    Copy-Item -Path "$srcDir\package.json" -Destination "$dstDir\package.json" -Force
  }
}

# Step D2: copy all runtime dependencies from root node_modules
# Direct copy is more reliable than recursive dependency walking because
# some packages have nested node_modules (e.g. duplexer2/node_modules/readable-stream)
# that contain their own dependencies (like process-nextick-args).
# We exclude obvious dev-only packages to keep size reasonable.
Write-Host "  Installing runtime dependencies (full node_modules copy)..."
$rootNodeModules = Join-Path $RootDir "node_modules"
$appNodeModules = Join-Path $unpackedDir "resources\app\node_modules"

New-Item -ItemType Directory -Force -Path $appNodeModules | Out-Null

$excludePatterns = @(
  '.bin',
  '.cache',
  '.package-lock.json',
  '@types',
  '@ziner',
  '@z-assistant',
  'electron',
  'electron-builder',
  'app-builder-bin',
  'builder-util',
  'dmg-builder',
  'ts-node',
  'typescript',
  'vite',
  'vitest',
  'webpack',
  'esbuild',
  'rollup',
  'sass',
  'less',
  'stylus',
  'postcss',
  'autoprefixer',
  'eslint',
  'prettier',
  'jest',
  'mocha',
  'chai',
  'sinon',
  '@jest',
  '@vitest',
  '@eslint',
  'rimraf',
  'cross-env',
  'dotenv-cli',
  'npm-run-all',
  'concurrently',
  'wait-on',
  'nodemon',
  'tsc-alias',
  'tsconfig-paths'
)

# Packages that must match exactly (not prefix) to avoid excluding related runtime packages
$exactMatch = @(
  'electron'
)

$pkgCount = 0
Get-ChildItem $rootNodeModules -Directory | ForEach-Object {
  $name = $_.Name
  $shouldExclude = $false
  foreach ($pattern in $excludePatterns) {
    if ($exactMatch -contains $pattern) {
      if ($name -eq $pattern) {
        $shouldExclude = $true
        break
      }
    } else {
      if ($name -eq $pattern -or $name -like "$pattern*") {
        $shouldExclude = $true
        break
      }
    }
  }
  if (-not $shouldExclude) {
    $src = $_.FullName
    $dst = Join-Path $appNodeModules $name
    if (-not (Test-Path $dst)) {
      New-Item -ItemType Directory -Force -Path $dst | Out-Null
    }
    Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force -ErrorAction SilentlyContinue
    $pkgCount++
  }
}

# Also ensure workspace scope dir exists (Step D already created @ziner)
Write-Host "  [OK] Runtime dependencies installed ($pkgCount packages)" -ForegroundColor Green

# Re-name the exe
$targetExe = Join-Path $unpackedDir "Ziner.exe"
if (Test-Path "$unpackedDir\electron.exe") {
  Rename-Item -Path "$unpackedDir\electron.exe" -NewName "Ziner.exe" -Force -ErrorAction SilentlyContinue
}

Write-Host "  [OK] Portable EXE ready" -ForegroundColor Green
$exitCode = 0

Pop-Location

if ($exitCode -ne 0) {
  Write-Host ""
  Write-Host "WARNING: Packaging failed (exit $exitCode)" -ForegroundColor Yellow
  Write-Host "  antivirus may be blocking app-builder.exe" -ForegroundColor Gray
  Write-Host "  Portable exe may already exist in:" -ForegroundColor Gray
  Write-Host "  $DistDir\win-unpacked\" -ForegroundColor Gray
} else {
  Write-Host ""
  Write-Host "  [OK] Package completed!" -ForegroundColor Green
}

# -- Check output --
Write-Host ""
Write-Host "================================" -ForegroundColor Cyan
Write-Host "  Checking output..." -ForegroundColor Yellow

if (Test-Path $DistDir) {
  $exeFiles = Get-ChildItem -Path $DistDir -Filter "*.exe" -Recurse | Sort-Object LastWriteTime -Descending
  if ($exeFiles) {
    foreach ($f in $exeFiles) {
      $size = "{0:N1} MB" -f ($f.Length / 1MB)
      Write-Host "  >> $($f.FullName)  ($size)" -ForegroundColor Green
    }
  } else {
    Write-Host "  No .exe found in $DistDir, check directories:" -ForegroundColor Yellow
    Get-ChildItem -Path $DistDir -Recurse -Directory | ForEach-Object {
      Write-Host "     $($_.FullName)" -ForegroundColor Gray
    }
  }
} else {
  Write-Host "  $DistDir does not exist" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Tip: dev mode (no packaging):" -ForegroundColor Magenta
Write-Host "  npm run build --workspaces --if-present" -ForegroundColor White
Write-Host "  npm run start -w apps/desktop" -ForegroundColor White
Write-Host ""

exit 0
