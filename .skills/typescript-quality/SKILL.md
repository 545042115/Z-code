---
name: TypeScript Quality
description: Ensure TypeScript code quality during modifications, refactoring, and bug fixes. Use when the task involves TypeScript files, type errors, compilation issues, or code quality improvements.
tags: [typescript, quality, refactor, compile]
priority: 60
mode: advisory
triggers:
  intents: [modify, refactor, bug_fix]
  file_globs:
    - "**/*.ts"
  keywords:
    - typescript
    - type error
    - compile
    - refactor
    - interface
stop_if:
  - backend-only
  - python-only
imports: []
tools_allow:
  - read_file
  - search_code
  - replace_text
  - insert_before
  - insert_after
  - run_terminal
verification:
  commands:
    - npm run compile
---

## Purpose

Ensure TypeScript modifications maintain type safety, public API compatibility, and code quality standards.

## Use When

- Modifying or refactoring TypeScript files
- Fixing type errors or compilation issues
- Adding new TypeScript interfaces or types
- Changing public APIs in TypeScript modules

## Workflow

1. Read the target file(s) to understand current types and interfaces
2. Identify the public API surface that must remain compatible
3. Make the minimal change needed
4. Verify that no type errors are introduced

## Do

- Preserve public interface compatibility
- Use proper TypeScript types instead of `any`
- Run `npm run compile` after changes
- Check for downstream consumers of modified types
- Use `unknown` instead of `any` when type is genuinely uncertain

## Do Not

- Use `any` to bypass type errors unless the existing codebase already uses it as a pattern
- Change public API signatures without checking all call sites
- Ignore TypeScript compiler errors
- Remove type annotations that provide safety guarantees

## Verification

Run `npm run compile` to verify no type errors are introduced. If the project has a `tsc --noEmit` script, prefer that for faster feedback.
