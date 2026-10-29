# AI Execution, Nebius Nemotron Default & UI Functionality Repair Report

**Date:** 2026-10-28  
**Repository:** Orchestrate (`c:\Users\VANSH\OneDrive\Desktop\orchestrate`)  
**Status:** VERIFIED  
**Author:** Antigravity Principal Engineering Agent  

---

## 1. Executive Summary & Root Cause Analysis

Following local developer evaluation, two product-blocking defect categories were identified in Orchestrate:

### Defect A: Lack of Genuine AI Model Execution & Default Nemotron Disconnect
1. **Silent Fallback to Mock Client:** In `apps/engine/src/server.ts`, the model client resolution function (`resolveModelClient`) defaulted to returning `new DeterministicTestModelClient()` whenever `userApiKey` was falsy, silently substituting static mock data instead of executing genuine AI inference or reporting missing credentials.
2. **Missing Environment Loading on Startup:** Neither `scripts/start-engine.ts` nor `apps/engine/src/server.ts` loaded root `.env` configuration on engine startup. As a result, even when operators placed `NEBIUS_API_KEY` in `.env`, `process.env.NEBIUS_API_KEY` was undefined, triggering the silent fallback to fake execution.
3. **Missing Execution Observability:** Task execution endpoints returned only minimal status flags, leaving users without insight into which model or provider ran, which tool calls were executed, what verification checks were evaluated, or the step-by-step progress of the run.

### Defect B: Transparent, Unreadable "Create New Task" Modal
1. **Missing CSS Custom Property:** In `apps/web/src/styles/tokens.css`, `--bg-surface` was undefined. In `apps/web/src/components/placeholder-page.ts`, the modal container used `background: var(--bg-surface);`, which evaluated to completely transparent in browsers.
2. **Inadequate Layering and Elevation:** The modal lacked an opaque backdrop, backdrop blur, and sufficient `z-index` layering (`z-index: 1000` / `1001`), allowing dashboard table text and navigation buttons underneath the modal to bleed through and clash with form inputs.
3. **Accessibility Gaps:** The dialog container lacked `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus trapping on open, focus restoration on dismiss, and Escape key dismissal.

---

## 2. Changes Made: Provider Wiring, Environment Loading & Model Resolution

### Engine Server (`apps/engine/src/server.ts`)
1. **Fail-Closed API Key Invariant:** Modified `resolveModelClient` so that it returns a typed `ResolvedModel { client, provider, model, isRealInference }`. If `userApiKey` is missing and deterministic test mode has not been explicitly activated via `--test-deterministic` or Settings, the engine **fails closed** with an HTTP 400/500 error:
   ```
   "Nebius API key is not configured. Please set NEBIUS_API_KEY in your .env file or
   configure it in Settings to execute tasks with nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B.
   (Or enable Deterministic Test Mode in Settings for offline evaluation)."
   ```
   Silent fallback to fake executors is completely eliminated.
2. **Default Model Anchor:** Fixed default model identifier to `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` on Nebius Token Factory (`https://api.tokenfactory.nebius.com/v1`).
3. **Runtime `.env` Loader:** Added automatic environment loading in `scripts/start-engine.ts` and `apps/engine/src/server.ts` using native `process.loadEnvFile()` (with robust fallback parsing). Guarded with `loadEnv !== false && !process.env.VITEST` to prevent automated test suites from consuming live inference credits.
4. **Structured Execution Timeline Recording:** Augmented `POST /projects/:projectId/tasks/:taskId/run` to record and return a granular execution activity timeline (`executionTimeline`):
   - `Workspace Isolation`: Isolated scratch workspace allocation and Git commit snapshot.
   - `Context Compiled`: Compiled project conventions, active decisions, and upstream task facts into context tokens.
   - `AI Inference Dispatch`: Model request dispatch to Nebius Token Factory with model identifier.
   - `Tool Executions`: Agent workspace tools invoked (`read_file`, `write_file`, `execute_command`).
   - `Structured Handoff`: Recording agent handoff record into the Project Brain.
   - `Independent Verification`: Execution of configured independent test/build checks.
   - `Trust State Settled`: Transition of task trust state (`VERIFIED`, `FAILED`, or `BLOCKED_NEEDS_HUMAN`).

### Frontend Service Client (`apps/web/src/services/engine-client.ts`)
Updated `TaskDetailDto` and `TaskRunResultDto` interfaces to propagate `model`, `provider`, `isRealInference`, and `executionTimeline`.

---

## 3. Default Model Confirmation

The default model for Orchestrate task execution is explicitly anchored to:
- **Model ID:** `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`
- **Provider:** Nebius Token Factory
- **Base URL:** `https://api.tokenfactory.nebius.com/v1`
- **Endpoint:** `/chat/completions`

This is verified across:
- `apps/engine/src/server.ts` (`DEFAULT_MODEL_ID = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B'`)
- `scripts/start-engine.ts` (Startup diagnostics banner)
- `apps/web/src/components/placeholder-page.ts` (Autonomous Agent Execution badge)
- `test/unit/nebius-provider-wiring.test.ts` (Automated provider wiring assertions)

