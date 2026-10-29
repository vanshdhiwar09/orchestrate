# Orchestrate: Agent Execution Loop Recovery, Project Explorer & Live Timeline Report

## 1. Executive Summary

This report documents the resolution of the product-blocking defects reported during user testing of Orchestrate:
1. **Agent Loop Exhaustion**: Fixed the root cause behind `AgentRunner reached maximum loop iterations (10) without reaching a final response`.
2. **Repository Attachment & Onboarding**: Eliminated the `Cannot execute coding task: Project has no attached repository` error by introducing benchmark auto-resolution, a dedicated repository status bar, and one-click attachment.
3. **Live Execution Activity Timeline**: Enabled real-time progress updates with a live task event stream endpoint (`GET /projects/:projectId/tasks/:taskId/events`) so the UI never sits on an opaque spinner.
4. **Project Explorer & Code Viewer**: Implemented a navigable repository tree with folder expand/collapse, file inspection, syntax styling, line metrics, and file-scope checkboxes that pre-populate task context.
5. **Conversational Agent Panel & Verification**: Visualized model thoughts, tool calls with arguments/results, git diffs, and independent verification check outcomes.

---

## 2. Root Cause Analysis

### The `AgentRunner reached maximum loop iterations (10)` Bug

Tracing the execution path through `AgentRunner`, `ModelClient` (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`), and `Orchestrator` identified three concrete root causes:

1. **Missing Operational Completion Directive in Prompt**:
   - The compiled context previously contained only XML facts (`<orchestrate_context>...`), with no clear agent operating instructions or stopping criteria.
   - After invoking `write_file` in round 1, the model did not receive explicit instruction to conclude its turn. It assumed it needed to perform further checks or re-write files, continuing until the 10-iteration limit was exhausted.
   - When given explicit stopping rules in our diagnostic tests, Nemotron completed the task in **2 iterations** cleanly with `finishReason: "stop"`.

2. **No-Progress Consecutive Duplicate Tool Calls**:
   - When the agent repeated identical tool calls with identical arguments, `AgentRunner` executed them blindly.
   - There was no deduplication or runaway loop guard.

3. **Loss of Workspace Changes on Unhandled Exceptions**:
   - When the runner threw `AgentExecutionError`, `Orchestrator` rethrew without persisting the partial timeline or running verification against the already modified workspace.
   - The engine responded with an unhandled HTTP 500, causing the frontend to lose context and display an error state.

---

## 3. Implementation Details

### A. Core Agent Loop & Safeguards (`packages/core/src/runner.ts` & `orchestrator.ts`)
- **Consecutive Duplicate Detection**: Tracks recent tool signatures (`${name}:${arguments}`). On the first consecutive repeat, a warning note is injected into the tool output. On the second consecutive repeat, `AgentRunner` breaks gracefully and concludes the turn, preventing infinite loops.
- **Event Callbacks (`onEvent` / `onProgress`)**: Emits `round_start`, `model_response`, `tool_start`, `tool_complete`, `duplicate_tool_warning`, and `round_complete`.
- **System Operating Instructions**: Integrated clear directives into `Orchestrator.executeTask`:
  ```ts
  const systemPromptWithInstructions = [
    'You are an autonomous AI software engineering agent working in an isolated workspace.',
    'Your objective is to accomplish the assigned task by inspecting existing code and making minimal, targeted changes.',
    'Operating Rules:',
    '1. Read relevant repository files before modifying them.',
    '2. Write necessary files using `write_file`.',
    '3. Run build/test commands if necessary using `execute_command`.',
    '4. COMPLETION RULE: Once you have created or edited the required files and fulfilled the task objective, STOP CALLING TOOLS IMMEDIATELY. Output your final response summarizing changes made, files affected, and verification details.',
    '',
    serializedContext,
  ].join('\n\n');
  ```

### B. Engine Endpoints (`apps/engine/src/server.ts`)
1. **`GET /projects/:projectId/tasks/:taskId/events`**:
   - Returns `{ isRunning: boolean, events: [...], timeline: [...] }`.
   - Polled by the web frontend during agent execution.
2. **`GET /projects/:projectId/repository/tree?subpath=...`**:
   - Recursively traverses repository files and directories.
   - Filters out `.git`, `node_modules`, `dist`, `.next`, `build`, `.cache`, `.turbo`, and `.orchestrate`.
   - Returns full relative paths, file sizes, and directory hierarchy.
3. **`GET /projects/:projectId/repository/file?path=...`**:
   - Safely reads file contents within the project's repository boundary.
   - Guards against path traversal (`..` escaping project root).
   - Returns file text, line count, and byte size.
4. **Repository Auto-Resolution**:
   - If a project lacks a `repository_path` fact, the engine automatically checks `benchmarks/${projectId}` or `benchmarks/profile-validation` and links it as a verified system fact.

### C. Web Frontend Experience (`apps/web/src/components/placeholder-page.ts`)
1. **Live Activity Timeline**:
   - Displays real-time steps as they occur: Workspace Isolation $\rightarrow$ Context Compilation $\rightarrow$ AI Agent Turn $\rightarrow$ Tool Execution $\rightarrow$ Verification $\rightarrow$ Settled.
   - Includes live spinner and active agent status badge.
2. **Repository Status Bar**:
   - Displays current repository path and active git branch.
   - Includes one-click `📁 Browse Files & Scope` and `Attach Repository` buttons.
3. **Project Explorer & Code Viewer**:
   - Tree navigation on the left with directory expand/collapse.
   - Code viewer on the right with line counts, file sizes, and syntax formatting.
   - File scope checkboxes: select any file or folder and click `+ Create Task with Selected Scope` to pre-fill requirements and suggested verification commands.
4. **New Project Template Selector**:
   - New Project creation offers `Sample Benchmark Template (Recommended)` alongside `Import local repository`, `Clone from Git URL`, and `Empty project`.

---

## 4. Verification Evidence

### Test Suite Results
- **Vitest Workspace**: 76 test files passed (100%), 998 tests passed (100%).
- **TypeScript**: `tsc -b` typecheck passed with 0 errors.
- **Frontend Production Build**: `vite build apps/web` passed in 120ms.
- **Benchmark Preflight**: All 4 scenarios passed cleanly without inference.
- **Historical Benchmark Artifacts**: Untouched (0 modifications in `benchmarks/runs/`).

---

## 5. End-to-End User Testing Guide

To test the complete workflow locally:

### Step 1: Start the Engine and Frontend
1. In terminal 1:
   ```bash
   npm run engine:dev
   ```
   *(Starts on `http://127.0.0.1:3001` with SQLite brain and Nebius provider)*
2. In terminal 2:
   ```bash
   npm run web:dev
   ```
   *(Starts on `http://localhost:3000`)*

### Step 2: Open the Web UI
- Open browser to `http://localhost:3000/#/projects`.
- You will see existing projects (e.g., `profile-validation`).

### Step 3: Browse Repository Files in Project Explorer
- Click on **Profile Validation Benchmark** $\rightarrow$ Navigate to **Tasks**.
- Look at the top repository bar: you will see `📁 Repository: ...\benchmarks\profile-validation (main)`.
- Click **📁 Browse Files & Scope**:
  - The Project Explorer expands!
  - Click on `src/email-validator.ts` or `test/email.test.ts`.
  - The Code Viewer immediately displays the syntax-styled code and line counts.
  - Check the box next to `src/email-validator.ts` and click **+ Create Task with Selected Scope**.
  - The New Task modal opens with the scope and suggested verification command (`node --test`) pre-populated!

### Step 4: Run Autonomous Agent Task
- In the task list, select `#task-profile-validator` (or `#task-email-validator`).
- Click **Run Task**:
  - The **Execution Activity Timeline** activates immediately with live stream updates:
    - `Workspace Initialized` (attempt-N directory isolated)
    - `Context Compiled` (facts and repository state compiled from Brain)
    - `Live Inference Dispatched: nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B (Nebius)`
    - `Tool Invoked: write_file` / `read_file`
    - `Independent Verification: VERIFIED`
    - `Task Settled: VERIFIED`
  - The task status transitions to `VERIFIED`!
  - Under **Code Changes**, inspect the captured Git diff showing the exact changes made by the AI model!
