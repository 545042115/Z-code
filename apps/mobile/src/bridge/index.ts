// Mobile Runtime Bridge — entry point
//
// Usage:
//   import { createRuntimeBridge } from './bridge';
//   const bridge = createRuntimeBridge('local');
//   await bridge.init(settings);

export { RemoteRuntimeBridge } from './remote-bridge';
export { LocalRuntimeBridge } from './local-bridge';
export * from './types';

import type { AppSettings, MobileRuntimeBridge } from './types';
import { RemoteRuntimeBridge } from './remote-bridge';
import { LocalRuntimeBridge } from './local-bridge';

/**
 * Create a runtime bridge by type.
 *
 * - 'local':   full local runtime running entirely on the device
 *              (memory + tools + multi-round agents + streaming)
 * - 'remote':  connects to a remote Z Code Runtime server via HTTP API
 */
export function createRuntimeBridge(
  type: 'local' | 'remote' = 'local',
): MobileRuntimeBridge {
  switch (type) {
    case 'remote':
      return new RemoteRuntimeBridge();
    case 'local':
    default:
      return new LocalRuntimeBridge();
  }
}

/**
 * Initialize a bridge with settings, using the bridgeMode from settings.
 * Convenience wrapper around createRuntimeBridge + bridge.init().
 */
export async function initRuntimeBridge(
  settings: AppSettings,
): Promise<MobileRuntimeBridge> {
  const bridge = createRuntimeBridge(settings.bridgeMode);
  await bridge.init(settings);
  return bridge;
}
