# Orchestrate Benchmark Experiment Protocol

**Document Version:** 1.0.0  
**Status:** FROZEN PROTOCOL SPECIFICATION (Pre-Implementation)  
**System Target:** Orchestrate Hackathon MVP Evaluation  

---

## 1. Research Purpose & Hypotheses

### 1.1 Primary Research Question
Does structured, verification-backed project state reduce context rediscovery and downstream rework for coding agents working sequentially on the same repository compared with repository-only context and equivalent but unverified handoffs?

### 1.2 Formal Hypotheses
- **Hypothesis 1 (H1 — Context Rediscovery & Rework Reduction):**  
  Coding agents working sequentially on the same repository will require less context rediscovery and rework when subsequent agents receive structured, verification-backed project state compared with repository-only context.
- **Hypothesis 2 (H2 — Error Propagation Suppression via Verification Gating):**  
  Verification-gated handoffs will reduce propagation of incorrect upstream claims and downstream repair/rework compared with equivalent handoffs that are not verification-gated.

---

## 2. Experimental Arms

The trial evaluates exactly three experimental arms.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Upstream Execution (Task 1 / Agent A)                                       │
│ [Frozen once per scenario-replication and cloned identically to all arms]   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       ▼                               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐ ┌─────────────────────────────┐
│ ARM A (BASELINE)            │ │ ARM B (UNVERIFIED HANDOFF)  │ │ ARM C (ORCHESTRATE)         │
├─────────────────────────────┤ ├─────────────────────────────┤ ├─────────────────────────────┤
│ • Repository / Workspace    │ │ • Repository / Workspace    │ │ • Repository / Workspace    │
│ • Task 2 Prompt             │ │ • Task 2 Prompt             │ │ • Task 2 Prompt             │
│ • NO structured handoff     │ │ • Structured Handoff        │ │ • Compiled Verified Context │
│                             │ │   (Claims Unverified)       │ │   (Project Brain facts,     │
│                             │ │ • NO verification exposed   │ │    decisions, verified work)│
│                             │ │                             │ │ • Verification Gating/Repair│
└──────────────┬──────────────┘ └──────────────┬──────────────┘ └──────────────┬──────────────┘
               │                               │                               │
               ▼                               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐ ┌─────────────────────────────┐
│ Agent B Executes Task 2     │ │ Agent B Executes Task 2     │ │ Agent B Executes Task 2     │
└──────────────┬──────────────┘ └──────────────┬──────────────┘ └──────────────┬──────────────┘
               │                               │                               │
               └───────────────────────┬───────┴───────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Independent Verification Engine (Universal Post-Execution Measurement)      │
│ [All 3 arms measured identically with full instrumentation]                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 `ARM_A_BASELINE` (Repository-Only Baseline)
- **Agent A**: Performs Task 1 in the isolated workspace.
- **Agent B**: Receives only the modified workspace filesystem (the raw Git repository) and the Task 2 prompt.
- **Handoff**: None. Agent B receives no structured handoff, no Project Brain data, and no upstream agent claims.
- **Verification Exposure**: No verification results are provided to Agent B.

### 2.2 `ARM_B_UNVERIFIED_HANDOFF` (Structured, Unverified Handoff)
- **Agent A**: Performs Task 1 in the isolated workspace.
- **Handoff Generation**: A structured handoff document (summary, affected files, claimed changes, decisions, assumptions) is constructed from Agent A's output.
- **Presentation Format**: To eliminate syntactic and formatting differences as an experimental confound, Arm B presents the handoff within the same XML-style envelope family as Arm C:
  ```xml
  <orchestrate_handoff>
    ...structured unverified handoff...
  </orchestrate_handoff>
  ```
  The contents and semantics remain strictly unverified.
- **Verification Exposure**: No independent verification checks are executed on Task 1, or if run for benchmark telemetry, results are strictly withheld from Agent B. All claims remain unverified (`CLAIMED` / `UNVERIFIED`).
- **Agent B**: Receives the workspace, the unverified structured handoff document inside `<orchestrate_handoff>`, and the Task 2 prompt.

