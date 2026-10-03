# Experimental Arm Construction & Isolation Contract

**Document Version:** 1.0.0
**Status:** FROZEN (M6A) — documentation only, no implementation
**Supplements:** [`docs/EXPERIMENT_PROTOCOL.md`](./EXPERIMENT_PROTOCOL.md) §2, §3, §8
**Depends on:** [`docs/TASK_A_SNAPSHOT_CONTRACT.md`](./TASK_A_SNAPSHOT_CONTRACT.md)

> [!IMPORTANT]
> **Provenance.** This contract is a **new addition** to the repository. A repository audit at commit
> `2558dcf` confirmed no arm construction/isolation contract was previously committed. It makes
> protocol §2 and §3 precise without changing their meaning.
>
> **Arm identifiers are unchanged.** The committed identifiers remain authoritative:
> `ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`.

---

## 1. Canonical Structure

```
                     UpstreamSnapshot (commitSha)
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   ARM_A_BASELINE    ARM_B_UNVERIFIED_HANDOFF   ARM_C_ORCHESTRATE
          │                     │                     │
       Task B                Task B                Task B
       + repo                + repo                + repo
                             + <orchestrate_handoff>  + <orchestrate_context>
                               (UNVERIFIED)            (compiled verified context)
```

All three arms begin from the **same** `UpstreamSnapshot` (identical `snapshotId`, `commitSha`,
`scenarioId`, `taskAId`).

---

## 2. Experimental Sequence (Agent A Freeze)

```
Agent A (runs once)
   ↓
canonical UpstreamSnapshot
   ↓
derived Task-A evidence (ArtifactManifest, handoff, Task-A verification)
   ↓
construct ARM_A / ARM_B / ARM_C   (order randomized per protocol §3.4)
   ↓
execute Task B independently in each arm
   ↓
independent verification + measurement in each arm
```

All derived Task-A evidence is **frozen before any arm executes**. Agent A is never re-run per arm.

---

## 3. ARM_A_BASELINE

**Receives:** Task B prompt; repository state materialized from `commitSha`.

**Does NOT receive:** Agent A handoff; compiled context; any verification-backed upstream context;
any verification results.

This is the repository-only baseline (protocol §2.1).

---

## 4. ARM_B_UNVERIFIED_HANDOFF

**Receives:** Task B prompt; repository state from `commitSha`; the structured Agent A handoff inside:

```xml
<orchestrate_handoff>
  ...structured unverified handoff...
</orchestrate_handoff>
```

- The handoff is explicitly **`UNVERIFIED`** (trust state `CLAIMED`/`UNVERIFIED`, protocol §4.1).
- No verified/compiled context is injected.
- Independent verification results (Task-A or Task-B) are **never** exposed to Agent B before or during
  execution (protocol §2.2).

---

## 5. ARM_C_ORCHESTRATE

**Receives:** Task B prompt; repository state from `commitSha`; compiled verified project context
inside:

```xml
<orchestrate_context>
  ...compiled verified context...
</orchestrate_context>
```

- The raw Agent A handoff is **NOT** separately injected. Arm C tests the compiled-verified-context
  treatment, not an additional raw-context channel.
- Verification results MAY be exposed and MAY trigger gating/repair **only** as defined by protocol
  §2.3 and §3.6 (max two repair attempts, then `BLOCKED_NEEDS_HUMAN`).
- Context compilation itself is out of scope here (`ContextCompiler`, unchanged).

---

## 6. Task-B Equality Controls

The Task B prompt is **byte-for-byte identical** across all three arms (protocol §3.2).

The following MUST also be equivalent across arms:

| Control | Equality rule |
| :--- | :--- |
| Task B prompt | byte-for-byte identical |
| Model | identical model identifier |
| Model configuration | identical parameters (temperature, max tokens, etc.) |
| System instructions | identical **base** instructions; the only permitted difference is the arm's treatment block (§6.1) |
| Tool definitions | identical names, schemas, descriptions |
| Tool permissions | identical allow/deny policy and workspace scope |
| Execution limits | identical timeouts, step limits, output limits |
| Dependency state | identical (e.g. same lockfile and installed dependency set) |
| Environment state | identical sanitized environment and runtime versions |
| Arm blinding | no arm identifier or arm-revealing metadata (protocol §3.3) |

### 6.1 The Treatment Block

The **only** intentional difference between arms is the treatment block delivered through the
configured context channel (protocol §3.2):

| Arm | Treatment block |
| :--- | :--- |
| `ARM_A_BASELINE` | empty (absent) |
| `ARM_B_UNVERIFIED_HANDOFF` | `<orchestrate_handoff>…</orchestrate_handoff>` |
| `ARM_C_ORCHESTRATE` | `<orchestrate_context>…</orchestrate_context>` |

