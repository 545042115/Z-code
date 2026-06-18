/** LLM-related errors (provider / model / response). */
export declare const LlmErrorCode: {
    readonly RateLimit: "1001";
    readonly ContextOverflow: "1002";
    readonly InvalidResponse: "1003";
    readonly ModelNotFound: "1004";
    readonly ProviderUnreachable: "1005";
    readonly AuthFailed: "1006";
};
export type LlmErrorCode = typeof LlmErrorCode[keyof typeof LlmErrorCode];
/** Tool / permission errors. */
export declare const ToolErrorCode: {
    readonly NotFound: "2001";
    readonly PermissionDenied: "2002";
    readonly InvalidArgs: "2003";
    readonly Timeout: "2004";
    readonly ExecutionFailed: "2005";
    readonly DangerousCommandBlocked: "2006";
};
export type ToolErrorCode = typeof ToolErrorCode[keyof typeof ToolErrorCode];
/** Agent-level errors (orchestrator, dispatch, budget). */
export declare const AgentErrorCode: {
    readonly Timeout: "3001";
    readonly BudgetExceeded: "3002";
    readonly MaxIterationsReached: "3003";
    readonly AgentNotFound: "3004";
    readonly DependencyFailed: "3005";
    readonly Cancelled: "3006";
};
export type AgentErrorCode = typeof AgentErrorCode[keyof typeof AgentErrorCode];
/** Sandbox / container errors. */
export declare const SandboxErrorCode: {
    readonly ContainerOom: "4001";
    readonly ContainerTimeout: "4002";
    readonly ImageNotFound: "4003";
    readonly MountFailed: "4004";
};
export type SandboxErrorCode = typeof SandboxErrorCode[keyof typeof SandboxErrorCode];
/** Configuration / schema errors. */
export declare const ConfigErrorCode: {
    readonly SchemaInvalid: "5001";
    readonly MissingRequired: "5002";
    readonly VersionMismatch: "5003";
    readonly SecretNotFound: "5004";
};
export type ConfigErrorCode = typeof ConfigErrorCode[keyof typeof ConfigErrorCode];
/** Storage / I/O errors. */
export declare const StorageErrorCode: {
    readonly IoError: "6001";
    readonly CorruptRecord: "6002";
    readonly NotFound: "6003";
    readonly VersionConflict: "6004";
};
export type StorageErrorCode = typeof StorageErrorCode[keyof typeof StorageErrorCode];
/** Unknown / unexpected. */
export declare const UnknownErrorCode: {
    readonly Unexpected: "9001";
};
export type UnknownErrorCode = typeof UnknownErrorCode[keyof typeof UnknownErrorCode];
/** All known error codes as a flat set for fast lookup. */
export declare const ALL_ERROR_CODES: ReadonlySet<string>;
/** Human-readable label for a code (best effort). */
export declare function describeErrorCode(code: string): string;
//# sourceMappingURL=error-codes.d.ts.map