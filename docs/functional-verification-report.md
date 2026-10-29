# Orchestrate — Functional Verification Report

**Status:** ALL WORKFLOWS VERIFIED  
**Date:** October 28, 2026  
**Test Suite:** `test/functional/e2e-workflows.test.ts`  
**Execution Environment:** Node.js v24.19.0, Vitest v5.0.2, Windows x64  
**Paid Model API Cost Incurred:** \$0.00 (Safe offline deterministic test mode)

---

## 1. Executive Summary

Orchestrate has successfully transitioned from an unintegrated UI shell with mock fallbacks into a fully functional, evidence-backed AI agent orchestration system. 

Every stage of the engineering pipeline is now wired, functional, and independently verified:
$$\text{UI Action} \longrightarrow \text{Frontend EngineClient} \longrightarrow \text{Engine HTTP API} \longrightarrow \text{Domain Services} \longrightarrow \text{Workspace / AgentRunner} \longrightarrow \text{VerificationEngine} \longrightarrow \text{Project Brain}$$

No decorative buttons, mock fallbacks, or fake progress indicators remain. All 10 end-to-end workflows (Workflows A through J) passed their automated tests with 100% pass rate.

---

## 2. Workflows A through J Verification Matrix

| Workflow | Description | Status | Duration | Key Assertions & Evidence |
| :--- | :--- | :---: | :---: | :--- |
| **Workflow A** | **Project Onboarding & Repository Connection** | `VERIFIED` | 537 ms | Validated local repository directory, checked Git integrity and clean status, persisted `repository_path`, `repository_type`, and `repository_branch` facts into SQLite Brain, verified `GET /projects/:id/repository/status`. |
| **Workflow B** | **Task Creation & Specification** | `VERIFIED` | 341 ms | Created task entity with title, description, acceptance criteria, and verification commands in Brain; verified zero-attempt task is listed with `UNVERIFIED` trust state and 0 recorded attempts. |
| **Workflow C** | **Single-Task Autonomous Execution** | `VERIFIED` | 702 ms | Agent performed workspace tool calls (`write_file`), recorded structured handoff (`CLAIMED`), executed independent verification checks (`VERIFIED`), captured unified Git diff, updated Brain trust state to `VERIFIED`. |
| **Workflow D** | **Verification Failure & Bounded Repair (Rule 9)** | `VERIFIED` | 999 ms | Failed task verification recorded as `FAILED`; automated repair retry executed; upon exhausting 2 repair attempts, transitioned to `BLOCKED_NEEDS_HUMAN`; rejected further run requests with HTTP 400; unblocked via `POST /unblock`. |
| **Workflow E** | **Multi-Task Dependent Workflow (Context Compiler)** | `VERIFIED` | 1,034 ms | Verified Task A state extracted by Context Compiler; upstream handoff and decisions injected into Task B prompt without raw conversation history leakage; Task B executed and verified. |
| **Workflow F** | **Error Handling & System Invariants** | `VERIFIED` | 247 ms | Prevented task execution on projects without connected repositories (HTTP 400); rejected invalid directories; rejected empty task titles; rejected requests on non-existent entities (HTTP 404). |
| **Workflow G** | **Git Safety & Workspace Isolation** | `VERIFIED` | 674 ms | Task executed strictly in isolated workspace (`workspaces/tasks/<projectId>/<taskId>/attempt-1`); base repository on disk remained completely unmodified; untracked files properly captured in unified diff. |
| **Workflow H** | **Frontend Service Integration (EngineClient)** | `VERIFIED` | 811 ms | `EngineClient` successfully called `getModelConfig`, `saveModelConfig`, `validateRepository`, `createProject`, `getRepositoryStatus`, `createTask`, `listTasks`, `runTask`, `getTaskDiff`, and `getTask`. |
| **Workflow I** | **Persistence Across Engine Restart** | `VERIFIED` | 644 ms | Engine stopped and Brain closed; new Engine started against the same SQLite file; verified 100% of projects, tasks, facts, handoffs, and verification history remained intact. |
| **Workflow J** | **Safe Zero-Credit Invariant** | `VERIFIED` | 227 ms | Verified offline deterministic test model client prevents accidental provider requests, network leaks, and credit consumption during automated verification suites. |

**Total Suite Duration:** ~6.24 seconds  
**Tests Passed:** 10 / 10 (100%)

---

## 3. Monorepo Regression Verification

In addition to the end-to-end functional test suite, all component-level test suites, TypeScript compilation, and production web bundling were executed:

1. **TypeScript Typecheck (`tsc -b`):** Passed with code 0 (Zero type errors).
2. **Web Production Build (`npm run web:build`):** Built in 119ms (`apps/web/dist` generated cleanly).
3. **Web Test Suite (`apps/web/test`):** 9 test files, 103 tests passed.
4. **Engine Test Suite (`apps/engine/test`):** 2 test files, 32 tests passed.
5. **Historical Benchmark Integrity:** All 24 files in `benchmarks/runs/` verified intact and untouched.

---

## 4. Manual Verification Instructions

To verify the Orchestrate application manually in your local environment:

### Step 1: Start the Orchestrate Engine
In a terminal, run:
```bash
npm run engine:dev
```
The engine starts on `http://127.0.0.1:3001` with SQLite persistence in `./orchestrate.sqlite` and workspaces in `./workspaces`.

### Step 2: Start the Web Interface
In a second terminal, run:
```bash
npm run web:dev
```
Open `http://localhost:5173` in your browser. The connection badge in the top-right will indicate `Connected` to the engine.

### Step 3: Configure Model Provider or Test Mode
1. Click **Settings** in the left navigation sidebar.
2. Under **Model Provider (Nebius Token Factory)**:
   - For offline zero-credit evaluation: Select **Deterministic Test Mode (Offline / Free)** and click **Save Changes**.
   - For live AI inference: Select **Nebius AI (Live Inference)**, enter your Nebius API Key, and click **Save Changes**.

### Step 4: Create a Project with Repository Onboarding
1. Click **+ New Project** in the project selector or navigate to `/projects`.
2. Enter a project name (e.g. `My Test Project`).
3. Under **Repository Configuration**:
   - Choose **Import existing repository**.
   - Enter the absolute path to any local Git repository (or the Orchestrate repository itself).
   - Click **Validate Path** — the badge will confirm valid Git status, branch name, and clean/dirty state.
4. Click **Create Project**. The project will open with the live **Repository Status Banner** showing the branch, commit, and sync state.

### Step 5: Create and Run a Task
1. Click **+ New Task** on the Project Overview or Tasks screen.
2. Enter:
   - **Title:** `Implement Greetings Helper`
   - **Description:** `Create src/feature.js with execute method`
   - **Acceptance Criteria:** `Module must export execute function`
   - **Verification Command:** `node --version` (or your custom test command)
3. Click **Create Task**. The task appears immediately in the task list in `UNVERIFIED` state.
4. Click the task to open the **Task Detail** screen.
5. Click **Run Task**:
   - The agent executes within an isolated workspace directory.
   - The Attempt Inspector updates with the structured handoff (`CLAIMED`).
   - The Independent Verification card displays the command output, exit code, and execution duration.
   - The **Code Changes (Git Diff)** section displays the unified diff of changes made by the agent.
   - The Task Trust State updates to `VERIFIED`.