### 2.3 `ARM_C_ORCHESTRATE` (Verification-Gated Orchestration)
- **Agent A**: Performs Task 1 in the isolated workspace.
- **Verification & Brain Persistence**: Independent `VerificationEngine` checks execute against Task 1 output. Only verified state enters `Project Brain`.
- **Context Compilation**: The `ContextCompiler` selects relevant verified facts, active decisions, and upstream verified outcomes according to deterministic relevance rules.
- **Presentation Format**: Arm C delivers compiled context using the canonical envelope:
  ```xml
  <orchestrate_context>
    ...compiled verified context...
  </orchestrate_context>
  ```
- **Agent B**: Receives the workspace, the compiled verified context inside `<orchestrate_context>`, and the Task 2 prompt.
- **Gating & Repair**: If upstream verification fails, verification gating initiates automated repair (up to 2 attempts) or transitions to `BLOCKED_NEEDS_HUMAN`. Agent B only receives verification-backed state.

### 2.4 Critical Measurement Invariant
All three arms are evaluated by the **same independent VerificationEngine checks** after Agent B completes Task 2.  
Measurement instrumentation must be identical across all arms. The only parameter that differs between arms is the context and gating provided to Agent B.

---

## 3. Experimental Controls & Invariants

1. **Frozen Upstream Execution (Agent A Replay):**  
   Agent A runs once per scenario replication. The resulting workspace state, commit, and agent output are frozen and cloned identically across Arm A, Arm B, and Arm C. Differences in downstream performance cannot be attributed to variation in Agent A.
2. **Byte-for-Byte Identical Downstream Prompts:**  
   The Task 2 prompt provided to Agent B is byte-for-byte identical across all three arms. Context is delivered strictly through standard context injection channels (system prompt or configured context block) without altering the task instruction.
3. **Downstream Blinding:**  
   Agent B does not receive any metadata or token indicating which experimental arm it is executing (`ARM_A`, `ARM_B`, or `ARM_C`).
4. **Execution Order Randomization:**  
   The execution sequence of arms within a replication block is randomized to control for temporal API drift, rate limiting, or network variations.
5. **Deterministic Local Fixtures:**  
   All scenario repositories, dependencies, and verification suites reside locally. No network calls (e.g., package registry downloads, external database queries) are permitted during task execution or verification.
6. **Bounded Repair Policy:**  
   In Arm C, automated repair is capped at a maximum of **two repair attempts**. If verification still fails after two repair attempts, the run transitions to `BLOCKED_NEEDS_HUMAN`.
7. **Token Measurement Discipline:**  
   Token usage is recorded directly from model provider telemetry. If the model provider does not return token usage, `usage_available` must be recorded as `false`. Token counts must never be inferred or fabricated.
8. **Human Intervention Logging:**  
   Any human intervention required to proceed must be explicitly recorded with reason, timestamp, and step.
9. **Pilot Run Exclusion:**  
   All exploratory pilot runs are quarantined and excluded from the primary evaluation dataset.

---

## 4. Trust State Semantics

The evaluation adheres to the exact Project Brain trust state hierarchy:

```
CODE (Authoritative)
  ↓
VERIFICATION EVIDENCE
  ↓
PROJECT BRAIN
  ↓
AGENT CLAIMS (Untrusted)
```

### 4.1 States
- **`CLAIMED`**: An agent reported that an outcome was achieved; independent verification has not evaluated it.
- **`UNVERIFIED`**: A recorded entity or fact exists, but no valid passing verification record currently establishes it.
- **`VERIFIED`**: Configured verification checks were executed and all passed.
- **`FAILED`**: Configured verification checks were executed and at least one check failed.
- **`BLOCKED_NEEDS_HUMAN`**: Automated execution or bounded repair ceased and requires operator intervention.

### 4.2 Canonical Verification Statement
> *"VERIFIED means the configured checks passed, not that the code is proven correct."*

---

## 5. Metrics Specification

