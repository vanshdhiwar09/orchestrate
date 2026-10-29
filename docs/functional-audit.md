# Orchestrate Functional Audit & Recovery Plan

**Audit Date:** 2026-10-28  
**Audit Purpose:** Comprehensive operational audit of Orchestrate's user-facing functionality, API surface, domain layers, and persistent state.  
**Objective:** Identify all non-functional, decorative, or missing capabilities and define a concrete engineering recovery plan.

---

## 1. Executive Summary

Orchestrate possesses a high-discipline, tested domain architecture across its core packages:
- `packages/brain` implements an append-only SQLite store with migration tracking and verification gating.
- `packages/compiler` deterministically compiles verified project state, decisions, and conventions.
- `packages/verification` independently verifies commands and enforces source-code freshness.
- `packages/workspace` enforces path traversal containment and provides a full Git abstraction.
- `packages/core` contains a complete `Orchestrator` and `AgentRunner` lifecycle.

However, an audit of the HTTP Engine (`apps/engine`) and Web Frontend (`apps/web`) reveals a critical disconnect: **the core domain capabilities were never wired to the user interface.**
1. The "+ New Task" button was hardcoded disabled with `title="Task creation endpoint is not exposed by the Engine HTTP API"`.
2. The Engine API omitted `POST /projects/:id/tasks` and `POST /projects/:id/tasks/:taskId/run`.
3. Project creation accepted only `name` and `id`, without connecting to a local Git repository, GitHub repository, or creating an isolated workspace.
4. Users could not execute tasks, review diffs, or trigger verification loops from the UI.
5. Model provider configuration could not be set or validated through the UI.

This audit establishes the root causes, feature matrix, and the prioritized recovery plan.

---

## 2. Feature & Functional Gap Matrix

| Area | Feature | Current State | Root Cause | Severity | Required Fix |
| :--- | :--- | :--- | :--- | :---: | :--- |
| **Projects** | Project Creation (`name`, `id`) | **WORKING** | Correctly calls `POST /projects` and saves to SQLite. | Low | Retain; add repository fields. |
| **Projects** | Local Git Repository Onboarding | **MISSING** | No UI inputs, no repository validation endpoint. | **P0 (Blocker)** | Add local repo path input, validate existence, branch, and status via `LocalGitRepository`. |
| **Projects** | GitHub Repository Onboarding | **MISSING** | No GitHub URL validation or clone workflow. | **P0 (Blocker)** | Add GitHub URL field, clone to managed workspace folder, handle errors. |
| **Projects** | Empty Project Mode | **PARTIAL** | Projects created without repository can't specify lack of repo. | **P0 (Blocker)** | Explicitly flag project as empty; guard task execution when no repo exists. |
| **Tasks** | Task Creation UI | **BROKEN** | Button disabled with `title="Task creation endpoint is not exposed"`. | **P0 (Blocker)** | Build Task Creation Modal with title, description, acceptance criteria, upstream dependency. |
| **Tasks** | Task Creation API | **MISSING** | `POST /projects/:id/tasks` not registered in `server.ts`. | **P0 (Blocker)** | Implement `POST /projects/:id/tasks` with body validation and SQLite persistence. |
| **Tasks** | Task List API | **MISSING** | `GET /projects/:id/tasks` not registered in `server.ts`. | **P0 (Blocker)** | Implement `GET /projects/:id/tasks` returning tasks from `brain.listTasks(projectId)`. |
| **Tasks** | Task Lifecycle Execution | **MISSING** | `POST /projects/:id/tasks/:taskId/run` not implemented. | **P1 (Core)** | Wire `Orchestrator.executeTask()` to an HTTP run endpoint with async execution & status tracking. |
| **Tasks** | Task Detail View | **PARTIAL** | UI shows historical attempts, but cannot run or inspect live execution. | **P1 (Core)** | Add Run Task, Retry, Cancel controls, live log output, and diff inspection. |
| **Orchestration** | Isolated Workspace Preparation | **MISSING** | No workspace manager linking repo to task execution folder. | **P1 (Core)** | Create task workspace copies/worktrees to protect original repositories from corruption. |
| **Orchestration** | Tool Execution Sandbox | **WORKING (Domain)** | `createReadFileTool`, `createWriteFileTool`, `createExecuteCommandTool` exist in `packages/core`. | Medium | Instantiate tools against the task's isolated workspace. |
| **Orchestration** | Context Compilation Integration | **WORKING (Standalone)** | `GET /projects/:id/context` works, but not linked into task prep. | Medium | Show context preview inside task creation and task detail screens. |
| **Orchestration** | Independent Verification Gating | **WORKING (Domain)** | `VerificationEngine` exists in `packages/verification`. | Medium | Automatically run verification plan after agent completes work. |
| **Model** | Provider Configuration | **UI-ONLY** | Shows static badge from `GET /health`; no key entry or provider switch. | **P1 (Core)** | Add API key configuration in Settings with server-side validation and test provider support. |
| **Model** | Deterministic Test Provider | **MISSING IN ENGINE** | Tests had mocks in `packages/benchmark`, but engine had no offline test mode. | **P1 (Core)** | Add a deterministic test provider to engine so end-to-end flows run without paid credits. |
| **UX** | First-Run Onboarding Guide | **MISSING** | New user lands on empty screen without guidance. | **P2** | Add interactive 5-step checklist on project overview guiding onboarding to first verification. |

