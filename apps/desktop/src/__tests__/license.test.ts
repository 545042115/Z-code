// @ziner/app-desktop — License service tests

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { LicenseService, type LicenseTier } from '../license';

describe('LicenseService', () => {
  let service: LicenseService;

  beforeEach(() => {
    // Each test gets a fresh service (defaults to dev-mode pro)
    service = new LicenseService();
  });

  it('default state has features in dev mode', () => {
    const s = service.state;
    // NODE_ENV is not set in test, so app.isPackaged is false → dev mode
    assert.ok(s.valid);
    assert.strictEqual(s.tier, 'pro');
    assert.ok(s.features.includes('memory'));
    assert.ok(s.features.includes('computer-use'));
  });

  it('hasFeature returns true for granted features', () => {
    assert.ok(service.hasFeature('memory'));
    assert.ok(service.hasFeature('computer-use'));
  });

  it('hasFeature returns false for unknown features', () => {
    assert.strictEqual(service.hasFeature('nothing'), false);
  });

  it('activate with empty key returns invalid', async () => {
    const result = await service.activate('');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error);
  });

  it('activate with a key sets pro tier', async () => {
    const result = await service.activate('TEST-KEY-123');
    assert.strictEqual(result.valid, true);
    const s = service.state;
    assert.strictEqual(s.tier, 'pro');
    assert.strictEqual(s.key, 'TEST-KEY-123');
  });

  it('deactivate returns to free tier', async () => {
    await service.activate('KEY');
    await service.deactivate();
    const s = service.state;
    assert.strictEqual(s.tier, 'free');
    assert.strictEqual(s.key, '');
  });
});
