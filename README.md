# Orchestrate

> **An AI engineering system that coordinates coding agents while maintaining persistent, evidence-backed project state.**

---

## Overview

Orchestrate bridges the gap between raw model inference and reliable software engineering by managing multi-turn coding agents within isolated execution workspaces, maintaining an immutable, append-only **Project Brain**, and independently verifying all agent claims through executable verification checks.

### Core Architecture

- **`ModelClient`** — Communicates with AI model providers. In the hackathon MVP, **Nebius Token Factory** is the sole implemented inference provider.
- **`AgentRunner`** — Owns the agent execution loop and coordinates model/tool interaction.
- **`ToolRegistry`** — Exposes controlled filesystem, terminal, and version control capabilities to agents.
- **`Workspace`** — Provides an isolated, tamper-evident execution environment with strict path containment.
- **`Verification`** — Independently executes configured test, lint, and build checks against live workspaces.
- **`Telemetry`** — Captures chronological execution traces, token usage, and timing data without persisting secrets.
- **`Project Brain`** — Stores structured project state, task handoffs, and evidence-backed knowledge.
- **`Context Compiler`** — Selects and compacts relevant project state into deterministic context envelopes for downstream tasks.

---

## Model Selection & Control Architecture

Orchestrate enforces a foundational architectural principle:

> **"Users choose models in normal project execution. Experiments choose and lock models."**

For complete details, see [`docs/NEBIUS_MODEL_SELECTION_AND_CONTROL.md`](./docs/NEBIUS_MODEL_SELECTION_AND_CONTROL.md).

### 1. Normal Project Execution

In normal engineering workflows:
- **Provider:** All inference is executed through **Nebius Token Factory**.
- **Model Selection:** Users may select and configure any model supported by their Nebius Token Factory deployment (with **NVIDIA Nemotron** demonstrated as the primary NVIDIA open-source model family).
- **Role-Based Configuration:** Tasks can configure role-specific models:
  - `planner` — high-level decomposition and architecture planning.
  - `builder` — code modification and implementation.
  - `reviewer` — independent code review and diff auditing.
  - `repairer` — targeted remediation after verification failure.
  - `summarizer` — state extraction and task handoff compilation.
- **Default Fallback:** All roles fall back to the project default Nebius model unless explicitly overridden.
- **Discovery:** Model IDs can be queried via the official Nebius `GET /v1/models` catalog endpoint.
- **Provenance:** Every completion event records the provider (`nebius`), model identifier, inference parameters, and token usage into immutable evidence. API keys and secrets are strictly redacted.

```
┌─────────────────────────────────────────────────────────┐
│                      Orchestrator                       │
│  (Coordinates Brain, Compiler, Runner, Verification)    │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                       ModelClient                       │
│          (Resolves role config & default model)         │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  NebiusModelClient                      │
│            (Token Factory API / v1 / HTTPS)             │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  Selected Nebius Model                  │
│   e.g. nvidia/nemotron-4-340b-instruct                  │
│   or meta-llama/Llama-3.3-70B-Instruct                  │
└─────────────────────────────────────────────────────────┘
```

### 2. Benchmark Execution

In scientific benchmark evaluation:
- **Locked Experimental Control:** Model identity and inference configuration are **controlled experimental variables**.
- **Cross-Arm Equality:** All three experimental arms (`ARM_A_BASELINE`, `ARM_B_UNVERIFIED_HANDOFF`, and `ARM_C_ORCHESTRATE`) must use the **exact same model identity** and **exact same inference configuration**:
  ```
  ControlFingerprint(ARM_A) == ControlFingerprint(ARM_B) == ControlFingerprint(ARM_C)
  ```
- **Treatment Isolation:** Model identity is strictly excluded from `TreatmentFingerprint`. Only the context representation supplied to Agent B differs.
- **Invalidation:** Any model or inference configuration divergence between arms violates experimental control and immediately marks the trial as `INVALID`. The benchmark never attributes model-quality divergence to the Orchestrate treatment.

```
┌─────────────────────────────────────────────────────────┐
│                   Experiment Config                     │
│  Selected Model: nebius/<model-id>                      │
│  Inference Config: { temperature, topP, maxTokens, seed }│
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼ (LOCKED)
┌─────────────────────────────────────────────────────────┐
│                  Control Fingerprint                    │
│  modelIdentity + inferenceConfigHash                    │
└───────────────────────────┬─────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────────┐┌─────────────────┐┌─────────────────┐
│     ARM A       ││     ARM B       ││     ARM C       │
│  (Baseline)     ││  (Unverified)   ││  (Orchestrate)  │
│                 ││                 ││                 │
│  Locked Model   ││  Locked Model   ││  Locked Model   │
│  Locked Config  ││  Locked Config  ││  Locked Config  │
│  NO CONTEXT     ││  RAW HANDOFF    ││  COMPILED CTX   │
└─────────────────┘└─────────────────┘└─────────────────┘
         ▲                  ▲                  ▲
         └──────────────────┴──────────────────┘
            ONLY THE CONTEXT TREATMENT DIFFERS
```

