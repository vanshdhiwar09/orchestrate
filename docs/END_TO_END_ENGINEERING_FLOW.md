# End-to-End Engineering Flow

## Status
**APPROVED / CORE ARCHITECTURE SPECIFICATION**

---

## 1. Overview & Core Product Thesis

Orchestrate is an AI engineering system that coordinates coding agents while maintaining persistent, evidence-backed project state.

Current multi-agent and coding-assistant systems typically suffer from two fundamental failure modes:
1. **Context Loss & Bloat:** When one agent finishes a task and another begins, either the entire raw conversational history is forwarded (polluting context, blowing token budgets, and carrying hallucinations forward) or the human developer is forced to manually summarize what happened and re-explain the project state.
2. **Unverified Claims:** LLMs frequently declare: *"I have implemented the feature and all tests pass,"* when no code was written, tests were deleted, or syntax errors prevent compilation. Systems that trust model claims promote hallucinations into project memory.

Orchestrate solves both problems through a structured, evidence-backed execution lifecycle.

### Core Product Thesis
> **"Agent B can continue work from Agent A without the user manually explaining Agent A's work."**

This is achieved because:
- Agent A's actions result in **real code changes** within an isolated workspace.
- Agent A's claims are captured in a structured **Handoff** with initial status `CLAIMED` (untrusted).
- An independent **VerificationEngine** executes objective checks (build, lint, test) against the workspace.
- **Project Brain** stores immutable evidence and derives authoritative task trust states.
- The **Context Compiler** deterministically extracts verified project facts, architectural decisions, and upstream verification evidence into a compact `<orchestrate_context>` envelope.
- Agent B receives **compiled, evidence-backed project state**—never Agent A's raw chat messages.

---

## 2. The End-to-End Engineering Pipeline

The complete flow from task inception to dependent task verification proceeds through nine deterministic stages:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                  TASK A EXECUTION                                      │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │       1. Task Input       │
                        │ (projectId, taskId, Plan) │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │      2. AgentRunner       │ ◄─── ModelClient (Nebius)
                        │   (Tool execution loop)   │ ◄─── Workspace (Filesystem)
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │   3. Real Code Changes    │
                        │   (Files written to disk) │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │   4. Structured Handoff   │
                        │ (Status: CLAIMED, notes)  │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ 5. VerificationEngine     │
                        │  (Independent test/build) │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │     6. Project Brain      │
                        │(Records & Trust: VERIFIED)│
                        └─────────────┬─────────────┘
                                      │
──────────────────────────────────────┼───────────────────────────────────────────────────
                                      │
┌─────────────────────────────────────┴──────────────────────────────────────────────────┐
│                            TASK B (DEPENDENT AGENT)                                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │    7. Context Compiler    │
                        │  (Extracts Brain state &  │
                        │   builds XML context)     │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ 8. Agent B (AgentRunner)  │
                        │  (Reads compiled state,   │
                        │   implements consumer)    │
                        └─────────────┬─────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ 9. VerificationEngine     │
                        │(Independent Task B checks)│
                        └───────────────────────────┘
```

### Stage-by-Stage Lifecycle

| Stage | Operation | Component | State / Output |
|---|---|---|---|
| **1** | Task Submission | Orchestrator | Target task, attempt number, and verification plan resolved |
| **2** | Agent Execution Loop | AgentRunner + ModelClient | Model completes turns and calls workspace tools |
| **3** | Workspace Modification | ToolRegistry (`write_file`) | Concrete files modified or created on the filesystem |
| **4** | Structured Handoff | Orchestrator + Brain | Agent claims captured in structured `Handoff` (`CLAIMED`) |
| **5** | Independent Verification | VerificationEngine | Objective checks run via `CommandExecutor` |
| **6** | Brain State Update | Project Brain | Verification record stored; task trust state derived (`VERIFIED` or `FAILED`) |
| **7** | Context Compilation | Context Compiler | Relevant decisions, facts, and upstream checks assembled into `<orchestrate_context>` |
| **8** | Dependent Agent Run | AgentRunner + ModelClient | Agent B runs with compiled state (zero raw message history) |
| **9** | Task B Verification | VerificationEngine | Objective checks evaluate Agent B's implementation independently |

---

## 3. Core Component Responsibilities

Orchestrate maintains strict responsibility boundaries across seven core subsystems:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                       Orchestrator                                      │
│                (Coordinates task lifecycles, sequencing, and handoffs)                 │
└───────────┬──────────────────────┬───────────────────────┬───────────────────────┬──────┘
            │                      │                       │                       │
            ▼                      ▼                       ▼                       ▼
    ┌───────────────┐      ┌───────────────┐       ┌───────────────┐       ┌───────────────┐
    │  AgentRunner  │      │ContextCompiler│       │ Verification  │       │ Project Brain │
    │ (Agent loop)  │      │ (Token-budget │       │    Engine     │       │ (Append-only  │
    │               │      │  context XML) │       │ (Objective    │       │ SQLite store) │
    └───────┬───────┘      └───────────────┘       │  test runner) │       └───────────────┘
            │                                      └───────┬───────┘
            ▼                                              │
    ┌───────────────┐                                      │
    │  ModelClient  │                                      │
    │(Nebius Token  │                                      │
    │   Factory)    │                                      │
    └───────────────┘                                      │
            │                                              │
            ▼                                              ▼
    ┌──────────────────────────────────────────────────────────────┐
    │                      Workspace Sandbox                       │
    │              (Isolated directory & git branch)               │
    └──────────────────────────────────────────────────────────────┘
```

