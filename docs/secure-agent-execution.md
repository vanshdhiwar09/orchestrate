# Orchestrate — Secure Agent Execution Architecture (P0)

## Overview

In Orchestrate, autonomous coding agents execute commands (such as compiling code with `tsc`, running unit tests with `node`, or inspecting repository status with `git`). In local desktop environments, this was historically handled via direct host subprocess spawning (`LocalCommandExecutor`). 

Exposing host subprocess spawning to the public internet creates a critical Remote Code Execution (RCE) vulnerability. This document details the **P0 Secure Agent Execution Implementation**, introducing containerized sandboxing, minimal environment allowlisting, and fail-closed production enforcement.

---

## 1. Security Threat Model & Defense-in-Depth

Untrusted agent code and model-generated shell commands are treated as adversarial inputs.

```
+-------------------------------------------------------------------------+
|                              Host Machine                               |
|                                                                         |
|  +-----------------------------------+                                  |
|  |     Orchestrate Engine API        |                                  |
|  |  (Fastify / Node 24 HTTP Server)  |                                  |
|  +-----------------+-----------------+                                  |
|                    |                                                    |
|           spawns via Docker CLI                                         |
|                    v                                                    |
|  +-------------------------------------------------------------------+  |
|  |        Disposable Container Sandbox (Docker / Podman)             |  |
|  |                                                                   |  |
|  |  +-------------------------------------------------------------+  |  |
|  |  | Resource Limits:                                            |  |  |
|  |  |   --memory 1g --memory-swap 1g --cpus 1.0 --pids-limit 100  |  |  |
|  |  +-------------------------------------------------------------+  |  |
|  |  | Security Flags:                                             |  |  |
|  |  |   --security-opt no-new-privileges --cap-drop ALL           |  |  |
|  |  |   --read-only rootfs + tmpfs /tmp (64MB)                    |  |  |
|  |  +-------------------------------------------------------------+  |  |
|  |  | Network:                                                    |  |  |
|  |  |   --network none (Default: Zero outbound internet access)   |  |  |
|  |  +-------------------------------------------------------------+  |  |
|  |  | Mounts:                                                     |  |  |
|  |  |   ONLY: /data/workspaces/.../attempt-N -> /workspace:rw     |  |  |
|  |  |   FORBIDDEN: /var/run/docker.sock, /, /etc, ~/.ssh          |  |  |
|  |  +-------------------------------------------------------------+  |  |
|  |  | Env Allowlist:                                              |  |  |
|  |  |   NODE_ENV, PATH, HOME=/tmp (Zero host server secrets)      |  |  |
|  |  +-------------------------------------------------------------+  |  |
|  |                                                                   |  |
|  |        Subprocess: node / npm / npx / tsc / git                   |  |  |
|  +-------------------------------------------------------------------+  |
+-------------------------------------------------------------------------+
```

---

## 2. Container Sandbox Security Invariants

### 1. No Host Root or Sensitive Directory Mounts
- `DockerSandboxCommandExecutor` validates `workspaceRoot` against forbidden host paths (`/`, `/etc`, `/var`, `/root`, `/home`, `C:\`, `C:\Windows`, `C:\Users`).
- The Docker socket (`/var/run/docker.sock`) is **never** mounted into agent containers, preventing container breakout attacks.

### 2. Zero Network Egress by Default (`--network none`)
- All commands execute with `--network none`.
- Agent processes cannot exfiltrate code or credentials to external servers, attack internal VPC resources, or access cloud instance metadata services (`http://169.254.169.254`).

### 3. Kernel & Privilege Restrictions
- `--security-opt no-new-privileges`: Prevents setuid binaries or privilege escalation.
- `--cap-drop ALL`: Strips all Linux capabilities (cannot mount devices, raw sockets, or modify network configurations).
- `--read-only`: The container root filesystem is mounted read-only. Writable scratch space is restricted to an in-memory `--tmpfs /tmp:rw,noexec,nosuid,size=64m`.

### 4. Cgroup Limits (DoS & Fork-Bomb Protection)
- `--memory 1g` and `--memory-swap 1g`: Hard memory cap. Swap expansion disabled.
- `--cpus 1.0`: Hard CPU ceiling preventing CPU exhaustion.
- `--pids-limit 100`: Maximum process count to completely neutralize fork-bombs.

### 5. Strict Environment Variable Allowlist
Both `DockerSandboxCommandExecutor` and `LocalCommandExecutor` utilize `DEFAULT_ENV_ALLOWLIST`. Server-side credentials (such as `NEBIUS_API_KEY`, `DATABASE_URL`, `JWT_SECRET`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) are never forwarded to agent subprocesses.

---

## 3. Configuration & Runtime Selection

The execution mode is governed by `process.env.ORCHESTRATE_EXECUTOR` and `process.env.NODE_ENV`:

| `NODE_ENV` | `ORCHESTRATE_EXECUTOR` | Selected Executor | Behavior |
| :--- | :--- | :--- | :--- |
| `production` | *(unset)* or `auto` | `DockerSandboxCommandExecutor` | **Fails closed** with `SandboxUnavailableError` if container daemon is missing. |
| `production` | `sandbox` | `DockerSandboxCommandExecutor` | **Fails closed** if container daemon is missing. |
| `production` | `local` | **BLOCKED** | Throws `Error: Insecure execution denied: LocalCommandExecutor cannot be used when NODE_ENV=production.` |
| `development`| `local` | `LocalCommandExecutor` | Allowed for local development; applies minimal environment allowlist and workspace containment. |
| `development`| `auto` | `LocalCommandExecutor` / Sandbox | Uses Docker if available, otherwise local development fallback. |

---

## 4. Runtime Prerequisites for Hosted Deployment

To enable secure containerized execution in production:

1. **Container Daemon:** Install Docker Engine (or Podman) on the host machine or VM:
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io
   sudo systemctl enable --now docker
   sudo usermod -aG docker orchestrate
   ```
2. **Base Sandbox Image:** Pull or build the default runtime image:
   ```bash
   docker pull node:24-slim
   ```
3. **Environment Configuration:**
   ```bash
   NODE_ENV=production
   ORCHESTRATE_EXECUTOR=sandbox
   ```
4. **Verification:**
   Run the preflight command check:
   ```bash
   docker run --rm --network none node:24-slim node --version
   ```