### 5.1 Primary Metrics

| Metric | Identifier | Definition & Measurement Method |
| :--- | :--- | :--- |
| **Discovery Actions** | `discovery_actions` | Absolute count of exploratory tool calls (`read_file`, directory listing, search, git query) issued by Agent B targeting code/architecture information not supplied in its initial context. |
| **Rework Events** | `rework_events` | Downstream edits by Agent B that modify, replace, or substantially rewrite established upstream artifacts from Task 1's frozen manifest. |
| **Human Interventions** | `human_interventions` | Number of operator prompts, parameter injections, or manual adjustments required to unblock execution. |
| **Verification Attempts** | `verification_attempts` | Total count of verification suite invocations during Agent B's task lifecycle. |
| **Verification Failures** | `verification_failures` | Total count of verification runs where one or more checks failed. |
| **Repair Attempts** | `repair_attempts` | Count of autonomous repair loops executed following verification failure (maximum 2 allowed in Arm C; 0 in Arm A/B). |
| **Time to Verified** | `time_to_verified_ms` | Elapsed wall-clock time in milliseconds from Agent B task invocation to passing verification (`VERIFIED`). If execution terminates in failure, records total duration with `verification_status: FAILED`. |
| **Token Usage** | `usage` | Structured object containing `input_tokens`, `output_tokens`, `total_tokens`, `estimated_cost_usd`, and `usage_available` flag. |

