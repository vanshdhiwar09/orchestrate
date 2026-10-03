# Task-A Snapshot Contract

**Document Version:** 1.0.0
**Status:** FROZEN (M6A) — documentation only, no implementation
**Supplements:** [`docs/EXPERIMENT_PROTOCOL.md`](./EXPERIMENT_PROTOCOL.md) §2, §3.1, §8
**Companion:** [`docs/EXPERIMENTAL_ARM_ISOLATION.md`](./EXPERIMENTAL_ARM_ISOLATION.md)

> [!IMPORTANT]
> **Provenance.** This contract is a **new addition** to the repository. A repository audit at commit
> `2558dcf` confirmed that no Task-A snapshot contract was previously committed. The only prior
> committed rule is `EXPERIMENT_PROTOCOL.md` §3.1 ("Frozen Upstream Execution"). This document makes
> that rule precise; it does not change its meaning.

---

## 1. Purpose

Define the single, canonical repository state produced by Agent A (Task 1 / "Task A") from which all
three experimental arms (`ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, `ARM_C_ORCHESTRATE`) begin.

---

## 2. Core Contract

```ts
interface UpstreamSnapshot {
  /** Harness-assigned, deterministic identifier. Never random inside measurement logic. */
  snapshotId: string;
  /** Scenario identifier (EXPERIMENT_PROTOCOL.md §7.2, e.g. "sc-auth-api"). */
  scenarioId: string;
  /** Task-A identifier (EXPERIMENT_PROTOCOL.md §8 `task_a_id`). */
  taskAId: string;
  /** Full 40-character Git commit SHA of the canonical Task-A state. */
  commitSha: string;
  /** ISO-8601 UTC creation time. Audit metadata only — NOT part of identity. */
  createdAt: string;
}
```

### 2.1 Identity
- The identity of a snapshot is the tuple **`(snapshotId, scenarioId, taskAId, commitSha)`**.
- `createdAt` is informational. It MUST NOT be used for identity, ordering of arms, or equality checks.
- `commitSha` MUST be the full SHA (no abbreviations), so equality is exact string comparison.
- `snapshotId` is assigned by the harness. For a given `(scenarioId, replication)` there is **exactly
  one** `UpstreamSnapshot`. A second snapshot for the same `(scenarioId, replication)` is a protocol
  violation (see §6).

---

## 3. Source of Truth

```
Git commit (commitSha)          ← canonical repository state
  ↓ referenced by
UpstreamSnapshot metadata       ← pointer to that state
  ↓ derived from
ArtifactManifest, Agent A handoff, Task-A verification evidence  ← evidence/metadata
```

1. The **Git commit identified by `commitSha` is the canonical source of truth** for the Task-A
   repository state.
2. `UpstreamSnapshot` is a **reference** to that commit, not a copy of it.
3. The following are **derived** from the canonical snapshot and MAY be associated with it by
   `snapshotId`, but MUST NOT be treated as the repository source of truth:
   - `ArtifactManifest` ([`docs/ARTIFACT_MANIFEST.md`](./ARTIFACT_MANIFEST.md))
   - Agent A structured handoff (an agent **claim**, trust level `CLAIMED`)
   - Task-A verification evidence
4. If derived evidence disagrees with the commit, **the commit wins** (consistent with the
   `CODE → VERIFICATION EVIDENCE → PROJECT BRAIN → AGENT CLAIMS` hierarchy in protocol §4).
5. The Rework Evaluator's `upstreamWorkspace` MUST be materialized from this same `commitSha`.

---

## 4. Agent A Execution Rule

1. Agent A runs **exactly once** per `(scenarioId, replication)`.
2. Agent A is **never** re-run independently for Arm A, Arm B, or Arm C.
3. After Agent A terminates, the harness captures the canonical Task-A state (§5) **before** any arm
   is constructed.
4. To make "ran once" auditable, the harness records alongside the snapshot (by reference, not as part
   of the core identity):

   ```ts
   interface SnapshotProvenance {
     snapshotId: string;
     /** Harness-assigned identifier of the single Agent A execution. */
     agentARunId: string;
     /** Commit SHA of the scenario starting repository before Agent A ran. */
     baseCommitSha: string;
   }
   ```

   Exactly one `agentARunId` maps to one `snapshotId`. All three arms reference that `snapshotId`.

---

## 5. Capture Procedure (Normative Semantics)

1. **Committed work:** If Agent A committed its work, those commits are included.
2. **Uncommitted work:** If Agent A leaves uncommitted changes (staged, unstaged, or untracked
   non-ignored files), the harness MUST include them in a single harness-authored snapshot commit on top
   of Agent A's last state before arms are constructed.
3. **Ignored files:** Files matched by the scenario repository's `.gitignore` are **not** part of the
   snapshot. Dependency/environment state that lives in ignored paths (e.g. `node_modules/`) is governed
   by the environment controls in `EXPERIMENTAL_ARM_ISOLATION.md` §6, not by the snapshot.
4. **Determinism of the snapshot commit:** The harness-authored commit uses a fixed harness author
   identity configured locally in the scenario repository (never global Git config). Its contents —
   not its timestamp — define the state.
5. **Clean after capture:** After capture, `git status` at `commitSha` MUST be clean with respect to
   non-ignored files. If not, capture has failed (§6).
6. **Retention:** `commitSha` MUST remain resolvable for the lifetime of the benchmark dataset (e.g.
   protected by a harness-owned ref) so the starting state can be re-materialized later.

---

## 6. Snapshot Failure

If the canonical snapshot cannot be created, verified clean, or retained:

- **The trial cannot proceed.** No arm may be constructed.
- The outcome is classified as **`INFRASTRUCTURE / SETUP FAILURE`**.
- It is **not** Agent A performance data and **not** Agent B performance data.
- It is handled under protocol §9.1 (infrastructure faults: marked invalid and re-executed under a fresh
  replication seed).

Creating more than one snapshot for the same `(scenarioId, replication)` is also a setup failure for
that replication.

---

## 7. Exact Identity Across Arms

Every arm in a trial MUST reference the **same**:

```
snapshotId
commitSha
scenarioId
taskAId
```

If any arm differs in any of these four values, the trial is **invalid** (see
`EXPERIMENTAL_ARM_ISOLATION.md` §11). This is an exact string comparison; no normalization or
inference is permitted.

---

## 8. Non-Goals

This contract does not define or implement: a snapshot manager, Git snapshot code, workspace
management, a benchmark runner, storage schema, or the Trial/Run contract (M6B).
