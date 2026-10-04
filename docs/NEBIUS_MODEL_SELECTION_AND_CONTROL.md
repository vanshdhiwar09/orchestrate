# Nebius Model Selection and Benchmark Model Control

## Status
**APPROVED / FROZEN FOR HACKATHON MVP**

## Context
Orchestrate is an AI engineering system that coordinates coding agents while maintaining persistent, evidence-backed project state. 

In early development stages, inference was exercised against a single default model configuration. However, real-world project workflows require flexibility in model selection across tasks and agent roles, while benchmark evaluation requires strict, immutable control over model identity and inference parameters to prevent confounding experimental results.

This document records the project-level architecture decision governing model selection in normal project execution and model control in benchmark evaluation.

---

## Core Principle

> **"Users choose models in normal project execution. Experiments choose and lock models."**

---

## 1. Architectural Decisions

### 1.1 Hackathon Provider Scope
- **Nebius Token Factory** is the **sole AI inference provider** implemented for the hackathon MVP.
- **NVIDIA Nemotron** (specifically Nemotron open-source models deployed on Nebius Token Factory, e.g., `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` or `nvidia/nemotron-4-340b-instruct`) remains the primary demonstrated NVIDIA open-source model family.
- The system architecture **must not assume Nemotron is the only selectable Nebius model**. Any model supported and deployed on the Nebius Token Factory platform may be configured and executed.
- No OpenAI, Anthropic/Claude, OpenCode, or Ollama/local model providers are implemented for the hackathon.

### 1.2 Normal Project Execution
- **User Selection:** Users may select any model available via their Nebius Token Factory account.
- **Granular Configuration:** Model selection is configurable at the project level, task level, and role level.
- **Role-Specific Configuration:** The architecture defines clean role-based model assignments:
  - `planner` — high-level task decomposition and specification analysis.
  - `builder` — code generation, refactoring, and patch generation.
  - `reviewer` — independent code review, invariant checking, and diff analysis.
  - `repairer` — targeted defect rectification following failed verification.
  - `summarizer` — state extraction, context compaction, and handoff synthesis.
- **Single-Provider Roles:** All roles are fulfilled through Nebius Token Factory without requiring multiple providers.
- **Sensible Default:** In the hackathon MVP, all roles default to the project's selected default Nebius model unless explicitly overridden.
- **Provenance & Evidence:** Every model call records its provider (`nebius`), model identifier, inference parameters, and token usage into immutable execution evidence. API keys and secrets are strictly redacted before persistence or emission.

### 1.3 Benchmark Execution
- **Controlled Experimental Variable:** In benchmark trials, model identity and inference parameters are **strictly controlled experimental variables**.
- **Cross-Arm Equality Invariant:**
  ```
  ControlFingerprint(ARM_A_BASELINE)
  ==
  ControlFingerprint(ARM_B_UNVERIFIED_HANDOFF)
  ==
  ControlFingerprint(ARM_C_ORCHESTRATE)
  ```
- **Frozen During Trial:** All three arms in a trial must use:
  - The exact same model identity (e.g. `nebius/meta-llama/Llama-3.3-70B-Instruct` or `nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`).
  - The exact same inference configuration (`temperature`, `topP`, `maxTokens`, `seed`).
  - The exact same system instructions, tools, permissions, environment, execution limits, and filesystem/network policies.
- **Treatment Isolation:** Model identity is **strictly excluded** from `TreatmentFingerprint`. The treatment consists exclusively of the context representation supplied to Agent B.
- **Invalidation Rule:** Any model or inference configuration divergence between arms violates experimental control and immediately transitions the trial to the terminal state **`INVALID`** (Category A failure classification: `INVALID_TRIAL`).
- **Attribution Invariant:** The benchmark must **never** attribute a model-quality difference to the Orchestrate treatment.

### 1.4 Future Providers & Extensibility
- Future adapters (OpenAI, Anthropic, OpenCode, Ollama/local models) are explicitly **OUT OF HACKATHON SCOPE**.
- The internal `ModelClient` interface provides a clean, decoupled seam (`complete(request): Promise<ModelResponse>`).
- Adding future providers will only require implementing a new `ModelClient` adapter; it will **not** require modifying `Project Brain`, `Context Compiler`, `VerificationEngine`, or benchmark evaluation semantics.

---

## 2. Normal Project Mode vs Benchmark Mode

| Dimension | Normal Project Mode | Benchmark Mode |
|---|---|---|
| **Objective** | Software engineering task completion | Controlled scientific measurement |
| **Model Choice** | User-selected via project/role configuration | Protocol-locked per trial replication |
| **Model Provider** | Nebius Token Factory | Nebius Token Factory |
| **Role Routing** | Supported (`planner`, `builder`, `reviewer`, etc.) | Disabled (all arms execute exact same Agent B role) |
| **Model Equality** | Different tasks/roles may use different models | **Mandatory:** Arm A == Arm B == Arm C |
| **Inference Config** | User-tunable per task or role | **Mandatory:** Identical across all three arms |
| **Treatment** | Standard compiled Orchestrate context | Three distinct arms: Baseline (A), Unverified (B), Orchestrate (C) |
| **Mismatch Handling** | Fallback to project default model | **Immediate trial invalidation (`INVALID`)** |
| **Provenance** | Stored in task run history and Brain | Stored in cryptographically sealed `TrialRecord` |

---

## 3. Architecture Diagrams

### 3.1 Normal Project Mode Execution
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

### 3.2 Benchmark Mode Execution (Model Lock)
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

### 3.3 Future Provider Extensibility (Clean Seam)
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

## 4. Nebius Model Discovery and Verification

### 4.1 Upstream API Verification
According to the official Nebius Token Factory API specifications:
- **Base URL:** `https://api.tokenfactory.nebius.com/v1`
- **Models Endpoint:** `GET /v1/models`
- **Authentication:** `Authorization: Bearer <NEBIUS_API_KEY>`
- **Response Format:** Standard OpenAI-compatible list schema:
  ```json
  {
    "object": "list",
    "data": [
      {
        "id": "nvidia/nemotron-4-340b-instruct",
        "object": "model",
        "created": 1718000000,
        "owned_by": "nebius"
      }
    ]
  }
  ```

### 4.2 Discovery Implementation Rule
1. `NebiusModelClient` provides a minimal `listModels(): Promise<string[]>` method that calls `/v1/models` and returns model identifier strings.
2. In the event of network failure or unavailable discovery, configured Nebius model IDs are accepted directly with runtime validation on invocation.
3. No speculative provider marketplace or dynamic capability negotiation is implemented.
4. API keys are strictly redacted from any discovery errors or log messages.

---

## 5. Scope Definition

### IN SCOPE (Hackathon MVP):
- Nebius Token Factory provider integration.
- Configurable project-level default Nebius model.
- Role-based model configuration data structures (`planner`, `builder`, `reviewer`, `repairer`, `summarizer`).
- Fallback from role configuration to project default model.
- Per-request model override.
- Strict cross-arm model identity and inference configuration locking in the benchmark harness.
- Provenance tracking (provider, model, inference parameters, usage).
- Sensitive key redaction in all model-related logging and errors.

### OUT OF SCOPE FOR HACKATHON:
- OpenAI, Anthropic, OpenCode, or Ollama/local provider adapters.
- Multi-provider dynamic routing or failover.
- Provider marketplace UI.
- Speculative capability scoring or automated model selection.