### 1. Orchestrator (`packages/core/src/orchestrator.ts`)
- **Role:** Central workflow coordinator.
- **Responsibilities:**
  - Manages the single-task execution lifecycle across `Project Brain`, `Context Compiler`, `AgentRunner`, and `VerificationEngine`.
  - Determines sequential attempt numbers (`attemptNumber = highestAttempt + 1`).
  - Resolves task and upstream task ownership within a project boundary.
  - Transforms agent completion output into structured `Handoff` records with status `CLAIMED`.
  - Dispatches verification plans to `VerificationEngine`.
  - Persists `Handoff` and `VerificationRecord` entities to `Project Brain`.
  - Never fabricates evidence or swallows verification failures.

### 2. AgentRunner (`packages/core/src/runner.ts`)
- **Role:** Agent execution coordinator.
- **Responsibilities:**
  - Manages the multi-turn interaction loop between the model and tools up to `maxIterations`.
  - Formats messages with system instructions, user task prompts, and prior turn tool call responses.
  - Exposes controlled capabilities via `ToolRegistry`:
    - `read_file` — Reads relative workspace file contents.
    - `write_file` — Writes UTF-8 text content to relative workspace paths.
    - `execute_command` — Runs strictly allowed executables (`node`, `npm`, `npx`, `tsc`, `git`).
    - `get_project_info` — Provides system metadata.
  - Enforces workspace containment and isolates executions within the designated directory.

### 3. ModelClient (`packages/model/src/nebius.ts`)
- **Role:** AI inference provider adapter.
- **Responsibilities:**
  - Communicates directly with **Nebius Token Factory** via HTTPS (`/v1/chat/completions`).
  - Implements the model-agnostic `ModelClient` interface.
  - Redacts API keys from all network logs, exception messages, and error traces.
  - Queries available models via `GET /v1/models`.
  - Captures execution provenance (provider, model ID, inference parameters, token usage).
  - In benchmark mode, enforces locked control fingerprints across experimental arms.

### 4. Handoff (`packages/brain/src/types.ts`)
- **Role:** Structured bridge from agent output to verification and downstream tasks.
- **Responsibilities:**
  - Captures agent-reported execution metadata:
    - `summary`: Plain language summary of what the agent claims to have done.
    - `changes`: Summary of modifications.
    - `filesAffected`: List of workspace paths modified or created.
    - `decisionsCreated`: Architectural decisions proposed by the agent.
    - `assumptions`: Explicit assumptions made during execution.
    - `limitations`: Known gaps, deferred work, or edges.
    - `recommendedFollowUp`: Suggested next steps.
  - Invariant: A newly created `Handoff` always carries status **`CLAIMED`**. It represents agent claims, not verified facts.

### 5. VerificationEngine (`packages/verification/src/engine.ts`)
- **Role:** Independent, objective evaluation engine.
- **Responsibilities:**
  - Executes configured `VerificationPlan` checks (`test`, `typecheck`, `lint`, `build`) against the workspace via `CommandExecutor`.
  - Collects tamper-evident `VerificationEvidence` per check:
    - Command, arguments, working directory.
    - Integer exit code and process termination signal.
    - Exact `stdout` and `stderr` streams.
    - Execution duration in milliseconds.
    - Pass/fail boolean (`exitCode === 0 && !timedOut`).
  - Computes deterministic overall status (`VERIFIED` if all checks pass; `FAILED` if any check fails).
  - Operates completely outside the agent's execution loop—the agent cannot modify, skip, or fabricate verification outcomes.

