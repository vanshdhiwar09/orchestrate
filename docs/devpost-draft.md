# Orchestrate — Devpost Submission Draft

**Project Title:** Orchestrate — Evidence-Backed AI Engineering  
**Tagline:** Coordinating coding agents through evidence-backed state, verified handoffs, and persistent project brains.

---

## 1. Project Links

- **GitHub Repository:** `[INSERT_REPOSITORY_URL]`
- **Live Demo Video (YouTube/Loom):** `[INSERT_VIDEO_URL]`
- **Deployed Web Application:** `[INSERT_DEPLOYED_URL_OR_LOCAL_DEMO]`
- **Documentation:** `docs/` (`docs/api-contract.md`, `docs/evaluation-final.md`, `docs/deployment.md`)

---

## 2. Inspiration

Autonomous coding agents are rapidly progressing from single-file code completion to multi-step engineering pipelines. However, when agents collaborate sequentially on the same codebase, they suffer from a fundamental failure mode: **the propagation of unverified claims**.

Agent A makes a change, declares success in natural language, and hands off to Agent B. If Agent A's claim contains subtle hallucinated assumptions, misses local runtime conventions (such as Node.js ESM extension requirements), or fails silent edge cases, Agent B either crashes or spends thousands of expensive model tokens exploring files to rediscover what was actually done.

We asked: *What if AI agents collaborated using the same source-of-truth hierarchy that high-discipline human engineering teams use?*

$$\text{CODE} \longrightarrow \text{VERIFICATION EVIDENCE} \longrightarrow \text{PROJECT BRAIN} \longrightarrow \text{AGENT CLAIMS}$$

---

## 3. What It Does

**Orchestrate** is an AI agent orchestration system that coordinates coding agents while maintaining persistent, evidence-backed project state.

Key capabilities:
1. **Source-of-Truth Hierarchy:** Agent claims are explicitly classified as untrusted assertions. Nothing enters the persistent Project Brain until independent, automated verification passes.
2. **Persistent Project Brain:** Backed by SQLite in WAL mode, the Project Brain records immutable facts, active architectural decisions, task attempts, and verification evidence.
3. **Deterministic Context Compiler:** Instead of dumping raw chat logs or unbounded repository listings into downstream prompts, the Context Compiler synthesizes only relevant verified state and repository conventions into clean context envelopes (`<orchestrate_context>`).
4. **Independent Verification Engine:** Evaluates type checks, unit tests, and acceptance suites inside sandboxed workspace checkouts, producing cryptographically sealed evidence records with zero human tampering.
5. **Modern Web Inspection UI:** A clean, responsive dashboard (Vite + React + Tailwind CSS) providing live visibility into project health, task attempts, structured handoffs, and verification evidence.

---

## 4. How We Built It

- **AI Model & Inference Provider:** Powered by **Nebius Token Factory**, running the high-performance open model `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`.
- **Backend HTTP Engine:** Native, dependency-disciplined Node.js HTTP server written in TypeScript, exposing 6 validated routes with zero external framework bloat.
- **Persistence Layer:** Built on SQLite (`node:sqlite`) with versioned migrations, foreign key constraints, and write-ahead logging (WAL) for durability.
- **Frontend Client:** Built with TypeScript, Vite, and modern CSS design tokens, following strict accessibility and contrast standards.
- **Benchmarking & Experimental Rigor:** A fully instrumented 3-arm benchmark harness measuring token consumption, tool discovery efficiency, rework events, and verification pass ratios under strict budget caps.

---

## 5. Challenges We Overcame

1. **Token Budget Exhaustion & Adaptive Reservations:** In early trials, static completion reservations prevented agents from taking actions when nearing budget limits. We engineered `TokenBudgetGuard.reserveAdaptive()`, which dynamically clamps outbound model limits down to a safe minimum floor while maintaining strict per-arm budget ceilings.
2. **Tool Schema Accounting:** Provider APIs charge tokens for serialized tool definitions. We hardened our budget estimators to serialize the full tool payload and incorporate safety headroom, eliminating budget overshoots.
3. **Runtime Type-Stripping Traps in Node.js 24:** Under Node 24 ESM, importing TypeScript interfaces without `import type` causes fatal runtime syntax errors. By extracting this convention into the Project Brain, Orchestrate's context compiler enabled downstream agents to avoid this pitfall entirely.

---

## 6. Accomplishments That We're Proud Of

- **Empirical 3-Arm Live Benchmark:** In our frozen evaluation trial on `profile-validation` using Nebius Token Factory:
  - **Arm A (Baseline):** 0/1 (0%) pass rate, exhausting budget on redundant discovery.
  - **Arm B (Unverified Handoff):** 0/1 (0%) pass rate, crashing with runtime syntax errors.
  - **Arm C (Orchestrate):** **1/1 (100%) pass rate**, passing all 9 acceptance test assertions on the first attempt with 7,653 tokens consumed.
- **Extreme Architecture Discipline:** Over 970 automated tests passing across 72 test suites, clean TypeScript builds, and zero circular dependencies.
- **Honest Telemetry:** Full commitment to scientific integrity—reporting unknown monetary costs rather than fabricating fake zeroes, and enforcing intent-to-treat denominators.

---

## 7. What We Learned

- Natural language handoffs between AI agents are brittle and prone to error compounding. Structured, verification-backed state is required for reliable multi-agent engineering.
- Small contextual details—such as Node.js module import syntax—make the difference between 100% test success and immediate runtime failure.
- Strict token guards must adapt dynamically to remaining budget capacity to avoid premature execution halts.

---

## 8. What's Next for Orchestrate

- **Multi-File Refactoring Scenarios:** Expanding the benchmark harness to larger enterprise codebases.
- **Dynamic Bounded Repair Loops:** Integrating human-in-the-loop approval when autonomous repair attempts reach their configured threshold.
- **Teamwork Integration:** Connecting with external agent platforms to exchange verification-backed project state across heterogeneous tools.
