// Error Codes — single source of truth for categorized error codes.
//
// Codes are 4-digit strings in a fixed range per category, mirroring
// SECURITY.md §10. Use these in every `ErrorRef.code` field.
//
// Format: "XYYY" where X is the category and YYY is the specific case.

/** LLM-related errors (provider / model / response). */
export const LlmErrorCode = {
  RateLimit: '1001',
  ContextOverflow: '1002',
  InvalidResponse: '1003',
  ModelNotFound: '1004',
  ProviderUnreachable: '1005',
  AuthFailed: '1006',
} as const;
export type LlmErrorCode = typeof LlmErrorCode[keyof typeof LlmErrorCode];

/** Tool / permission errors. */
export const ToolErrorCode = {
  NotFound: '2001',
  PermissionDenied: '2002',
  InvalidArgs: '2003',
  Timeout: '2004',
  ExecutionFailed: '2005',
  DangerousCommandBlocked: '2006',
} as const;
export type ToolErrorCode = typeof ToolErrorCode[keyof typeof ToolErrorCode];

/** Agent-level errors (orchestrator, dispatch, budget). */
export const AgentErrorCode = {
  Timeout: '3001',
  BudgetExceeded: '3002',
  MaxIterationsReached: '3003',
  AgentNotFound: '3004',
  DependencyFailed: '3005',
  Cancelled: '3006',
} as const;
export type AgentErrorCode = typeof AgentErrorCode[keyof typeof AgentErrorCode];

/** Sandbox / container errors. */
export const SandboxErrorCode = {
  ContainerOom: '4001',
  ContainerTimeout: '4002',
  ImageNotFound: '4003',
  MountFailed: '4004',
} as const;
export type SandboxErrorCode = typeof SandboxErrorCode[keyof typeof SandboxErrorCode];

/** Configuration / schema errors. */
export const ConfigErrorCode = {
  SchemaInvalid: '5001',
  MissingRequired: '5002',
  VersionMismatch: '5003',
  SecretNotFound: '5004',
} as const;
export type ConfigErrorCode = typeof ConfigErrorCode[keyof typeof ConfigErrorCode];

/** Storage / I/O errors. */
export const StorageErrorCode = {
  IoError: '6001',
  CorruptRecord: '6002',
  NotFound: '6003',
  VersionConflict: '6004',
} as const;
export type StorageErrorCode = typeof StorageErrorCode[keyof typeof StorageErrorCode];

/** Unknown / unexpected. */
export const UnknownErrorCode = {
  Unexpected: '9001',
} as const;
export type UnknownErrorCode = typeof UnknownErrorCode[keyof typeof UnknownErrorCode];

/** All known error codes as a flat set for fast lookup. */
export const ALL_ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.values(LlmErrorCode),
  ...Object.values(ToolErrorCode),
  ...Object.values(AgentErrorCode),
  ...Object.values(SandboxErrorCode),
  ...Object.values(ConfigErrorCode),
  ...Object.values(StorageErrorCode),
  ...Object.values(UnknownErrorCode),
]);

/** Human-readable label for a code (best effort). */
export function describeErrorCode(code: string): string {
  if (code.startsWith('1')) return 'LLM error';
  if (code.startsWith('2')) return 'Tool / permission error';
  if (code.startsWith('3')) return 'Agent error';
  if (code.startsWith('4')) return 'Sandbox error';
  if (code.startsWith('5')) return 'Configuration error';
  if (code.startsWith('6')) return 'Storage error';
  if (code.startsWith('9')) return 'Unknown error';
  return 'Unrecognized error';
}