### 6. Project Brain (`packages/brain/src/brain.ts`)
- **Role:** Persistent, append-only project memory and truth store.
- **Responsibilities:**
  - Implemented as an immutable, append-only SQLite database with WAL mode (or deterministic memory store).
  - Stores Projects, Tasks, ProjectFacts, Decisions, Handoffs, and VerificationRecords.
  - Derives authoritative `TaskTrustState` from complete attempt history:
    - `UNVERIFIED`: Task registered, no attempts made.
    - `CLAIMED`: Handoff recorded, no verification record yet.
    - `VERIFIED`: Latest verification record has status `VERIFIED`.
    - `FAILED`: Latest verification record has status `FAILED` (and repair attempts remain).
    - `BLOCKED_NEEDS_HUMAN`: Failed after maximum repair attempts (2) or explicitly blocked.
  - Tracks cross-task architectural decisions and decision supersede lineage.

### 7. Context Compiler (`packages/compiler/src/compiler.ts`)
- **Role:** Pure, deterministic context extraction and budgeting engine.
- **Responsibilities:**
  - Loads snapshot data from `Project Brain` and Git repository state.
  - Enforces strict token budgeting across context sections (decisions, facts, upstream work, git state).
  - Quarantines unverified agent claims behind explicit warning tags.
  - Serializes compiled context into clean, structured XML markdown (`<orchestrate_context>`) for prompt injection.
  - Contains no stochastic components, embeddings, vector search, or LLM summarization—compilation is 100% deterministic and repeatable.

---

## 4. Source-of-Truth Hierarchy & Trust State Taxonomy

### The Source-of-Truth Hierarchy

When evaluating project state or resolving conflicting data, Orchestrate enforces an unalterable precedence hierarchy:

```
    CODE  (autoritative ground truth in workspace)
     ↓
VERIFICATION EVIDENCE  (executed test/lint/build outputs)
     ↓
PROJECT BRAIN  (persisted facts and architectural decisions)
     ↓
AGENT CLAIMS  (untrusted assertions from model outputs)
```

1. **CODE:** What actually exists on the filesystem in the workspace. If an agent claims a file exists but the filesystem does not contain it, the filesystem is authoritative.
2. **VERIFICATION EVIDENCE:** Real exit codes and error streams from executed commands. If an agent claims "all tests pass," but Vitest exited with code 1, the test runner is authoritative.
3. **PROJECT BRAIN:** Immutable, recorded history of decisions, facts, and verified attempts.
4. **AGENT CLAIMS:** Model-generated descriptions, summaries, and self-assessments. Agent claims are considered **untrusted input** until independently corroborated.

### Agent Claims vs. Verified Project State

| Characteristic | Agent Claims (`Handoff`) | Verified Project State (`VerificationRecord` & Brain) |
|---|---|---|
| **Author** | AI Model (via `AgentRunner`) | Independent OS Process (via `VerificationEngine`) |
| **Trust Level** | Untrusted | Verified (evidence-backed) |
| **Initial Status** | `CLAIMED` | Evaluated against objective criteria |
| **Verification Basis** | Model self-report | Concrete exit code, stdout, stderr, execution duration |
| **Downstream Treatment** | Quarantined in `<unverified_agent_notes>` with explicit warnings | Promoted to trusted context in `<upstream_work>` and `<verified_facts>` |

### Trust State Taxonomy

```
                   ┌──────────────┐
                   │  UNVERIFIED  │ (Task created, no execution)
                   └──────┬───────┘
                          │ Agent starts and completes loop
                          ▼
                   ┌──────────────┐
                   │   CLAIMED    │ (Agent claims work is complete)
                   └──────┬───────┘
                          │ VerificationEngine runs checks
             ┌────────────┴────────────┐
             ▼                         ▼
      ┌──────────────┐          ┌──────────────┐
      │   VERIFIED   │          │    FAILED    │ (Check failed: exit code != 0)
      └──────────────┘          └──────┬───────┘
                                       │ 2 failed repair attempts
                                       ▼
                                ┌──────────────────────┐
                                │ BLOCKED_NEEDS_HUMAN  │
                                └──────────────────────┘
```

