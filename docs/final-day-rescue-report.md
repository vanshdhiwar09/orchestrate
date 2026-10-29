# Orchestrate — Final-Day Rescue & Product Differentiation Report

## 1. Executive Summary

Orchestrate has been upgraded into a reliable, evidence-backed AI coding agent orchestration system. All core workflow bottlenecks, loop exhaustion failures, transparent UI modals, hardcoded host paths, and repository detachment issues have been resolved without breaking architectural boundaries or benchmark reproducibility.

### Core Achievements
1. **Agent Loop Exhaustion & Stalling Elimination**:
   - Resolved the issue where `AgentRunner reached maximum loop iterations (10) without reaching a final response`.
   - Replaced provider-incompatible `finishReason !== 'tool_calls'` checks with strict `hasToolCalls` array evaluation.
   - Added progressive loop control: tracking `filesWritten`, `lastCheckPassed`, consecutive errors, and duplicate tool-call rounds.
   - When required files are written and test checks exit 0, injected explicit completion guidance: `[Notice: Workspace files have been modified and verification checks passed. Please provide your final summary and finish without calling further tools.]`.
   - Added graceful halting on consecutive duplicate calls or unrecoverable tool errors.
   - In `Orchestrator`, when an agent modifies workspace files but concludes abruptly, captured state into a `CLAIMED` handoff and evaluated independent verification checks rather than terminating with an unhandled 500 error.

2. **Native OS File/Folder Picker & Scope Selection**:
   - Replaced all raw text prompts and hardcoded Windows paths with native browser file picker capabilities (`<input type="file" multiple>` and `<input type="file" webkitdirectory>` with fallback to `window.showDirectoryPicker()`).
   - Integrated a live **Target Scope** panel where users can select individual files or folders with instant file count badges and individual remove (`✕`) chips.
   - Eliminated all hardcoded drive letters (`C:\Users\...`) in user-facing forms and modals.

3. **Compact 4-Phase Stepper Execution Timeline**:
   - Replaced the growing event timeline with a 4-phase status stepper: `Plan (GLM-5.3-Flash) → Implement (Kimi-K2.6) → Review (Nemotron-3.5-Super-VL) → Verify (Independent Verification Engine)`.
   - Single active status line with live status dot.
   - Deduplicated polling updates and follow-tail auto-scrolling with bounded container height.

4. **Evidence-Backed Continuity & Product Differentiation**:
   - Task completion presents:
     - **What Changed**: Diff viewer via `GET /projects/:id/tasks/:id/diff`
     - **What Passed**: Test results table with independent check exit codes and stdout/stderr
     - **What Was Reviewed**: Reviewer card with verdict and commentary
     - **Project Context Used**: Persistent facts from Project Brain (architecture conventions, type contracts, source freshness).

5. **Multi-Model Nebius Token Factory Routing**:
   - Configured central `NEBIUS_MODEL_REGISTRY` with endpoint mapping:
     - Lead Planner: `zai-org/GLM-5.3-Flash` (`https://api.tokenfactory.us-north1.nebius.com/v1`)
     - Core Implementer: `moonshotai/Kimi-K2.6` (`https://api.tokenfactory.us-central1.nebius.com/v1`)
     - Code Reviewer: `nvidia/Nemotron-3.5-Super-VL` (`https://api.tokenfactory.us-north1.nebius.com/v1`)
     - General / Default: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (`https://api.tokenfactory.nebius.com/v1`)

---

## 2. Verification Evidence

- **Unit & Integration Suite**: 76 test files, 1,003 tests passing (100% pass rate).
- **TypeScript Strict Compilation**: `tsc -b` exits with 0 errors.
- **Frontend Production Build**: `vite build apps/web` completed in 129ms.
- **Benchmark Preflight**: All 4 scenarios validated clean; all 24 historical benchmark run files in `benchmarks/runs/` preserved with untouched SHAs.
