# M7 — Benchmark Harness Implementation Plan

**Document Version:** 1.1.0  
**Status:** DRAFT IMPLEMENTATION PLAN (Pre-Implementation Architectural Proposal)  
**Target Milestone:** M7 — Benchmark Harness Implementation  
**Governing Specifications:**
- [`docs/TASK_A_SNAPSHOT_CONTRACT.md`](./TASK_A_SNAPSHOT_CONTRACT.md) (Canonical Upstream Snapshot)
- [`docs/EXPERIMENTAL_ARM_ISOLATION.md`](./EXPERIMENTAL_ARM_ISOLATION.md) (Arm Construction & Isolation)
- [`docs/TRIAL_RUN_CONTRACT.md`](./TRIAL_RUN_CONTRACT.md) (Trial Container, Lifecycle, Failure Taxonomy, Validity)
- [`docs/HARNESS_EXECUTION_CONTRACT.md`](./HARNESS_EXECUTION_CONTRACT.md) (Execution Controls, Fingerprints, Leakage Protection)
- [`docs/EXPERIMENT_PROTOCOL.md`](./EXPERIMENT_PROTOCOL.md) (Experimental Protocol, Hypotheses, Metrics)
- [`docs/ARTIFACT_MANIFEST.md`](./ARTIFACT_MANIFEST.md) (Upstream Artifact Manifest Contract)
- [`docs/DISCOVERY_MEASUREMENT.md`](./DISCOVERY_MEASUREMENT.md) (Discovery Measurement Contract)

---

## 1. Current Repository Architecture

The Orchestrate repository is organized as a strict, multi-package monorepo with distinct responsibility boundaries:

```
packages/
├── model/        ──► Low-level LLM abstraction (ModelClient, NebiusTokenFactoryClient, ModelUsage)
├── workspace/    ──► Sandboxed execution (LocalWorkspace, LocalCommandExecutor, LocalGitRepository)
├── verification/ ──► Independent verification execution (VerificationEngine, VerificationPlan)
├── brain/        ──► Persistence layer for structured, evidence-backed knowledge (MemoryProjectBrain)
├── compiler/     ──► Deterministic context compilation (<orchestrate_context> XML serializer)
├── core/         ──► Agent execution loop (AgentRunner, ToolRegistry, Orchestrator)
├── benchmark/    ──► Pure evaluation algorithms (evaluateDiscovery, evaluateRework, manifest freeze)
└── telemetry/    ──► Observability interfaces (currently stub)
apps/
├── engine/       ──► Service daemon entrypoint (currently stub)
└── web/          ──► Web frontend entrypoint (currently stub)
```

### Architectural Axiom
The benchmark harness does **not** introduce an alternative runtime or duplicate core orchestration capabilities. Instead, it acts as an **experimental controller and evidence collector** that wraps the existing `AgentRunner`, `LocalWorkspace`, `LocalGitRepository`, and `VerificationEngine` within strict treatment boundaries.

---

## 2. Existing API Inventory

Every component in M7 builds directly on verified, existing repository APIs:

| Package | Existing Type / Class | Method / Signature | Harness Role |
| :--- | :--- | :--- | :--- |
| `@orchestrate/model` | `ModelClient` | `complete(req: ModelRequest): Promise<ModelResponse>` | Model completions during Agent B run |
| `@orchestrate/model` | `ModelUsage` | `{ promptTokens: number; completionTokens: number; totalTokens: number }` | Token consumption extraction |
| `@orchestrate/workspace` | `Workspace` | `readFile(path: string): Promise<string>`<br>`writeFile(path: string, content: string): Promise<void>` | Filesystem access inside arm sandbox |
| `@orchestrate/workspace` | `LocalWorkspace` | `constructor(options: { rootPath: string })` | Sandboxed physical workspace instance |
| `@orchestrate/workspace` | `CommandExecutor` | `execute(cmd: string, args: string[], opts?: ExecuteCommandOptions): Promise<CommandResult>` | Subprocess tool execution |
| `@orchestrate/workspace` | `LocalCommandExecutor` | `constructor(options: LocalCommandExecutorOptions)` | Command execution with timeout & allowlist |
| `@orchestrate/workspace` | `GitRepository` | `isRepository(): Promise<boolean>`<br>`getStatus(): Promise<GitStatus>`<br>`getHeadCommit(): Promise<GitCommit \| null>`<br>`getDiff(options?: GitDiffOptions): Promise<string>` | Snapshot verification and final diff capture |
| `@orchestrate/workspace` | `LocalGitRepository` | `constructor(options: LocalGitRepositoryOptions \| CommandExecutor)` | Git operations via CommandExecutor |
| `@orchestrate/verification` | `VerificationPlan` | `{ checks: VerificationCheck[] }` | Immutable verification specification |
| `@orchestrate/verification` | `VerificationEngine` | `run(plan: VerificationPlan): Promise<VerificationResult>` | Independent verification of arm workspace |
| `@orchestrate/verification` | `VerificationResult` | `{ status: 'VERIFIED' \| 'FAILED', passed: boolean, evidence: VerificationEvidence[], ... }` | Objective verification ground truth |
| `@orchestrate/compiler` | `ContextCompiler` | `compile(req: CompilationRequest): Promise<CompiledContext>` | Arm C context compilation from Brain |
| `@orchestrate/compiler` | `ContextSerializer` | `static serialize(context: CompiledContext): string` | Generates `<orchestrate_context>` XML |
| `@orchestrate/compiler` | `sanitizeText` | `(text: string, additionalSecrets?: string[]): SanitizeResult` | Secret redaction regexes |
| `@orchestrate/core` | `AgentRunner` | `run(input: AgentRunInput): Promise<AgentRunResult>` | Autonomous model/tool interaction loop |
| `@orchestrate/core` | `ToolRegistry` | `register(tool: Tool)`, `list()`, `toToolDefinitions()`, `execute(name, input)` | Tool registry exposed to Agent B |
| `@orchestrate/core` | `createDefaultToolRegistry` | `(options?: { workspace?: Workspace, executor?: CommandExecutor }): ToolRegistry` | Standard tools (`read_file`, `write_file`, `execute_command`) |
| `@orchestrate/benchmark` | `evaluateDiscovery` | `evaluateDiscovery(input: DiscoveryEvaluationInput): Readonly<DiscoveryEvaluationReport>` | Deterministic `discovery_actions` metric |
| `@orchestrate/benchmark` | `evaluateRework` | `evaluateRework(input: ReworkEvaluationInput): Promise<Readonly<ReworkEvaluationReport>>` | Deterministic `rework_events` metric |
| `@orchestrate/benchmark` | `freezeManifest` | `freezeManifest(manifest: ArtifactManifest): FrozenArtifactManifest` | Upstream snapshot manifest validation |

