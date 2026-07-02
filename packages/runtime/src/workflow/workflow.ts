// @ziner/runtime — Workflow Engine
//
// Declarative multi-step workflow execution. Supports:
//   - sequential and dependency-driven step ordering
//   - tool invocation via an executor
//   - simple templated arguments
//   - conditional steps
//   - human-approval checkpoints

export interface WorkflowDefinition {
  name: string;
  /** Input variable declarations. */
  inputs?: Record<string, { type?: 'string' | 'number' | 'boolean'; default?: unknown }>;
  steps: WorkflowStep[];
}

export type WorkflowStep =
  | ToolWorkflowStep
  | HumanApprovalStep
  | SubWorkflowStep;

export interface BaseWorkflowStep {
  id: string;
  name?: string;
  /** Skip this step unless the expression evaluates truthy. */
  if?: string;
  /** Step ids that must complete before this one runs. */
  dependsOn?: string[];
}

export interface ToolWorkflowStep extends BaseWorkflowStep {
  type?: 'tool';
  tool: string;
  args: Record<string, unknown>;
}

export interface HumanApprovalStep extends BaseWorkflowStep {
  type: 'human-approval';
  prompt: string;
  /** Step to run if approved (optional; can also be handled by executor). */
  onApprove?: string;
  /** Step to run if denied (optional). */
  onDeny?: string;
}

export interface SubWorkflowStep extends BaseWorkflowStep {
  type: 'sub-workflow';
  workflow: string;
  inputs?: Record<string, unknown>;
}

export interface WorkflowContext {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  variables: Record<string, unknown>;
}

export type StepExecutor = (step: WorkflowStep, ctx: WorkflowContext) => Promise<unknown>;

export interface WorkflowResult {
  ok: boolean;
  outputs: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  error?: string;
  failedStepId?: string;
}

function buildDependencyOrder(steps: WorkflowStep[]): string[] {
  const map = new Map<string, WorkflowStep>();
  for (const s of steps) map.set(s.id, s);

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Workflow dependency cycle at step ${id}`);
    const step = map.get(id);
    if (!step) throw new Error(`Unknown workflow step: ${id}`);
    visiting.add(id);
    for (const dep of step.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const s of steps) visit(s.id);
  return order;
}

function renderTemplate(value: unknown, ctx: WorkflowContext): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr) => {
    const trimmed = expr.trim();
    // Support paths like inputs.foo, outputs.stepId.field, variables.bar
    const parts = trimmed.split('.');
    let current: unknown = undefined;
    if (parts[0] === 'inputs') current = ctx.inputs;
    else if (parts[0] === 'outputs') current = ctx.outputs;
    else if (parts[0] === 'variables') current = ctx.variables;
    else return '';
    for (let i = 1; i < parts.length; i++) {
      if (current === null || current === undefined) return '';
      current = (current as Record<string, unknown>)[parts[i]];
    }
    return current === undefined ? '' : String(current);
  });
}

function renderArgs(args: Record<string, unknown>, ctx: WorkflowContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = Array.isArray(v)
      ? v.map((x) => renderTemplate(x, ctx))
      : renderTemplate(v, ctx);
  }
  return out;
}

function evaluateCondition(expr: string, ctx: WorkflowContext): boolean {
  const rendered = renderTemplate(expr, ctx);
  if (typeof rendered === 'boolean') return rendered;
  if (rendered === 'true') return true;
  if (rendered === 'false') return false;
  return !!rendered;
}

/**
 * Execute a declarative workflow.
 *
 * The executor receives each step and the current workflow context. It is
 * responsible for running tool calls, human-approval UI, or sub-workflows.
 */
export async function runWorkflow(
  definition: WorkflowDefinition,
  ctx: WorkflowContext,
  executor: StepExecutor,
): Promise<WorkflowResult> {
  let order: string[];
  try {
    order = buildDependencyOrder(definition.steps);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, outputs: ctx.outputs, stepResults: {}, error: message };
  }

  const stepMap = new Map(definition.steps.map((s) => [s.id, s]));
  const stepResults: Record<string, unknown> = {};

  for (const id of order) {
    const step = stepMap.get(id)!;

    if (step.if && !evaluateCondition(step.if, ctx)) {
      stepResults[id] = { skipped: true };
      continue;
    }

    // Materialise tool args templates before handing to executor.
    const materialisedStep = step.type === 'tool' || step.type === undefined
      ? { ...step, args: renderArgs(step.args, ctx) }
      : step;

    try {
      const result = await executor(materialisedStep, ctx);
      stepResults[id] = result;
      ctx.outputs[id] = result;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, outputs: ctx.outputs, stepResults, error: message, failedStepId: id };
    }
  }

  return { ok: true, outputs: ctx.outputs, stepResults };
}
