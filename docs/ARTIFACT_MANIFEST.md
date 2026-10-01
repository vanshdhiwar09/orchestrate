# Frozen Upstream Artifact Manifest Specification

**Document Version:** 1.0.0  
**Status:** FROZEN DESIGN SPECIFICATION (Pre-Implementation)  
**System Target:** Orchestrate Benchmark Evaluation Harness (V1)  

---

## 1. Purpose & System Boundary

### 1.1 Purpose
The **Frozen Upstream Artifact Manifest** exists solely to support **deterministic V1 measurement of downstream rework** in the benchmark evaluation harness.

The Orchestrate Benchmark Protocol ([`docs/EXPERIMENT_PROTOCOL.md`](file:///c:/Users/VANSH/OneDrive/Desktop/orchestrate/docs/EXPERIMENT_PROTOCOL.md)) establishes:
> *"A downstream edit qualifies as a rework event only when Agent B modifies, replaces, or substantially rewrites an upstream artifact established as functional by Task 1."*

To evaluate this rule deterministically without introducing complex semantic AST analysis or LLM-based subjective judges in V1, the harness must capture an immutable snapshot of the concrete code artifacts established during Task 1 by Agent A.

### 1.2 Architectural Boundaries
- **Measurement Metadata Only:** The manifest is benchmark measurement metadata. It is **NOT** Project Brain state and does not create or modify Brain entities.
- **Arm-Agnostic:** The manifest must not encode the experimental arm (`ARM_A`, `ARM_B`, `ARM_C`). A single frozen Task 1 manifest is reused identically across all arms within a replication block.
- **Isolated from Agent Context:** The manifest is not passed to Agent B as task context. Agent B operates solely within its arm-specified inputs (workspace repository, unverified handoff in Arm B, or compiled verified context in Arm C).
- **Decoupled from Orchestrator Runtime:** The manifest does not alter the production `Orchestrator` lifecycle or package contracts.
- **No Semantic Correctness Claim:** The manifest records what Task 1 added or modified; it does not claim formal mathematical correctness.

---

## 2. Core Contract & TypeScript Type Definitions

```typescript
/**
 * Supported structural symbol kinds for V1 benchmark artifact tracking.
 * Deliberately small, language-agnostic, and syntactic.
 */
export type ArtifactSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'method'
  | 'export';

/**
 * File modification status relative to repository state prior to Task 1.
 */
export type ArtifactFileStatus = 'ADDED' | 'MODIFIED';

/**
 * A concrete structural code entity established within a file by Task 1.
 */
export interface ArtifactSymbol {
  /** Identifier name of the symbol (e.g. "authenticateToken", "AuthRequest"). */
  name: string;

  /** Structural classification of the symbol. */
  kind: ArtifactSymbolKind;

  /**
   * Optional syntactic signature or declaration snippet.
   * Used for deterministic identity matching without full AST parse trees.
   */
  signature?: string;
}

/**
 * A repository file established or modified during Task 1.
 */
export interface ArtifactFile {
  /**
   * Canonical repository-relative path using forward slashes (e.g. "src/middleware/auth.ts").
   * Traversal outside the repository root is strictly forbidden.
   */
  path: string;

  /** Whether the file was newly created or modified from pre-existing code. */
  status: ArtifactFileStatus;

  /** Key structural symbols established in this file by Task 1. */
  symbols: ArtifactSymbol[];
}

/**
 * Immutable measurement manifest capturing all concrete artifacts established by Task 1.
 * Frozen immediately at the conclusion of Task 1 before downstream evaluation.
 */
export interface ArtifactManifest {
  /** Target task identifier (e.g. "task-auth-middleware"). */
  taskId: string;

  /** Attempt sequence number of the task execution (must be >= 1). */
  attemptNumber: number;

  /** ISO 8601 UTC creation timestamp (e.g. "2026-10-01T12:00:00.000Z"). */
  createdAt: string;

  /** List of repository files established or modified, sorted deterministically. */
  files: ArtifactFile[];
}
```

---

## 3. Supported Symbol Taxonomy

The symbol kinds are intentionally constrained to seven language-agnostic syntactic entities:

| Symbol Kind | Definition | Examples |
| :--- | :--- | :--- |
| `function` | Top-level or exported callable routine | `authenticateToken`, `hashPassword`, `calculateSummary` |
| `class` | Class definition or object factory type | `ProjectRepository`, `AuthService`, `TokenValidator` |
| `interface` | Structural type contract or interface declaration | `AuthRequest`, `UserPayload`, `ProjectSummary` |
| `type` | Type alias or union definition | `UserId`, `TokenStatus`, `SummaryResult` |
| `variable` | Top-level constant, instance, or exported value | `JWT_SECRET`, `authRouter`, `defaultConfig` |
| `method` | Exported class member method or prototype routine | `findById`, `verifyToken`, `invalidateSession` |
| `export` | Explicit module re-export or named export binding | `export * from './types'`, `export { authMiddleware }` |

AST parsing is explicitly deferred. Symbol extraction in V1 uses deterministic regular expression and token scanning against the working-tree diff.

---

## 4. Validation & Canonicalization Rules

A valid `ArtifactManifest` must satisfy all eighteen validation invariants:

1. **Repository-Relative Paths:** All file paths must be strictly relative to the workspace root. Absolute paths (e.g., `C:\...` or `/var/...`) are rejected.
2. **Canonical Separator:** Paths must use POSIX forward slashes (`/`). Backslashes (`\`) are normalized to `/` prior to validation.
3. **No Path Traversal:** Paths containing null bytes (`\0`), leading slashes (`/src`), or traversal segments (`../`, `./`, `..`) are strictly rejected.
4. **Unique File Paths:** Every entry in `files` must have a distinct `path`. Duplicate paths within a manifest invalidate it.
5. **Unique Symbols Per File:** Every symbol within an `ArtifactFile.symbols` array must have a unique `name`. Duplicate symbol names within a file are invalid.
6. **Non-Empty Paths:** `path` must be a non-empty string after whitespace trimming.
7. **Non-Empty Symbol Names:** `name` must be a non-empty string after whitespace trimming.
8. **Valid Attempt Number:** `attemptNumber` must be a positive integer ($\ge 1$).
9. **Valid Task Identifier:** `taskId` must be a non-empty string after whitespace trimming.
10. **Valid Creation Timestamp:** `createdAt` must be a valid, parsable ISO 8601 UTC timestamp string.
11. **Immutability Once Frozen:** Once emitted, an `ArtifactManifest` object is deeply frozen (`Object.freeze`). Fields may not be mutated.
12. **Measurement Isolation:** The manifest must not create, modify, or delete entities in `Project Brain`.
13. **Runtime Decoupling:** The manifest must not alter the production `Orchestrator` execution loop.
14. **No Agent B Exposure:** The manifest is strictly excluded from Agent B's task input, system prompt, and compiled context.
15. **No AST Dependency:** Symbol extraction and comparison must not depend on complex AST compilers in V1.
16. **No Semantic Subjectivity:** The manifest records concrete syntactic presence; it does not evaluate whether code is "good" or "clean".
17. **Deterministic Canonical Sorting:**
    - `files` must be sorted alphabetically by `path` in ascending ASCII order.
    - `symbols` within each file must be sorted alphabetically by `name` in ascending ASCII order.
18. **Unresolved Fallback:** If an edit cannot be deterministically classified as rework against the manifest, the evaluator emits `UNRESOLVED_AMBIGUOUS_REWORK`.

---

## 5. Serialization & Machine-Readable Schema

Manifests are serialized as deterministic canonical JSON. Keys are sorted, strings use UTF-8, and 2-space indentation is used for persistent records.

### 5.1 JSON Schema
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ArtifactManifest",
  "type": "object",
  "required": ["taskId", "attemptNumber", "createdAt", "files"],
  "additionalProperties": false,
  "properties": {
    "taskId": { "type": "string", "minLength": 1 },
    "attemptNumber": { "type": "integer", "minimum": 1 },
    "createdAt": { "type": "string", "format": "date-time" },
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["path", "status", "symbols"],
        "additionalProperties": false,
        "properties": {
          "path": { "type": "string", "minLength": 1 },
          "status": { "enum": ["ADDED", "MODIFIED"] },
          "symbols": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["name", "kind"],
              "additionalProperties": false,
              "properties": {
                "name": { "type": "string", "minLength": 1 },
                "kind": {
                  "enum": [
                    "function",
                    "class",
                    "interface",
                    "type",
                    "variable",
                    "method",
                    "export"
                  ]
                },
                "signature": { "type": "string" }
              }
            }
          }
        }
      }
    }
  }
}
```

---

## 6. Extraction Pipeline & Relationship to Upstream State

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Agent A Executes Task 1                                                     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Git Working-Tree / Commit Diff Inspection                                   │
│ (LocalGitRepository.getDiff / LocalWorkspace.readFile)                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Extract changed file paths relative to workspace root                    │
│ 2. Distinguish newly ADDED files vs MODIFIED existing files                 │
│ 3. Filter out transient/ignored files (node_modules, .git, *.log)           │
│ 4. Extract exported/primary symbols (functions, classes, interfaces, types) │
│ 5. Sort files and symbols canonicalized alphabetically                      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Freeze Immutable ArtifactManifest (reused identically for Arms A, B, and C)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Relationship to Git Diff
The manifest is grounded in the **actual Git diff** produced by Task 1 relative to the scenario base commit:
- Files appearing as `Untracked` or newly added in staged diff are marked `ADDED`.
- Pre-existing files containing line modifications are marked `MODIFIED`.
- Files with zero diff modifications are excluded.

### 6.2 Relationship to Agent A Output
The manifest does **NOT** rely on Agent A's reported handoff claims.  
If Agent A claims it created `src/utils/token.ts`, but no such file exists in the Git working tree, that file is **omitted** from the manifest. CODE is authoritative over AGENT CLAIMS.

---

## 7. Downstream Rework Evaluation Pipeline

At the conclusion of Task 2 by Agent B, the benchmark harness computes downstream rework events by cross-referencing Agent B's Git diff against the frozen `ArtifactManifest`:

```
                           Agent B Git Diff (Task 2)
                                       │
                                       ▼
               ┌───────────────────────────────────────────────┐
               │ Does diff modify a path in ArtifactManifest?  │
               └───────┬───────────────────────────────┬───────┘
                       │ YES                           │ NO
                       ▼                               ▼
      ┌─────────────────────────────────┐   ┌─────────────────────────┐
      │ Was file status in manifest:    │   │ Not Upstream Artifact   │
      │ ADDED by Task 1?                │   │ (New Task 2 Work)       │
      └───┬─────────────────────────┬───┘   │ [rework_event = 0]      │
          │ YES                     │ NO    └─────────────────────────┘
          ▼                         ▼
┌──────────────────┐   ┌─────────────────────────────────────────┐
│ Modifies Upstream│   │ Modified Pre-existing Repository File   │
│ Task 1 File      │   │ (e.g. src/server.ts)                    │
│ [REWORK EVENT]   │   └────┬───────────────────────────────┬────┘
└──────────────────┘        │ Modifies manifest symbol?     │ Edits unrelated lines?
                            ▼                               ▼
                 ┌──────────────────┐             ┌───────────────────┐
                 │ Modifies Symbol  │             │ Non-interfering   │
                 │ from Task 1      │             │ Modification      │
                 │ [REWORK EVENT]   │             │ [rework_event = 0]│
                 └──────────────────┘             └───────────────────┘
```

### 7.1 Deterministic Evaluation Rules
1. **Added File Mutation:** If Agent B deletes, renames, or modifies lines inside a file marked `ADDED` in the manifest, this constitutes a **rework event** (Agent B is replacing or patching Task 1's work).
2. **Modified File Symbol Mutation:** If Agent B edits a pre-existing file marked `MODIFIED` in the manifest, an edit constitutes a **rework event** only if the diff alters lines belonging to a symbol registered in that file's `symbols` array.
3. **Ambiguity Emittance:** If an edit alters shared whitespace, import order, or internal helpers in a `MODIFIED` file where symbol attribution is uncertain, the evaluator logs `UNRESOLVED_AMBIGUOUS_REWORK` rather than guessing.

---

## 8. Contrast: Manifest vs. System Components

| Dimension | `ArtifactManifest` | `Handoff` | `VerificationRecord` | `Git State` | `Project Brain` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Layer** | Benchmark Evaluation | Core Engine | Verification Layer | Workspace Filesystem | Persistent State Store |
| **Author** | Benchmark Harness | Coding Agent | `VerificationEngine` | Subprocess Git CLI | Brain Store Engine |
| **Trust Level** | Trusted Measurement | Untrusted (`CLAIMED`) | Trusted Evidence | Authoritative Code | Trusted Knowledge |
| **Mutability** | Frozen / Immutable | Immutable Record | Immutable Record | Mutable Working Tree | Append-Only Lineage |
| **Target Audience**| Benchmark Evaluator | Next Agent / Operator| Project Brain / Admin| Agent & Tools | Context Compiler |
| **Contains Arm?** | **NO** | No | No | No | No |
| **Scope** | Task 1 Syntactic Entities | Summary & Intent | Checks Pass/Fail | Raw Text Diffs | Facts, Decisions, Tasks |

---

## 9. Concrete Manifest Examples

### Example 1: Added Authentication Middleware File
*Scenario: `auth-protected-api`, Task 1 implements JWT validation middleware.*

```json
{
  "taskId": "task-auth-middleware",
  "attemptNumber": 1,
  "createdAt": "2026-10-01T14:00:00.000Z",
  "files": [
    {
      "path": "src/middleware/auth.ts",
      "status": "ADDED",
      "symbols": [
        {
          "name": "AuthRequest",
          "kind": "interface",
          "signature": "interface AuthRequest extends Request { user?: UserPayload; }"
        },
        {
          "name": "UserPayload",
          "kind": "type",
          "signature": "type UserPayload = { id: string; email: string; role: string; };"
        },
        {
          "name": "authenticateToken",
          "kind": "function",
          "signature": "export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void"
        }
      ]
    }
  ]
}
```
*Downstream Rule:* Any deletion, modification, or re-implementation of `src/middleware/auth.ts` by Agent B is recorded as a `rework_event`.

---

### Example 2: Modified Existing Repository File
*Scenario: `data-model-feature`, Task 1 updates existing database schema and server mounting.*

```json
{
  "taskId": "task-data-model",
  "attemptNumber": 1,
  "createdAt": "2026-10-01T14:05:00.000Z",
  "files": [
    {
      "path": "src/data/schema.ts",
      "status": "MODIFIED",
      "symbols": [
        {
          "name": "ProjectEntity",
          "kind": "interface",
          "signature": "export interface ProjectEntity { id: string; name: string; status: string; }"
        },
        {
          "name": "projectsTable",
          "kind": "variable",
          "signature": "export const projectsTable: TableDefinition"
        }
      ]
    },
    {
      "path": "src/server.ts",
      "status": "MODIFIED",
      "symbols": [
        {
          "name": "registerDataRoutes",
          "kind": "function",
          "signature": "export function registerDataRoutes(app: Express): void"
        }
      ]
    }
  ]
}
```
*Downstream Rule:* If Agent B adds a route in `src/server.ts` without touching `registerDataRoutes`, rework is `0`. If Agent B edits `registerDataRoutes` or redefines `ProjectEntity`, a `rework_event` is recorded.

---

### Example 3: Ambiguous Case Emitting `UNRESOLVED_AMBIGUOUS_REWORK`
*Scenario: `auth-password-reset`, Task 1 modified `src/config/env.ts` to add reset token expiry. In Task 2, Agent B reorganizes all imports in `src/config/env.ts` and changes environment variable validation library.*

```json
{
  "taskId": "task-password-reset",
  "attemptNumber": 1,
  "createdAt": "2026-10-01T14:10:00.000Z",
  "files": [
    {
      "path": "src/config/env.ts",
      "status": "MODIFIED",
      "symbols": [
        {
          "name": "PASSWORD_RESET_EXPIRY_MS",
          "kind": "variable",
          "signature": "export const PASSWORD_RESET_EXPIRY_MS: number"
        }
      ]
    }
  ]
}
```
*Downstream Rule:* Agent B modified `src/config/env.ts`, altering import lines and refactoring config loaders, but retained the value of `PASSWORD_RESET_EXPIRY_MS`. Because syntactic line attribution is intertwined without full AST semantics, the evaluator deterministically records:
```json
{
  "file": "src/config/env.ts",
  "classification": "UNRESOLVED_AMBIGUOUS_REWORK",
  "reason": "Edits altered surrounding file structure without explicit deletion of manifest symbol"
}
```
It is **NOT** counted as a confirmed rework event in primary metrics.

---

## 10. Explicit Non-Claims & Anti-Patterns

The manifest explicitly does **NOT**:
1. **Does not evaluate code quality:** A messy, unformatted function that passed Task 1 verification is recorded in the manifest as-is.
2. **Does not declare mathematical correctness:** Presence in the manifest reflects verified execution against configured checks, not formal proof.
3. **Does not track internal private locals:** Variables private to function closures are omitted. Only top-level/exported structural entities are tracked.
4. **Does not store experimental telemetry:** The manifest never contains `arm`, `model`, `provider`, `verification_status`, or token metrics.

---

## 11. Remaining Unresolved Design Questions

1. **Lightweight Symbol Extraction Strategy:**  
   Whether V1 regex token extraction is sufficient across all five scenario languages/dialects or whether a single deterministic regex pattern per symbol kind should be standardized before harness implementation.
2. **Signature Comparison Strictness:**  
   Whether `signature` matching during downstream diff checks should be whitespace-normalized (trimmed single-line canonical string) to prevent false positives from code formatter re-wrapping.
