import { type ToolPolicy } from '@z-assistant/contracts';
export declare class ToolDeniedError extends Error {
    readonly code: "2002";
    constructor(message: string);
}
export declare class DangerousCommandError extends Error {
    readonly code: "2006";
    constructor(message: string);
}
export interface ToolGuardOptions {
    /** When true, `assertToolAllowed` will return whether confirmation is needed. */
    policy: ToolPolicy;
}
/** Pre-call check. Throws if denied. Returns whether confirmation is needed. */
export declare function assertToolAllowed(toolName: string, policy: ToolPolicy): {
    needsConfirm: boolean;
};
export declare function checkDangerousCommand(cmd: string): void;
//# sourceMappingURL=tool-guard.d.ts.map