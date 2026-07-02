// Ambient type declarations for npm packages without bundled .d.ts files.

declare module 'dockerode' {
  // We only type the surface we use. Everything else falls through as any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Docker: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export default Docker;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Docker = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Container = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Image = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type Modem = any;
}

declare module 'unzipper' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function Extract(opts: { path: string }): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Parse: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Open: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ParseStream: any;
}
