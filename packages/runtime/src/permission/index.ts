// permission/ — Universal permission guards + Computer Use safety + HITL.
//
// Re-export shim: fs-guard / net-guard / tool-guard live in
// `@z-assistant/infra-permission`; Computer Use action classification
// (classifyWebAction / classifyGUIAction / isDangerUrl) is implemented
// locally in `./computer-use`; universal tool risk classification, the
// ConfirmationGate (P1-2), and the DryRunExecutor (P1-2) live in
// `./risk-levels`, `./confirmation`, and `./dry-run`.
export * from '@z-assistant/infra-permission';
export * from './computer-use';
export * from './risk-levels';
export * from './confirmation';
export * from './dry-run';
export * from './prompt-injection';
export {
  ToolInvocationPipeline,
  type ToolInvocationPipelineOptions,
  type PipelineInvocationResult,
  type ToolExecutor,
} from './pipeline';

export { checkPath, extractFilePaths, type PathGuardOptions } from './path-guard';