### 3. Future Provider Extensibility

The `ModelClient` interface provides a clean, decoupled boundary:

```
                     ┌──────────────────┐
                     │   ModelClient    │ (Interface seam)
                     └────────┬─────────┘
                              │
     ┌────────────────────────┼────────────────────────┐
     │ (CURRENT HACKATHON)    │ (FUTURE)               │ (FUTURE)
     ▼                        ▼                        ▼
┌───────────────┐      ┌───────────────┐        ┌───────────────┐
│ Nebius Client │      │ OpenAI Adapter│        │Anthropic Adapt│
└───────┬───────┘      └───────────────┘        └───────────────┘
        │
        ▼
Selected Nebius Model
```

---

## Project Scope

### Current Hackathon Implementation (In Scope)
- **Nebius Token Factory** inference client.
- **NVIDIA open-source model / Nemotron** demonstrated on Nebius Token Factory.
- Selectable Nebius model configuration per project and task.
- Role-based model configuration (`planner`, `builder`, `reviewer`, `repairer`, `summarizer`).
- Execution provenance and token usage tracking.
- Model-locked benchmark experiments with cryptographic control fingerprints.
- Strict secret redaction across all logs, telemetry, and error messages.

### Out of Scope for Hackathon (Future Work)
- OpenAI API adapter.
- Anthropic/Claude adapter.
- OpenCode integration.
- Ollama or local model runners.
- Multi-provider dynamic routing or cross-provider failover.
- Provider marketplace UI.

---

## Monorepo Packages

| Package | Description |
|---|---|
| [`packages/model`](./packages/model) | Low-level model abstractions, `NebiusModelClient`, model config types, and discovery |
| [`packages/core`](./packages/core) | Minimal orchestrator, `AgentRunner`, and tool registry |
| [`packages/brain`](./packages/brain) | Append-only SQLite Project Brain storing verified records and handoffs |
| [`packages/compiler`](./packages/compiler) | Context compiler selecting and formatting evidence into task context |
| [`packages/verification`](./packages/verification) | Independent verification engine evaluating tests, lints, and builds |
| [`packages/workspace`](./packages/workspace) | Isolated workspace sandboxes with path traversal containment |
| [`packages/benchmark`](./packages/benchmark) | Controlled A/B/C benchmark harness, trial runner, and metric evaluators |
| [`packages/telemetry`](./packages/telemetry) | Secret-redacted execution logging and observability |

---

## Documentation

- [`docs/NEBIUS_MODEL_SELECTION_AND_CONTROL.md`](./docs/NEBIUS_MODEL_SELECTION_AND_CONTROL.md) — Architecture decision on Nebius model selection & benchmark control
- [`docs/EXPERIMENT_PROTOCOL.md`](./docs/EXPERIMENT_PROTOCOL.md) — Benchmark experiment methodology and evaluation protocols
- [`docs/TRIAL_RUN_CONTRACT.md`](./docs/TRIAL_RUN_CONTRACT.md) — Benchmark trial lifecycle, failure taxonomy, and contracts
- [`docs/HARNESS_EXECUTION_CONTRACT.md`](./docs/HARNESS_EXECUTION_CONTRACT.md) — Execution harness invariants and fingerprinting rules
- [`docs/DISCOVERY_MEASUREMENT.md`](./docs/DISCOVERY_MEASUREMENT.md) — Discovery action taxonomy and scoring rules
- [`docs/ARTIFACT_MANIFEST.md`](./docs/ARTIFACT_MANIFEST.md) — Task-A artifact manifest specification
- [`docs/TASK_A_SNAPSHOT_CONTRACT.md`](./docs/TASK_A_SNAPSHOT_CONTRACT.md) — Canonical snapshot commit requirements
- [`docs/EXPERIMENTAL_ARM_ISOLATION.md`](./docs/EXPERIMENTAL_ARM_ISOLATION.md) — Arm workspace isolation rules

---

## Getting Started

### Prerequisites
- Node.js 22+
- npm 10+
- Git

### Installation
```bash
npm install
```

### Build & Typecheck
```bash
npm run build
npx tsc -b
```

### Running Tests
```bash
npm test
```
