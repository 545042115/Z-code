import { type ConfigSpec } from '@z-assistant/contracts';
export interface ConfigLoadOptions {
    /** Path to YAML file; default ~/.z-assistant/config.yaml */
    configPath?: string;
    /** Skip env overrides (used by tests). */
    skipEnv?: boolean;
}
export declare class ConfigError extends Error {
    readonly code: string;
    readonly category: "config";
    constructor(message: string, code?: string);
}
/** Load a ConfigSpec. Throws ConfigError on any failure. */
export declare function loadConfig(opts?: ConfigLoadOptions): Promise<ConfigSpec>;
export declare function validateConfig(cfg: ConfigSpec): void;
//# sourceMappingURL=config-center.d.ts.map