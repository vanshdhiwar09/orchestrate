# Discovery Measurement Contract Specification

**Document Version:** 2.0.0 (Frozen Exemption Specification)
**Status:** FROZEN DESIGN SPECIFICATION (Pre-Implementation)
**System Target:** Orchestrate Benchmark Evaluation Harness (V1)
**References:**
- [`docs/EXPERIMENT_PROTOCOL.md`](file:///c:/Users/VANSH/OneDrive/Desktop/orchestrate/docs/EXPERIMENT_PROTOCOL.md) (Section 5.1 & Section 5.2: Metrics Specification)
- [`docs/ARTIFACT_MANIFEST.md`](file:///c:/Users/VANSH/OneDrive/Desktop/orchestrate/docs/ARTIFACT_MANIFEST.md) (Rework Measurement Counterpart)

---

## 1. Purpose & System Boundary

### 1.1 Purpose
The **Discovery Measurement Contract** defines the deterministic evaluation mechanism for the benchmark metric:

$$\text{discovery\_actions}$$

The Orchestrate Benchmark Protocol ([`docs/EXPERIMENT_PROTOCOL.md`](file:///c:/Users/VANSH/OneDrive/Desktop/orchestrate/docs/EXPERIMENT_PROTOCOL.md)) evaluates Hypothesis 1 (H1):
> *"Coding agents working sequentially on the same repository will require less context rediscovery and rework when subsequent agents receive structured, verification-backed project state compared with repository-only context."*

The metric `discovery_actions` measures **context rediscovery**, not general tool usage. It quantifies how frequently Agent B must actively explore the repository or inspect filesystem state to obtain project information that was not already provided in its initial context envelope.

### 1.2 Architectural Boundaries
- **Measurement Metadata Only:** Discovery records are benchmark telemetry. They do not alter production agent execution or `Project Brain` state.
- **Arm-Blind:** The discovery measurement component does **NOT** know or inspect which experimental arm (`ARM_A`, `ARM_B`, or `ARM_C`) generated the execution trace. It operates solely on:
  1. The sequence of tool execution events emitted by Agent B (`DiscoveryEvent[]`).
  2. The list of structured context references supplied to Agent B prior to execution (`SuppliedContextReference[]`).
- **Deterministic Syntactic Evaluation:** No LLMs, embeddings, vector search, semantic similarity models, or probabilistic classifiers are used. Classification is 100% deterministic and rule-based.
- **Decoupled from Rework & Verification:** Discovery measurement evaluates Agent B's *information-gathering behavior*; it is completely orthogonal to the *code-modification behavior* evaluated by the Rework Evaluator and the *correctness evaluation* performed by `VerificationEngine`.

---

## 2. Operational Definition of `discovery_actions`

> **Operational Definition:**
> A **discovery action** is a tool invocation by Agent B that retrieves repository/project information that was **not already explicitly available** in the context supplied to Agent B before task execution.
>
> The primary metric is:
>
> $$\text{discovery\_actions} = \sum (\text{qualifying repository-information retrieval events})$$
>
> defined as the total number of qualifying discovery events performed by Agent B during the downstream task.

---

## 3. Tool Classification & Qualifying Categories

Tool names alone are **not** sufficient to determine discovery semantics. Invocations are classified according to their operational category:

### 3.1 Qualifying Discovery Categories

The following tool categories qualify as discovery when they retrieve project or repository information:

| Category | Description | Representative Tool Invocations | Target Format |
| :--- | :--- | :--- | :--- |
| `FILE_READ` | Reading contents of a workspace file | `read_file`, `view_file`, `cat`, `head`, `tail` | Normalized file path (`"src/auth.ts"`) |
| `FILE_LIST` | Listing directory structure or directory contents | `list_files`, `list_dir`, `ls`, `dir`, `tree` | Normalized directory path (`"src/"`) |
| `SEARCH` | Text or regex searching across repository files | `search`, `grep`, `find_in_files`, `ripgrep` | Exact search term string (`"requireAuth"`) |
| `SYMBOL_LOOKUP` | Identifier definition or symbol reference query | `lookup_symbol`, `find_symbol`, `get_definition`| Exact symbol identifier (`"AuthService"`) |
| `GIT_STATE` | Inspecting current working tree or index status | `git_status`, `git status --porcelain` | Canonical state specifier (`"status"`) |
| `GIT_HISTORY` | Inspecting commit history or revision logs | `git_log`, `git log -n 5` | Target commit/log ref (`"HEAD"` or `""`) |
| `GIT_DIFF` | Inspecting uncommitted or commit diffs | `git_diff`, `git diff HEAD~1` | Target diff ref or path specifier (`""` or `"HEAD"`) |

### 3.2 Non-Qualifying Tool Categories (Strictly Excluded)

The following tool actions do **NOT** qualify as discovery under any circumstance:

- **File Modifications & Deletions:** `write_file`, `edit_file`, `replace_file_content`, `delete_file`, `rm`
- **Execution & Subprocess Tooling:** `run_command` (compilers, servers, package managers), `execute_command` (unless parsed as read-only search/listing)
- **Verification & Build Validation:** `run_tests`, `test`, `build`, `typecheck`, `lint`
- **Version Control Mutations:** `commit`, `git commit`, `git add`, `git checkout`
- **Human Communication:** `ask_question`, `send_message_to_user` (handled via `human_interventions`, see Section 8)

---

## 4. Core Contract & TypeScript Interfaces

```typescript
/**
 * Types of structured references supplied in Agent B's starting context envelope.
 */
export type SuppliedContextType =
  | 'TASK'
  | 'FILE'
  | 'DIRECTORY'
  | 'SYMBOL'
  | 'DECISION'
  | 'FACT'
  | 'VERIFICATION'
  | 'HANDOFF'
  | 'GIT_STATE'
  | 'GIT_HISTORY'
  | 'GIT_DIFF';

/**
 * A concrete, structured reference supplied to Agent B before downstream execution.
 * The evaluator performs exact syntactic matching against these references without
 * attempting semantic interpretation of natural language text.
 */
export interface SuppliedContextReference {
  /** Structural category of the supplied context item. */
  type: SuppliedContextType;

  /**
   * Canonical syntactic value:
   * - For 'FILE': Canonical repository-relative path (e.g. "src/middleware/auth.ts").
   * - For 'DIRECTORY': Canonical repository-relative directory path ending with '/' (e.g. "src/").
   * - For 'SYMBOL': Exact identifier name (e.g. "authenticateToken", "AuthRequest").
   * - For 'GIT_STATE' / 'GIT_HISTORY' / 'GIT_DIFF': Canonical Git context indicator (e.g. "status", "HEAD", "").
   * - For 'DECISION' / 'FACT' / 'TASK' / 'VERIFICATION' / 'HANDOFF': Canonical reference identifier.
   */
  value: string;
}

/**
 * Supported structural categories for repository discovery actions.
 */
export type DiscoveryCategory =
  | 'FILE_READ'
  | 'FILE_LIST'
  | 'SEARCH'
  | 'SYMBOL_LOOKUP'
  | 'GIT_STATE'
  | 'GIT_HISTORY'
  | 'GIT_DIFF';

/**
 * A discrete tool invocation event executed by Agent B.
 * Ordered strictly by monotonically increasing sequence number (not timestamps).
 */
export interface DiscoveryEvent {
  /**
   * Monotonically increasing execution sequence index (1, 2, 3, ...).
   * Primary ordering mechanism; timestamps must NOT be used for ordering.
   */
  sequence: number;

  /** Name of the tool invoked by the agent (e.g. "read_file", "git_status"). */
  toolName: string;

  /**
   * Structured target of the invocation:
   * - FILE_READ: Normalized repository-relative file path (e.g. "src/auth.ts").
   * - FILE_LIST: Normalized repository-relative directory path (e.g. "src/").
   * - SEARCH: Exact search term or query string (e.g. "requireAuth").
   * - SYMBOL_LOOKUP: Exact symbol identifier name (e.g. "requireAuth").
   * - GIT_STATE: Canonical state identifier ("status").
   * - GIT_HISTORY: Target ref or commit specifier ("HEAD" or "").
   * - GIT_DIFF: Target diff ref or path specifier ("" or "HEAD").
   */
  target?: string;

  /** Qualifying discovery category. */
  category: DiscoveryCategory;
}

/**
 * An event that could not be deterministically classified as discovery or non-discovery.
 * Recorded separately for scientific auditability; strictly excluded from discovery_actions.
 */
export interface UnclassifiedEvent {
  sequence: number;
  toolName: string;
  rawInput?: unknown;
  reason: string;
}

/**
 * Input contract for the Discovery Evaluator.
 */
export interface DiscoveryEvaluationInput {
  /** Downstream task identifier. */
  taskId: string;

  /**
   * Structured references supplied to Agent B before execution.
   * For Arm A: Typically empty [].
   * For Arm B: Unverified handoff file/symbol/directory references.
   * For Arm C: Verified Brain context references.
   */
  suppliedContext: readonly SuppliedContextReference[];

  /**
   * Chronological list of tool invocation events executed by Agent B,
   * ordered by sequence index.
   */
  events: readonly DiscoveryEvent[];

  /**
   * Optional unclassified or unknown events encountered in the trace.
   */
  unclassifiedEvents?: readonly UnclassifiedEvent[];
}

/**
 * Machine-readable report emitted by the Discovery Evaluator.
 */
export interface DiscoveryEvaluationReport {
  /** Downstream task identifier. */
  taskId: string;

  /**
   * Primary benchmark metric: count of qualifying discovery actions.
   * Unclassified events and supplied-context hits are STRICTLY EXCLUDED.
   */
  discovery_actions: number;

  /** List of qualifying discovery events that contributed to the metric. */
  qualifyingEvents: DiscoveryEvent[];

  /** List of events that matched supplied context and thus were NOT discovery. */
  suppliedHits: DiscoveryEvent[];

  /** List of unclassified tool invocations. */
  unclassified: UnclassifiedEvent[];

  /** Summary statistics. */
  summary: {
    totalEventsEvaluated: number;
    qualifyingCount: number;
    suppliedHitCount: number;
    unclassifiedCount: number;
  };
}
```

---

## 5. Exact Context Exemption Matching Rules

> [!IMPORTANT]
> **Non-Negotiable Invariant:**
> Context exemption is **exact and type-aware**. The evaluator **MUST NOT** infer that one supplied context reference semantically covers another retrieval target.
> No semantic similarity, parent-directory inference, filename inference, or LLM reasoning is permitted.

### 5.1 Category-Specific Deterministic Matching Matrix

An event $E$ matches a supplied reference $R \in \text{suppliedContext}$ (and is therefore **EXEMPT** from `discovery_actions`) if and only if the exact condition below evaluates to `true`:

| Event Category | Required Reference Type | Exact Matching Rule |
| :--- | :---: | :--- |
| `FILE_READ` | `FILE` | $R.\text{type} == \text{'FILE'} \land \text{normalizePath}(R.\text{value}) == \text{normalizePath}(E.\text{target})$ |
| `FILE_LIST` | `DIRECTORY` | $R.\text{type} == \text{'DIRECTORY'} \land \text{normalizeDir}(R.\text{value}) == \text{normalizeDir}(E.\text{target})$ |
| `SEARCH` | `SYMBOL` or `FILE` | $(R.\text{type} == \text{'SYMBOL'} \land R.\text{value} == E.\text{target}) \lor (R.\text{type} == \text{'FILE'} \land (\text{normalizePath}(R.\text{value}) == \text{normalizePath}(E.\text{target}) \lor \text{basename}(R.\text{value}) == E.\text{target}))$ |
| `SYMBOL_LOOKUP` | `SYMBOL` | $R.\text{type} == \text{'SYMBOL'} \land R.\text{value} == E.\text{target}$ |
| `GIT_STATE` | `GIT_STATE` | $R.\text{type} == \text{'GIT_STATE'}$ |
| `GIT_HISTORY` | `GIT_HISTORY` | $R.\text{type} == \text{'GIT_HISTORY'} \land (R.\text{value} == \text{""} \lor R.\text{value} == E.\text{target})$ |
| `GIT_DIFF` | `GIT_DIFF` | $R.\text{type} == \text{'GIT_DIFF'} \land (R.\text{value} == \text{""} \lor R.\text{value} == E.\text{target})$ |

### 5.2 Normalization Definitions
- `normalizePath(p)`:
  1. Trim whitespace and unwrap quotes.
  2. Replace backslashes `\` with forward slashes `/`.
  3. Strip leading slashes and `./` prefixes.
  4. Strip trailing slashes for files (e.g. `"src/auth.ts/"` $\to$ `"src/auth.ts"`).
- `normalizeDir(p)`:
  1. Trim whitespace and unwrap quotes.
  2. Replace backslashes `\` with forward slashes `/`.
  3. Strip leading slashes and `./` prefixes.
  4. Ensure a trailing slash `/` (e.g. `"src"` $\to$ `"src/"`, `""` $\to$ `"./"`, `"src/"` $\to$ `"src/"`).

### 5.3 Explicit Non-Inference Rules
1. **A supplied `FILE` does NOT exempt a `DIRECTORY` listing:**
   Supplying `FILE: src/auth.ts` does **not** exempt `list_files("src/")`. Listing a directory explores the filesystem beyond the known file.
2. **A supplied `DIRECTORY` does NOT exempt a `FILE_READ`:**
   Supplying `DIRECTORY: src/` does **not** exempt `read_file("src/auth.ts")`. Knowing that a directory exists does not provide the file's content.
3. **A supplied `SYMBOL` does NOT exempt a natural-language search:**
   Supplying `SYMBOL: requireAuth` does **not** exempt `search("authentication middleware")` or `search("jwt tokens")`.
4. **Supplied files, symbols, or directories do NOT exempt Git operations:**
   Supplying `FILE: src/auth.ts` does **not** exempt `git_diff`, `git_status`, or `git_log`. Git history and state are independent repository metadata.

---

## 6. Duplicate Invocations Semantics

> **Every qualifying discovery invocation counts separately.**

If an agent reads an unsupplied file multiple times:
```text
Sequence 1: read_file("src/unsupplied.ts")   -> Discovery Action #1
Sequence 2: read_file("src/unsupplied.ts")   -> Discovery Action #2
Sequence 3: read_file("src/unsupplied.ts")   -> Discovery Action #3
```
$$\text{discovery\_actions} = 3$$

**Rationale:** The metric measures **active exploration actions and rediscovery overhead**, not the number of unique knowledge items discovered. An agent that repeatedly re-reads files incurs higher rediscovery friction than an agent that reads a file once or receives it in context.

---

## 7. Concrete Test & Verification Scenarios

The design guarantees exact outcomes across these eight primary cases:

| # | Scenario Description | Supplied Context Reference | Tool Invocation Event | Outcome | Metric Impact |
|---|---|---|---|:---:|:---:|
| 1 | **Supplied file + exact read** | `FILE: src/auth.ts` | `read_file("src/auth.ts")` | Context Hit | `discovery_actions = 0` |
| 2 | **Supplied file + different read** | `FILE: src/auth.ts` | `read_file("src/middleware/auth.ts")` | Discovery Action | `discovery_actions = 1` |
| 3 | **Supplied directory + exact listing** | `DIRECTORY: src/` | `list_files("src/")` | Context Hit | `discovery_actions = 0` |
| 4 | **Supplied file + directory listing** | `FILE: src/auth.ts` | `list_files("src/")` | Discovery Action | `discovery_actions = 1` |
| 5 | **Supplied symbol + exact symbol query** | `SYMBOL: requireAuth` | `symbol_lookup("requireAuth")` (or `search("requireAuth")`) | Context Hit | `discovery_actions = 0` |
| 6 | **Supplied symbol + unrelated search** | `SYMBOL: requireAuth` | `search("authentication middleware")` | Discovery Action | `discovery_actions = 1` |
| 7 | **Supplied file + Git diff (no Git ref)**| `FILE: src/auth.ts` | `git_diff()` | Discovery Action | `discovery_actions = 1` |
| 8 | **Exact Git context + Git retrieval** | `GIT_DIFF: ""` | `git_diff()` | Context Hit | `discovery_actions = 0` |

---

## 8. Human Intervention Separation

If Agent B requests project or architectural information from an operator via an interactive question tool (`ask_question`, `prompt_user`):

1. **Increment `human_interventions`:** The harness records this in the `human_interventions` metric.
2. **Exclude from `discovery_actions`:** Human consultations are **NEVER** counted as Agent discovery actions.
3. **Audit Log:** The prompt, operator response, and sequence index are preserved in the run record under `human_interventions_log`.

**Resulting Metric Accounting:**
$$\text{discovery\_actions} = 0$$
$$\text{human\_interventions} = 1$$

---

## 9. Unknown Tool Classification

If a trace contains tool calls that cannot be deterministically mapped to either a discovery category or an excluded execution category (e.g., custom plugins, arbitrary shell one-liners with complex pipelines):

1. Record the event in `unclassified` with `reason`.
2. **Do NOT count in `discovery_actions`**.
3. **Never guess.**

Ambiguity must never silently inflate the primary benchmark metric.

---

## 10. Arm Blindness & Isolation Invariant

The discovery measurement component is strictly arm-blind:
- It does **NOT** accept `arm` (`ARM_A`, `ARM_B`, `ARM_C`) as an argument.
- It contains no branch conditions checking experimental arms.
- It evaluates all arms via the identical mathematical function:

$$\text{EvaluateDiscovery}(\text{events}, \text{suppliedContext})$$

### How Arm Differences Emerge Naturally:
- **`ARM_A_BASELINE`**: `suppliedContext` is empty (`[]`). Any file read or search targeting the repository qualifies as discovery.
- **`ARM_B_UNVERIFIED_HANDOFF`**: `suppliedContext` contains the references extracted from the unverified handoff. Reads targeting those files/symbols do not count as discovery; reads targeting unmentioned files do.
- **`ARM_C_ORCHESTRATE`**: `suppliedContext` contains verified Brain facts, decision references, and verified file/symbol references compiled by `ContextCompiler`. Reads targeting verified items do not count; reads exploring beyond compiled context do.

---

## 11. Explicit Non-Claims & Anti-Patterns

The Discovery Evaluator explicitly does **NOT**:
1. **No LLM or semantic classifiers:** Never passes tool traces or prompts to an AI model to guess intent.
2. **No embeddings or vector distance:** Never computes semantic similarity between file content and prompts.
3. **No timestamps for ordering:** Event order is defined solely by integer `sequence` indices.
4. **No statistical aggregation:** The evaluator emits raw counts and validated reports; hypothesis testing ($t$-tests, ANOVAs) is performed downstream in statistical reporting packages.
5. **No production runtime coupling:** Does not modify `AgentRunner`, `Workspace`, `ToolRegistry`, or `Project Brain`.

---

## 12. Summary of Frozen Invariants

1. **`discovery_actions` = count of qualifying retrieval events.**
2. **Context exemption is exact and type-aware:** No parent-directory or semantic inference.
3. **Every duplicate retrieval counts separately.**
4. **Human intervention increments `human_interventions`, never `discovery_actions`.**
5. **Unclassified tools are recorded in `unclassified` and excluded from `discovery_actions`.**
6. **File modifications, deletions, test executions, and builds never qualify as discovery.**
7. **The evaluator is 100% deterministic and strictly arm-blind.**
