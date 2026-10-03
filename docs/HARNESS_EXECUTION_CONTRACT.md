# Harness Execution / Treatment Control Contract

**Document Version:** 1.0.0  
**Status:** FROZEN DESIGN SPECIFICATION (M6C — Pre-Implementation)  
**System Target:** Orchestrate Benchmark Evaluation Harness (V1)  
**References:**
- [`docs/EXPERIMENT_PROTOCOL.md`](./EXPERIMENT_PROTOCOL.md) (Protocol, Arm Definitions, Metrics, Data Schema)
- [`docs/TASK_A_SNAPSHOT_CONTRACT.md`](./TASK_A_SNAPSHOT_CONTRACT.md) (Canonical Upstream Snapshot)
- [`docs/EXPERIMENTAL_ARM_ISOLATION.md`](./EXPERIMENTAL_ARM_ISOLATION.md) (Arm Construction, Equality Controls, Isolation)
- [`docs/TRIAL_RUN_CONTRACT.md`](./TRIAL_RUN_CONTRACT.md) (Trial Container, Lifecycle, Failure Taxonomy, Validity)
- [`docs/ARTIFACT_MANIFEST.md`](./ARTIFACT_MANIFEST.md) (Upstream Manifest Specification)
- [`docs/DISCOVERY_MEASUREMENT.md`](./DISCOVERY_MEASUREMENT.md) (Discovery Measurement Contract)

---

## 1. Purpose

This contract defines the normative operational rules, execution controls, and treatment injection mechanics that the future benchmark harness MUST apply when executing downstream Task B across experimental arms.

Its primary purpose is to guarantee **strict experimental control**: any measured difference in downstream metrics (`discovery_actions`, `rework_events`, `time_to_verified_ms`, `repair_attempts`) between `ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, and `ARM_C_ORCHESTRATE` MUST be attributable solely and exclusively to the defined information treatment, and never to confounding execution variations.

---

## 2. Scope

This contract governs the **harness execution phase** of a benchmark trial (corresponding to the `EXECUTING` state in [`docs/TRIAL_RUN_CONTRACT.md §15`](./TRIAL_RUN_CONTRACT.md#L372)). It specifies:
- Construction of starting inputs for Agent B.
- Physical, process, network, and environmental boundaries.
- Model invocation parameters and tool definitions.
- Runtime execution limits.
- Capture of execution, verification, and measurement evidence.
- Pre-execution integrity verification via treatment fingerprints.
- Boundaries separating harness execution failures from agent failures.

This document is a **design specification only**. It contains no production runner code, database persistence logic, or evaluator modifications.

---

## 3. Definitions

- **Harness:** The software engine orchestrating the benchmark experiment (workspace creation, prompt injection, agent execution, telemetry collection, evaluator dispatch).
- **Experimental Arm:** One of three canonical experimental conditions:
  - `ARM_A_BASELINE`
  - `ARM_B_UNVERIFIED_HANDOFF`
  - `ARM_C_ORCHESTRATE`
- **Execution Control:** Any parameter, constraint, tool policy, or environment variable that MUST remain identical across all three arms of a trial.
- **Treatment Block:** The structured information payload injected into Agent B's starting context envelope to represent the experimental variable.
- **Trial Container:** The overall benchmark evaluation unit defined in [`docs/TRIAL_RUN_CONTRACT.md`](./TRIAL_RUN_CONTRACT.md).

---

## 4. Immutable Execution Controls (Identical Across Arms)

To eliminate confounding variables, the harness MUST ensure that the following execution properties are **strictly identical** across all three arms of a trial:

| Control Domain | Parameter / Invariant | Requirement |
| :--- | :--- | :--- |
| **Upstream Baseline** | `snapshot_commit_sha` | Materialized from identical canonical Git commit |
| **Task Prompt** | Task B Prompt Text | Byte-for-byte identical text |
| **Inference Model** | Model Identifier & Version | Identical provider endpoint and model string |
| **Sampling Config** | Configured Sampling Params | Identical configured sampling parameters (e.g. temperature, top_p, max tokens, penalty settings); identical configured seed across arms only if supported and configured |
| **Base Instructions** | System Prompt Base | Byte-for-byte identical instructions (excluding treatment block) |
| **Tool Definitions** | Tool Name, Schema, Description | Identical tool schemas and parameter types |
| **Tool Permissions** | Allowlist & Security Policy | Identical executable allowlist and sandbox scope |
| **Filesystem Base** | Initial Working Tree | Clean working tree matching `snapshot_commit_sha` |
| **Dependencies** | Installed Dependency Tree | Identical lockfile and pre-installed dependencies |
| **Environment** | Sanitized Environment Variables | Identical sanitized environment variable set |
| **Execution Limits** | Timeouts & Step Caps | Identical task timeout, command timeouts, and step limits |
| **Network Policy** | Network Egress Rules | Identical local-only network restriction policy |
| **Harness Version** | Orchestration Code Version | Identical harness runtime and scenario fixture version |

---

## 5. Treatment-Specific Inputs (The Sole Permitted Difference)

The **only** intentional difference permitted between arms is the specific context treatment block injected into Agent B's starting context envelope:

```
                      Canonical Task-B Prompt (Byte-for-Byte Identical)
                                            │
         ┌──────────────────────────────────┼──────────────────────────────────┐
         ▼                                  ▼                                  ▼
  ARM_A_BASELINE                ARM_B_UNVERIFIED_HANDOFF               ARM_C_ORCHESTRATE
  [No Treatment Block]          [<orchestrate_handoff>]                [<orchestrate_context>]
  • Repository only             • Repository                           • Repository
  • Raw filesystem state        • Structured unverified handoff        • Compiled verified state
                                • Claims marked UNVERIFIED             • ContextCompiler output
