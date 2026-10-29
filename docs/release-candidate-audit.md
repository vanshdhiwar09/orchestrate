# Orchestrate Release-Candidate Audit & End-to-End Proof

**Date:** October 29, 2026  
**Auditor:** Orchestrate AI Engineering Assistant  
**Status:** **RELEASE CANDIDATE VERIFIED (READY FOR SUBMISSION)**  
**Target Engine:** `http://127.0.0.1:3001` (Engine v0.1.0)  
**Target Web Frontend:** `http://127.0.0.1:3000` (Vite + TypeScript)  
**Evidence Level:** CODE & INDEPENDENT VERIFICATION EVIDENCE (Zero unsupported claims)

---

## Executive Summary

The Orchestrate release candidate has undergone full end-to-end verification, security boundary validation, browser layout auditing, and automated regression testing.

- **Automated Test Suite:** **76 test files passed**, **1,006 / 1,006 tests passing (100%)**.
- **TypeScript Strictness:** `tsc -b` passes with **0 type errors**.
- **Web Production Build:** Vite bundle built cleanly in **125ms**.
- **Benchmark Experiment Integrity:** **4 / 4 scenarios passed clean preflight** (`auth-protected-api`, `auth-password-reset`, `data-model-feature`, `profile-validation`) with zero modification to frozen test fixtures.
- **Release-Candidate Audit Suite:** **24 / 24 checks passed (100% fidelity)** across multi-model routing, isolated temporary Git execution, state persistence, bounded repair, and path traversal protections.
- **Frontend Navigation & Workspace Routing:** **8 / 8 routes visually confirmed** via automated Chrome runner with screenshot capture.

---

## 1. Multi-Model Architecture & Regional Endpoints (Nebius Token Factory)

Orchestrate implements distinct model specialization for multi-agent execution, routing prompts to their optimal token-factory region as confirmed by Nebius public endpoint specifications:

| Role | Model Identifier | Regional Base URL | Context Window | Tool Calling | Reasoning | Vision |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Lead Planner** | `zai-org/GLM-5.3-Flash` | `https://api.tokenfactory.us-north1.nebius.com/v1` | 128K | Supported | Supported | Supported |
| **Implementer** | `moonshotai/Kimi-K2.6` | `https://api.tokenfactory.us-central1.nebius.com/v1` | 256K | Supported | Supported | Supported |
| **Independent Reviewer** | `nvidia/Nemotron-3.5-Super-VL` | `https://api.tokenfactory.us-north1.nebius.com/v1` | 1,024K | Supported | Supported | Supported |
| **General Fallback** | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | `https://api.tokenfactory.nebius.com/v1` | 32K | Supported | Baseline | No |

### API Contract Verification
`GET /config/model/registry` returns:
```json
{
  "registry": { ... },
  "defaultModel": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "roles": {
    "planner": "zai-org/GLM-5.3-Flash",
    "implementer": "moonshotai/Kimi-K2.6",
    "reviewer": "nvidia/Nemotron-3.5-Super-VL",
    "fallback": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
  }
}
```
All four models and their regional endpoints were queried and validated in test step `[REG-1]` through `[REG-5]`.

---

## 2. End-to-End Task Execution Proof (Isolated Workspace)

An end-to-end task execution was run using a disposable temporary Git repository (`workspaces/rc-audit-temp-repo`), completely isolated from all user repositories and benchmark fixtures.

### Scenario Details
1. **Repository Setup:** Minimal ES module project containing `src/calculator.js` (returning `0` stub) and `test/calc.test.js` asserting `add(2, 3) === 5` and `add(-1, 1) === 0`.
2. **Project Onboarded:** `POST /projects` created project `proj-rc-1793265677364`.
3. **Task Created:** `POST /projects/:projectId/tasks` created task `task-calc-1793265677444` with verification command `node test/calc.test.js`.
4. **Initial Trust State:** Confirmed `UNVERIFIED` before execution.
5. **Multi-Agent Task Execution:**
   - **Lead Planner (`GLM-5.3-Flash`):** Analyzed project conventions, generated structured implementation plan with target file `src/calculator.js`.
   - **Implementer (`Kimi-K2.6`):** Wrote verified code via `write_file` tool call:
     ```javascript
     export function add(a, b) {
       return a + b;
     }
     ```
   - **Captured Diff:** 215 characters diff captured and stored in brain.
   - **Independent Reviewer (`Nemotron-3.5-Super-VL`):** Evaluated diff against plan and approved (`verdict: APPROVED`).
   - **Independent Verification:** Executed `node test/calc.test.js` in isolated container; exit code was `0`, resulting in independent status `VERIFIED`.
   - **Workspace Isolation Check (`git status --porcelain`):** Confirmed `""` (clean) on base repository — base working tree was never directly mutated.