---

## 3. End-to-End Execution Trace

### Target End-to-End Workflow

```
[User in Browser]
       │
       ▼ 1. Project Creation
  Enters Name, ID, & selects Local Repo Path or GitHub URL
       │
       ▼ 2. Engine `POST /projects`
  Validates Git repository, detects default branch & status,
  records repository metadata in SQLite Project Brain
       │
       ▼ 3. Task Creation
  Enters Title, Description, Acceptance Criteria (e.g. `npm test`)
       │
       ▼ 4. Engine `POST /projects/:id/tasks`
  Validates input, persists task record to `tasks` table
       │
       ▼ 5. Task Execution `POST /projects/:id/tasks/:taskId/run`
  a. Prepares isolated workspace (cloned or copied from project repo)
  b. Context Compiler compiles verified upstream facts & conventions
  c. AgentRunner invokes model with tools (read_file, write_file, execute_command)
  d. Agent modifies code in isolated workspace
  e. Handoff created (`CLAIMED`) and persisted to Brain
  f. VerificationEngine executes acceptance checks (e.g. `npm test`)
  g. If checks pass -> Status `VERIFIED`; if checks fail -> Status `FAILED`
  h. Git diff captured between pre-execution and post-execution workspace
       │
       ▼ 6. UI Live Refresh
  Displays execution output, handoff claims, independent verification results,
  and inspectable Git diff.
```

---

## 4. Prioritized Recovery Plan

### Phase P0: Core Usability (Blocker)
1. **Engine Task Routes:**
   - `GET /projects/:id/tasks`
   - `POST /projects/:id/tasks`
   - `GET /projects/:id/tasks/:taskId`
2. **Engine Repository Onboarding Routes:**
   - `POST /projects/:id/repository/validate` (checks path or GitHub URL)
   - `POST /projects/:id/repository/import` (clones or links repo)
   - `GET /projects/:id/repository/status` (fetches branch, status, commits)
3. **Frontend Project Onboarding:**
   - Update New Project modal to support Local Git Repository, GitHub Clone, or Empty Project.
   - Show repository connection status, branch, and clean/dirty badge.
4. **Frontend Task Creation:**
   - Enable "+ New Task" button.
   - Build Task Creation Modal with title, description, verification plan (command, args), and model choice.

### Phase P1: Real Orchestration & Execution
1. **Engine Task Runner:**
   - Implement `POST /projects/:id/tasks/:taskId/run`.
   - Setup isolated workspace using `LocalWorkspace`.
   - Wire `Orchestrator.executeTask()` with `ContextCompiler`, `AgentRunner`, and `VerificationEngine`.
   - Support both live `NebiusModelClient` and deterministic `DeterministicTestModelClient` for offline testing.
2. **Frontend Task Execution Controls:**
   - Add "Run Task", "Retry", and execution progress indicator.
   - Show live or completed execution status, handoff summary, and verification check details.
   - Add Git diff viewer showing files modified during task run.
3. **Model Provider Setup:**
   - Add provider configuration card in Settings to securely configure `NEBIUS_API_KEY` or select Test Mode.

### Phase P2: Context Continuity & First-Run Experience
1. **Context Inspection in Task:**
   - Add "Inspect Compiled Context" modal on task detail view before running.
2. **First-Run Onboarding Checklist:**
   - Interactive checklist on Project Overview (Configure Provider -> Import Repo -> Create Task -> Inspect Context -> Run Agent -> Review Verification).

### Phase P3: Verification & Automated E2E Test Suite
1. Automated functional suite (`test/functional/e2e-workflow.test.ts`) exercising Workflows A through J without live credits.
2. Verify all 72 existing test suites pass.
3. Build check (`tsc -b` and `vite build apps/web`).
4. Generate `docs/functional-verification-report.md`.