```

### 5.1 `ARM_A_BASELINE` Input
- **Conceptual Construction:** Task B + repository/workspace only.
- **Receives:**
  - Canonical Task-B prompt text.
  - Workspace filesystem materialized from `snapshot_commit_sha`.
- **Does NOT Receive:**
  - Any treatment block (absent).
  - Any upstream agent claims, notes, or handoffs.
  - Any verification results or Project Brain data.

### 5.2 `ARM_B_UNVERIFIED_HANDOFF` Input
- **Conceptual Construction:** Task B + repository/workspace + `<orchestrate_handoff>...</orchestrate_handoff>`.
- **Receives:**
  - Canonical Task-B prompt text.
  - Workspace filesystem materialized from `snapshot_commit_sha`.
  - Structured unverified handoff block formatted strictly as:
    ```xml
    <orchestrate_handoff>
    ...structured unverified handoff from Task A...
    </orchestrate_handoff>
    ```
- **Rules:**
  - The handoff is explicitly **UNVERIFIED** (untrusted upstream agent claims).
  - No raw Task-A artifacts are added as separate treatment inputs.
  - No verification results (Task A or Task B) may be exposed before or during execution.
  - No compiled Project Brain context is injected.

### 5.3 `ARM_C_ORCHESTRATE` Input
- **Conceptual Construction:** Task B + repository/workspace + `<orchestrate_context>...</orchestrate_context>`.
- **Receives:**
  - Canonical Task-B prompt text.
  - Workspace filesystem materialized from `snapshot_commit_sha`.
  - Compiled verified context block formatted strictly as:
    ```xml
    <orchestrate_context>
    ...compiled verified context from Project Brain...
    </orchestrate_context>
    ```
- **Rules:**
  - Compiled context follows the already-frozen Context Compiler contract ([`packages/compiler`](../packages/compiler)).
  - Context contains strictly verification-backed facts, active decisions, and verified interfaces compiled from Project Brain.
  - The raw Agent A handoff MUST NOT be separately injected.
  - Gated repair may expose verification results and bounded repair (maximum 2 attempts) strictly according to protocol.

---

## 6. Arm Input Construction & Strict Agent Blinding

### 6.1 Context Envelope Assembly
The harness MUST construct the initial payload for Agent B using a deterministic envelope structure:

```text
[Base System Instructions (Identical Across Arms)]