- **`UNVERIFIED`**: The task has been defined, but no agent attempts have been recorded.
- **`CLAIMED`**: The agent has executed its turns and submitted a handoff, but independent verification has not yet run or passed.
- **`VERIFIED`**: The configured verification plan executed against the workspace and every check passed (exit code 0).
- **`FAILED`**: The verification plan executed against the workspace and one or more checks failed (non-zero exit code or timeout).
- **`BLOCKED_NEEDS_HUMAN`**: The task failed verification and exhausted the maximum allowed automated repair attempts (bounded at 2 attempts), or encountered an unrecoverable invariant violation. Progress halts until a human intervenes.

### Mandatory Verification Invariant

> **"VERIFIED means the configured checks passed; it does not mean the code is proven correct."**

Verification guarantees that the specific, configured commands (e.g., `tsc --noEmit`, `vitest run`, `eslint .`) executed successfully in the workspace environment. It does not claim formal mathematical correctness or absence of unspecified defects.

---

## 5. Concrete Walkthrough: Task A → Task B Greeting Module

To illustrate the complete engineering flow, consider a real-world scenario where Task A builds a greeting utility and Task B builds an HTTP consumer that imports it.

```
┌───────────────────────────────────────┐
│                TASK A                 │
│      "Create Greeting Module"         │
└──────────────────┬────────────────────┘
                   │
                   ▼ writes src/greeting.ts
┌───────────────────────────────────────┐
│          src/greeting.ts              │
│  export function createGreeting(...)  │
└──────────────────┬────────────────────┘
                   │
                   ▼ independently verifies
┌───────────────────────────────────────┐
│          VerificationEngine           │
│   npm test -> greeting.test.ts PASS   │
└──────────────────┬────────────────────┘
                   │
                   ▼ records verified state
┌───────────────────────────────────────┐
│             Project Brain             │
│   Task A trust state: VERIFIED        │
└──────────────────┬────────────────────┘
                   │
                   ▼ compiles evidence-backed context
┌───────────────────────────────────────┐
│           Context Compiler            │
│   Generates <orchestrate_context>     │
└──────────────────┬────────────────────┘
                   │
                   ▼ injected into prompt (zero raw chat history)
┌───────────────────────────────────────┐
│                TASK B                 │
│      "Create Greeting Consumer"       │
└──────────────────┬────────────────────┘
                   │
                   ▼ imports createGreeting from './greeting.js'
┌───────────────────────────────────────┐
│          src/consumer.ts              │
│  import { createGreeting } from ...   │
└──────────────────┬────────────────────┘
                   │
                   ▼ independently verifies
┌───────────────────────────────────────┐
│          VerificationEngine           │
│   npm test -> consumer.test.ts PASS   │
└───────────────────────────────────────┘
```

### Step 1: Task A Definition & Orchestration
The Orchestrator receives Task A:
- **Task ID:** `task-greeting-impl`
- **Title:** `Implement Greeting Module`
- **Verification Plan:**
  ```json
  {
    "checks": [
      {
        "id": "check-typecheck",
        "name": "Typecheck",
        "command": "npx",
        "args": ["tsc", "--noEmit"]
      },
      {
        "id": "check-unit-tests",
        "name": "Greeting Unit Tests",
        "command": "npm",
        "args": ["test", "--", "greeting.test.ts"]
      }
    ]
  }
  ```

### Step 2: Agent A Execution & Real Code Change
The Orchestrator calls `AgentRunner.run(...)`.
Agent A uses the Nebius Token Factory model (`nvidia/nemotron-4-340b-instruct`) and workspace tools:
1. Agent A calls `write_file` with path `src/greeting.ts`:
   ```typescript
   export interface GreetingOptions {
     salutation?: string;
     punctuation?: string;
   }

   export function createGreeting(name: string, options: GreetingOptions = {}): string {
     const salutation = options.salutation ?? 'Hello';
     const punctuation = options.punctuation ?? '!';
     const trimmed = name.trim();
     if (!trimmed) {
       throw new Error('Name cannot be empty.');
     }
     return `${salutation}, ${trimmed}${punctuation}`;
   }
   ```
