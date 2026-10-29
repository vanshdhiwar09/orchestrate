# Orchestrate Final Benchmark Evaluation Report & Closure

**Document Status:** FROZEN EVALUATION RECORD  
**Closure Date:** 2026-10-28  
**Model Under Evaluation:** `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`  
**Inference Provider:** Nebius Token Factory  
**Controlled Policy:** `CONTROLLED_PER_ARM_BUDGET` (10,000 tokens/arm, 30,000 tokens aggregate ceiling)  
**Replication Count:** $N=1$ exploratory run  

---

## 1. Formal Declaration of Evaluation Closure

The benchmark evaluation phase for the Orchestrate Hackathon MVP is **officially closed and frozen**.

No further live inference calls, model invocations, experimental replications, or benchmark prompt adjustments will be performed. All findings below represent the final, sealed, and audited empirical outcomes of the experimental harness.

---

## 2. Executive Summary of Experimental Findings

Across iterative harness hardening passes (Runs 1–3) culminating in the authorized live trial (**Run 4**), the Orchestrate evaluation measured downstream agent performance across three experimental arms on the `profile-validation` task:

1. **ARM A (Baseline — Repository Only):** FAILED independent verification (0/1, 0.0%). Agent exhausted 9,870 tokens across multiple tool exploratory loops without producing a passing implementation.
2. **ARM B (Unverified Handoff — Claims Only):** FAILED independent verification (0/1, 0.0%). Agent consumed 5,914 tokens and generated code based on upstream agent claims, but suffered a fatal runtime syntax error (`SyntaxError: The requested module '...' does not provide an export named 'ValidationResult'`) under Node 24 type stripping.
3. **ARM C (Orchestrate — Evidence-Backed Context & Conventions):** **VERIFIED (1/1, 100.0%)**. Agent completed the task using 7,653 tokens, adhered to compiled type-only import conventions, and passed all 9 independent acceptance test assertions on the first verification attempt.

| Experimental Arm | Status | Tokens Used | Budget Adherence | Acceptance Tests | Independent Verification |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **ARM A (Baseline)** | FAILED | 9,870 / 10,000 | PASS (0 overshoot) | 0/9 Passed | FAILED |
| **ARM B (Unverified Handoff)** | FAILED | 5,914 / 10,000 | PASS (0 overshoot) | 0/9 Passed | FAILED |
| **ARM C (Orchestrate)** | **VERIFIED** | **7,653 / 10,000** | **PASS (0 overshoot)** | **9/9 Passed (100%)** | **VERIFIED** |

---

## 3. Iterative Benchmark Hardening History

The evaluation progressed through four controlled trials on the `profile-validation` scenario:

### 3.1 Run 1 (`eval-profile-validation-20261028-run1`)
- **Outcome:** All three arms stopped prior to implementing `src/validate-profile.ts`.
- **Root Cause:** A static 4,096-token maximum completion reservation blocked further model dispatches when remaining arm budget dipped below 4,096 tokens, despite 1,856–3,392 tokens remaining.
- **Remediation:** Designed and implemented `TokenBudgetGuard.reserveAdaptive()`, dynamically clamping outbound `maxTokens` to fit within remaining budget down to a 256-token minimum floor.

### 3.2 Run 2 (`eval-profile-validation-20261028-run2`)
- **Outcome:** Adaptive reservations allowed agents to complete implementations, but all arms failed verification due to missing repository context conventions (e.g., Node.js ESM `.ts`/`.js` extension requirements).
- **Remediation:** Integrated repository convention extraction into the context compilation pipeline, providing downstream agents with explicit file extension and module syntax conventions.

### 3.3 Run 3 (`eval-profile-validation-20261028-run3`)
- **Outcome:** Arm B overshot its 10,000-token per-arm limit by 353 tokens (10,353 total tokens).
- **Root Cause:** Prompt token estimation accounted only for message content and omitted serialized tool definitions sent in the API request payload. Additionally, Node 24 runtime type stripping caused syntax errors when types were imported without `import type`.
- **Remediation:** Updated `estimatePromptTokens` to serialize all tool schemas and include configurable safety headroom. Added `type_import_convention` to the scenario context catalog.

### 3.4 Run 4 (`eval-profile-validation-20261028-run4`) — Final Authorized Live Trial
- **Outcome:** Perfect budget accounting (zero token overshoot across all arms; aggregate 23,437 tokens $\le 30,000$). Arm C achieved `VERIFIED` status with 100% acceptance test pass rate.
- **Sealed Artifacts:**
  - Report: `benchmarks/runs/eval-profile-validation-20261028-run4/benchmark-report.md`
  - Summary: `benchmarks/runs/eval-profile-validation-20261028-run4/benchmark-summary.json`
  - Raw Trial Data: `benchmarks/runs/eval-profile-validation-20261028-run4/trial-profile-validation-r1-1793180363619.json`

---

## 4. Mandatory Methodological Disclosures & Limitations

In accordance with strict empirical integrity guidelines, the following limitations are explicitly recorded:

1. **Exploratory Sample Size ($N=1$):**  
   This evaluation reflects a single-replication exploratory trial. No claim of formal statistical significance ($p < 0.05$) or broad generalizability across arbitrary codebases is made.
2. **Intent-to-Treat Denominators:**  
   All arms are evaluated against the total planned runs. Incomplete, failed, or budget-exhausted runs are retained in the denominator to avoid survivorship bias.
3. **Tuned Context Conventions:**  
   Arm C's success relied on the Project Brain's ability to supply verified TypeScript import conventions tailored to Node 24's runtime type stripping. Arms A and B lacked this structured knowledge and failed due to environment-specific syntax errors.
4. **Agent Loop Budget Exhaustion:**  
   In complex scenarios without structured handoffs, unassisted agents (Arm A) readily exhaust their token budget on redundant file discovery operations before reaching implementation.
5. **Honest Cost Accounting:**  
   Because inference provider telemetry does not supply exact real-time billing rates, monetary costs are reported as "Unknown (no billing telemetry)". Fabricated or estimated dollar amounts are strictly avoided. Accurate financial limits must be enforced via provider project quotas.

---

## 5. Summary Table: All Benchmark Artifacts

The repository maintains an immutable record of all 24 benchmark files across 8 evaluation directories:

| Directory | Trials | Valid | Status |
| :--- | :---: | :---: | :---: |
| `eval-auth-protected-api-20261028-093546` | 1 | 1 | Sealed Historical |
| `eval-auth-protected-api-20261028-run2` | 1 | 1 | Sealed Historical |
| `eval-profile-validation-20261028-run1` | 1 | 1 | Sealed Historical |
| `eval-profile-validation-20261028-run2` | 1 | 1 | Sealed Historical |
| `eval-profile-validation-20261028-run3` | 1 | 1 | Sealed Historical |
| `eval-profile-validation-20261028-run4` | 1 | 1 | **Final Live Evaluation** |
| `smoke-auth-protected-api-20261023-2053` | 1 | 1 | Preflight Smoke |
| `smoke-auth-protected-api-20261023-2145` | 1 | 1 | Preflight Smoke |

**Hash Verification:** All 24 SHA-256 hashes match verified baseline values.