[Optional Arm Treatment Block:
  - ARM_A: (Empty / Omitted)
  - ARM_B: <orchestrate_handoff>...</orchestrate_handoff>
  - ARM_C: <orchestrate_context>...</orchestrate_context>
]

--------------------------------------------------
[User Message: Canonical Task-B Prompt (Byte-for-Byte Identical Across Arms)]
```

### 6.2 Strict Agent Blinding Rules
To prevent observer effects and model bias, the agent MUST NOT receive any metadata identifying the experiment or condition. The harness MUST NEVER inject:
- Arm identifiers (`ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`).
- Trial identifiers or run IDs (`run_id`, `trial_id`).
- Replication index (`replication`).
- Benchmark metric definitions (`discovery_actions`, `rework_events`).
- Evaluator rules, thresholds, or measurement logic.
- Treatment fingerprints or validation hashes.
- Harness internal logs or framing indicating that execution is part of a benchmark.

---

## 7. Execution Lifecycle per Arm

Within the trial's `EXECUTING` lifecycle state, the harness executes each arm through the following sequential phases:

```
[ARMS_READY]
     │
     ▼
1. Workspace Initialization ──► Clone/materialize from snapshot_commit_sha; verify clean status.
     │
     ▼
2. Control Verification     ──► Verify ControlFingerprint match across arms and validate TreatmentFingerprint.
     │
     ▼
3. Input Assembly          ──► Combine base system prompt, arm treatment block, and Task-B prompt.
     │
     ▼
4. Execution Start         ──► Record ISO-8601 UTC start timestamp; set status = RUNNING.
     │
     ▼
5. Autonomous Agent Loop   ──► Dispatch model completions and execute authorized tools.
     │                         Capture events, transcripts, stderr/stdout, and tokens.
     ▼
6. Execution Termination   ──► Record ISO-8601 UTC end timestamp; set terminal execution status
     │                         (COMPLETED, FAILED, or BLOCKED_NEEDS_HUMAN).
     ▼
7. Workspace Finalization  ──► Capture resulting commit or unified diff relative to snapshot.
     │
     ▼
8. Verification Dispatch   ──► Execute independent VerificationEngine suite on final workspace.
     │
     ▼