Arm C's verification exposure and bounded repair (§5) is part of its defined treatment, not a control
violation.

### 6.2 Provability

To make equality auditable, the harness records per arm a treatment fingerprint (by reference; the
exact record shape is defined in M6B):

```ts
interface ArmTreatmentFingerprint {
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
  /** Hash of the arm's treatment block; empty string hash for ARM_A_BASELINE. */
  treatmentBlockSha256: string;
}
```

All fields except `treatmentBlockSha256` MUST be identical across the three arms of a trial.
`environmentSha256` MUST be computed over a sanitized view that excludes secrets.

---

## 7. Physical Isolation

1. Each arm receives an **independent workspace** materialized from the same `commitSha`.
2. An arm MUST NOT write into another arm's workspace.
3. Agent B in one arm MUST NOT be able to inspect another arm's:
   workspace, tool output, logs, verification results, handoff/context, or repair attempts.
4. Workspace containment follows the existing `Workspace` isolation invariant (no path traversal or
   access outside the assigned workspace).
5. Workspace isolation is a condition of **experimental validity**, not only of security.

---

## 8. Information (Cognitive) Isolation

No information may propagate between arms during a trial:

- Agent A output and all derived Task-A evidence are frozen **before** arm execution.
- Human intervention in one arm MUST NOT inform another arm.
- Verification output from one arm MUST NOT enter another arm.
- Tool output from one arm MUST NOT enter another arm.
- Repair attempts remain inside their originating arm.
- Agent B outputs remain isolated per arm.
- The harness MUST NOT dynamically "help" one arm using information discovered in another arm.
- Treatment blocks are computed **only** from frozen Task-A evidence, never from any arm's Task-B
  execution.

Any information leakage **invalidates the affected trial**.

---

## 9. Verification

Preserves protocol §2.4:

- Independent verification is performed in **all three arms** for measurement, using identical checks.
- `ARM_A_BASELINE`: Agent B does not receive verification results.
- `ARM_B_UNVERIFIED_HANDOFF`: Agent B does not receive verification results.
- `ARM_C_ORCHESTRATE`: verification MAY be exposed per the existing gating/repair protocol.

Measurement verification in Arms A and B is performed after Agent B finishes and its results are
written only to measurement evidence. The `VerificationEngine` is not redesigned here.

---

## 10. Workspace Lifecycle per Arm

1. Materialize workspace from `commitSha`; confirm `HEAD == commitSha` and clean working tree.
2. Establish dependency/environment state; record fingerprint (§6.2).
3. Inject treatment block (§6.1).
4. Execute Task B.
5. Run independent measurement verification.

Failure in steps 1–3 is an `INFRASTRUCTURE / SETUP FAILURE`.

---

## 11. Invalidation Rules

A trial is **invalid** if any of the following occur:

- different `snapshotId` across arms
- different `commitSha` across arms (or a workspace whose starting `HEAD` ≠ `commitSha`)
- Task-B prompt mismatch
- model mismatch or model configuration mismatch
- base system instruction mismatch
- tool definition mismatch
- tool permission mismatch
- execution-limit mismatch
- dependency/environment mismatch
- treatment block not matching its arm definition (e.g. Arm C receiving the raw handoff, Arm A
  receiving any treatment block)
- unintended context or information leakage (§8)
- unintended cross-arm workspace access (§7)
- missing required setup or evidence caused by harness failure

Invalid trials are excluded from benchmark data and handled per protocol §9.1.

### 11.1 Invalid Trial ≠ Failed Agent

```
invalid trial   ≠   failed agent
```

An agent failing Task B (timeout, no usable completion, failing verification, exhausted repair,
`BLOCKED_NEEDS_HUMAN`) is **benchmark evidence**, not an invalidation. Detailed failure taxonomy is
deferred to M6B (Trial/Run Contract).

---

## 12. Relationship to `EXPERIMENT_PROTOCOL.md`

- Supplements §2 (arm definitions), §3 (controls), and §8 (data schema); replaces none of them.
- Arm identifiers are unchanged.
- No experimental conclusions, metrics, or interpretation rules are modified.
- §8 `BenchmarkRunRecord` is not changed here; any additional identity fields (e.g. `snapshot_id`)
  are deferred to M6B.

---

## 13. Non-Goals

No implementation of: snapshot manager, Git snapshot code, workspace manager changes, benchmark runner,
arm scheduler, database schema, or new production TypeScript APIs. Interfaces above are illustrative
contract definitions only.