---

## 4. UI Modal Styling, Accessibility & Layering Repairs

### Design Tokens (`apps/web/src/styles/tokens.css`)
- Defined `--bg-surface: #ffffff;` ensuring consistent opaque white card backgrounds.

### Stylesheet Rules (`apps/web/src/styles/main.css`)
- **`.modal-backdrop`:**
  - `position: fixed; inset: 0;`
  - `background-color: rgba(15, 23, 42, 0.45);`
  - `backdrop-filter: blur(4px);`
  - `z-index: 1000;`
  - `display: flex; align-items: center; justify-content: center;`
- **`.modal-dialog`:**
  - `background-color: #ffffff !important;`
  - `color: var(--text-primary);`
  - `border: 1px solid var(--border-strong);`
  - `border-radius: var(--radius-xl);`
  - `box-shadow: 0 20px 45px rgba(20, 20, 19, 0.28), 0 4px 12px rgba(20, 20, 19, 0.1);`
  - `z-index: 1001;`
  - `max-width: 560px; max-height: 90vh; overflow-y: auto;`
- **`.modal-header`, `.modal-title`, `.modal-close-btn`, `.modal-footer`:**
  - Crisp typography, high-contrast close button, clear form field spacing, and sticky modal footer.

### Dialog Semantics & Lifecycle (`apps/web/src/components/placeholder-page.ts`)
- Added `role="dialog"`, `aria-modal="true"`, and `aria-labelledby="modal-task-title"`.
- Attached click-outside / backdrop dismissal with `event.stopPropagation()` on the dialog container.
- Added keyboard handler for `Escape` key dismissal.
- Added focus trap on dialog open and focus restoration to the trigger button on close.

---

## 5. Execution Activity Timeline

The Task Detail view now renders an interactive, real-time Execution Activity Timeline upon task run:

| Timeline Step | State Indicator | Content Rendered |
|---|---|---|
| **Workspace Isolation** | `COMPLETED` | Isolated attempt directory path, scratch repository initialization |
| **Context Compiled** | `COMPLETED` | Fact compilation, convention extraction, token usage |
| **AI Inference Dispatch** | `COMPLETED` | Provider name (`nebius`), model ID (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) |
| **Tool Executions** | `COMPLETED` | Number of tool calls, tool names (`read_file`, `write_file`, `execute_command`) |
| **Structured Handoff** | `COMPLETED` | Handoff ID, modified files list, active decisions recorded |
| **Independent Verification** | `PASSED` / `FAILED` | Check name, CLI command, exit code, execution duration (ms) |
| **Trust State Settled** | `VERIFIED` / `FAILED` | Final derived trust state based on independent evaluation evidence |

When credentials are not configured, the Task Detail card displays a clear alert linking directly to `#/settings` rather than allowing unauthenticated runs to fail silently.

---

## 6. Automated Test Results

All automated test suites pass cleanly across unit, web, engine, and functional suites:

```
 RUN  v5.0.2 C:/Users/VANSH/OneDrive/Desktop/orchestrate

 ✓ apps/web/test/engine-client.test.ts (14 tests)
 ✓ apps/web/test/overview.test.ts (8 tests)
 ✓ apps/web/test/settings.test.ts (14 tests)
 ✓ apps/web/test/tasks.test.ts (8 tests)
 ✓ apps/web/test/handoffs-verifications.test.ts (11 tests)
 ✓ apps/web/test/router.test.ts (7 tests)
 ✓ apps/web/test/modal-and-timeline.test.ts (3 tests)
 ✓ apps/web/test/components.test.ts (11 tests)
 ✓ apps/web/test/context-compiler.test.ts (15 tests)
 ✓ apps/web/test/project-brain.test.ts (15 tests)
 ✓ apps/engine/test/server.test.ts (25 tests)
 ✓ test/unit/nebius-provider-wiring.test.ts (4 tests)
 ✓ apps/engine/test/repository-and-tasks.test.ts (7 tests)
 ✓ test/functional/e2e-workflows.test.ts (10 tests)

 Test Files  14 passed (14)
      Tests  152 passed (152)
   Duration  7.15s
```

