export declare class SecretNotFoundError extends Error {
    readonly code = "5004";
    constructor(name: string);
}
/** Look up a secret by name. Throws SecretNotFoundError when missing. */
export declare function loadSecret(name: string): string;
/** Return a secret or undefined (no throw). */
export declare function tryLoadSecret(name: string): string | undefined;
//# sourceMappingURL=secrets.d.ts.map