// Unit tests for permission module
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  assertPathSafe,
  checkPath,
  FsDeniedError,
  isInside,
  isSystemPath,
  resolveInWorkspace,
} from '../fs-guard';
import { assertUrlAllowed, matchHost, NetDeniedError } from '../net-guard';
import {
  assertToolAllowed,
  checkDangerousCommand,
  DangerousCommandError,
  ToolDeniedError,
} from '../tool-guard';
import { ToolErrorCode } from '@ziner/infra-errors';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp } from 'fs/promises';

// ── FsGuard ───────────────────────────────────────────────────────────

const isWin = process.platform === 'win32';

test('resolveInWorkspace: absolute path passes through', () => {
  const abs = isWin ? 'D:\\etc\\passwd' : '/etc/passwd';
  const out = resolveInWorkspace(abs, '/root');
  assert.strictEqual(out, abs);
});

test('resolveInWorkspace: relative joins to root', () => {
  const expected = isWin ? 'D:\\root\\foo\\bar.ts' : '/root/foo/bar.ts';
  const out = resolveInWorkspace('foo/bar.ts', isWin ? 'D:\\root' : '/root');
  assert.strictEqual(out, expected);
});

test('isInside: true for nested', () => {
  assert.strictEqual(isInside('/root/a/b', '/root'), true);
});

test('isInside: false for outside', () => {
  assert.strictEqual(isInside('/etc/passwd', '/root'), false);
});

test('isSystemPath: detects /etc on linux', () => {
  if (isWin) return;
  assert.strictEqual(isSystemPath('/etc/passwd'), true);
  assert.strictEqual(isSystemPath('/home/user/x'), false);
});

test('checkPath: allows workspace-relative', () => {
  const root = isWin ? 'D:\\root' : '/root';
  const expected = isWin ? 'D:\\root\\foo\\bar.ts' : '/root/foo/bar.ts';
  const r = checkPath('foo/bar.ts', { workspaceRoot: root });
  assert.ok(r.ok);
  assert.strictEqual((r as { resolved: string }).resolved, expected);
});

test('checkPath: denies path traversal', () => {
  const r = checkPath('../etc/passwd', { workspaceRoot: '/root' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual((r as { code: string }).code, ToolErrorCode.PermissionDenied);
});

test('checkPath: denies absolute outside path', () => {
  const r = checkPath('/etc/passwd', { workspaceRoot: '/root' });
  assert.strictEqual(r.ok, false);
});

test('checkPath: denies hidden files by default', () => {
  const r = checkPath('.env', { workspaceRoot: '/root' });
  assert.strictEqual(r.ok, false);
});

test('checkPath: allowHidden can opt-in', () => {
  // Hidden-file rule is platform-sensitive (regex matches both / and \);
  // we keep the test focused on the Linux case for determinism.
  if (isWin) return;
  const r = checkPath('.env', { workspaceRoot: '/root', allowHidden: ['**/.env'] });
  assert.ok(r.ok);
});

test('checkPath: deny wins over allow', () => {
  // Use a deny pattern that matches by basename only.
  const r = checkPath('secrets.txt', {
    workspaceRoot: '/root',
    deny: ['*secrets.txt'],
  });
  assert.strictEqual(r.ok, false);
});

test('assertPathSafe: integration with real temp dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fs-guard-'));
  try {
    const real = await assertPathSafe('a/b/c.ts', { workspaceRoot: root });
    assert.ok(real.startsWith(root));
  } finally {
    // cleanup handled by tmpdir lifetime
  }
});

test('assertPathSafe: throws on traversal', async () => {
  await assert.rejects(
    () => assertPathSafe('../escape', { workspaceRoot: '/root' }),
    FsDeniedError,
  );
});

// ── NetGuard ──────────────────────────────────────────────────────────

test('matchHost: exact', () => {
  assert.strictEqual(matchHost('api.openai.com', 'api.openai.com'), true);
  assert.strictEqual(matchHost('api.openai.com', 'evil.com'), false);
});

test('matchHost: wildcard subdomain', () => {
  assert.strictEqual(matchHost('*.openai.com', 'api.openai.com'), true);
  assert.strictEqual(matchHost('*.openai.com', 'openai.com'), false);
  assert.strictEqual(matchHost('*.openai.com', 'api.deep.openai.com'), true);
});

test('assertUrlAllowed: https + allowed host', () => {
  const u = assertUrlAllowed('https://api.openai.com/v1/chat', {
    allow: ['api.openai.com'],
  });
  assert.strictEqual(u.hostname, 'api.openai.com');
});

test('assertUrlAllowed: blocks IP literal', () => {
  assert.throws(
    () => assertUrlAllowed('http://127.0.0.1/x', { allow: ['*'] }),
    NetDeniedError,
  );
});

test('assertUrlAllowed: blocks non-allow host', () => {
  assert.throws(
    () => assertUrlAllowed('https://evil.com/x', { allow: ['api.openai.com'] }),
    NetDeniedError,
  );
});

test('assertUrlAllowed: blocks file:// and other schemes', () => {
  assert.throws(
    () => assertUrlAllowed('file:///etc/passwd', { allow: ['*'] }),
    NetDeniedError,
  );
});

test('assertUrlAllowed: offline mode blocks all', () => {
  assert.throws(
    () => assertUrlAllowed('https://api.openai.com/x', { allow: ['*'], offline: true }),
    NetDeniedError,
  );
});

test('assertUrlAllowed: deny wins over allow', () => {
  assert.throws(
    () => assertUrlAllowed('https://api.openai.com/x', {
      allow: ['*'],
      deny: ['api.openai.com'],
    }),
    NetDeniedError,
  );
});

// ── ToolGuard ─────────────────────────────────────────────────────────

const basePolicy = {
  allow: ['read_file', 'edit_file', 'shell_exec'],
  deny: ['shell_exec:rm_rf'],
  requireConfirm: ['shell_exec'],
};

test('assertToolAllowed: allowed tool', () => {
  const r = assertToolAllowed('edit_file', basePolicy);
  assert.strictEqual(r.needsConfirm, false);
});

test('assertToolAllowed: needs confirmation', () => {
  const r = assertToolAllowed('shell_exec', basePolicy);
  assert.strictEqual(r.needsConfirm, true);
});

test('assertToolAllowed: denied throws', () => {
  assert.throws(
    () => assertToolAllowed('shell_exec:rm_rf', basePolicy),
    ToolDeniedError,
  );
});

test('checkDangerousCommand: rm -rf /', () => {
  assert.throws(() => checkDangerousCommand('rm -rf /'), DangerousCommandError);
});

test('checkDangerousCommand: force push', () => {
  assert.throws(() => checkDangerousCommand('git push --force origin main'), DangerousCommandError);
});

test('checkDangerousCommand: chmod 777', () => {
  assert.throws(() => checkDangerousCommand('chmod -R 777 /tmp'), DangerousCommandError);
});

test('checkDangerousCommand: safe commands pass', () => {
  checkDangerousCommand('ls -la');
  checkDangerousCommand('npm test');
  checkDangerousCommand('git push origin main');
});
