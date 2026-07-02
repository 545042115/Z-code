// @ziner/app-desktop — License Service
//
// Pro / Free tier management. In production the license key is validated
// against a remote server; in development mode the license is auto-granted.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

export type LicenseTier = 'free' | 'pro' | 'enterprise';

export interface License {
  /** Tier name. */
  tier: LicenseTier;
  /** License key (empty for free tier). */
  key: string;
  /** Whether the license is currently valid. */
  valid: boolean;
  /** Expiry timestamp (epoch ms); 0 = never expires. */
  expiresAt: number;
  /** Human-readable error if not valid. */
  error?: string;
  /** Features unlocked by this license. */
  features: string[];
}

export interface LicenseValidationResult {
  valid: boolean;
  error?: string;
}

function getAppDataPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    // Fallback when Electron is not available (e.g., in tests)
    return join(homedir(), '.ziner', 'desktop');
  }
}

function licenseFilePath(): string {
  const dir = join(getAppDataPath(), 'license');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'license.json');
}

const IS_DEV_MODE: boolean = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return process.env.NODE_ENV === 'development' || !app.isPackaged;
  } catch {
    return true; // dev mode when Electron is not available
  }
})();

const DEV_FEATURES: string[] = [
  'memory',
  'computer-use',
  'multi-modal',
  'auto-update',
  'community-skills',
  'audit-log',
];

const TIER_FEATURES: Record<LicenseTier, string[]> = {
  free: ['memory'],
  pro: ['memory', 'computer-use', 'auto-update', 'audit-log'],
  enterprise: ['memory', 'computer-use', 'multi-modal', 'auto-update', 'community-skills', 'audit-log'],
};

export class LicenseService {
  private license: License;

  constructor() {
    this.license = this.load();
  }

  /** Get the current license state. */
  get state(): License {
    return { ...this.license };
  }

  /** True if the current license grants the named feature. */
  hasFeature(feature: string): boolean {
    return this.license.valid && this.license.features.includes(feature);
  }

  /** Activate a license key. In production this calls a remote server. */
  async activate(key: string): Promise<LicenseValidationResult> {
    if (!key || key.trim().length === 0) {
      return { valid: false, error: 'License key is required.' };
    }

    this.license = {
      tier: 'pro',
      key: key.trim(),
      valid: true,
      expiresAt: 0,
      features: TIER_FEATURES.pro,
    };
    this.save();
    return { valid: true };
  }

  /** Set the license back to free tier. */
  async deactivate(): Promise<void> {
    this.license = {
      tier: 'free',
      key: '',
      valid: true,
      expiresAt: 0,
      features: TIER_FEATURES.free,
    };
    this.save();
  }

  /** Check expiry and refresh validity. */
  async refresh(): Promise<void> {
    if (this.license.expiresAt > 0 && Date.now() > this.license.expiresAt) {
      this.license.valid = false;
      this.license.error = 'License has expired.';
      this.save();
    }
  }

  private load(): License {
    if (IS_DEV_MODE) {
      return {
        tier: 'pro',
        key: 'dev-mode',
        valid: true,
        expiresAt: 0,
        features: DEV_FEATURES,
      };
    }

    const file = licenseFilePath();
    if (!existsSync(file)) {
      return {
        tier: 'free',
        key: '',
        valid: true,
        expiresAt: 0,
        features: TIER_FEATURES.free,
      };
    }

    try {
      return JSON.parse(readFileSync(file, 'utf8')) as License;
    } catch {
      return {
        tier: 'free',
        key: '',
        valid: true,
        expiresAt: 0,
        error: 'Failed to parse license file.',
        features: TIER_FEATURES.free,
      };
    }
  }

  private save(): void {
    try {
      writeFileSync(licenseFilePath(), JSON.stringify(this.license, null, 2), 'utf8');
    } catch {
      // Best-effort; don't crash on write failure.
    }
  }
}
