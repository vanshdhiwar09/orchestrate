# Orchestrate — Security Review & Hardening Audit

## 1. Security Invariants & Compliance Status

| Security Boundary | Policy Requirement | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- |
| **Workspace Isolation** | Execution restricted strictly to assigned temporary attempt workspace | `LocalCommandExecutor` rejects paths with `..`, absolute traversal, or symlinks escaping root | **VERIFIED** |
| **Untrusted Model Input** | Model-generated tool parameters treated as untrusted | Strict type validation on `command`, `args`, `path`, and `content` before system execution | **VERIFIED** |
| **Secret Protection** | Zero leakage of `NEBIUS_API_KEY` or sensitive credentials | Environment variables sanitized, stripped before spawning subprocesses, and excluded from telemetry sinks | **VERIFIED** |
| **Command Execution** | Subprocess invocation without shell (`shell: false`) | Safe execution whitelist, argument array enforcement, process timeouts, and 1 MiB output caps | **VERIFIED** |
| **Sensitive File Access** | Protect `.env`, `.git`, and private credentials | File tools reject access to `.env` files or traversal outside designated project roots | **VERIFIED** |

## 2. Model Input Sanitization & Path Canonicalization

- All tool parameters (`read_file`, `write_file`, `execute_command`) undergo rigorous sanitization:
  - Relative path normalization strips leading slashes (`/src/index.ts` -> `src/index.ts`) while preventing parent traversal (`../`).
  - Command execution enforces argument arrays and disallows arbitrary shell concatenation or command injection.
  - Subprocess environments explicitly filter out `NEBIUS_API_KEY` and other sensitive authorization tokens before execution.

## 3. Telemetry & Log Redaction

- `InstrumentedModelClient` and `InstrumentedToolRegistry` automatically redact authorization headers, bearer tokens, and private credentials before recording telemetry events or persisting Project Facts.
- Error messages sent to client UIs never expose raw internal stack traces containing credentials.
