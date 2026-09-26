---
trigger: always_on
---

# Orchestrate Architecture & Engineering Rules

## 1. Project Purpose

Orchestrate is an AI engineering system that coordinates coding agents while maintaining persistent, evidence-backed project state.

The current priority is the hackathon MVP and its controlled evaluation.

Prefer the simplest implementation that satisfies the current milestone. Do not introduce complexity for hypothetical future requirements.

---

## 2. Core Architecture

Maintain clear responsibility boundaries between the following components:

- **ModelClient** — communicates with AI model providers.
- **AgentRunner** — owns the agent execution loop and coordinates model/tool interaction.
- **ToolRegistry** — exposes controlled capabilities to agents.
- **Workspace** — provides an isolated execution environment for an agent run.
- **Verification** — independently evaluates configured checks against the resulting state.
- **Telemetry** — records execution and measurement data.
- **Project Brain** — stores structured project state and evidence-backed knowledge.
- **Context Compiler** — selects relevant project state for downstream agent tasks.

Do not collapse these responsibilities or create cross-layer coupling without an explicit architectural reason.

Avoid circular dependencies.

---

## 3. Source-of-Truth Hierarchy

When determining how much to trust information, use this hierarchy:

CODE
↓
VERIFICATION EVIDENCE
↓
PROJECT BRAIN
↓
AGENT CLAIMS

An agent's statement that work is complete is a claim, not independent verification.

Do not promote an agent claim into trusted project state without the required evidence.

---

## 4. Verification

`VERIFIED` means that the configured verification checks passed.

It does not mean that the implementation is universally, mathematically, or formally proven correct.

Never report a verification check as passed unless it was actually executed and passed.

Never:

- delete a failing assertion to make tests pass
- disable a verification check to make a task pass
- skip a required check without reporting it
- weaken verification criteria merely to obtain a passing result
- fabricate or infer verification results

If verification fails, preserve the failure information and investigate the underlying cause.

---

## 5. Agent-Generated Input Is Untrusted

Treat all model-generated content as untrusted input.

This includes:

- file paths
- shell commands
- URLs
- environment variables
- tool arguments
- generated code
- configuration changes
- database queries
- Git operations

Validate and constrain these operations according to the applicable security boundary.

Never assume that an AI-generated command or path is safe merely because the model produced it.

---

## 6. Workspace Isolation

An agent execution must operate only within its assigned workspace unless an explicitly authorized operation requires access outside it.

Do not allow an agent to silently:

- read unrelated project directories
- modify another agent's workspace
- modify arbitrary host files
- access unrelated repositories
- access user credentials or private files
- escape its assigned workspace through path traversal

Workspace isolation is a system invariant, not an optional convenience.

When implementing or modifying workspace-related code, preserve this invariant.

---

## 7. Command and Process Execution

Code that executes model-generated commands must account for:

- command injection
- path traversal
- subprocess timeouts
- resource exhaustion
- environment-variable exposure
- unexpected process termination
- excessive output
- unauthorized network access

Do not expose unnecessary environment variables or host capabilities to an agent.

Do not remove execution restrictions merely because they make a test or development workflow inconvenient.

---

## 8. Secrets and Telemetry

Never intentionally expose or persist secrets.

Sensitive values include, but are not limited to:

- API keys
- access tokens
- authentication headers
- passwords
- private credentials
- `.env` contents
- SSH credentials

Telemetry must not intentionally record secrets or credentials.

Before emitting telemetry, consider sensitive information that may appear in:

- tool arguments
- environment variables
- model messages
- command output
- error messages
- stack traces
- file contents

Redact sensitive values before sending them to external observability systems such as LangSmith.

Never commit secrets to Git.

---

## 9. Repair Loop

Automated repair must be bounded.

The Orchestrate repair loop may perform a maximum of **two automated repair attempts** for a failed task.

After the maximum is reached, the execution must transition to:

`BLOCKED_NEEDS_HUMAN`

Do not create an unbounded autonomous repair loop.

The maximum applies to the Orchestrate runtime; tests may use deterministic mocks or fakes without invoking the real repair loop.

---

## 10. Experiment Integrity

The benchmark and evaluation are controlled experiments.

Frozen experiment definitions must not be casually modified while debugging implementation or metric-computation problems.

Do not change without explicit authorization:

- experimental arm definitions
- prompts
- scenario inputs
- task dependencies
- metric definitions
- verification criteria
- context conditions
- replication rules

If an experiment implementation contains a bug, fix the implementation without silently changing the experimental definition.

If the experimental definition itself must change, record that change explicitly and treat the affected results accordingly.

---

## 11. Benchmark Determinism

Benchmark scenarios should be deterministic wherever practical.

Avoid uncontrolled dependence on:

- network availability
- external mutable services
- wall-clock timing
- random uncontrolled state
- machine-specific state
- non-deterministic external data

If a scenario intentionally requires an external dependency or non-deterministic behavior, document it explicitly.

Do not claim reproducibility when the required conditions were not reproduced.