[EVIDENCE_CAPTURED]
```

### 7.1 Execution Order Randomization
In accordance with [`docs/EXPERIMENT_PROTOCOL.md §3.4`](./EXPERIMENT_PROTOCOL.md#L104), the execution sequence of arms within a replication block MUST be randomized by the harness to neutralize temporal API drift, host load fluctuations, and provider caching.

---

## 8. Workspace & Environment Isolation

### 8.1 Physical Workspace Boundaries
- Each arm MUST execute in a completely isolated filesystem directory.
- The harness MUST enforce physical and lexical workspace containment (`Workspace` invariant):
  - Agent file tools (`read_file`, `write_file`, `list_files`) MUST NOT access or traverse outside the designated workspace root.
  - Path traversal sequences (`../`, symlinks to host paths) MUST be rejected with permission errors.
  - Subprocess execution (`CommandExecutor`) MUST set the subprocess working directory strictly within the assigned workspace.

### 8.2 Environment Variable Sanitization
The harness MUST sanitize the process environment before spawning agent execution or tool subprocesses:
- **Stripped:** Host credentials, cloud tokens, shell history, SSH keys, personal home paths.
- **Allowed:** Minimal required runtime variables (`PATH` restricted to system binaries, `NODE_ENV=test`, runtime engine binaries).
- **Model Credentials:** Handled exclusively by the harness model client; API keys MUST NEVER be exposed as environment variables inside the agent workspace or logged in transcripts.

### 8.3 Network Restrictions
- In accordance with [`docs/EXPERIMENT_PROTOCOL.md §3.5`](./EXPERIMENT_PROTOCOL.md#L106), all scenario fixtures, package dependencies, and verification checks MUST execute locally.
- Subprocess tools MUST NOT initiate outbound network connections (e.g. `npm install`, remote database queries, git push/pull).
- The only network egress permitted is the harness model client communicating with the configured inference endpoint.

---

## 9. Model & Runtime Controls

### 9.1 Model Inference Settings
- **Provider & Model:** Fixed model identifier (e.g. Nebius Token Factory `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`).
- **Sampling & Inference Parameters:** Configured sampling parameters (such as temperature, top_p, max completion tokens, and presence/frequency penalties) MUST be controlled identically across all arms. If an underlying provider/model supports an explicit random seed and one is configured, the identical configured seed MUST be applied across all arms. Seed support is not universally mandated if the provider/model does not expose it, and the harness does not invent an artificial deterministic-generation guarantee.
- **Max Completion Tokens:** Fixed upper bound per model response across all arms.

### 9.2 Tool Registry Controls
- **Tool Allowlist:** The toolset exposed to Agent B MUST be identical across arms:
  - Read tools: `read_file`, `list_files`, `search`, `lookup_symbol`.
  - Mutation tools: `write_file`, `replace_file_content`, `delete_file`.
  - Execution tools: Controlled command execution (`run_command` via allowlisted binaries).
  - Version control tools: Read-only git inspection (`git_status`, `git_diff`, `git_log`).
- **No Arm-Specific Tools:** The harness MUST NOT register special tools in one arm that are absent in another.

---

## 10. Execution Limits

Execution limits prevent runaway execution, resource exhaustion, or infinite loops:

1. **Configured Task Execution Timeout:**  
   Each arm execution is bounded by the scenario-configured task execution timeout. If Agent B does not complete within this duration, the harness MUST terminate execution and mark the arm as `executionStatus = FAILED` with reason `TIMEOUT`.
2. **Maximum Execution Steps:**  
   The agent execution loop is bounded by a fixed maximum step count (e.g. 50 tool invocations). Exceeding this limit forces termination with `FAILED`.
3. **Command Subprocess Timeout:**  
   Every individual tool command execution is bounded by the `CommandExecutor` timeout (default 30 seconds, maximum 120 seconds).
4. **Subprocess Output Buffers:**  
   Stdout and stderr capture per command are bounded at 1 MiB per stream to prevent memory exhaustion.

---

## 11. Evidence Capture Specification

The harness MUST capture three distinct categories of evidence for each arm execution:

```
                                    Arm Execution Output
                                              │
         ┌────────────────────────────────────┼────────────────────────────────────┐
         ▼                                    ▼                                    ▼
