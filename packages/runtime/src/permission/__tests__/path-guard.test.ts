// @z-assistant/runtime — path guard tests

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { checkPath, extractFilePaths } from '../path-guard';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

describe('checkPath', () => {
  const root = resolve(tmpdir(), 'sandbox-test');

  it('allows paths inside allowed root', () => {
    const result = checkPath(join(root, 'sub', 'file.txt'), { allowedRoots: [root] });
    assert.strictEqual(result.allowed, true);
    assert.ok(result.normalized);
  });

  it('blocks paths outside allowed root', () => {
    const result = checkPath('/etc/passwd', { allowedRoots: [root] });
    assert.strictEqual(result.allowed, false);
  });

  it('blocks traversal attempts', () => {
    const result = checkPath(join(root, '..', '..', 'etc', 'passwd'), { allowedRoots: [root] });
    assert.strictEqual(result.allowed, false);
  });

  it('blocks absolute paths when disabled', () => {
    const result = checkPath(join(root, 'file.txt'), { allowedRoots: [root], allowAbsolute: false });
    assert.strictEqual(result.allowed, false);
  });
});

describe('extractFilePaths', () => {
  it('extracts filePath, path, dirPath, cwd', () => {
    const paths = extractFilePaths({
      filePath: 'a.txt',
      path: 'b.txt',
      dirPath: 'dir',
      cwd: '/tmp',
      content: 'ignored',
    });
    assert.deepStrictEqual(paths, ['a.txt', 'b.txt', 'dir', '/tmp']);
  });
});
