---
name: orchestrate-engineering
description: Use when modifying, implementing, debugging, refactoring, testing, or reviewing code in the Orchestrate repository. Follow the repository's engineering workflow, preserve architecture boundaries, verify changes, and report evidence rather than unsupported claims.
---

# Orchestrate Engineering

## Purpose

Work on the Orchestrate repository using a disciplined, evidence-driven engineering workflow.

Orchestrate is an AI engineering system that coordinates coding agents while maintaining verification-backed project state.

The goal is to produce small, correct, testable changes without unnecessary complexity.

## Core Workflow

For every non-trivial engineering task:

1. Inspect the relevant repository structure and existing implementation.
2. Identify the architectural boundaries affected by the change.
3. State a concise implementation plan before making significant changes.
4. Implement the smallest change that satisfies the requirement.
5. Run the relevant tests, typechecks, linting, and other configured verification.
6. Inspect the final Git diff.
7. Report what changed and provide concrete verification evidence.

Do not skip inspection simply because the requested change appears small.

## Repository Principles

- Prefer simple solutions over unnecessary abstractions.
- Do not introduce a dependency unless it solves a concrete requirement.
- Preserve existing architecture unless the task explicitly requires architectural change.
- Keep responsibilities separated between packages.
- Avoid circular dependencies.
- Do not place unrelated changes in the same task.
- Do not modify files outside the task's scope without explaining why.
- Do not silently rewrite working code merely for stylistic preference.

## TypeScript

- Use strict TypeScript.
- Avoid `any` unless there is a documented reason.
- Prefer explicit types at important system boundaries.
- Do not suppress TypeScript errors without understanding and documenting the cause.
- Preserve type safety across package boundaries.

## Error Handling

- Do not silently swallow errors.
- Preserve useful error context.
- Errors in agent execution should identify the relevant operation and execution context where available.
- Do not convert failures into successful-looking results.

## Testing

After implementation:

1. Run the most specific relevant tests first.
2. Run typechecking when applicable.
3. Run linting when configured.
4. Run broader tests/build checks when appropriate.
5. Investigate failures instead of declaring the task complete.

Tests are evidence. They do not prove that the implementation is universally correct.

## Verification Language

Do not claim that a task is "verified" merely because an agent says it is complete.

Use evidence-based language:

- `CLAIMED` — an agent reported that work was completed.
- `VERIFIED` — the configured verification checks passed.
- `FAILED` — one or more required checks failed.
- `BLOCKED_NEEDS_HUMAN` — progress cannot continue safely without human input.

Important:

VERIFIED means the configured checks passed. It does not mean the code is mathematically or universally proven correct.

## Git Discipline

Before completing a task:

- Inspect `git diff`.
- Check for unintended files.
- Do not commit secrets.
- Do not commit `.env` files.
- Do not rewrite unrelated history.
- Keep changes focused and reviewable.

## Security

Treat all model-generated input as untrusted.

Never assume that an AI-generated command, path, URL, or file operation is safe.

When working on execution-related code, consider:

- filesystem boundaries
- path traversal
- command injection
- subprocess timeouts
- environment-variable exposure
- secret leakage
- network access
- resource exhaustion
- permission boundaries

Do not weaken a security boundary merely to make a test pass.

## Dependencies

Before adding a dependency:

1. Determine whether the functionality can reasonably be implemented using the existing stack.
2. Check whether the dependency is actually required.
3. Prefer mature, maintained dependencies with a clear purpose.
4. Keep the dependency surface small.

Do not add frameworks or infrastructure merely because they are popular.

## Scope Control

Do not implement future Orchestrate features unless they are required for the current task.

Examples of features that should not be added prematurely:

- multi-provider routing
- distributed execution
- Kubernetes
- complex event buses
- production-scale databases
- unnecessary caching
- speculative abstractions

Follow the current project milestone.

## Completion Report

When finished, report:

### Changed
- Files changed
- What was implemented

### Verification
- Tests run
- Typecheck result
- Lint result
- Build result, if applicable

### Notes
- Important design decisions
- Known limitations
- Any remaining issues

Never claim a check passed unless it was actually run and passed.