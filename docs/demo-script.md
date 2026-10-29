# Orchestrate — 3-Minute Hackathon Video Demo Script

**Target Duration:** 3 minutes (180 seconds)  
**Tone:** Confident, technical, evidence-backed, senior engineering  
**Presenter Flow:** Problem → Architecture & Invariants → Live UI Walkthrough → Benchmark Results

---

## Shot 1: The Problem (0:00 - 0:30)

**[Screen: Title Card or Slide — "Orchestrate: Evidence-Backed AI Engineering"]**

**Speaker:**  
"Today, multi-agent coding systems face a fundamental trust crisis: when one AI finishes a task and hands it off to another, it passes unchecked claims in prose.  
If Agent A hallucinates an API contract, omits a module convention, or claims tests pass when they didn't, Agent B inherits that defect, burns thousands of tokens rediscovering files, or crashes with runtime syntax errors.

We built **Orchestrate** to solve this with a non-negotiable source-of-truth hierarchy:  
$$\text{CODE} \longrightarrow \text{VERIFICATION EVIDENCE} \longrightarrow \text{PROJECT BRAIN} \longrightarrow \text{AGENT CLAIMS}$$  
In Orchestrate, an agent's statement that work is done is just a claim. Nothing enters persistent project state until independent, automated verification passes."

---

## Shot 2: Core Architecture & Invariants (0:30 - 1:00)

**[Screen: README Architecture Diagram / Engine Terminal]**

**Speaker:**  
"Orchestrate is built around clear responsibility boundaries:
- A high-performance **Engine API** running on Node.js and TypeScript.
- An isolated, sandboxed **Workspace** for agent execution with controlled tool permissions.
- An independent **Verification Engine** that evaluates type checks and acceptance suites cryptographically.
- A persistent **Project Brain** backed by SQLite in WAL mode.
- And a deterministic **Context Compiler** that extracts only verified facts, active architectural decisions, and repository conventions for downstream agents.

All model inference runs on **Nebius Token Factory**, evaluating open models like `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` under strict per-arm token budget caps."

---

## Shot 3: Live Application Walkthrough (1:00 - 2:00)

**[Screen: Web UI at `http://localhost:3000/#/projects` → Click into `profile-validation`]**

**Speaker:**  
"Let's look at the live Orchestrate Web Application.  
Here in the Project Overview for our profile validation benchmark, we see the real-time engine health indicator in the header, showing connected status and engine latency.

Notice how the UI visually separates **Agent Claims** from **Independent Verification Evidence**:
1. When we inspect **Handoffs**, we see Agent A's claimed changes, assumptions, and affected files.
2. But looking at **Verifications**, we see the immutable cryptographic seal from the independent verification engine: unit tests passed, acceptance tests passed, with exact exit codes and execution durations.
3. In the **Project Brain** tab, we see active architectural decisions—such as enforcing explicit `import type` statements under Node 24 runtime type stripping—and verified repository facts.
4. Finally, in the **Context Compiler**, we can inspect the exact compiled context delivered to downstream agents, either as structured JSON or serialized XML, complete with one-click copy feedback."

---

## Shot 4: Empirical Benchmark Findings (2:00 - 2:40)

**[Screen: `docs/evaluation-final.md` or Benchmark Report Markdown]**

**Speaker:**  
"We didn't just build this—we rigorously tested it across a controlled 3-arm benchmark evaluating downstream coding performance on an open-source model:
- **Arm A (Baseline — Repository Only):** Failed. Without structured handoffs, the agent exhausted its 10,000-token budget exploring files and never finished.
- **Arm B (Unverified Handoffs):** Failed. It generated code based on upstream agent claims, but suffered a fatal runtime syntax error because it lacked verified repository conventions.
- **Arm C (Orchestrate):** **100% Verified Pass**. Armed with compiled verified context and active type-import conventions, it passed all 9 acceptance tests on the first try, staying well under budget at 7,653 tokens.

We report these results under strict intent-to-treat rules with honest cost disclosures."

---

## Shot 5: Conclusion & Future Outlook (2:40 - 3:00)

**[Screen: GitHub repository / Final Dashboard Overview]**

**Speaker:**  
"Orchestrate brings software engineering discipline to AI agent teams: reproducible environments, bounded repair loops, verified handoffs, and persistent project state.

The entire application builds cleanly, is backed by automated smoke tests, and is ready for production evaluation.  
Thank you!"