1. Execution Evidence               2. Verification Evidence             3. Measurement Evidence
• Monotonic tool event transcript   • Check-by-check pass/fail           • DiscoveryEvaluationReport
• Start / End ISO-8601 timestamps   • Overall suite status               • Upstream ArtifactManifest
• Wall-clock duration (ms)            (VERIFIED / FAILED)                • ReworkEvaluationReport
• Agent stdout / stderr logs        • Failure diagnostics                • Human intervention metrics
• Resulting commit / unified diff   • Repair attempt logs (Arm C)        • Token usage & cost object
• Terminal execution status
```

### 11.1 Monotonic Tool Event Transcript
Every tool invocation by Agent B MUST be captured in chronological order:
- `sequence`: 1-based monotonically increasing integer index ($1, 2, 3, \dots$).
- `toolName`: String name of the tool called.
- `input`: Normalized tool arguments.
- `output`: Result or error string returned to the agent.
- `timestamp`: ISO-8601 UTC timestamp.

### 11.2 Timestamps & Durations
- Start timestamp recorded immediately before the first model call.
- End timestamp recorded immediately upon agent loop termination.
- Wall-clock elapsed duration recorded in milliseconds (`time_to_verified_ms`).

### 11.3 Workspace Diff
The final workspace state MUST be recorded as a Git unified diff relative to `snapshot_commit_sha`.

---

## 12. Token & Cost Telemetry Capture

Token consumption MUST be captured directly from model provider API response headers or payloads:

```json
{
  "input_tokens": 1280,
  "output_tokens": 420,
  "total_tokens": 1700,
  "estimated_cost_usd": 0.0034,
  "usage_available": true
}
```

### 12.1 Telemetry Rules
1. **No Fabrication:** If the inference provider does not supply token metrics, the harness MUST record:
   ```json
   {
     "input_tokens": 0,
     "output_tokens": 0,
     "total_tokens": 0,
     "estimated_cost_usd": 0.0,
     "usage_available": false
   }
   ```
   Token counts must NEVER be estimated or guessed.
2. **Deterministic Pricing:** `estimated_cost_usd` MUST be computed using fixed token pricing constants configured for the scenario, preventing temporal price drift from affecting benchmark metrics.

---

## 13. Integrity & Control Fingerprint Model

The purpose of the fingerprint mechanism is to establish and audit that **A/B/C controls are identical outside the intentional treatment difference**. The fingerprint model serves strictly as an integrity and control verification mechanism; it does not claim to formally prove universal correctness.

To provide clear auditing, the conceptual model strictly separates the **Control Fingerprint** (which MUST match identically across all three arms) from the **Treatment Fingerprint** (which intentionally captures the experimental variable).

### 13.1 Control Fingerprint (Identical Across Arms)

The `ControlFingerprint` captures all invariant dimensions that must not vary between arms:

```typescript
interface ControlFingerprint {
  /** Canonical Task-A snapshot / starting commit SHA. */
  snapshotCommitSha: string;
  /** Hash of canonical Task-B prompt text. */
  taskBPromptHash: string;
  /** Model provider and model version identifier. */
  modelIdentity: string;
  /** Hash of inference configuration (temperature, top_p, max tokens, penalty settings, configured seed if supported). */
  inferenceConfigHash: string;
  /** Hash of base system instructions / configuration. */
  systemInstructionsHash: string;
  /** Hash of tool definitions and schemas. */
  toolDefinitionsHash: string;
  /** Hash of permitted tool permissions and binary allowlist. */
  toolPermissionsHash: string;
  /** Hash of environment/dependency fingerprint (sanitized environment and dependency lockfile state). */
  environmentDependencyFingerprint: string;
  /** Hash of execution limits (task timeout, command timeout, max steps, stream buffer caps). */
  executionLimitsHash: string;
  /** Hash of filesystem policy (workspace root isolation and path traversal restrictions). */
  filesystemPolicyHash: string;
  /** Hash of network policy (local-only restrictions). */
  networkPolicyHash: string;
  /** Harness / runtime version identifier. */
  harnessVersion: string;
  /** Hash of relevant deterministic runtime configuration. */
  runtimeConfigHash: string;
}
```

#### Control Equality Invariant:
$$\text{ControlFingerprint}(\text{Arm A}) == \text{ControlFingerprint}(\text{Arm B}) == \text{ControlFingerprint}(\text{Arm C})$$

Nondeterministic fields (such as wall-clock timestamps, ephemeral process IDs, or dynamic host memory addresses) MUST NEVER be hashed into the control fingerprint.

### 13.2 Treatment Fingerprint (Intentional Experimental Difference)

The `TreatmentFingerprint` captures the exact treatment payload supplied to Agent B for that arm:

```typescript
interface TreatmentFingerprint {
  /** Experimental arm identifier. */
  armId: 'ARM_A_BASELINE' | 'ARM_B_UNVERIFIED_HANDOFF' | 'ARM_C_ORCHESTRATE';
  /** Hash of the exact treatment/context payload supplied to Agent B. */
  treatmentPayloadHash: string;
}
```

#### Treatment Payload Rules:
- For `ARM_A_BASELINE`: `treatmentPayloadHash` is the hash of the empty context (or omitted payload).
- For `ARM_B_UNVERIFIED_HANDOFF`: `treatmentPayloadHash` is the hash of the `<orchestrate_handoff>` envelope containing the unverified Task-A handoff.
- For `ARM_C_ORCHESTRATE`: `treatmentPayloadHash` is the hash of the `<orchestrate_context>` envelope containing the compiled verified state from Project Brain.

### 13.3 Pre-Flight Control Verification Invariant
Prior to initiating downstream execution in any arm, the harness MUST verify:
1. The `ControlFingerprint` is identical across all three arms.
2. Each arm's `TreatmentFingerprint` corresponds strictly to its defined experimental condition.

If any control parameter mismatches across arms, or if an arm's treatment fingerprint violates its condition rule, the harness MUST abort execution and mark the trial as **`INVALID_TRIAL`**.

---

## 14. Failure Taxonomy & Harness Detection

The harness MUST preserve the exact failure taxonomy established in [`docs/TRIAL_RUN_CONTRACT.md §11`](./TRIAL_RUN_CONTRACT.md#L250) without collapsing or redefining its categories:

```
                                  Encountered Error / Non-Passing State
                                                    │
                 ┌──────────────────────────────────┴──────────────────────────────────┐
                 ▼                                                                     ▼
    Experimental Setup / Invariant                                      Agent / Task Lifecycle Event
    (Snapshot, Workspaces, Leaks)                                       (Execution, Verification, Repair)
                 │                                                                     │
                 ▼                                       ┌─────────────────────────────┼─────────────────────────────┐
         [Category A]                                    ▼                             ▼                             ▼
   INFRASTRUCTURE / SETUP FAILURE                  [Category B]                  [Category C]                  [Category D]
                 │                            AGENT EXECUTION FAILURE        VERIFICATION FAILURE             REPAIR FAILURE
                 ▼                                       │                             │                             │
          INVALID_TRIAL                                  ▼                             ▼                             ▼
    (Excluded from primary;                       Arm: FAILED                   Arm: FAILED                  Arm: FAILED / BLOCKED
     retained in audit record)                  (Valid benchmark              (Valid benchmark                 (Valid benchmark
                                                    evidence)                     evidence)                        evidence)