---

## 3. Proposed M7 Architecture

M7 implements the benchmark harness inside `packages/benchmark/src/harness/`. It strictly enforces the critical pipeline boundary:

```
EXECUTION ──► RAW REDACTED EVIDENCE ──► INDEPENDENT VERIFICATION ──► MEASUREMENT ──► TRIAL VALIDATION ──► RESULT
```

```
                                  Trial Specification
                                           │
                                           ▼
                                 ┌───────────────────┐
                                 │  SnapshotLoader   │ ◄── Resolves Task-A Snapshot SHA & Lockfile
                                 └─────────┬─────────┘
                                           │
                                           ▼
                                 ┌───────────────────┐
                                 │   TrialBuilder    │ ◄── Assembles TrialRecord, ControlFingerprint,
                                 └─────────┬─────────┘     and generates armOrderSeed
                                           │
                                           ▼
                                 ┌───────────────────┐
                                 │    ArmBuilder     │ ◄── Generates ARM_A, ARM_B, ARM_C Context Envelopes
                                 └─────────┬─────────┘     and computes TreatmentFingerprints
                                           │
               Deterministic Permutation via armOrderSeed (§3.4)
                                           │
               ┌───────────────────────────┼───────────────────────────┐
               ▼                           ▼                           ▼
        [ARM_A_BASELINE]       [ARM_B_UNVERIFIED_HANDOFF]      [ARM_C_ORCHESTRATE]
        • Empty Context        • <orchestrate_handoff>         • <orchestrate_context>
        • Isolated Dir         • Isolated Dir                  • Isolated Dir
               │                           │                           │
               └───────────────────────────┼───────────────────────────┘
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │   ArmExecutor       │ ◄── Dispatches Instrumented Tools/Model
                                └──────────┬──────────┘
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │ Structured Redaction│ ◄── Field-Aware Secret Redaction (Pre-Sealing)
                                └──────────┬──────────┘
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │ Evidence Sealer     │ ◄── Computes EvidenceContentSha256
                                └──────────┬──────────┘
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │VerificationAdapter  │ ◄── Independent VerificationEngine Suite
                                └──────────┬──────────┘
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │ Measurement Pipeline│
                                │ • Discovery Adapter │ ◄── evaluateDiscovery()
                                │ • Rework Adapter    │ ◄── evaluateRework()
                                │ • Usage Tracker     │ ◄── Token & Cost Calculation
                                └──────────┬──────────┘
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │   TrialValidator    │ ◄── Category A–E Taxonomy & Invariants
                                └──────────┬──────────┘
                                           │
                                           ▼
                              Final Sealed Trial Record
                               (VALID or INVALID_TRIAL)
```

---

## 4. Component Responsibilities

### A. Trial Builder (`packages/benchmark/src/harness/trial-builder.ts`)
- **Inputs:** Scenario configuration, replication index, Task-A snapshot metadata, Task-B prompt, execution controls, optional `armOrderSeed`.
- **Responsibilities:**
  - Validates scenario ID and replication index format.
  - Constructs the immutable `TrialRecord` container.
  - Computes the immutable `ControlFingerprint`.
  - Generates or binds `armOrderSeed` and computes the deterministic `executionOrder`.
  - Enforces that no execution occurs at builder time.

### B. Snapshot Loader (`packages/benchmark/src/harness/snapshot-loader.ts`)
- **Inputs:** Repository path, target `commitSha`.
- **Responsibilities:**
  - Validates that `commitSha` is an exact 40-character hexadecimal string.
  - Verifies that the commit exists and is resolvable in the local Git repository via `LocalGitRepository`.
  - Asserts that the working tree is clean.
  - Extracts and computes the dependency lockfile hash (`dependencyStateSha256`).
  - Assembles the `environmentDependencyFingerprint`.

### C. Arm Builder (`packages/benchmark/src/harness/arm-builder.ts`)
- **Inputs:** `TrialRecord`, Task-A snapshot, raw unverified handoff text, compiled verified context text.
- **Responsibilities:**
  - Instantiates exact triad: `ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`.
  - Attaches identical `ControlFingerprint` to all three arms.
  - Injects specific treatment envelope:
    - Arm A: Omitted / empty string.
    - Arm B: `<orchestrate_handoff>...</orchestrate_handoff>`.
    - Arm C: `<orchestrate_context>...</orchestrate_context>`.
  - Computes `TreatmentFingerprint` for each arm.

