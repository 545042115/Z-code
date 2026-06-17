// Minimal type stubs for the third-party deps that ship without types.
// These are only the symbols we use; add more as needed.

declare module 'js-yaml' {
  export function load(s: string): unknown;
  export function dump(obj: unknown): string;
  export class YAMLException extends Error {
    name: 'YAMLException';
    reason: string;
    mark: { position: number; line: number; column: number };
  }
}