---

## 12. Nebius Critical Path

Nebius is the required AI inference provider for the hackathon MVP's real model-execution path.

Do not replace, remove, or silently mock Nebius in the production/demo execution path without explicit human approval.

Tests may use deterministic mocks, fakes, or fixtures where appropriate so that unit and integration tests do not unnecessarily depend on live inference.

The hackathon requirement must remain visible in the actual working application.

---

## 13. Technology Direction

The current planned stack is:

- **Frontend:** Next.js, React, TypeScript, Tailwind CSS
- **Engine:** Node.js, TypeScript, Fastify, WebSocket
- **Persistence:** SQLite with WAL initially
- **AI:** Nebius Token Factory / NVIDIA open-source model
- **Observability:** LangSmith
- **Research:** Tavily
- **Human evaluation:** Toloka

Do not replace these technologies or introduce alternatives unless a concrete requirement, measured limitation, or explicit architectural decision justifies the change.

---

## 14. Dependency Discipline

Every dependency must have a concrete purpose.

Before adding a dependency:

1. Determine whether the existing stack can reasonably provide the required functionality.
2. Determine whether the dependency is actually necessary.
3. Prefer mature and maintained dependencies.
4. Consider security, maintenance, licensing, and bundle/runtime impact.
5. Keep the dependency surface small.

Do not add frameworks, infrastructure, or libraries merely because they are popular or convenient.

---

## 15. TypeScript

Use strict TypeScript.

- Keep `strict: true`.
- Avoid `any` unless there is a documented reason.
- Prefer explicit types at important system boundaries.
- Preserve type safety across package boundaries.
- Do not suppress TypeScript errors without understanding the underlying problem.
- Do not use unsafe casts as a substitute for understanding data flow.

---

## 16. Error Handling

Errors must remain observable and actionable.

Do not:

- silently swallow exceptions
- return fake success states
- replace failures with meaningless fallback values
- hide the original error
- mark failed work as successful

Where appropriate, preserve enough context to identify:

- task
- execution
- operation
- workspace
- tool
- underlying error

Do not expose sensitive information through error messages or logs.

---

## 17. Engineering Workflow

Before modifying code:

1. Inspect the relevant repository structure and implementation.
2. Identify affected architectural boundaries.
3. Determine whether the requested change conflicts with an existing invariant.
4. State a concise implementation plan.
5. Implement the smallest appropriate change.
6. Run relevant verification.
7. Inspect the final Git diff.
8. Report concrete evidence.

Do not make broad changes simply because they are convenient.

Do not modify unrelated files without a clear reason.

---

## 18. Ambiguity Handling

If a task is materially ambiguous and different interpretations would produce different architecture, behavior, security properties, or experimental results:

- identify the ambiguity
- inspect available project context
- choose the safest interpretation only when the choice is low-risk and reversible
- otherwise ask for clarification before making a consequential change

Do not invent requirements.

Do not silently choose a product or architectural direction that requires human judgment.

---

## 19. Scope Control

Implement only what the current task and milestone require.

Do not prematurely introduce:

- multi-provider routing
- distributed execution
- Kubernetes
- microservices
- complex event buses
- production-scale databases
- speculative caching
- unnecessary abstractions
- additional orchestration frameworks

Future capabilities may be documented or planned without being implemented prematurely.

---

## 20. Architecture Changes

Preserve the existing architecture unless the task explicitly requires an architectural change.

If implementation reveals that an existing architectural assumption is invalid:

1. Stop before making a broad architectural change.
2. Explain the discovered problem.
3. Identify affected components.
4. Present the smallest reasonable alternatives.
5. Obtain the required human decision before proceeding with a consequential architectural change.

Do not silently replace core technologies or restructure the system because the current implementation is inconvenient.

---

## 21. Git Discipline

Before completing a task:

- inspect `git diff`
- check for unintended files
- check for secrets
- check that generated artifacts are appropriate
- keep changes focused
- do not rewrite unrelated history
- do not commit `.env` files or credentials

Do not claim a clean diff without actually inspecting it.

---

## 22. Completion Standard

Writing code does not by itself mean a task is complete.

A completed engineering task should have, where applicable:

- implementation
- relevant tests
- typecheck
- lint
- build verification
- security checks
- reviewed Git diff
- documented limitations

Report only checks that were actually executed.

Use evidence-based status language:

- **CLAIMED** — an agent reported that work was completed.
- **VERIFIED** — configured verification checks passed.
- **FAILED** — one or more required checks failed.
- **BLOCKED_NEEDS_HUMAN** — progress cannot safely continue without human input.

Never claim `VERIFIED` based solely on an agent's statement.

---

## 23. No Unnecessary Complexity

The project is being developed under a fixed hackathon timeline.

Prefer:

- simple architecture
- explicit code
- small changes
- deterministic behavior
- measurable requirements
- reusable boundaries where justified

Avoid engineering complexity that does not contribute to the current product, experiment, security, or submission requirements.