```

### 14.1 Category A: Infrastructure / Setup Failure
- **Definition:** The execution environment, snapshot capture, workspace isolation, or experimental controls were compromised by the harness or host environment.
- **Harness Detection:**
  - Upstream Task-A snapshot unresolvable or missing.
  - Workspace directory creation or initialization failed.
  - Pre-flight `ControlFingerprint` mismatch across arms.
  - Arm treatment fingerprint violation.
  - Cross-arm workspace traversal, file write, or information leakage detected.
  - Harness process crash or failure to record required immutable telemetry.
- **Classification:** **`INVALID_TRIAL`**.
- **Dataset Handling:** `INVALID_TRIAL`; excluded from primary benchmark analysis; retained in the invalid-trial/audit record. No quarantine, reseed, replacement replication, or automatic rerun policy is defined.

### 14.2 Category B: Agent Execution Failure
- **Definition:** Agent B encountered an unrecoverable failure during task execution that was not caused by harness infrastructure.
- **Harness Detection:**
  - AI model provider returned 5xx, 429 rate limit exhaustion, or malformed/unparseable JSON.
  - Configured task execution timeout is exceeded.
  - Agent crashed due to unhandled exception in model-generated code or tool script within permitted sandbox.
  - Agent produced empty or unparseable final completion.
  - Execution step limit exceeded.
- **Classification:** **`Agent Failure`** (Arm execution status = `FAILED`).
- **Dataset Handling:** **Valid benchmark data**. The arm is retained as a failed execution. Does not invalidate the trial.

### 14.3 Category C: Verification Failure
- **Definition:** Agent B completed Task B, but the configured independent `VerificationEngine` checks failed.
- **Harness Detection:**
  - Harness dispatches independent verification suite against final workspace state, and one or more verification checks return failing assertions.
- **Classification:** **`Verification Failure`** (Arm verification status = `FAILED`).
- **Dataset Handling:** **Valid benchmark data**. Directly measures the efficacy of the arm's context treatment.

### 14.4 Category D: Repair Failure
- **Definition:** In Arm C, automated repair ran the maximum allowed attempts (2) without passing verification.
- **Harness Detection:**
  - Harness monitors Arm C repair loop; after attempt 2 fails verification, the repair loop terminates without passing.
- **Classification:** **`Repair Failure`** (Arm verification status = `FAILED`, repair status = `EXHAUSTED`).
- **Dataset Handling:** **Valid benchmark data**. Demonstrates bounded repair termination.

### 14.5 Category E: Human Block
- **Definition:** Execution reached a state where automated progress was impossible without human direction (`BLOCKED_NEEDS_HUMAN`).
- **Harness Detection:**
  - In Arm C, exhaustion of the 2-attempt repair budget transitions task state to `BLOCKED_NEEDS_HUMAN`.
- **Classification:** **`Blocked Needs Human`** (Arm execution status = `BLOCKED_NEEDS_HUMAN`).
- **Dataset Handling:** **Valid benchmark evidence**. Never converted to success or infrastructure failure.

---

## 15. Cross-Arm Leakage Prevention

The harness MUST implement defensive separation to enforce the zero-leakage invariant of [`docs/TRIAL_RUN_CONTRACT.md §14`](./TRIAL_RUN_CONTRACT.md#L351):

1. **Process Separation:** Each arm MUST run in an isolated process context. No global in-memory singletons or caches may bridge arm runs.
2. **Filesystem Segregation:** Arm workspaces MUST reside in separate directories. No arm workspace may be a subdirectory of another arm workspace.
3. **Pre-Computed Contexts:** Treatment blocks for Arms B and C MUST be constructed and frozen before any arm begins Task B. No dynamic context generation may take place during downstream execution.
4. **Verification Isolation:** Verification checks for Arms A and B MUST execute in isolation, writing results strictly to measurement logs without exposing diagnostics to the agent.
5. **Repair Confinement:** In Arm C, automated repair loops MUST operate strictly within Arm C's workspace and memory context.
6. **No-Salvage Trigger:** If any cross-arm file read, tool pipe, or context contamination is detected, the harness MUST immediately abort and mark the trial `INVALID`.

---

## 16. Arm Completion Requirements

An arm CANNOT transition to `COMPLETED` or `FAILED` until the harness confirms that all required evidence artifacts exist and are sealed:
1. `executionStatus` is set to a terminal status (`COMPLETED`, `FAILED`, `BLOCKED_NEEDS_HUMAN`).
2. Complete tool event transcript is saved with monotonically increasing sequence numbers.
3. Start and end timestamps and elapsed wall-clock milliseconds are recorded.
4. Final workspace diff relative to `snapshot_commit_sha` is captured.
5. Independent `VerificationEngine` run is complete and recorded.
6. Deterministic `DiscoveryEvaluationReport` has been generated.
7. Deterministic `ReworkEvaluationReport` has been generated.
8. Token usage object is fully populated.
9. `ControlFingerprint` and `TreatmentFingerprint` are persisted and validated.

Missing any required evidence item constitutes a harness failure and invalidates the trial.

---

## 17. Determinism & Reproducibility Requirements

- **Strict Machine-Readability:** All traces, reports, and logs MUST be serialized as valid, UTF-8 JSON.
- **Pure Evaluation Post-Processing:** Discovery and rework metrics MUST be calculated exclusively by invoking the frozen pure evaluators ([`evaluateDiscovery`](../packages/benchmark/src/discovery/evaluator.ts) and [`evaluateRework`](../packages/benchmark/src/evaluator/evaluator.ts)) over captured traces, never by inline ad-hoc parsing.
- **Audit Traceability:** Every measurement in the final dataset MUST link to its originating `(run_id, arm_id, snapshot_commit_sha)` tuple.

---

## 18. Conceptual TypeScript Data Model

The following types formalize the harness execution interfaces (illustrative contract specification only, no runtime implementation):

```typescript
import type { BenchmarkArmId, ArmExecutionStatus, TokenUsageRecord } from './TRIAL_RUN_CONTRACT.js';