### D. Workspace Isolation Manager (`packages/benchmark/src/harness/workspace-factory.ts`)
- **Inputs:** Base repository root, target `commitSha`, unique `armId`.
- **Responsibilities:**
  - Creates a dedicated, isolated temporary directory on disk (e.g. `<tempRoot>/<trialId>/<armId>/`).
  - Clones or checks out the repository strictly at `commitSha`.
  - Verifies working tree status is completely clean using `LocalGitRepository.getStatus()`.
  - Provisions instance of `LocalWorkspace`, `LocalCommandExecutor`, and `LocalGitRepository`.
  - Provides teardown hook ensuring complete removal of temporary directory upon trial conclusion.

### E. Agent Execution Adapter & Instrumented Interceptors (`packages/benchmark/src/harness/agent-adapter.ts`)
- **Inputs:** `ArmRecord`, `LocalWorkspace`, `ToolRegistry`, `ModelClient`.
- **Responsibilities:**
  - Intercepts model interactions and tool executions cleanly via instrumented wrappers without modifying production `AgentRunner`.
  - Assembles initial input payload for `AgentRunner`:
    - Base system prompt.
    - Arm treatment block (if present).
    - Canonical Task-B prompt text (blinded: no arm identifiers, trial IDs, or metric details).
  - Captures monotonic tool events, durations, and `ModelUsage`.
  - Does **NOT** compute metrics.

### F. Structured Redaction Layer (`packages/benchmark/src/harness/redaction.ts`)
- **Inputs:** Raw tool events, model responses, stdout/stderr, execution metadata.
- **Responsibilities:**
  - Applies field-aware sanitization across all structured evidence prior to hashing and sealing.
  - Explicitly strips API keys, Authorization headers, `.env` contents, and unallowed environment variables.
  - Uses `sanitizeText()` from `@orchestrate/compiler` on text fields.

### G. Execution Evidence Sealer (`packages/benchmark/src/harness/evidence-sealer.ts`)
- **Inputs:** Redacted tool events, redacted model responses, workspace diff, timing data.
- **Responsibilities:**
  - Canonicalizes the redacted execution trace using sorted key serialization.
  - Computes `evidenceContentSha256`.
  - Structures data into immutable `ArmRawExecutionTrace`.
  - Seals evidence into read-only JSON object.

### H. Verification Adapter (`packages/benchmark/src/harness/verification-adapter.ts`)
- **Inputs:** Arm workspace root, scenario `VerificationPlan`, `armId`.
- **Responsibilities:**
  - Binds independent `VerificationEngine` to the arm's dedicated `LocalCommandExecutor`.
  - Dispatches independent verification checks after agent loop termination.
  - Returns `VerificationResult`.
  - In Arms A & B: Verification results are measurement evidence only; never exposed to agent; does NOT trigger repair.
  - In Arm C: Initial verification failure may trigger bounded repair (maximum 2 attempts); logs each attempt as a distinct execution/evidence record.

### I. Discovery Measurement Adapter (`packages/benchmark/src/harness/discovery-adapter.ts`)
- **Inputs:** Redacted arm tool event transcript, supplied context references.
- **Responsibilities:**
  - Maps tool invocations into `DiscoveryEvent[]`.
  - Invokes pure `evaluateDiscovery()`.
  - Produces frozen `DiscoveryEvaluationReport`.

### J. Rework Measurement Adapter (`packages/benchmark/src/harness/rework-adapter.ts`)
- **Inputs:** Frozen upstream workspace, downstream final diff, upstream `ArtifactManifest`.
- **Responsibilities:**
  - Invokes pure `evaluateRework()`.
  - Produces frozen `ReworkEvaluationReport`.

### K. Token & Usage Tracker (`packages/benchmark/src/harness/usage-tracker.ts`)
- **Inputs:** Cumulative `ModelUsage` records from model client completions.
- **Responsibilities:**
  - Aggregates `promptTokens`, `completionTokens`, and `totalTokens`.
  - If usage was not provided by model, sets `usage_available = false` and token counts to 0.
  - Computes `estimated_cost_usd` deterministically using scenario-fixed pricing constants.

### L. Trial State Machine & Runner (`packages/benchmark/src/harness/trial-runner.ts`)
- **Responsibilities:**
  - Drives trial lifecycle through frozen states:
    `CREATED -> SNAPSHOT_READY -> ARMS_READY -> EXECUTING -> EVIDENCE_CAPTURED -> MEASURED -> COMPLETE` (or `INVALID`).
  - Dispatches arms in deterministic sequence governed by `armOrderSeed`.
  - Coordinates arm execution, verification, and measurement.

### M. Integrity Guard (`packages/benchmark/src/harness/integrity-guard.ts`)
- **Responsibilities:**
  - Pre-flight validation: verifies $\text{ControlFingerprint}(\text{Arm A}) == \text{ControlFingerprint}(\text{Arm B}) == \text{ControlFingerprint}(\text{Arm C})$.
  - Validates treatment payload hashes.
  - Checks for workspace directory traversal or cross-contamination.
  - If any invariant is violated, triggers immediate transition to `INVALID_TRIAL`.

---

## 5. Agent Execution Telemetry Boundary

### 5.1 Architecture: Clean Interception Without Core Intrusion
The existing public API of `AgentRunner` in `@orchestrate/core` is:
```typescript
run(input: AgentRunInput): Promise<AgentRunResult>
```
To capture complete execution telemetry without duplicating the runner loop or modifying core production code, M7 implements the **Instrumented Wrapper Pattern** at the interfaces passed into `AgentRunner`:

