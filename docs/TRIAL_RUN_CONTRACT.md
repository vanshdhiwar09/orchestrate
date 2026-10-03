# Trial / Run Contract

**Document Version:** 1.0.0
**Status:** FROZEN DESIGN SPECIFICATION (M6B — Pre-Implementation)
**System Target:** Orchestrate Benchmark Evaluation Harness (V1)
**References:**
- [`docs/EXPERIMENT_PROTOCOL.md`](./EXPERIMENT_PROTOCOL.md) (Protocol, Arm Definitions, Metrics, Data Schema)
- [`docs/TASK_A_SNAPSHOT_CONTRACT.md`](./TASK_A_SNAPSHOT_CONTRACT.md) (Canonical Upstream Snapshot)
- [`docs/EXPERIMENTAL_ARM_ISOLATION.md`](./EXPERIMENTAL_ARM_ISOLATION.md) (Arm Construction, Equality Controls, Isolation)
- [`docs/ARTIFACT_MANIFEST.md`](./ARTIFACT_MANIFEST.md) (Upstream Manifest Specification)
- [`docs/DISCOVERY_MEASUREMENT.md`](./DISCOVERY_MEASUREMENT.md) (Discovery Measurement Contract)
- Rework Evaluator Contract ([`packages/benchmark/src/evaluator/types.ts`](../packages/benchmark/src/evaluator/types.ts))
- Discovery Measurement Evaluator ([`packages/benchmark/src/discovery/types.ts`](../packages/benchmark/src/discovery/types.ts))

---

## 1. What is a Benchmark Trial?

A **benchmark trial** is the complete, closed evaluation unit of the Orchestrate experiment.

### 1.1 Formal Operational Definition
A benchmark trial consists of:
1. **One scenario** (`scenario_id`).
2. **One replication index** (`replication`).
3. **One canonical Task-A snapshot** (`UpstreamSnapshot`) produced by a single execution of Agent A.
4. **Exactly three Task-B arm executions**:
   - `ARM_A_BASELINE` (Repository only)
   - `ARM_B_UNVERIFIED_HANDOFF` (Repository + `<orchestrate_handoff>` [UNVERIFIED])
   - `ARM_C_ORCHESTRATE` (Repository + `<orchestrate_context>` [Compiled verified state])