2. Agent A calls `write_file` with path `src/greeting.test.ts`:
   ```typescript
   import { describe, expect, it } from 'vitest';
   import { createGreeting } from './greeting.js';

   describe('createGreeting', () => {
     it('creates standard greeting', () => {
       expect(createGreeting('World')).toBe('Hello, World!');
     });

     it('respects custom salutation', () => {
       expect(createGreeting('Alice', { salutation: 'Welcome' })).toBe('Welcome, Alice!');
     });
   });
   ```
3. Agent A finishes its iteration loop and outputs a structured handoff payload.

### Step 3: Structured Handoff Created
The Orchestrator captures Agent A's output into a `Handoff`:
```json
{
  "id": "handoff-task-greeting-impl-a1-1728040000",
  "taskId": "task-greeting-impl",
  "attemptNumber": 1,
  "model": "nebius/nvidia/nemotron-4-340b-instruct",
  "status": "CLAIMED",
  "summary": "Implemented createGreeting function and test suite in src/greeting.ts",
  "changes": "Added greeting module with configurable salutation and validation",
  "filesAffected": ["src/greeting.ts", "src/greeting.test.ts"],
  "decisionsCreated": ["dec-greeting-interface"],
  "assumptions": ["ESM module resolution is configured"],
  "limitations": ["No localization support yet"],
  "recommendedFollowUp": ["Implement consumer in CLI or HTTP service"]
}
```
At this point, Agent A's work is recorded in Project Brain, but its status is **`CLAIMED`** (untrusted).

### Step 4: Independent Verification of Task A
The Orchestrator dispatches the `VerificationPlan` to the `VerificationEngine`:
1. `VerificationEngine` executes `npx tsc --noEmit` via `LocalCommandExecutor`:
   - Exit code: `0`
   - Stdout: `""`
   - Passed: `true`
2. `VerificationEngine` executes `npm test -- greeting.test.ts`:
   - Exit code: `0`
   - Stdout: `"✓ src/greeting.test.ts (2 tests) 12ms"`
   - Passed: `true`
3. Result:
   ```json
   {
     "status": "VERIFIED",
     "checks": [
       { "checkId": "check-typecheck", "passed": true, "durationMs": 420 },
       { "checkId": "check-unit-tests", "passed": true, "durationMs": 680 }
     ],
     "totalDurationMs": 1100
   }
   ```
4. Project Brain persists the `VerificationRecord` linking to `handoff-task-greeting-impl-a1-1728040000`.
5. Authoritative trust state for Task A becomes **`VERIFIED`**.

### Step 5: Task B Inception
Task B is submitted:
- **Task ID:** `task-consumer-impl`
- **Title:** `Implement Greeting Consumer Service`
- **Upstream Task ID:** `task-greeting-impl`
- **Prompt:** `"Create src/consumer.ts that imports createGreeting and formats greetings for registered users."`

### Step 6: Context Compilation (The Core Bridge)
Before Agent B runs, the Orchestrator invokes `ContextCompiler.compile(...)` with `upstreamTaskId: "task-greeting-impl"`.
The Context Compiler loads verified facts, decisions, git status, and Task A's verification record from Project Brain, producing `<orchestrate_context>`:

```xml
<orchestrate_context>
  <evidence_hierarchy_rule>
    Precedence: CODE > VERIFICATION EVIDENCE > PROJECT BRAIN > AGENT CLAIMS
    If current repository code conflicts with a recorded Brain fact or agent claim, current repository code is authoritative.
  </evidence_hierarchy_rule>
  <architectural_decisions>
    <decision id="dec-greeting-interface">
      <statement>createGreeting accepts name string and optional GreetingOptions configuration</statement>
      <rationale>Allows consumer flexibility without breaking existing callers</rationale>
    </decision>
  </architectural_decisions>
  <verified_facts>
    <fact key="module_system" provenance="CODE">NodeNext ESM</fact>
    <fact key="package_name" provenance="CODE">greeting-service</fact>
  </verified_facts>
  <upstream_work task_id="task-greeting-impl" trust_state="VERIFIED" attempt="1" title="Implement Greeting Module">
    <files_affected>
      <file>src/greeting.ts</file>
      <file>src/greeting.test.ts</file>
    </files_affected>
    <verification_checks>
      <check id="check-typecheck" status="PASSED" duration_ms="420" exit_code="0">
        <name>Typecheck</name>
        <command>npx tsc --noEmit</command>
      </check>
      <check id="check-unit-tests" status="PASSED" duration_ms="680" exit_code="0">
        <name>Greeting Unit Tests</name>
        <command>npm test -- greeting.test.ts</command>
      </check>
    </verification_checks>
    <unverified_agent_notes>
      <warning>The following notes were reported by an upstream agent and are UNVERIFIED CLAIMS.</warning>
      <summary>Implemented createGreeting function and test suite in src/greeting.ts</summary>
      <changes>Added greeting module with configurable salutation and validation</changes>
      <limitations>
        <item>No localization support yet</item>
      </limitations>
      <assumptions>
        <item>ESM module resolution is configured</item>
      </assumptions>
    </unverified_agent_notes>
  </upstream_work>
  <git_state branch="main">
    <head_commit hash="a3f89b1" author="Agent A">feat: implement greeting module</head_commit>
  </git_state>
</orchestrate_context>
```