```
┌───────────────────────────────────────────────────────────────┐
│                    AgentExecutionAdapter                      │
│                                                               │
│   ┌─────────────────────┐             ┌───────────────────┐   │
│   │InstrumentedModelClnt│             │InstrumentedToolReg│   │
│   │(implements          │             │(wraps ToolRegistry│   │
│   │ ModelClient)        │             │ execute())        │   │
│   └──────────┬──────────┘             └─────────┬─────────┘   │
│              │                                  │             │
│              ▼                                  ▼             │
│   ┌───────────────────────────────────────────────────────┐   │
│   │              AgentRunner.run(input)                   │   │
│   │  (Reused existing production class without changes)   │   │
│   └───────────────────────────────────────────────────────┘   │
│              │                                  │             │
│              └─────────────────┬────────────────┘             │
│                                ▼                              │
│                    Telemetry Event Collector                  │
│                                │                              │
│                                ▼                              │
│                      ArmRawExecutionTrace                     │
└───────────────────────────────────────────────────────────────┘
```

### 5.2 Boundary Specification Details
1. **Existing API Reused:**
   - `AgentRunner` (`packages/core/src/runner.ts`): completely unchanged.
   - `ModelClient` (`packages/model/src/types.ts`): standard `complete(request)` interface.
   - `ToolRegistry` (`packages/core/src/tools.ts`): standard `execute(name, input)` interface.
2. **Minimal New API Required (Internal to `@orchestrate/benchmark`):**
   - `InstrumentedToolRegistry`: Wraps the `ToolRegistry` provided to `AgentRunner`. Intercepts every `execute(toolName, args)` call.
   - `InstrumentedModelClient`: Implements `ModelClient`. Wraps the underlying `ModelClient.complete(request)` call.
3. **Event Emission Ownership:**
   - `InstrumentedToolRegistry` owns emitting tool invocation start and completion events.
   - `InstrumentedModelClient` owns emitting model request, response, latency, and `ModelUsage` events.
4. **Event Collection Ownership:**
   - `AgentExecutionAdapter` owns event collection. It maintains an in-memory, append-only buffer of ordered events for the arm.
5. **Event Fields Captured:**
   - `sequence`: Monotonically increasing 1-based index ($1, 2, 3, \dots$).
   - `toolName`: Name of the executed tool.
   - `input`: Normalized tool arguments object.
   - `output`: Raw string result returned by the tool.
   - `isError`: Boolean indicating whether the tool threw or returned an error payload.
   - `timestamp`: ISO-8601 UTC timestamp of execution.
   - `durationMs`: Wall-clock elapsed time of tool execution.
6. **Production Core Invariance:**
   - Zero modifications to `packages/core`.
   - Outside the benchmark harness, `AgentRunner` behaves exactly as before.

---

## 6. Structured Secret Redaction

Converting structured objects to string and calling a generic regex replacer is insufficient. M7 implements **Field-Aware Structured Redaction** that executes **BEFORE** evidence sealing and hashing:

```
Raw Execution Events ──► Field-Aware Redaction ──► Canonical JSON ──► Evidence Content Hash
```

### 6.1 Field-Aware Redaction Policy
| Evidence Field | Permitted Content | Redaction Action |
| :--- | :--- | :--- |
| **Model Request** | Model string, message roles, temperature, maxTokens | All HTTP authorization headers, Bearer tokens, and provider credentials stripped. |
| **Model Response** | Assistant text, reasoning content | Text passed through `sanitizeText()`; known key patterns redacted. |
| **Tool Name** | Strict allowlist (`read_file`, `write_file`, `execute_command`, `git_*`) | Untrusted names rejected. Tool names never contain secrets. |
| **Tool Arguments** | Structured parameters (`path`, `content`, `args`) | For `write_file`: content sanitized with `sanitizeText()`.<br>For file paths: paths validated to not expose host user directory names. |
| **Tool Results** | Tool output strings | Output passed through `sanitizeText()`. |
| **Command Name** | Strict allowlist (`node`, `npm`, `npx`, `tsc`, `git`) | Checked against `ALLOWED_VERIFICATION_COMMANDS`. |
| **Command Args** | Array of CLI arguments | Flags matching sensitive patterns (e.g. `--token=*`, `password=*`, `-p *`) replaced with `[REDACTED]`. |
| **Stdout / Stderr** | Process output streams | Sanitized with `sanitizeText()`. Stack traces stripped of host home paths. |
| **Environment** | Minimal allowlisted metadata only (`NODE_ENV`, `PATH`, `CI`) | **Strict Forbidden:** Blind dumping of `process.env` is prohibited. `NEBIUS_API_KEY`, `LANGSMITH_API_KEY`, `.env` files are excluded. |
| **HTTP Metadata** | Status code, duration, endpoint URL | Request headers stripped of `Authorization`, `x-api-key`, and cookies. |

### 6.2 Pre-Sealing Invariant
- Redaction executes **strictly before** canonical serialization and content hashing.
- Only the canonical, permitted, redacted representation is hashed and sealed into `ArmRawExecutionTrace`.
- **Secrets are NEVER hashed.**

---

## 7. Randomized Arm Execution Order & Replayability

### 7.1 Mechanism
Protocol §3.4 mandates that the execution sequence of arms (`ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`) be randomized within each replication to neutralize temporal API drift, host load fluctuations, and provider caching.

To ensure **100% deterministic trial replay**, the ordering is generated via a pseudo-random permutation governed by an explicit seed:

1. **Deterministic Arm-Order Seed:**
   - The harness MUST use a deterministic `armOrderSeed` for arm-order generation.
   - The generated/selected seed MUST be recorded in trial execution evidence.
   - Replay MUST accept the recorded seed and reproduce the same arm execution order.
   - Normal trial creation MAY derive the seed deterministically from trial identity.
   - The exact derivation algorithm is an implementation detail and MUST NOT affect experimental semantics.