/**
 * Control fingerprint establishing identical conditions across arms.
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
 * Treatment fingerprint capturing the intentional context difference.
 */
export interface TreatmentFingerprint {
  armId: BenchmarkArmId;
  treatmentPayloadHash: string;
}

/**
 * Immutable configuration governing Task B execution across all arms.
 */
export interface HarnessExecutionControls {
  /** Canonical Task-A snapshot commit SHA. */
  snapshotCommitSha: string;

  /** Byte-for-byte identical Task-B prompt text. */
  taskBPromptText: string;

  /** Inference model identifier and endpoint. */
  modelId: string;
  modelEndpoint: string;

  /** Configured sampling parameters. */
  temperature: number;
  maxCompletionTokens: number;
  topP?: number;
  seed?: number;

  /** Base system prompt (identical across arms). */
  baseSystemInstructions: string;

  /** Tool definitions and schemas. */
  toolDefinitions: readonly Record<string, unknown>[];

  /** Permitted executable allowlist. */
  toolPermissions: readonly string[];

  /** Execution timeouts and limits. */
  taskTimeoutMs: number;
  maxSteps: number;
  commandTimeoutMs: number;

  /** Sanitized environment variables. */
  sanitizedEnv: Readonly<Record<string, string>>;
}

/**
 * Treatment envelope prepared for a specific arm.
 */