### 5.2 Discovery Measurement Contract (V1 Deterministic Rule)
For V1, discovery actions are evaluated deterministically against structured supplied context references (see [`docs/DISCOVERY_MEASUREMENT.md`](file:///c:/Users/VANSH/OneDrive/Desktop/orchestrate/docs/DISCOVERY_MEASUREMENT.md)):

1. **Operational Definition:**
   A discovery action is a tool invocation by Agent B that retrieves repository/project information that was not already explicitly available in the context supplied to Agent B prior to task execution. The primary metric is `discovery_actions`, representing the absolute count of qualifying discovery events.
2. **Qualifying Categories & Exact Targets:**
   - `FILE_READ` (`read_file`): target is normalized repository-relative file path.
   - `FILE_LIST` (`list_files`): target is normalized repository-relative directory path ending with `/`.
   - `SEARCH` (`search`/`grep`): target is exact search term string.
   - `SYMBOL_LOOKUP` (`lookup_symbol`): target is exact symbol identifier name.
   - `GIT_STATE` (`git_status`): canonical state identifier (`"status"`).
   - `GIT_HISTORY` (`git_log`): target commit/log ref (`"HEAD"` or `""`).
   - `GIT_DIFF` (`git_diff`): target diff ref or path specifier (`""` or `"HEAD"`).
3. **Strict Exclusions:**
   `write_file`, `delete_file`, `run_command` (compilers/execution), `run_tests`, `build`, `typecheck`, `lint`, and `commit` never qualify as discovery.
4. **Duplicate Counting:**
   Every qualifying retrieval invocation counts separately (e.g. 3 reads of the same unsupplied file = 3 discovery actions). The metric measures exploration actions and rediscovery overhead, not unique knowledge items.
5. **Exact Type-Aware Context Exemption:**
   Context exemption is exact and type-aware. The evaluator MUST NOT infer that one supplied context reference semantically covers another retrieval target:
   - `FILE: path` exempts only `FILE_READ` of that exact path.
   - `DIRECTORY: dir/` exempts only `FILE_LIST` of that exact directory. (Supplying `FILE: src/auth.ts` does NOT exempt `list_files("src/")`).
   - `SYMBOL: name` exempts only `SYMBOL_LOOKUP` of `name` or exact `SEARCH` of `name`. (Does not exempt natural language searches).
   - Git operations (`GIT_STATE`, `GIT_HISTORY`, `GIT_DIFF`) are exempt ONLY when matching Git context was explicitly supplied.
6. **Arm Blindness:**
   The discovery evaluator operates purely on tool execution events and supplied context references; it does not use arm-specific branching or encode H1/H2 assumptions.
7. **Human Intervention Distinction:**
   If Agent B requests project information from an operator, it increments `human_interventions`, never `discovery_actions`.
8. **Ambiguity / Unknown Tools:**
   Unknown tools or invocations that cannot be deterministically classified are recorded in `unclassified` and strictly excluded from `discovery_actions`.

### 5.3 Measurement Criteria for Rework (V1 Deterministic Manifest)
For V1, rework is evaluated strictly against a **frozen upstream artifact manifest**:

1. **Frozen Upstream Manifest:**  
   For each Task 1 execution, the harness records an immutable manifest containing:
   - Target files produced or modified by Agent A (paths relative to workspace root).
   - Relevant symbols, functions, routes, schemas, or interfaces established by Task 1.
2. **Rework Event Qualification:**  
   A downstream edit counts as a rework event only when Agent B modifies, replaces, or substantially rewrites an upstream artifact that was already established by Task 1.
3. **AST Deferral:**  
   Do not introduce AST infrastructure yet. Evaluation in V1 uses file and symbol manifest containment from the frozen upstream record.
4. **Ambiguity Handling:**  
   If an edit or artifact cannot be classified deterministically against the frozen manifest, mark the classification as unresolved (`UNRESOLVED_AMBIGUOUS_REWORK`) rather than inventing an ad-hoc judgment.

---

## 6. Scenario Definitions

### Scenario 1: `auth-protected-api`
- **Initial Repository State:** Minimal Express/Fastify TypeScript HTTP service with basic configuration and user fixture.
- **Task 1 (Agent A):** Implement authentication token verification middleware (`src/middleware/auth.ts`) that validates Bearer JWT tokens and attaches `req.user`.
- **Expected Upstream Outcome:** Middleware exported and tested with unit tests passing.
- **Task 2 (Agent B):** Implement a protected route `/api/profile` that uses the authentication middleware to return the authenticated user's profile.
- **Dependency Relationship:** Task 2 requires importing and correctly applying the middleware created in Task 1.
- **Verification Plan:**
  1. `npm run typecheck` passes.
  2. Integration test sends request with valid token and receives `200 OK` with user profile.
  3. Integration test sends request with missing/invalid token and receives `401 Unauthorized`.
- **Discovery Target for Agent B:** Location of `auth.ts`, export name, token format, attached request property name (`user` vs `currentUser` vs `auth`).
- **Rework Target:** Agent B re-implementing an ad-hoc token validator in the route handler instead of using `auth.ts`.

### Scenario 2: `auth-password-reset`
- **Initial Repository State:** Repository with User entity and in-memory or SQLite database layer.
- **Task 1 (Agent A):** Implement password reset token generator and storage schema (`src/services/password-reset.ts`) with expiry semantics.
- **Expected Upstream Outcome:** Service exported, persisting reset tokens with timestamp validation.
- **Task 2 (Agent B):** Implement the password reset confirmation endpoint `POST /api/auth/reset-password` accepting token and new password.
- **Dependency Relationship:** Task 2 depends on consuming Task 1's validation service and hashing interface.
- **Verification Plan:**
  1. Unit tests verifying password reset flow.
  2. Expired token rejection test.
  3. Successful password update and authentication check with new password.
- **Discovery Target for Agent B:** Token expiration interval, hashing algorithm, service function signatures.
- **Rework Target:** Agent B writing a custom token check query that bypasses the reset service methods.

### Scenario 3: `data-model-feature`
- **Initial Repository State:** TypeScript repository with structured repository pattern for entities.
- **Task 1 (Agent A):** Define a `Project` entity schema and database repository interface (`src/data/project-repository.ts`).
- **Expected Upstream Outcome:** Repository class with `findById`, `create`, and `update` methods.
- **Task 2 (Agent B):** Implement a `ProjectSummaryService` that calculates project completion percentages and status badges.
- **Dependency Relationship:** Task 2 must consume the repository abstraction from Task 1.
- **Verification Plan:**
  1. Unit tests validating summary calculations against mocked repository methods.
  2. End-to-end service test against local database.
- **Discovery Target for Agent B:** Exact fields on `Project` interface, error handling on `findById` (returns `null` vs throws).
- **Rework Target:** Agent B modifying the `Project` entity fields or bypassing `project-repository.ts` with direct DB calls.

### Scenario 4 (H2 Fault-Injection Scenario Only): `faulty-auth-contract`

> [!IMPORTANT]
> **Hypothesis Partitioning & Contamination Prevention:**  
> - **Primary H1 Comparison**: Evaluated strictly on clean upstream scenarios (Scenarios 1, 2, and 3) where upstream output is valid.  
> - **H2 Fault-Injection**: Scenario 4 is dedicated exclusively to evaluating Hypothesis 2 (suppression of defective upstream claim propagation).  
> - **Contamination Guard**: Scenario 4 runs must NEVER be pooled into primary H1 context rediscovery/rework metrics.

- **Hypothesis Distinction:**
  - **H1**: Measures context rediscovery and rework under clean upstream state.
  - **H2**: Measures propagation of deliberately introduced upstream defects under verification gating.
- **Intervention Difference:**
  - In Scenarios 1–3, downstream starting code is frozen identically across all arms.
  - In Scenario 4, Arm C intentionally allows a different downstream state after verification gating/repair because that state difference **IS the intervention being tested for H2**.
- **Task 1 (Agent A):** Instructed to implement JWT middleware, but Agent A produces code with an inverted check (e.g., permits invalid tokens or throws unhandled error) while claiming in its handoff that the middleware is complete and verified.
- **Arm Behavior:**
  - **Arm A & Arm B**: Agent B receives the broken code (and in Arm B, the false unverified claim of success). Evaluates whether defect propagates into downstream failure/rework.
  - **Arm C**: Independent verification catches the Task 1 defect immediately. Verification gating triggers bounded repair (up to 2 attempts) or marks `BLOCKED_NEEDS_HUMAN`, preventing Agent B from building atop an unverified upstream defect.

---

## 7. Trial Design & Sample Size

> [!NOTE]
> A formal statistical power calculation has not yet been performed for this milestone. The sample sizes specified below reflect structural replication minimums for the experimental block design; they do not imply or assert formal statistical power.

### 7.1 Sample Sizes
- **Pilot Trial (Harness Stabilization Only):**  
  `1 scenario × 3 arms × 1 replication = 3 runs`  
  *Rule: Pilot data is strictly quarantined from primary analysis.*
- **Primary Minimum Design (Clean H1 Scenarios):**  
  `3 scenarios × 3 arms × 3 replications = 27 runs`
- **Preferred Full Design:**  
  `5 scenarios × 3 arms × 3 replications = 45 runs`

### 7.2 Run Identification Convention
- `run_id`: Format `run-{scenario_id}-{arm_id}-r{replication}-{timestamp}`
- `scenario_id`: Format `sc-auth-api`, `sc-pass-reset`, `sc-data-model`, `sc-faulty-auth`
- `arm_id`: Exactly one of `ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`
- `replication`: Integer index `1..N`

---

## 8. Data Schema

The benchmark harness will record each run as a validated JSON record adhering to this schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BenchmarkRunRecord",
  "type": "object",
  "required": [
    "run_id",
    "scenario_id",
    "arm",
    "replication",
    "task_a_id",
    "task_b_id",
    "verification_status",
    "discovery_actions",
    "rework_events",
    "human_interventions",
    "verification_attempts",
    "verification_failures",
    "repair_attempts",
    "time_to_verified_ms",
    "usage"
  ],
  "properties": {
    "run_id": { "type": "string" },
    "scenario_id": { "type": "string" },
    "arm": { "enum": ["ARM_A_BASELINE", "ARM_B_UNVERIFIED_HANDOFF", "ARM_C_ORCHESTRATE"] },
    "replication": { "type": "integer", "minimum": 1 },
    "task_a_id": { "type": "string" },
    "task_b_id": { "type": "string" },
    "verification_status": { "enum": ["VERIFIED", "FAILED", "BLOCKED_NEEDS_HUMAN"] },
    "discovery_actions": { "type": "integer", "minimum": 0 },
    "rework_events": { "type": "integer", "minimum": 0 },
    "human_interventions": { "type": "integer", "minimum": 0 },
    "verification_attempts": { "type": "integer", "minimum": 0 },
    "verification_failures": { "type": "integer", "minimum": 0 },
    "repair_attempts": { "type": "integer", "minimum": 0, "maximum": 2 },
    "time_to_verified_ms": { "type": "number", "minimum": 0 },
    "usage": {
      "type": "object",
      "required": ["input_tokens", "output_tokens", "total_tokens", "estimated_cost_usd", "usage_available"],
      "properties": {
        "input_tokens": { "type": "integer", "minimum": 0 },
        "output_tokens": { "type": "integer", "minimum": 0 },
        "total_tokens": { "type": "integer", "minimum": 0 },
        "estimated_cost_usd": { "type": "number", "minimum": 0 },
        "usage_available": { "type": "boolean" }
      }
    }
  }
}
```

### 8.1 Example Valid Run Record
```json
{
  "run_id": "run-sc-auth-api-ARM_C_ORCHESTRATE-r1-1790841000000",
  "scenario_id": "sc-auth-api",
  "arm": "ARM_C_ORCHESTRATE",
  "replication": 1,
  "task_a_id": "task-auth-middleware",
  "task_b_id": "task-profile-endpoint",
  "verification_status": "VERIFIED",
  "discovery_actions": 1,
  "rework_events": 0,
  "human_interventions": 0,
  "verification_attempts": 1,
  "verification_failures": 0,
  "repair_attempts": 0,
  "time_to_verified_ms": 14250,
  "usage": {
    "input_tokens": 1280,
    "output_tokens": 420,
    "total_tokens": 1700,
    "estimated_cost_usd": 0.0034,
    "usage_available": true
  }
}
```

---

## 9. Failure Handling & Exclusion Criteria

1. **Infrastructure Faults:**  
   If a run fails due to provider network unavailability, host disk exhaustion, or harness crash, the run is marked `INVALID_INFRASTRUCTURE_FAILURE` and re-executed under a fresh replication seed. It is not recorded as an agent failure.
2. **Missing Token Telemetry:**  
   If the inference endpoint omits token counts, `usage_available` is recorded as `false` and token counts are recorded as `0`. They are excluded from token-efficiency aggregations but retained for discovery and rework metrics.
3. **Run Timeout:**  
   Each task execution is constrained by a 10-minute timeout. Runs exceeding the timeout are classified as `FAILED` with `timeout: true`.

---

## 10. Result Interpretation Matrix

Data collected will be evaluated against pre-registered outcome patterns without bias:

| Observed Pattern | Hypothesized Meaning |
| :--- | :--- |
| **$B < A$ and $C \approx B$** | Structured context accounts for most of the reduction in rediscovery; verification provides minimal additional discovery benefit for clean code. |
| **$B < A$ and $C < B$** | Both structured context and independent verification contribute additively to reducing discovery and rework. |
| **$A \approx B > C$** | Independent verification is the primary operative mechanism; unverified handoffs fail to prevent rework. |
| **$A \approx B \approx C$** | The hypothesized mechanisms produce no measurable effect under the tested conditions. |

*Note: No experimental outcome or advantage will be claimed until data is collected and statistically evaluated.*

---

## 11. Remaining Unresolved Design Questions

The following implementation details remain open prior to coding the harness:

1. **Frozen Upstream Manifest Schema:**  
   The exact structure and recording mechanism for Task 1's frozen upstream manifest (file paths and exported symbol signatures) must be specified before the harness test runner is implemented.
2. **Deterministic Token Cost Multiplier:**  
   Exact token pricing constants for the Nebius Token Factory `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` deployment must be configured in the harness so `estimated_cost_usd` is evaluated deterministically across runs.