### Key Newly Added Test Files:
1. `test/unit/nebius-provider-wiring.test.ts`:
   - Confirms `NebiusModelClient` requires API key and defaults to Nebius Token Factory endpoint.
   - Validates JSON payload serialization with `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, messages, and tools format.
   - Verifies Engine rejects task run when `NEBIUS_API_KEY` is missing without silent fallback (fail-closed).
   - Verifies Engine allows deterministic test mode client when explicitly configured.
2. `apps/web/test/modal-and-timeline.test.ts`:
   - Validates `--bg-surface: #ffffff;` token and `.modal-dialog` opaque white styling with `z-index: 1001`.
   - Validates modal accessibility attributes (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`).
   - Validates Autonomous Agent Execution card with default Nemotron badge and timeline container.

---

## 7. Live Inference Verification & Opt-In Safety Gate

### Safety Invariant
In compliance with Rule 1 and P0 Requirement 1, live inference credits were **never consumed during development or automated test runs**.

### Dedicated Smoke Test (`scripts/live-smoke-test.ts`)
A dedicated opt-in verification tool is provided at `scripts/live-smoke-test.ts`.

#### Safety Gate Execution (No Credits Authorized)
```bash
node --experimental-strip-types scripts/live-smoke-test.ts
```
**Output:**
```
======================================================================
ORCHESTRATE — NEBIUS LIVE INFERENCE SMOKE TEST
Default Model: nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B
Provider: Nebius Token Factory (https://api.tokenfactory.nebius.com/v1)
======================================================================

[SAFETY GATE] Live inference authorization not provided.
Zero live requests were made; zero inference credits were spent.

To run a single verified live call to Nebius Token Factory, re-run with:
  node --experimental-strip-types scripts/live-smoke-test.ts --authorize-credits
  or set AUTHORIZE_LIVE_CREDITS=true
======================================================================
```

#### Authorized Operator Execution
When an operator with active credits authorizes live verification:
```bash
node --experimental-strip-types scripts/live-smoke-test.ts --authorize-credits
```
The script will perform a single, minimal 16-token ping to `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` on Nebius Token Factory and output exact latency, finish reason, and token usage.

---

## 8. Browser Navigation & Visual Verification

Automated browser verification using headless Google Chrome (`scripts/verify-frontend-navigation.ts` with `--virtual-time-budget=3000`) confirmed 8/8 routes and components:

```
===============================================================
 Frontend Route Verification Summary
===============================================================
[PASSED] #/projects (4 assertions)
[PASSED] #/settings (4 assertions)
[PASSED] #/projects/profile-validation/overview (4 assertions)
[PASSED] #/projects/profile-validation/tasks (9 assertions)
[PASSED] #/projects/profile-validation/tasks?task=task-email-validator (7 assertions)
[PASSED] #/projects/profile-validation/handoffs (3 assertions)
[PASSED] #/projects/profile-validation/context (4 assertions)
[PASSED] #/projects/profile-validation/brain (3 assertions)

All frontend routes rendered and verified successfully in Chrome!
```

### Captured Visual Artifacts (`docs/screenshots/`):
- `01_projects_index.png`: Clean project catalog and creation CTA.
- `02_settings.png`: Model provider settings and API key configuration.
- `03_project_overview.png`: Evidence-backed project workspace overview.
- `04_tasks_explorer.png`: Task explorer with accessible, opaque "Create New Task" modal structure.
- `04b_task_detail.png`: Task Detail view with Autonomous Agent Execution card, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B (Nebius)` model badge, run button, and timeline container.
- `05_handoffs_verifications.png`: Handoff and verification log.
- `06_context_compiler.png`: Evidence compiler interface.
- `07_project_brain.png`: SQLite Brain fact inspection.

---

## 9. Historical Benchmark Artifact Integrity

All 24 historical benchmark files in `benchmarks/runs/` were audited. Not a single byte or hash was altered:

| Benchmark Run Directory | SHA-256 (Summary JSON) | Status |
|---|---|---|
| `eval-auth-protected-api-20261028-093546` | `c72ba32c7d8116386f7400083012e3afe4e3cb8dc149ad35b60754ca515fef4c` | UNCHANGED |
| `eval-auth-protected-api-20261028-run2` | `ecb6b4ef8f8477acc0802fd516c280200fe996548ea6dfbfd24a89b53ab2c4ce` | UNCHANGED |
| `eval-profile-validation-20261028-run1` | `be6de4843272b38160421ac8100bd85f0ec7f25782306040e133b116d3dfdb61` | UNCHANGED |
| `eval-profile-validation-20261028-run2` | `87e27f9479daff5f2b22506965ae147cb6076533c9b62177c54fd6153b08ef5d` | UNCHANGED |
| `eval-profile-validation-20261028-run3` | `4984464e696c5f8b11048d9edd158cace6b247a1e79c010ada86024e28503db4` | UNCHANGED |
| `eval-profile-validation-20261028-run4` | `42de12a73254dfa60321fc1670fb620a22acd5412ef1a42412c24f09fab3d92c` | UNCHANGED |
| `smoke-auth-protected-api-20261023-2053` | `2fe9a3a0a02e027a0261b1e5aeaad67b30a2114b22f6ad8ebbee7183abf96351` | UNCHANGED |
| `smoke-auth-protected-api-20261023-2145` | `44789bb85bce70b9a843a2e40c0eef595a97e635120871806aa964c3d47aad63` | UNCHANGED |

`git status benchmarks/runs` confirms working tree is completely clean.

---

## 10. Limitations & Future Work

1. **Streaming Token Display:** The current engine uses turn-by-turn completion responses from Nebius Token Factory. Real-time token streaming over WebSockets could further enhance UI responsiveness during longer inference passes.
2. **Multi-Model Orchestration:** The system demonstrates `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` as the primary default open-source model. Support for switching between different models deployed on Nebius Token Factory is built into the architecture and settings UI.
3. **Hosted Deployment:** For cloud deployment, ensure `NEBIUS_API_KEY` is provided through a managed secret store rather than a plain `.env` file.