2. **Permutation Generation:**
   - A deterministic PRNG (such as Mulberry32) is initialized with `armOrderSeed`.
   - The three arms are permuted using a deterministic shuffle (such as Fisher-Yates) over the set of 6 possible permutations ($3! = 6$):
     `['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE']`.
3. **Execution Evidence Recording:**
   - The trial evidence explicitly records both the seed and the resolved sequence:
     ```json
     {
       "armOrderSeed": 38472910,
       "executionOrder": [
         "ARM_B_UNVERIFIED_HANDOFF",
         "ARM_A_BASELINE",
         "ARM_C_ORCHESTRATE"
       ]
     }
     ```
4. **Replay Invariant:**
   - Replaying a trial with the recorded `armOrderSeed` reproduces the exact arm execution sequence byte-for-byte.

### 7.2 Conceptual Separation: Arm Order Seed vs. Model Inference Seed
- **`armOrderSeed`:** Harness orchestration metadata. Controls the execution order of the three arms.
- **`modelConfig.seed`:** Model inference parameter. Controls the provider's token generation sampling if supported by the model/provider.
- The two seeds are conceptually and operationally distinct.

---

## 8. Verification Engine Integration

### 8.1 Integration Architecture
The harness integrates the existing `VerificationEngine` (`packages/verification/src/engine.ts`) with zero modifications to the verification package:

```
[armWorkspacePath]
        │
        ▼
new LocalCommandExecutor({ workspaceRoot: armWorkspacePath, allowedCommands: ALLOWED_VERIFICATION_COMMANDS })
        │
        ▼
new VerificationEngine({ executor: armCommandExecutor })
        │
        ▼
verificationEngine.run(scenarioVerificationPlan)
        │
        ▼
VerificationResult { status: 'VERIFIED' | 'FAILED', evidence: VerificationEvidence[], durationMs, verifiedAt }
```

### 8.2 Binding Rules & Verification-Driven Repair Gating per Arm

1. **Workspace Binding:** The harness constructs a dedicated `LocalCommandExecutor` rooted at the arm's physical workspace directory (`armWorkspacePath`).
2. **VerificationPlan Construction:** The plan is loaded immutably from the scenario definition. All check commands must be in `ALLOWED_VERIFICATION_COMMANDS` (`node`, `npm`, `npx`, `tsc`, `git`).
3. **Execution Isolation:** Verification runs strictly **after** Agent B terminates. Agent B is never given access to `VerificationEngine`.
4. **Arm-Specific Verification & Repair Rules:**
   - **`ARM_A_BASELINE`:**
     - Agent executes Task B.
     - Independent verification runs afterward.
     - Verification results are measurement evidence only.
     - Verification does **NOT** trigger repair.
     - Verification results are concealed from the agent.
   - **`ARM_B_UNVERIFIED_HANDOFF`:**
     - Agent executes Task B with the structured unverified handoff.
     - Independent verification runs afterward.
     - Verification results are measurement evidence only.
     - Verification does **NOT** trigger repair.
     - Verification results are concealed from the agent.
   - **`ARM_C_ORCHESTRATE`:**
     - Agent executes Task B with compiled verified context.
     - Independent verification runs afterward.
     - The verification result **MAY trigger the already-frozen Orchestrate repair/gating behavior**.
     - Repair is bounded exactly according to the existing frozen contract (a maximum of **2 automated repair attempts**).
     - Each repair attempt is a distinct execution and evidence record (`verificationAttempts: [result1, result2]`).
     - If attempt 2 fails, the execution terminates with status `BLOCKED_NEEDS_HUMAN` and `repairStatus = 'EXHAUSTED'`.
     - **No repair is triggered from agent claims alone.**
     - **No repair occurs in Arm A or Arm B.**
5. **Ground Truth Invariant:**
   - `VERIFIED` means the verification engine ran and all checks passed.
   - An agent statement claiming "all tests pass" is an unverified claim, not verification evidence.
   - Agent B cannot self-declare verification in any arm.

---

## 9. Rework Measurement Integration

### 9.1 API Invocation
The harness integrates the pure `evaluateRework()` function (`packages/benchmark/src/evaluator/evaluator.ts`):
```typescript
const reworkReport = await evaluateRework({
  manifest: upstreamArtifactManifest,
  upstreamWorkspace: frozenUpstreamWorkspace,
  diff: finalDownstreamDiff,
});
```

### 9.2 Immutable Upstream Workspace Supply
To guarantee that post-Agent-B modifications can **never** contaminate the upstream comparison baseline:
1. `frozenUpstreamWorkspace`: A dedicated `LocalWorkspace` rooted at a clean checkout of the canonical `snapshot_commit_sha`. This directory is instantiated separately from all arm workspaces.
2. `downstreamDiff`: Captured directly from the arm's `LocalGitRepository` using `getDiff()` against `snapshot_commit_sha`.
3. `upstreamArtifactManifest`: Frozen manifest loaded from Task A.
4. **Physical Immutability:** Because `frozenUpstreamWorkspace` resides in a distinct filesystem path from the arm workspaces, Agent B filesystem mutations cannot alter the upstream baseline.

---

## 10. Minimal Evidence Sealing Model

M7 deliberately avoids unnecessary cryptographic infrastructure (such as Merkle trees or external PKI) in favor of a clean, deterministic content-hash model:

```
Raw Structured Evidence
         │
         ▼
Field-Aware Redaction (Section 6)
         │
         ▼
Canonical JSON Serialization (Deterministic Sorted Keys)
         │
         ▼
SHA-256 Content Hash (evidenceContentSha256)
         │
         ▼
Immutable Sealed Record on Disk
```