5. **Independently captured evidence** (execution transcripts, verification outcomes, and evaluators' measurement reports).

The trial compares the three experimental treatments against the **identical frozen upstream state**.

```
                           Scenario (scenario_id) + Replication (replication)
                                                    │
                                                    ▼
                                    Canonical Task-A Snapshot (commitSha)
                                                    │
                   ┌────────────────────────────────┼────────────────────────────────┐
                   ▼                                ▼                                ▼
            ARM_A_BASELINE              ARM_B_UNVERIFIED_HANDOFF             ARM_C_ORCHESTRATE
                   │                                │                                │
           Task B + Repository              Task B + Repository              Task B + Repository
                   │                     + <orchestrate_handoff>          + <orchestrate_context>
                   ▼                                ▼                                ▼
           Execution Evidence               Execution Evidence               Execution Evidence
                   │                                │                                │
                   ▼                                ▼                                ▼
         Verification Evidence            Verification Evidence            Verification Evidence
                   │                                │                                │
                   ▼                                ▼                                ▼
          Measurement Reports              Measurement Reports              Measurement Reports
                   │                                │                                │
                   └────────────────────────────────┼────────────────────────────────┘
                                                    ▼
                                         Unified Trial Record
```

### 1.2 What a Trial is NOT
A trial is **NOT**:
- A single agent invocation.
- A single experimental arm.
- A single verification check run.
- A single repair loop iteration.

Those entities are strictly **components** of an individual arm execution within a trial. A trial evaluates the comparative relationship across all three arms starting from the same upstream foundation.

---

## 2. Trial Identity & Uniqueness Invariants

### 2.1 Identity Tuple
Every trial is immutably identified by the tuple:
$$\text{Trial Identity} = (\text{run\_id}, \text{scenario\_id}, \text{replication}, \text{task\_a\_id}, \text{task\_b\_id}, \text{snapshot\_id}, \text{snapshot\_commit\_sha})$$

| Field | Source / Authority | Invariant & Rules |
| :--- | :--- | :--- |
| `run_id` | Harness-assigned | Globally unique primary identifier of the trial across the entire benchmark dataset. |
| `scenario_id` | [`EXPERIMENT_PROTOCOL.md §7.2`](./EXPERIMENT_PROTOCOL.md#L284) | Scenario identifier (e.g. `sc-auth-api`, `sc-pass-reset`, `sc-data-model`). |
| `replication` | [`EXPERIMENT_PROTOCOL.md §7.2`](./EXPERIMENT_PROTOCOL.md#L284) | 1-based integer index ($1 \le r \le N$). |
| `task_a_id` | Scenario definition | Upstream Task 1 identifier (e.g. `task-auth-middleware`). |
| `task_b_id` | Scenario definition | Downstream Task 2 identifier (e.g. `task-profile-endpoint`). |
| `snapshot_id` | [`TASK_A_SNAPSHOT_CONTRACT.md §2`](./TASK_A_SNAPSHOT_CONTRACT.md#L21) | Canonical Task-A snapshot identifier. |
| `snapshot_commit_sha`| [`TASK_A_SNAPSHOT_CONTRACT.md §2`](./TASK_A_SNAPSHOT_CONTRACT.md#L21) | Full 40-character Git commit hash of the snapshot. |

### 2.2 Uniqueness Invariant
- `run_id` is **globally unique** across all trials in the benchmark dataset.
- Format follows the deterministic convention: `trial-{scenario_id}-r{replication}-{deterministic_seed_or_hash}`.
- Timestamps must **NEVER** serve as entity identity or be used to establish execution order.
- Identifiers must **NEVER** be randomly generated inside pure measurement logic.

### 2.3 Trial Identity vs. Arm Identity
- `run_id` identifies the **entire trial** (the container of all three arms).
- An individual arm execution is identified by the compound key:
  $$(\text{run\_id}, \text{arm\_id})$$
  where `arm_id` is strictly one of `ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, or `ARM_C_ORCHESTRATE`.

---

## 3. Canonical Task-A Snapshot Reference

The trial contract integrates directly with [`docs/TASK_A_SNAPSHOT_CONTRACT.md`](./TASK_A_SNAPSHOT_CONTRACT.md):

1. **Commit as Source of Truth:** The repository state at `snapshot_commit_sha` is the sole canonical source of truth for the upstream baseline. The trial record stores the reference tuple `(snapshot_id, snapshot_commit_sha)`, never a copy of the repository files.
2. **Absolute Starting State Invariant:**
   $$\forall \text{arm} \in \{\text{ARM\_A\_BASELINE}, \text{ARM\_B\_UNVERIFIED\_HANDOFF}, \text{ARM\_C\_ORCHESTRATE}\}: \quad \text{arm.workspace.initial\_commit\_sha} == \text{trial.snapshot\_commit\_sha}$$
   If any arm begins from a different commit SHA or a dirty tree, the invariant fails and the trial transitions immediately to `INVALID_TRIAL`.
3. **Infrastructure Failure Distinction:** If snapshot capture fails, the trial cannot proceed. This is recorded as an `INFRASTRUCTURE / SETUP FAILURE` and is excluded from agent performance metrics.

---

## 4. The Three Arm Records

A valid trial contains **exactly three arm records**, one for each frozen arm identifier:
- `ARM_A_BASELINE`
- `ARM_B_UNVERIFIED_HANDOFF`
- `ARM_C_ORCHESTRATE`

### 4.1 Structural Rules
- **No Duplicate Arms:** A trial MUST NOT contain more than one record for any arm identifier.
- **No Missing Arms:** A trial containing fewer than three completed/recorded arms can **never** become `COMPLETE` or `VALID`.
- **Unified Schema:** All three arms share a single structural record format (`TrialArmRecord`). Arm-specific differences reside entirely in the configured context treatment block and gating policies, not in diverging schemas.

### 4.2 Cross-References per Arm Record
Each arm record contains immutable references linking it to:
1. `run_id` (Parent trial identifier)
2. `arm_id` (Specific experimental arm)
3. `snapshot_id` (Canonical Task-A snapshot identifier)
4. `task_b_id` (Downstream task identifier)
5. `treatmentFingerprint` (Verification of experimental controls)
6. `executionEvidence` (Tool logs, timestamps, agent terminal status)
7. `verificationEvidence` (Independent test run records)
8. `measurementEvidence` (Discovery, Rework, Token usage records)

---

## 5. Arm Treatments & Invariant Context Delivery

Context injection must follow [`docs/EXPERIMENTAL_ARM_ISOLATION.md`](./EXPERIMENTAL_ARM_ISOLATION.md) without variation:

| Arm Identifier | Injected Context Envelope | Content Semantics | Independent Verification Exposed? |
| :--- | :--- | :--- | :--- |
| `ARM_A_BASELINE` | *None* (empty) | Repository filesystem only | **NO** (Strictly withheld) |
| `ARM_B_UNVERIFIED_HANDOFF` | `<orchestrate_handoff>` | Upstream Agent A claims (`UNVERIFIED`) | **NO** (Strictly withheld) |
| `ARM_C_ORCHESTRATE` | `<orchestrate_context>` | ContextCompiler verified facts & decisions | **YES** (Via gated repair protocol) |

### 5.1 Prohibition of Extraneous Channels
- In `ARM_C_ORCHESTRATE`, the raw Agent A handoff must **NOT** be separately injected alongside `<orchestrate_context>`. Arm C tests the compiled verified context treatment in isolation.
- In `ARM_A_BASELINE` and `ARM_B_UNVERIFIED_HANDOFF`, no verification results may be revealed before or during execution.

---

## 6. Treatment Fingerprint & Equality Controls

To guarantee that downstream performance differences stem solely from the information treatment, the trial enforces the equality of all other execution parameters across arms via [`ArmTreatmentFingerprint`](./EXPERIMENTAL_ARM_ISOLATION.md#L62):

$$\text{fingerprint}(\text{arm}) = (\text{prompt\_hash}, \text{model\_id}, \text{config\_hash}, \text{instructions\_hash}, \text{tools\_hash}, \text{permissions\_hash}, \text{limits\_hash}, \text{env\_hash}, \text{treatment\_hash})$$

### 6.1 Equality Invariant
Across all three arms of a trial:
$$\text{hash}_{\text{prompt}}(\text{A}) == \text{hash}_{\text{prompt}}(\text{B}) == \text{hash}_{\text{prompt}}(\text{C})$$
$$\text{model\_id}(\text{A}) == \text{model\_id}(\text{B}) == \text{model\_id}(\text{C})$$
$$\text{hash}_{\text{config}}(\text{A}) == \text{hash}_{\text{config}}(\text{B}) == \text{hash}_{\text{config}}(\text{C})$$
$$\text{hash}_{\text{base\_instructions}}(\text{A}) == \text{hash}_{\text{base\_instructions}}(\text{B}) == \text{hash}_{\text{base\_instructions}}(\text{C})$$
$$\text{hash}_{\text{tools}}(\text{A}) == \text{hash}_{\text{tools}}(\text{B}) == \text{hash}_{\text{tools}}(\text{C})$$
$$\text{hash}_{\text{permissions}}(\text{A}) == \text{hash}_{\text{permissions}}(\text{B}) == \text{hash}_{\text{permissions}}(\text{C})$$
$$\text{hash}_{\text{limits}}(\text{A}) == \text{hash}_{\text{limits}}(\text{B}) == \text{hash}_{\text{limits}}(\text{C})$$
$$\text{hash}_{\text{env}}(\text{A}) == \text{hash}_{\text{env}}(\text{B}) == \text{hash}_{\text{env}}(\text{C})$$

The **only** permitted difference between fingerprints is `treatment_hash` (`treatmentBlockSha256`). Any other difference constitutes an experimental control violation and transitions the trial to `INVALID_TRIAL`.

---

## 7. Task-B Execution Evidence

Each arm executes Task B in a strictly isolated workspace. The arm record must capture or reference:
1. **Execution Status:** Terminal agent state (`COMPLETED`, `FAILED`, `BLOCKED_NEEDS_HUMAN`).
2. **Timing & Duration:** Start time, completion time, wall-clock duration in milliseconds (`time_to_verified_ms`).
3. **Execution Transcript:** Complete chronological list of tool invocation events with integer `sequence` numbers, tool names, parameters, and outputs.
4. **Human Interventions:** Structured log of any operator interactions (`prompt`, `response`, `sequence`).
5. **Final Workspace Commit / Diff:** The resulting Git commit or unified diff relative to `snapshot_commit_sha`.
6. **Agent Terminal Message:** Text or completion message emitted by Agent B upon conclusion.

---

## 8. Verification Evidence

Independent verification checks configured for Task 2 are executed against the final workspace state of **all three arms**.

### 8.1 Verification Concepts
- **Verification Attempt:** A discrete execution of the verification suite by `VerificationEngine`.
- **Verification Result:** The structured outcome containing check-by-check pass/fail statuses.
- **Verification Status:** Categorical result of the suite (`VERIFIED` or `FAILED`).
- **Verification Failures:** Count of failed checks within an attempt.

### 8.2 Invariant Verification Rules
- Verification execution is identical across all arms.
- A failing verification check is **benchmark evidence**, never an infrastructure failure or trial invalidation.
- Verification results are strictly arm-local. Results from Arm A or Arm C must never enter Arm B's context.

---

## 9. Bounded Repair Evidence

In `ARM_C_ORCHESTRATE`, failing verification checks trigger the automated repair loop under the frozen bounds of [`EXPERIMENT_PROTOCOL.md §3.6`](./EXPERIMENT_PROTOCOL.md#L108):
- Maximum of **two automated repair attempts** ($N_{\text{repair}} \le 2$).
- If verification fails after attempt 2, execution transitions to `BLOCKED_NEEDS_HUMAN`.
- Arms A and B execute zero repair attempts ($N_{\text{repair}} = 0$).

### 9.1 Repair Evidence Tracking
The arm record maintains an append-only array of repair attempts:
$$\text{repairAttempts}: [\text{Attempt}_1, \text{Attempt}_2]$$
Each attempt records:
- Input verification failure diagnostic.
- Tool transcript during repair.
- Subsequent verification result.
- Resulting status (`VERIFIED`, `FAILED`, or `BLOCKED_NEEDS_HUMAN`).

Exhausting repair attempts without reaching `VERIFIED` is valid benchmark evidence and does **not** invalidate the trial.

---

## 10. Measurement Evidence Architecture

Measurement evidence is generated by executing the frozen deterministic benchmark evaluators over the arm's captured execution and workspace traces.

```
TrialRecord (run_id)
  └── TrialArmRecord (run_id, arm_id)
        ├── Execution Evidence (Transcript, Timing, Diff)
        ├── Verification Evidence (VerificationAttempts, FinalStatus)
        └── Measurement Evidence:
              ├── DiscoveryEvaluationReport (discovery_actions, qualifyingEvents, suppliedHits)
              ├── Upstream ArtifactManifest (Target files, symbols from Task 1)
              ├── ReworkEvaluationReport (rework_events, events, ambiguous)
              ├── Human Intervention Metric (count & audit log)
              └── Token Usage Telemetry (input_tokens, output_tokens, cost)
```

The Trial Contract references these evidence records by stable identifier or embedded schema; it does **not** redefine the evaluation rules of [`DiscoveryMeasurementEvaluator`](../packages/benchmark/src/discovery/evaluator.ts) or [`ReworkEvaluator`](../packages/benchmark/src/evaluator/evaluator.ts).

---

## 11. Comprehensive Failure Taxonomy

The harness deterministically classifies every error into one of five mutually exclusive categories:

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

### 11.1 Category A: Infrastructure / Setup Failure
- **Definition:** The execution environment, snapshot capture, workspace isolation, or experimental controls were compromised by the harness or host environment.
- **Examples:**
  - Upstream Task-A snapshot failed to capture or commit.
  - Workspace directory creation failed (e.g. disk full, permission denied).
  - Pre-existing files present in workspace (dirty starting state).
  - Dependency or environment fingerprint mismatch across arms.
  - Cross-arm workspace traversal or file modification detected.
  - Information leakage detected across arms.
  - Harness crashed or omitted required immutable telemetry.
- **Classification:** **`INVALID_TRIAL`**.
- **Dataset Handling:** INVALID_TRIAL; excluded from primary benchmark analysis; retained in the invalid-trial/audit record.

### 11.2 Category B: Agent Execution Failure
- **Definition:** Agent B encountered an unrecoverable failure during task execution that was not caused by harness infrastructure.
- **Examples:**
  - AI model provider returned 5xx, 429 rate limit exhaustion, or malformed JSON.
  - The configured execution timeout is exceeded.
  - Agent crashed due to unhandled exception in model-generated script.
  - Agent produced empty or unparseable final completion.
- **Classification:** **`Agent Failure`** (Arm execution status = `FAILED`).
- **Dataset Handling:** **Valid benchmark data**. The arm is retained as a failed execution. Does **not** invalidate the trial.

### 11.3 Category C: Verification Failure
- **Definition:** Agent B completed Task 2, but the configured `VerificationEngine` checks failed.
- **Classification:** **`Verification Failure`** (Arm verification status = `FAILED`).
- **Dataset Handling:** **Valid benchmark data**. Directly measures the efficacy of the arm's context treatment.

### 11.4 Category D: Repair Failure
- **Definition:** In Arm C, automated repair ran the maximum allowed attempts (2) without passing verification.
- **Classification:** **`Repair Failure`** (Arm verification status = `FAILED`, repair status = `EXHAUSTED`).
- **Dataset Handling:** **Valid benchmark data**. Demonstrates bounded repair termination.

### 11.5 Category E: Human Block
- **Definition:** Execution reached a state where automated progress was impossible without human direction (`BLOCKED_NEEDS_HUMAN`).
- **Classification:** **`Blocked Needs Human`**.
- **Dataset Handling:** **Valid benchmark evidence**. Never converted to success or infrastructure failure.

---

## 12. Explicit Trial Validity Rules

A trial is classified as **`VALID`** if and only if **all nine** of the following conditions hold:

1. **Canonical Snapshot Integrity:** Canonical `UpstreamSnapshot` exists, is clean, and its `commitSha` is resolvable.
2. **Snapshot Consistency:** All three arms initialized from the exact same `commitSha`.
3. **Task-B Equality:** Prompts, models, configs, base instructions, tools, permissions, limits, and environments match across all three arms (validated via `ArmTreatmentFingerprint`).
4. **Treatment Fidelity:** Each arm received strictly its defined context envelope and no other.
5. **Physical Isolation:** No arm accessed, modified, or traversed into another arm's workspace.
6. **Cognitive Isolation:** Zero information leaked between arms during the trial.
7. **Complete Arm Triad:** Exactly three arms (`ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`) executed and recorded.
8. **Evidence Completeness:** Transcripts, verification results, and evaluator reports are present for all three arms.
9. **Harness Integrity:** No harness exception or setup failure occurred during orchestration.

### 12.1 The Non-Equivalence Axiom
$$\mathbf{Invalid\ Trial} \quad \neq \quad \mathbf{Failed\ Agent}$$

A trial can be completely **valid** while containing:
- An arm that timed out (`FAILED`).
- An arm whose verification checks failed (`FAILED`).
- An arm that exhausted repair attempts (`FAILED`).
- An arm that halted awaiting human input (`BLOCKED_NEEDS_HUMAN`).

The trial validity assesses the **integrity of the experimental container**. Agent success or failure is the **measurement within that container**.

---

## 13. State Semantics Contrast

The benchmark contract strictly distinguishes four conceptual statuses:

| Status | Domain | Meaning | May Be Benchmark Evidence? |
| :--- | :--- | :--- | :---: |
| **`INVALID`** | Trial Container | Experimental invariants or controls were compromised. | **NO** (Retained in invalid-trial/audit record) |
| **`FAILED`** | Agent / Verification | The agent crashed, timed out, or verification checks failed. | **YES** (Core metric data) |
| **`BLOCKED_NEEDS_HUMAN`**| Task Lifecycle | Autonomous repair ceased after 2 attempts; requires operator. | **YES** (Core metric data) |
| **`VERIFIED`** | Verification Engine | Configured automated verification checks executed and passed. | **YES** (Core metric data) |

> [!CAUTION]
> `VERIFIED` means the configured checks passed. It does **NOT** mean the code is formally, universally, or mathematically proven correct.

---

## 14. Information Leakage Invariants

Information must never cross arm boundaries. If information leakage occurs, the harness must **immediately invalidate the trial**:
$$\text{leakage\_detected} \implies \text{trial.status} = \text{INVALID}$$

### 14.1 Leakage Violations
The following constitute fatal information leaks:
1. **Tool / Transcript Cross-Contamination:** Tool output from one arm is read by, piped to, or used as prompt context in another arm.
2. **Verification Leakage:** Arm A or Arm B receiving Task-A or Task-B verification failure diagnostics.
3. **Human Consultation Leakage:** Operator advice given to Agent B in one arm informing the prompt or execution of another arm.
4. **Workspace Peeking:** An agent inspecting the path, branch, or filesystem contents of another arm's directory.
5. **Dynamic Context Re-Compilation:** Arm C's context being generated from downstream Task-B outputs rather than frozen Task-A snapshot state.

### 14.2 Strict No-Salvage Policy
If leakage is detected:
- The trial is immediately marked `INVALID` with reason `INFORMATION_LEAKAGE`.
- No attempt may be made to "filter out" the contaminated event or salvage the remaining arms.
- The trial is marked INVALID, excluded from primary benchmark analysis, and retained in the invalid-trial/audit record.

---

## 15. Trial Lifecycle State Machine

A trial transitions through a minimal, sequential state machine:

```
                      [START]
                         │
                         ▼
                      CREATED
                         │
                         ▼ (Agent A runs once; snapshot captured)
                  SNAPSHOT_READY
                         │
                         ▼ (Three isolated workspaces & treatments prepared)
                    ARMS_READY
                         │
                         ▼ (Task B runs in all three arms [randomized order])
                     EXECUTING
                         │
                         ▼ (Transcripts, diffs, and tool traces persisted)
                 EVIDENCE_CAPTURED
                         │
                         ▼ (Verification Engine & Evaluators execute)
                      MEASURED
                         │
                         ▼ (All validity invariants confirmed)
                      COMPLETE
                         │
                         ▼
                       [END]
```

### 15.1 The `INVALID` Transition
At **any point** from `CREATED` to `MEASURED`, if an invariant fails, a treatment mismatches, or leakage occurs, the trial immediately branches to:
$$\text{State} \longrightarrow \mathbf{INVALID}$$
This is a terminal state.

### 15.2 Separation of Dimensions
The trial lifecycle state is completely orthogonal to:
- **Arm Execution Status** (`NOT_STARTED`, `RUNNING`, `COMPLETED`, `FAILED`, `BLOCKED_NEEDS_HUMAN`)
- **Verification Status** (`UNVERIFIED`, `VERIFIED`, `FAILED`)
- **Repair Status** (`NONE`, `IN_PROGRESS`, `EXHAUSTED`, `REPAIRED`)

---

## 16. Arm Lifecycle State Machine

Each of the three arms within a trial transitions through its own state machine:

```
                  NOT_STARTED
                       │
                       ▼
                    RUNNING
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
     COMPLETED       FAILED     BLOCKED_NEEDS_HUMAN
```

- **`NOT_STARTED`**: Workspace materialized; awaiting execution.
- **`RUNNING`**: Agent B is actively invoking tools and receiving model completions.
- **`COMPLETED`**: Agent B reached a natural termination, signaling task completion.
- **`FAILED`**: Agent B crashed, timed out, or threw an unrecoverable execution error.
- **`BLOCKED_NEEDS_HUMAN`**: Execution halted requiring human intervention.

An arm transitioning to `FAILED` or `BLOCKED_NEEDS_HUMAN` does **not** cause the parent trial to become `INVALID`.

---

## 17. Immutability & Append-Only Evidence

To guarantee auditability and scientific reproducibility:

### 17.1 Immutable Identity Fields
Once written, the following fields can never be updated:
- `trial.run_id`, `scenario_id`, `replication`, `task_a_id`, `task_b_id`, `snapshot_id`, `snapshot_commit_sha`.
- `arm.run_id`, `arm_id`, `snapshot_id`, `task_b_id`.

### 17.2 Append-Only Evidence Records
- All evidence records (tool event traces, human intervention logs, verification run records, repair attempts) are **append-only**.
- A second verification run or repair attempt does **not** overwrite the prior attempt; it appends `Attempt_2` to the history.
- Telemetry records emitted to persistent storage are sealed with cryptographic hashes.

---

## 18. Auditability & Reproducibility Standard

A completed trial is reproducible if an independent auditor, given only the benchmark dataset, can:
1. Check out the exact starting repository state via `trial.snapshot_commit_sha`.
2. Verify that all three arms started at that identical commit.
3. Verify that all non-treatment controls matched via `treatmentFingerprint`.
4. Re-run `ReworkEvaluator` using the trial's frozen `ArtifactManifest` and the arm's Git diff, producing the identical `rework_events` count.
5. Re-run `DiscoveryMeasurementEvaluator` using the arm's tool event transcript and supplied context envelope, producing the identical `discovery_actions` count.
6. Trace every human intervention, model token count, and verification diagnostic directly to the originating arm.

---

## 19. Contract Relationship Hierarchy

```
┌────────────────────────────────────────────────────────────────────────┐
│                      docs/EXPERIMENT_PROTOCOL.md                       │
│             (Hypotheses H1/H2, Metric Definitions, 3 Arms)             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ governs
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   docs/TASK_A_SNAPSHOT_CONTRACT.md                     │
│         (Canonical Upstream Git Commit, Single Agent A Run)            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ feeds
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 docs/EXPERIMENTAL_ARM_ISOLATION.md                     │
│    (Arm Construction, Task-B Equality Controls, Physical & Cognitive)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ constructs
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      docs/TRIAL_RUN_CONTRACT.md                        │
│         (Trial Container, 3 Arms, Validity, Lifecycle, Taxonomy)       │
└───────┬───────────────────────────┼───────────────────────────┬────────┘
        │ produces                  │ measures                  │ verifies
        ▼                           ▼                           ▼
┌───────────────┐           ┌───────────────┐           ┌───────────────┐
│ Artifact      │           │ Discovery     │           │ Verification  │
│ Manifest &    │           │ Measurement   │           │ Engine Checks │
│ Rework Eval   │           │ Evaluator     │           │ & Telemetry   │
└───────┬───────┘           └───────┬───────┘           └───────┬───────┘
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    ▼
                        Benchmark Run Dataset
```

---

## 20. Conceptual Data Model (TypeScript Specification)

The following TypeScript definitions formalize the contract schema. They serve as the normative design specification for future runner implementations:

```typescript
import type { DiscoveryEvaluationReport } from './discovery/types.js';
import type { ReworkEvaluationReport } from './evaluator/types.js';
import type { ArtifactManifest } from './manifest/types.js';

/**
 * Authoritative Arm Identifiers from EXPERIMENT_PROTOCOL.md.
 */
export type BenchmarkArmId =
  | 'ARM_A_BASELINE'
  | 'ARM_B_UNVERIFIED_HANDOFF'
  | 'ARM_C_ORCHESTRATE';

/**
 * Lifecycle state of the overall trial container.
 */
export type TrialLifecycleState =
  | 'CREATED'
  | 'SNAPSHOT_READY'
  | 'ARMS_READY'
  | 'EXECUTING'
  | 'EVIDENCE_CAPTURED'
  | 'MEASURED'
  | 'COMPLETE'
  | 'INVALID';

/**
 * Execution status of Agent B within an arm.
 */
export type ArmExecutionStatus =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED_NEEDS_HUMAN';

/**
 * Verification outcome status from VerificationEngine.
 */
export type VerificationOutcomeStatus =
  | 'UNVERIFIED'
  | 'VERIFIED'
  | 'FAILED';

/**
 * Reason explaining why a trial was marked INVALID.
 */
export type TrialInvalidationReason =
  | 'SNAPSHOT_CREATION_FAILED'
  | 'SNAPSHOT_COMMIT_UNRESOLVABLE'
  | 'STARTING_COMMIT_MISMATCH'
  | 'TREATMENT_FINGERPRINT_MISMATCH'
  | 'UNINTENDED_CONTEXT_INJECTION'
  | 'CROSS_ARM_WORKSPACE_ACCESS'
  | 'INFORMATION_LEAKAGE'
  | 'MISSING_ARM_RECORD'
  | 'MISSING_REQUIRED_EVIDENCE'
  | 'HARNESS_INTERNAL_ERROR';

/**
 * Audit record of an operator interaction.
 */
export interface HumanInterventionRecord {
  sequence: number;
  prompt: string;
  response: string;
  timestamp: string;
}

/**
 * Telemetry record of token consumption.
 */
export interface TokenUsageRecord {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  usage_available: boolean;
}

/**
 * Discrete record of an automated repair loop attempt.
 */
export interface RepairAttemptRecord {
  attemptNumber: number; // 1 or 2
  diagnosticSummary: string;
  transcriptRef: string;
  verificationStatus: VerificationOutcomeStatus;
  passed: boolean;
}

/**
 * Verification record for an arm.
 */
export interface ArmVerificationRecord {
  attempts: number;
  failures: number;
  finalStatus: VerificationOutcomeStatus;
  checkDetailsRef?: string;
  repairAttempts: RepairAttemptRecord[];
}

/**
 * Complete execution and measurement record for one arm.
 */
export interface TrialArmRecord {
  /** Parent trial identifier. */
  run_id: string;

  /** Experimental arm identifier. */
  arm_id: BenchmarkArmId;

  /** Canonical snapshot identifier. */
  snapshot_id: string;

  /** Downstream task identifier. */
  task_b_id: string;

  /** Status of Agent B execution. */
  executionStatus: ArmExecutionStatus;

  /** Execution controls fingerprint validating experimental equality. */
  treatmentFingerprint: {
    snapshotId: string;
    commitSha: string;
    taskBPromptSha256: string;
    modelId: string;
    modelConfigSha256: string;
    baseSystemInstructionsSha256: string;
    toolDefinitionsSha256: string;
    toolPermissionsSha256: string;
    executionLimitsSha256: string;
    dependencyStateSha256: string;
    environmentSha256: string;
    treatmentBlockSha256: string;
  };

  /** Wall-clock execution duration in milliseconds. */
  time_to_verified_ms: number;

  /** Human intervention events count. */
  human_interventions: number;
  human_interventions_log: HumanInterventionRecord[];

  /** Token usage statistics. */
  usage: TokenUsageRecord;

  /** Verification Engine outcomes. */
  verification: ArmVerificationRecord;

  /** Rework evaluation report. */
  reworkReport?: ReworkEvaluationReport;

  /** Discovery measurement report. */
  discoveryReport?: DiscoveryEvaluationReport;

  /** Resulting workspace commit SHA. */
  resultingCommitSha?: string;
}

/**
 * Top-level container representing ONE complete benchmark trial.
 */
export interface TrialRecord {
  /** Globally unique trial identifier across the benchmark dataset. */
  run_id: string;

  /** Scenario identifier. */
  scenario_id: string;

  /** Replication index (1..N). */
  replication: number;

  /** Upstream Task 1 identifier. */
  task_a_id: string;

  /** Downstream Task 2 identifier. */
  task_b_id: string;

  /** Canonical Task-A snapshot identifier. */
  snapshot_id: string;

  /** Canonical Task-A snapshot Git commit SHA. */
  snapshot_commit_sha: string;

  /** High-level lifecycle state. */
  lifecycleState: TrialLifecycleState;

  /** Explicit validity flag. */
  isValid: boolean;

  /** Reason if marked invalid. */
  invalidationReason?: TrialInvalidationReason;
  invalidationDetails?: string;

  /** Exactly three arm records. */
  arms: {
    ARM_A_BASELINE: TrialArmRecord;
    ARM_B_UNVERIFIED_HANDOFF: TrialArmRecord;
    ARM_C_ORCHESTRATE: TrialArmRecord;
  };

  /** Associated Task-A ArtifactManifest reference. */
  upstreamManifest?: ArtifactManifest;
}
```

---

## 21. Non-Goals

The following components are explicitly **out of scope** for this contract and must not be implemented under M6B:
- Benchmark runner execution engines or CLI schedulers.
- Database schemas, SQLite tables, or ORM mappings.
- Model routing, inference orchestration, or prompt compilation engines.
- Statistical hypothesis testing, ANOVA scripts, or p-value calculators.
- Production TypeScript implementations of runner classes.

---

## 22. Design Review & Freeze Verification

The following ten questions have been rigorously evaluated against this specification:

| # | Design Verification Question | Contract Verification Finding | Section Reference |
|---|---|---|---|
| 1 | **Can one trial be uniquely identified?** | **YES.** `run_id` is globally unique; composite tuple `(scenario_id, replication, snapshot_commit_sha)` is deterministic. | §2.1, §2.2 |
| 2 | **Can all three arms be reconstructed?** | **YES.** `TrialRecord.arms` strictly contains `ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, and `ARM_C_ORCHESTRATE`. | §4, §20 |
| 3 | **Can we prove all arms started from the same snapshot?** | **YES.** Starting commit invariant enforces `arm.workspace.initial_commit_sha == trial.snapshot_commit_sha`. | §3, §6 |
| 4 | **Can we distinguish invalid trial from failed agent?** | **YES.** `INVALID` is container-level validity; `FAILED` is agent/task-level evidence. Explicit axiom: $\text{Invalid Trial} \neq \text{Failed Agent}$. | §11, §12, §13 |
| 5 | **Can we distinguish verification failure from agent failure?** | **YES.** Captured in separate dimensions: `executionStatus` (`COMPLETED`/`FAILED`) vs `verification.finalStatus` (`VERIFIED`/`FAILED`). | §8, §11, §13 |
| 6 | **Can we identify every repair attempt?** | **YES.** Recorded in append-only `repairAttempts` array with diagnostics and outcomes. | §9, §20 |
| 7 | **Can we detect treatment mismatch?** | **YES.** `treatmentFingerprint` hashes all execution controls; differences outside `treatmentBlockSha256` trigger `INVALID_TRIAL`. | §6 |
| 8 | **Can we detect information leakage?** | **YES.** Concrete leakage violations trigger immediate irreversible transition to `INVALID` with strict no-salvage rule. | §14 |
| 9 | **Can every metric trace back to an arm and trial?** | **YES.** Hierarchical references `Trial (run_id) -> Arm (run_id, arm_id) -> Evidence` bind all metrics. | §10, §20 |
| 10 | **Can an auditor reconstruct the trial later?** | **YES.** Retained Git commit SHA, immutable transcripts, evaluator reports, and fingerprints enable 100% deterministic reconstruction. | §18 |
