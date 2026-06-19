export interface NetPolicy {
    /** Allowed hostnames, e.g. ["api.openai.com", "*.openai.com"] */
    allow: string[];
    /** Denied hosts override allow. */
    deny?: string[];
    /** When true, block all outbound network. */
    offline?: boolean;
}
export declare class NetDeniedError extends Error {
    readonly code: any;
    constructor(message: string);
}
/** Minimal glob match for net allow-list. `*` matches one label. */
export declare function matchHost(pattern: string, host: string): boolean;
/** Validate a URL against the policy. Throws on deny. */
export declare function assertUrlAllowed(url: string, policy: NetPolicy): URL;
//# sourceMappingURL=net-guard.d.ts.map