### 10.1 Sealing Specification
1. **Canonical JSON Serialization:** All object keys are serialized in lexicographical order with UTF-8 encoding.
2. **Content Hash Computation:**
   $$\text{evidenceContentSha256} = \text{sha256}(\text{canonicalJson}(\text{redactedTrace}))$$
3. **Identity Fields Included:**
   - `trialId`, `scenarioId`, `replicationIndex`, `armId`, `snapshotCommitSha`.
4. **Evidence Fields Included:**
   - `events` (redacted monotonic tool events).
   - `stdout` / `stderr` (redacted).
   - `finalDiff` (relative to snapshot).
   - `tokenUsage` (`input_tokens`, `output_tokens`, `total_tokens`, `estimated_cost_usd`, `usage_available`).
   - `status` (`COMPLETED`, `FAILED`, `BLOCKED_NEEDS_HUMAN`).
5. **Timestamp Rule:** Timestamps are recorded in evidence for chronological audit, but are **never** hashed into control-equivalence fingerprints.
6. **No Universal Proof Claim:** Evidence content hashing guarantees tamper-evidence and audit traceability; it does not claim to formally prove universal correctness.

---

## 11. Separation of the Three Fingerprint and Hash Concepts

The harness strictly distinguishes three separate concepts:

| Concept | Scope | Purpose | Formula / Content | Invariant Across Arms |
| :--- | :--- | :--- | :--- | :---: |
| **`ControlFingerprint`** | Trial-level control integrity | Proves that all execution controls outside intentional treatment are identical. | Hash of snapshot SHA, prompt, model ID, inference config, tool schemas, permissions, env/dependency hash, limits. | **MUST BE IDENTICAL:**<br>$A == B == C$ |
| **`TreatmentFingerprint`** | Arm-level treatment identity | Identifies the intentional information variable injected into Agent B. | Hash of treatment envelope (empty for A, `<orchestrate_handoff>` for B, `<orchestrate_context>` for C). | **INTENTIONALLY DIFFERENT:**<br>$A \neq B \neq C$ |
| **`EvidenceContentHash`** | Post-run evidence tamper-proofing | Provides audit traceability and content verification for captured evidence. | $\text{sha256}(\text{canonicalJson}(\text{redactedTrace}))$ | Evaluated per arm post-execution |

---

## 12. Proposed Interface & Data Model

Every interface below explicitly references whether it is an **Existing** type from the codebase or a **New** type proposed for M7:

```typescript
// ============================================================================
// Imports from Existing Repository Packages
// ============================================================================
import type { ModelClient, ModelUsage } from '@orchestrate/model'; // EXISTING
import type { Workspace, CommandExecutor, GitRepository, GitStatus } from '@orchestrate/workspace'; // EXISTING
import type { VerificationPlan, VerificationResult, VerificationStatus } from '@orchestrate/verification'; // EXISTING
import type { ArtifactManifest, DiscoveryEvaluationReport, ReworkEvaluationReport } from '@orchestrate/benchmark'; // EXISTING

// ============================================================================
// New M7 Types (to live in packages/benchmark/src/harness/types.ts)
// ============================================================================

export type BenchmarkArmId =
  | 'ARM_A_BASELINE'
  | 'ARM_B_UNVERIFIED_HANDOFF'
  | 'ARM_C_ORCHESTRATE';

export type TrialLifecycleState =
  | 'CREATED'
  | 'SNAPSHOT_READY'
  | 'ARMS_READY'
  | 'EXECUTING'
  | 'EVIDENCE_CAPTURED'
  | 'MEASURED'
  | 'COMPLETE'
  | 'INVALID';

export type ArmExecutionStatus =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED_NEEDS_HUMAN';

/**
 * Control fingerprint: MUST be identical across arms.
 */
export interface ControlFingerprint {
  snapshotCommitSha: string;
  taskBPromptHash: string;
  modelIdentity: string;
  inferenceConfigHash: string;
  systemInstructionsHash: string;
  toolDefinitionsHash: string;
  toolPermissionsHash: string;
  environmentDependencyFingerprint: string;
  executionLimitsHash: string;
  filesystemPolicyHash: string;
  networkPolicyHash: string;
  harnessVersion: string;
  runtimeConfigHash: string;
}

/**
 * Treatment fingerprint: Intentionally different across arms.
 */
export interface TreatmentFingerprint {
  armId: BenchmarkArmId;
  treatmentPayloadHash: string;
}

/**
 * Token usage telemetry record.
 */
export interface TokenUsageRecord {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  usage_available: boolean;
}

/**
 * Monotonic tool event captured during agent execution.
 */
export interface HarnessToolEvent {
  sequence: number;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  timestamp: string;
  durationMs: number;
}

/**
 * Complete raw execution evidence captured for one arm.
 */
export interface ArmRawExecutionTrace {
  runId: string;
  armId: BenchmarkArmId;
  snapshotCommitSha: string;
  controlFingerprint: ControlFingerprint;
  treatmentFingerprint: TreatmentFingerprint;
  evidenceContentSha256: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ArmExecutionStatus;
  terminationReason?: string;
  events: HarnessToolEvent[];
  stdout: string;
  stderr: string;
  finalDiff: string;
  tokenUsage: TokenUsageRecord;
}

/**
 * Arm-level evidence package.
 */
export interface ArmTrialRecord {
  armId: BenchmarkArmId;
  status: ArmExecutionStatus;
  rawTrace: ArmRawExecutionTrace;
  verificationResult: VerificationResult;
  discoveryReport: DiscoveryEvaluationReport;
  reworkReport: ReworkEvaluationReport;
}

/**
 * Top-level benchmark trial container.
 */
export interface BenchmarkTrialRecord {
  trialId: string;
  scenarioId: string;
  replicationIndex: number;
  state: TrialLifecycleState;
  createdAt: string;
  completedAt?: string;
  armOrderSeed: number;
  executionOrder: BenchmarkArmId[];
  controlFingerprint: ControlFingerprint;
  arms: Record<BenchmarkArmId, ArmTrialRecord>;
  invalidReason?: string;
}
```