### Why This Differs from Traditional Multi-Agent Setups

Notice what Agent B receives vs. what is excluded:
- **INCLUDED:**
  - The exact files modified (`src/greeting.ts`).
  - The exact verification checks that passed (`check-typecheck`, `check-unit-tests`).
  - Active architectural decisions.
  - Quarantined agent notes clearly labeled with a warning.
- **EXCLUDED:**
  - Agent A's multi-turn conversational transcript.
  - Agent A's failed intermediate tool attempts, file retries, or debugging chatter.
  - Thousands of redundant tokens.
  - Model hallucinations that were not verified.

### Step 7: Agent B Execution & Task B Verification
1. Agent B inspects `src/greeting.ts` directly using `read_file` (ground truth code).
2. Agent B writes `src/consumer.ts`, cleanly importing `{ createGreeting } from './greeting.js'`.
3. Agent B writes `src/consumer.test.ts`.
4. Agent B completes its turns.
5. The `VerificationEngine` independently runs Task B's verification plan (typecheck + consumer unit tests).
6. The tests pass. Project Brain records Task B as **`VERIFIED`**.

**Result:** Agent B completed work directly dependent on Agent A without human intervention, without conversation transcript pollution, and with mathematical verification integrity.

---

## 6. What Orchestrate Is and Is Not

To maintain architectural integrity and prevent scope inflation, the following boundaries are strictly enforced:

| Capability | Orchestrate Hackathon MVP | Explicitly NOT Implemented |
|---|---|---|
| **Inference Provider** | Nebius Token Factory with selectable open-source models (e.g. NVIDIA Nemotron) | No OpenAI, Anthropic, OpenCode, or Ollama adapters |
| **Verification Scope** | Objective execution of configured test, lint, and build checks | No formal mathematical proofs; no assertion that passing checks equals infallible code |
| **Automated Repair** | Strictly bounded repair loop (maximum 2 automated attempts before `BLOCKED_NEEDS_HUMAN`) | No unbounded autonomous repair loops; no infinite retry cycles |
| **Context Retrieval** | Pure, deterministic compilation of Brain entities, git state, and upstream checks with token budgets | No vector databases, embeddings, semantic retrieval, or RAG |
| **Workspace Sandbox** | Local directory sandboxes with strict path containment and local Git repositories | No cloud-hosted sandboxes, Kubernetes clusters, or remote GitHub CI mutations |
| **Task Execution** | Deterministic sequential task orchestration with structured handoffs | No parallel multi-agent swarms, complex actor networks, or speculative caching |

---

## 7. Summary of Invariants

1. **Hierarchy Rule:** `CODE > VERIFICATION EVIDENCE > PROJECT BRAIN > AGENT CLAIMS`.
2. **Untrusted Input Rule:** All model-generated content (paths, shell commands, file edits, summaries) is untrusted input.
3. **Verification Invariant:** *"VERIFIED means the configured checks passed; it does not mean the code is proven correct."*
4. **Handoff Status Invariant:** An agent handoff is always created with status `CLAIMED`. Only passing `VerificationEngine` execution transitions a task to `VERIFIED`.
5. **Context Invariant:** Dependent agents receive compiled, evidence-backed XML context envelopes—never upstream conversational transcripts.
6. **Bounded Repair Invariant:** Tasks that fail verification may be retried at most twice before transitioning permanently to `BLOCKED_NEEDS_HUMAN`.
