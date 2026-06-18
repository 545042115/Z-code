import type { ErrorRef } from '@z-assistant/contracts';
/** Classification of an error. */
export type ErrorCategory = 'llm' | 'tool' | 'agent' | 'sandbox' | 'config' | 'storage' | 'unknown';
export interface ClassifiedError extends ErrorRef {
    category: ErrorCategory;
    /** Original error name, e.g. "TypeError" */
    cause?: string;
}
/** Heuristic classifier. Add new mappings here as new error sources appear. */
export declare function classify(err: unknown): ClassifiedError;
/** Convert classified error to plain ErrorRef (drop the internal category). */
export declare function toErrorRef(c: ClassifiedError): ErrorRef;
//# sourceMappingURL=classifier.d.ts.map