export interface ArmTreatmentEnvelope {
  armId: BenchmarkArmId;
  treatmentBlock: string; // Empty for Arm A, <orchestrate_handoff> for Arm B, <orchestrate_context> for Arm C
  treatmentBlockSha256: string;
}

/**
 * Discrete tool execution event recorded in transcript.
 */
export interface HarnessToolEvent {
  sequence: number;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
  timestamp: string;
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
```

---

## 19. Explicit Non-Goals

The following areas are explicitly **out of scope** for M6C:
- Writing benchmark runner code, schedulers, or worker pool managers.
- Writing database persistence layers or SQLite storage drivers.
- Introducing new experimental arms or altering existing arm names (`ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`).
- Changing the primary metric definitions (`discovery_actions`, `rework_events`).
- Altering the frozen evaluators (`evaluateDiscovery`, `evaluateRework`).
- Defining trial sampling, replication replacement, or automatic rerun policies.

---

## 20. Consistency & Integrity Review

This contract has been cross-referenced against all previously frozen specifications:

| Checked Document | Verification Finding |
| :--- | :--- |
| [`docs/EXPERIMENT_PROTOCOL.md`](./EXPERIMENT_PROTOCOL.md) | Fully consistent. Preserves hypotheses H1/H2, arm names, blinding (§3.3), and metrics (§5.1). |
| [`docs/TASK_A_SNAPSHOT_CONTRACT.md`](./TASK_A_SNAPSHOT_CONTRACT.md) | Fully consistent. Inherits `snapshot_commit_sha` as the sole canonical starting state. |
| [`docs/EXPERIMENTAL_ARM_ISOLATION.md`](./EXPERIMENTAL_ARM_ISOLATION.md) | Fully consistent. Separates control invariants from treatment differences, preserving context envelopes and equality controls. |
| [`docs/TRIAL_RUN_CONTRACT.md`](./TRIAL_RUN_CONTRACT.md) | Fully consistent. Adheres to trial lifecycle, failure taxonomy (Categories A–E), and `INVALID_TRIAL` rules. |
| [`docs/DISCOVERY_MEASUREMENT.md`](./DISCOVERY_MEASUREMENT.md) | Fully consistent. Transcripts directly provide input events for `evaluateDiscovery()`. |
| [`docs/ARTIFACT_MANIFEST.md`](./ARTIFACT_MANIFEST.md) | Fully consistent. Workspace diffs directly provide input for `evaluateRework()`. |

**Zero contradictions found.**