---

## 13. Package and File Layout

All M7 implementation files will reside strictly under `packages/benchmark/src/harness/`:

```
packages/benchmark/
├── package.json                   ──► Add workspace dependencies (@orchestrate/core, @orchestrate/model, etc.)
├── src/
│   ├── discovery/                 ──► (Existing M5 pure evaluator, untouched)
│   ├── evaluator/                 ──► (Existing M3 pure evaluator, untouched)
│   ├── extractor/                 ──► (Existing M2 extractor, untouched)
│   ├── manifest/                  ──► (Existing M2 manifest, untouched)
│   ├── harness/                   ──► [NEW M7 MODULE]
│   │   ├── types.ts               ──► Core M7 interfaces and type definitions
│   │   ├── snapshot-loader.ts     ──► Git commit resolver and lockfile hasher
│   │   ├── trial-builder.ts       ──► TrialRecord constructor & ControlFingerprint generator
│   │   ├── arm-builder.ts         ──► Arm triad builder & TreatmentFingerprint generator
│   │   ├── workspace-factory.ts   ──► Isolated temporary directory & workspace manager
│   │   ├── agent-adapter.ts       ──► AgentRunner wrapper, event interceptors & listeners
│   │   ├── redaction.ts           ──► Field-aware structured secret redaction layer
│   │   ├── usage-tracker.ts       ──► ModelUsage aggregator & cost calculator
│   │   ├── evidence-sealer.ts     ──► Canonical serialization & content hash calculator
│   │   ├── verification-adapter.ts──► VerificationEngine dispatcher & bounded repair handler
│   │   ├── discovery-adapter.ts   ──► Tool event to DiscoveryEvaluationInput mapper
│   │   ├── rework-adapter.ts      ──► Diff to ReworkEvaluationInput mapper
│   │   ├── integrity-guard.ts     ──► Pre-flight fingerprint and isolation validator
│   │   ├── trial-runner.ts        ──► State machine driver coordinating the run
│   │   └── index.ts               ──► Harness public exports
│   └── index.ts                   ──► Export harness symbols alongside existing evaluators
└── test/
    ├── discovery.test.ts          ──► (Existing tests, untouched)
    ├── evaluator.test.ts          ──► (Existing tests, untouched)
    ├── extractor.test.ts          ──► (Existing tests, untouched)
    ├── manifest.test.ts           ──► (Existing tests, untouched)
    └── harness/                   ──► [NEW M7 TESTS]
        ├── snapshot-loader.test.ts
        ├── trial-builder.test.ts
        ├── arm-builder.test.ts
        ├── workspace-factory.test.ts
        ├── agent-adapter.test.ts
        ├── redaction.test.ts
        ├── verification-adapter.test.ts
        ├── discovery-adapter.test.ts
        ├── rework-adapter.test.ts
        ├── integrity-guard.test.ts
        └── trial-runner.test.ts
```

---

## 14. Testing Strategy

All M7 harness tests will be **strictly deterministic** and runnable offline without live inference endpoints:

| Test Category | Target Component | Verifications |
| :--- | :--- | :--- |
| **1. Snapshot Resolution** | `SnapshotLoader` | Rejects invalid SHA format; rejects missing commits; computes lockfile hash. |
| **2. Trial Construction** | `TrialBuilder` | Assembles valid `TrialRecord`; computes identical `ControlFingerprint`. |
| **3. Arm Construction** | `ArmBuilder` | Correct context envelopes; correct `TreatmentFingerprint` for A, B, C. |
| **4. Order Replay** | `TrialBuilder` | Same `armOrderSeed` reproduces exact same arm sequence; records `executionOrder`. |
| **5. Workspace Isolation** | `WorkspaceFactory` | Creates isolated temporary repos; checks out commit; cleans up properly. |
| **6. Prompt Blinding** | `AgentExecutionAdapter` | Ensures no arm identifiers, trial IDs, or metric names exist in prompts. |
| **7. Monotonic Events** | `AgentExecutionAdapter` | Monotonically increasing sequence numbers ($1, 2, 3\dots$); timestamps present. |
| **8. Structured Redaction** | `RedactionLayer` | Redacts API keys, auth headers, .env, arguments; strips private keys. |
| **9. Evidence Content Hash** | `EvidenceSealer` | Deterministic canonical JSON hashing; hashes post-redaction state. |
| **10. Usage Telemetry** | `UsageTracker` | Correct aggregation; handles missing usage (`usage_available = false`). |
| **11. Independent Verification**| `VerificationAdapter` | Passes/fails independent checks; conceals results from Arms A/B. |
| **12. Bounded Repair** | `VerificationAdapter` | Arm C executes at most 2 repair attempts before terminating with `EXHAUSTED`. |
| **13. Discovery Pipeline** | `DiscoveryAdapter` | Transcripts correctly trigger `evaluateDiscovery()`. |
| **14. Rework Pipeline** | `ReworkAdapter` | Diffs correctly trigger `evaluateRework()`; upstream workspace unmutated. |
| **15. State Machine** | `TrialRunner` | Clean transition through all 7 states; aborts to `INVALID` on violation. |
| **16. Category A Detection** | `TrialValidator` | Harness crash or leak invalidates trial (`INVALID_TRIAL`). |
| **17. Category B Detection** | `TrialValidator` | Agent timeout or crash marks arm `FAILED` but preserves trial validity. |
| **18. Category C Detection** | `TrialValidator` | Verification failure marks arm `FAILED` as valid experimental evidence. |
| **19. Category D Detection** | `TrialValidator` | Repair failure marks arm `FAILED` as valid experimental evidence. |
| **20. Category E Detection** | `TrialValidator` | Repair exhaustion correctly marks arm `BLOCKED_NEEDS_HUMAN`. |
| **21. Leakage Detection** | `IntegrityGuard` | Detects cross-arm path access and triggers `INVALID_TRIAL`. |
| **22. Control Mismatch** | `IntegrityGuard` | Detects modified control parameter and triggers `INVALID_TRIAL`. |

