// audit/ — Operation audit logging (P1-2 HITL).
//
// Records every tool invocation's lifecycle (decision + outcome) to
// `<rootDir>/audit.jsonl` for post-hoc review.
export * from './logger';