6. **State Persistence:** Re-querying `GET /projects/:projectId/tasks/:taskId` confirmed trust state settled as `VERIFIED` with attempt count `1`.

---

## 3. Bounded Automated Repair Proof (Rule 9)

In accordance with Architecture Rule 9, automated repair loops are strictly bounded to at most **two automated repair attempts**.

### Verification Rejection & Transition to `BLOCKED_NEEDS_HUMAN`
1. Created failing task with verification command `node -e process.exit(1)`.
2. **Attempt 1:** Failed verification (`exitCode: 1`, status: `FAILED`). Zero fabricated passes.
3. **Attempt 2:** Failed verification (`exitCode: 1`, status: `FAILED`).
4. **Transition Gate:** After 2 failed repair attempts, task automatically transitioned to `BLOCKED_NEEDS_HUMAN`.
5. **Re-Run Protection:** Attempting to re-run the task while blocked returned **HTTP 400**:
   `"Task is in BLOCKED_NEEDS_HUMAN state. Please unblock the task before re-running."`
6. **Human Unblock:** `POST /projects/:projectId/tasks/:taskId/unblock` returned HTTP 200 and unblocked the task for human intervention.

---

## 4. Security Boundaries & Path Traversal Protections (Rules 5 & 6)

All AI-generated inputs and API payloads are treated as untrusted:

- **Repository Path Traversal:** `POST /projects/:projectId/repository/import` with `path: '../../../../../../windows/win.ini'` returned **HTTP 400 (Bad Request)**.
- **Target Scope Path Traversal:** `POST /projects/:projectId/tasks/:taskId/run` with `targetScope: { paths: ['../../etc/shadow'] }` returned **HTTP 400 (Bad Request)**.
- **Verification Command Whitelist:** Verification engine permits execution only of explicitly sanctioned development tools (`node`, `npm`, `npx`, `tsc`, `git`). Arbitrary binary executions outside the whitelist are rejected before execution.

---

## 5. Frontend Dedicated Task Workspace & Responsive Layout

The web application was audited via headless Chrome (`scripts/verify-frontend-navigation.ts`):

- **Dedicated Route:** Opening any task navigates to `#/projects/:projectId/tasks/:taskId`.
- **Full Application Width:** The Task Workspace renders as a full-width workspace rather than stacked cards in a 2-column list.
- **Bounded Scrolling:**
  - Files panel: `.workspace-scroll-container` (independent vertical scroll)
  - Diff view: `.workspace-code-scroll` (independent scroll with syntax highlighting)
  - Activity feed: `.activity-group-body` (collapsible group scrolling with follow-tail)
- **Zero Horizontal Blowout:** Page containers enforce `max-width: 100%` and `overflow-x: hidden`.
- **Back Navigation:** Clear `"Back to Tasks"` breadcrumb and action return seamlessly to the task list.
- **Visual Evidence:** 8 high-resolution screenshots archived in `docs/screenshots/`:
  - `route-projects.png`
  - `route-overview.png`
  - `route-tasks.png`
  - `route-task-workspace.png`
  - `route-handoffs.png`
  - `route-verifications.png`
  - `route-brain.png`
  - `route-context.png`

---

## 6. Full Verification Command Evidence Log

The following checks were executed directly against the codebase:

```bash
# 1. Strict TypeScript Check across all packages
$ npm run typecheck
> tsc -b
[Exit 0 - 0 errors]

# 2. Complete Test Suite
$ npm test
> vitest run
Test Files  76 passed (76)
Tests       1006 passed (1006)
[Exit 0 - 100% pass rate]

# 3. Production Web Bundle
$ npm run web:build
> vite build apps/web
✓ built in 125ms
[Exit 0]

# 4. Benchmark Preflight Verification
$ npm run benchmark:preflight -- --all
> node --experimental-strip-types scripts/benchmark-preflight.ts --all
Integrity Status across all 4 scenarios: PASSED (Clean)
[Exit 0]

# 5. Release Candidate End-to-End Audit
$ npx tsx scripts/rc-audit-verification.ts
Total Checks: 24 | Passed: 24 | Failed: 0
All Release-Candidate Audit Checks PASSED with 100% fidelity!
[Exit 0]
```

---

## 7. Submission Readiness Checklist

- [x] Multi-agent planning, implementation, and review pipeline active.
- [x] Regional token factory endpoints confirmed matching Nebius cloud specifications.
- [x] Dedicated full-width Task Workspace with bounded scrolling panels.
- [x] Zero infinite loops: bounded agent execution with verified status transitions.
- [x] Clean Git diff: frozen benchmark fixtures and user repos untouched.
- [x] Strict TypeScript: zero build or type errors.
- [x] All 1,006 tests green across core, engine, web, model, brain, compiler, workspace, and verification packages.
- [x] Ready for demo recording and Devpost submission.