---

## 15. Unit vs. Integration Test Boundaries

1. **Unit Tests (`packages/benchmark/test/harness/*.test.ts`):**
   - Mock `ModelClient` with deterministic responses (pre-programmed tool calls and completions).
   - Fast, local, in-memory execution.
   - Part of standard `npm.cmd test`.
2. **Harness Integration Tests:**
   - Execute real `LocalGitRepository`, `LocalWorkspace`, and `LocalCommandExecutor` on temporary Git repositories initialized on disk.
   - Run verification checks using real Node.js scripts in temporary workspaces.
   - Still mock `ModelClient` to remain deterministic and network-free.
3. **Live Inference Spike (Explicitly Isolated):**
   - Live Nebius Token Factory runs belong to scenario execution scripts, never default unit test suites.

---

## 16. Implementation Order (Phased Delivery)

We propose executing M7 in four focused, verifiable phases:

- **Phase 1: Core Types, Builders & Redaction**
  - Implement `types.ts`, `snapshot-loader.ts`, `trial-builder.ts`, `arm-builder.ts`, `redaction.ts`.
  - Unit tests for fingerprinting, prompt blinding, secret redaction, and deterministic arm order shuffling.
- **Phase 2: Workspace Factory, Agent Adapter & Sealer**
  - Implement `workspace-factory.ts`, `agent-adapter.ts`, `usage-tracker.ts`, `evidence-sealer.ts`.
  - Unit tests for sandboxing, monotonic event interception, diff generation, and content hashing.
- **Phase 3: Evaluator Adapters & Verification Coordinator**
  - Implement `verification-adapter.ts` (with bounded repair), `discovery-adapter.ts`, `rework-adapter.ts`.
  - Unit tests for evaluator integration, upstream workspace immutability, and measurement purity.
- **Phase 4: Integrity Guard & Trial State Machine**
  - Implement `integrity-guard.ts`, `trial-runner.ts`, public exports.
  - End-to-end deterministic trial integration tests covering full lifecycle and failure categories.

---

## 17. Key Risks and Mitigations

| Risk | Description | Mitigation |
| :--- | :--- | :--- |
| **Cross-Arm Workspace Leakage** | An agent in Arm B modifies or inspects files in Arm A's workspace. | Enforce physical path separation in distinct OS temporary directories; validate paths with `IntegrityGuard`. |
| **Accidental Blinding Violation** | Harness accidentally includes `ARM_B` or scenario metrics in prompt text. | Automated regex assertion in `IntegrityGuard` before dispatching model calls. |
| **Non-Deterministic Pricing Drift** | Cost calculations vary due to live API pricing changes over time. | Fix pricing constants per token inside scenario definitions; never query live billing APIs. |
| **Unbounded Repair in Arm C** | Agent C enters an infinite loop trying to fix failing verification checks. | Hardcap repair attempts at exactly 2; transition immediately to `BLOCKED_NEEDS_HUMAN` upon exhaustion. |
| **Git Working Tree Contamination** | Host repo state is altered by benchmark runs. | All arm runs execute strictly inside temporary directories cloned from the canonical commit SHA. |
| **Secret Leakage in Transcripts** | API keys or credentials recorded in raw traces. | Field-aware redaction layer scrubs data before canonical hashing and file sealing. |

---

## 18. Explicit Non-Goals

The following are strictly **out of scope** for M7:
- Real-time web UI or dashboard visualization.
- Multi-threaded or distributed parallel trial execution (sequential single-machine runs only).
- PostgreSQL or external database persistence.
- Multi-provider model routing or failover logic.
- RAG, vector databases, or semantic search.
- Automated statistical significance or hypothesis testing (H1/H2) computation.

---

## 19. Open Questions and Clarifications

1. **Temporary Directory Strategy on Windows:**  
   Temporary directory paths will use Node.js `os.tmpdir()` with sanitized UUID prefixes to avoid Windows path length limitations (`MAX_PATH`).
2. **Upstream Artifact Manifest Source:**  
   `SnapshotLoader` resolves the canonical `ArtifactManifest` directly from the frozen snapshot commit (e.g. `.orchestrate/manifest.json` or scenario fixture).

---

## 20. Definition of Done for M7 Implementation

M7 will be considered complete when:
1. All 13 harness modules are implemented under `packages/benchmark/src/harness/`.
2. All 22 test categories pass deterministically in `npm.cmd test`.
3. Complete trial state machine (`CREATED` through `COMPLETE` / `INVALID`) is verified.
4. Zero regressions in existing 297 unit tests.
5. Strict adherence to TypeScript `strict: true` with zero compiler warnings.
6. Clean Git diff with zero production code changes outside `@orchestrate/benchmark`.
