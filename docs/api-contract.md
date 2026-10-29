# Orchestrate Engine API Contract

**Status:** CANONICAL & VERIFIED  
**Specification Version:** 2.0.0  
**Transport:** HTTP/1.1 (JSON over HTTP)  
**Default Bindings:** Host `127.0.0.1`, Port `3001`  
**CORS Policy:** Whitelisted origin or configurable via `ORCHESTRATE_CORS_ORIGIN` (`GET`, `POST`, `OPTIONS`)

---

## 1. Overview & Trust Boundary

The Orchestrate HTTP Engine exposes a strictly validated API surface for the web user interface, CLI runners, and integration tests.

It enforces the core source-of-truth hierarchy:

$$\text{CODE} \longrightarrow \text{VERIFICATION EVIDENCE} \longrightarrow \text{PROJECT BRAIN} \longrightarrow \text{AGENT CLAIMS}$$

All endpoints return strictly typed JSON payloads. Errors never leak sensitive system internals, credentials, or arbitrary stack traces. Model execution strictly isolates agent actions within dedicated workspace directories with bounded repairs (Rule 9).

---

## 2. Supported Routes Overview

| Method | Path | Description | Supported Parameters / Body |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Server status, runtime diagnostics, and model availability | None |
| `GET` | `/config/model` | Retrieves active model configuration and provider mode | None |
| `POST` | `/config/model` | Configures model provider, API key, and test mode | JSON body (`apiKey`, `defaultModel`, `testMode`, `baseUrl`) |
| `POST` | `/projects` | Creates a new project with optional repository onboarding | JSON body (`id`, `name`, `repositoryType`, `repositoryPath`, `repositoryUrl`, `repositoryBranch`) |
| `GET` | `/projects` | Lists all registered projects with their facts | None |
| `GET` | `/projects/:id` | Retrieves a project record and its current Project Brain facts | None |
| `POST` | `/projects/:id/repository/validate` | Validates local directory or GitHub repo URL without mutating state | JSON body (`type`, `path`, `url`) |
| `POST` | `/projects/:id/repository/import` | Attaches/imports repository to project | JSON body (`type`, `path`, `url`, `branch`) |
| `GET` | `/projects/:id/repository/status` | Probes live git status of the project's connected repository | None |
| `GET` | `/projects/:id/tasks` | Lists all tasks for a project with derived trust states and attempt counts | None |
| `POST` | `/projects/:id/tasks` | Creates a task in Project Brain with acceptance criteria and verification plan | JSON body (`id`, `title`, `description`, `acceptanceCriteria`, `verificationCommand`, `verificationArgs`, `upstreamTaskId`) |
| `GET` | `/projects/:id/tasks/:taskId` | Retrieves task details, trust state, chronological attempt history, and diff | None |
| `POST` | `/projects/:id/tasks/:taskId/run` | Executes agent in isolated workspace with tools and independent verification | JSON body (`model`, `modelProvider`, `temperature`, `maxTokens`, `timeoutMs`, `verificationCommand`) |
| `GET` | `/projects/:id/tasks/:taskId/diff` | Retrieves captured unified git diff for a task | None |
| `POST` | `/projects/:id/tasks/:taskId/unblock` | Unblocks a task from `BLOCKED_NEEDS_HUMAN` to `UNVERIFIED` | None |
| `GET` | `/projects/:id/handoffs` | Retrieves structured handoff records for a project | Query: `taskId` (optional) |
| `GET` | `/projects/:id/verifications` | Retrieves independent verification evidence records | Query: `taskId` (optional) |
| `GET` | `/projects/:id/context` | Compiles evidence-backed context for downstream task | Query: `targetTaskId` (required), `upstreamTaskId` (optional), `tags` (optional) |

---

## 3. Endpoint Specifications

### 3.1 `GET /health`
Returns runtime health status, memory usage, Node version, and configured AI model capabilities.

- **Success Response (200 OK):**
```json
{
  "status": "ok",
  "timestamp": "2026-10-28T10:00:00.000Z",
  "version": "0.1.0",
  "process": {
    "pid": 12345,
    "uptimeSeconds": 120,
    "nodeVersion": "v24.19.0",
    "memoryUsageMb": 42
  },
  "model": {
    "provider": "nebius",
    "defaultModel": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    "hasApiKey": true,
    "baseUrl": "https://api.tokenfactory.nebius.com/v1"
  },
  "capabilities": {
    "tools": ["get_project_info", "read_file", "write_file", "execute_command"],
    "workspace": "local-sandboxed",
    "verification": "verification-engine"
  }
}
```

---

### 3.2 `GET /config/model` & `POST /config/model`
Manages model provider configuration and safe offline test mode.

- **POST Request Body:**
```json
{
  "apiKey": "sk-secret-token",
  "defaultModel": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "testMode": true
}
```
- **Response (200 OK):**
```json
{
  "success": true,
  "provider": "nebius",
  "defaultModel": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
  "hasApiKey": true,
  "testMode": true,
  "baseUrl": "https://api.tokenfactory.nebius.com/v1"
}
```
*Note: The raw API key is never echoed back in the response payload.*

---

### 3.3 `POST /projects`
Registers a new project entity in SQLite Project Brain, with optional repository onboarding facts.

- **Request Body:**
```json
{
  "id": "project-alpha",
  "name": "Project Alpha",
  "repositoryType": "local",
  "repositoryPath": "C:/projects/sample-repo"
}
```
- **Success Response (201 Created):** Returns project DTO including facts stored in Brain.

---

### 3.4 `POST /projects/:id/repository/validate`
Validates directory path or GitHub URL existence and git properties without modifying state.

- **Request Body:**
```json
{
  "type": "local",
  "path": "C:/projects/sample-repo"
}
```
- **Response (200 OK):**
```json
{
  "valid": true,
  "type": "local",
  "path": "C:/projects/sample-repo",
  "isGit": true,
  "branch": "main",
  "isClean": true,
  "stagedCount": 0,
  "unstagedCount": 0,
  "untrackedCount": 0
}
```

---

### 3.5 `GET /projects/:id/repository/status`
Returns live git status of the repository attached to the project.

- **Response (200 OK):**
```json
{
  "connected": true,
  "type": "local",
  "path": "C:/projects/sample-repo",
  "isGit": true,
  "branch": "main",
  "isClean": true,
  "stagedCount": 0,
  "unstagedCount": 0,
  "untrackedCount": 0,
  "headCommit": {
    "hash": "a1b2c3d4",
    "subject": "Initial commit",
    "author": "Developer <dev@example.com>",
    "timestamp": "2026-10-28T10:00:00.000Z"
  }
}
```

---

### 3.6 `GET /projects/:id/tasks` & `POST /projects/:id/tasks`
Lists all tasks (enriched with derived trust states and attempt counts) or creates a new task.

- **POST Request Body:**
```json
{
  "id": "task-1",
  "title": "Implement Profile Validation",
  "description": "Implement validateProfile in src/validate-profile.ts",
  "acceptanceCriteria": "Conform to ProfileSchema and pass test suite",
  "verificationCommand": "npm test",
  "verificationArgs": [],
  "upstreamTaskId": "task-0"
}
```
- **POST Response (201 Created):**
```json
{
  "task": {
    "id": "task-1",
    "projectId": "project-alpha",
    "title": "Implement Profile Validation",
    "description": "Implement validateProfile in src/validate-profile.ts",
    "createdAt": "2026-10-28T10:00:00.000Z",
    "updatedAt": "2026-10-28T10:00:00.000Z"
  },
  "trustState": "UNVERIFIED"
}
```

---

### 3.7 `GET /projects/:id/tasks/:taskId`
Retrieves task specification, current trust state, chronological attempt history, and unified diff.

- **Response (200 OK):**
```json
{
  "task": { ... },
  "trustState": "VERIFIED",
  "history": [
    {
      "attemptNumber": 1,
      "handoff": { ... },
      "verificationRecord": { ... }
    }
  ],
  "diff": "diff --git a/src/validate-profile.ts ...",
  "acceptanceCriteria": "...",
  "verificationConfig": { "command": "npm test", "args": [] },
  "isRunning": false
}
```

---

### 3.8 `POST /projects/:id/tasks/:taskId/run`
Executes an agent run in an isolated attempt workspace (`workspaces/tasks/<projectId>/<taskId>/attempt-<N>`).
Wired capabilities:
1. Workspace isolation snapshot.
2. Context compiler extraction of upstream verified facts.
3. Model client invocation with ToolRegistry (`read_file`, `write_file`, `execute_command`, `get_project_info`).
4. Structured handoff generation.
5. Independent verification check execution.
6. Unified git diff capture.
7. Bounded repair loop (Rule 9): Transitions to `BLOCKED_NEEDS_HUMAN` after 2 consecutive failed attempts.

- **Response (200 OK):**
```json
{
  "success": true,
  "taskId": "task-1",
  "attemptNumber": 1,
  "status": "VERIFIED",
  "trustState": "VERIFIED",
  "handoff": { ... },
  "verificationResult": {
    "status": "VERIFIED",
    "checks": [ ... ]
  },
  "diff": "diff --git a/src/validate-profile.ts b/src/validate-profile.ts\n..."
}
```

---

### 3.9 `GET /projects/:id/tasks/:taskId/diff`
Returns the captured git diff for the task.

- **Response (200 OK):**
```json
{
  "diff": "diff --git a/src/validate-profile.ts b/src/validate-profile.ts\n..."
}
```

---

### 3.10 `POST /projects/:id/tasks/:taskId/unblock`
Unblocks a task that transitioned to `BLOCKED_NEEDS_HUMAN` back to `UNVERIFIED`.

- **Response (200 OK):**
```json
{
  "success": true,
  "taskId": "task-1",
  "trustState": "UNVERIFIED"
}
```

---

### 3.11 `GET /projects/:id/context`
Compiles evidence-backed context for a downstream task.

- **Query Parameters:**
  - `targetTaskId` (**required**) — The task being targeted.
  - `upstreamTaskId` (optional) — Upstream dependency task.
  - `tags` (optional) — Comma-separated tags.
- **Success Response (200 OK):**
```json
{
  "context": {
    "projectId": "project-alpha",
    "targetTaskId": "task-2",
    "upstreamHandoff": { ... },
    "upstreamVerification": { ... },
    "facts": [ ... ],
    "decisions": [ ... ],
    "conventions": [ ... ]
  },
  "serialized": "<orchestrate_context>\n  <project id=\"project-alpha\">\n    ...\n  </project>\n</orchestrate_context>"
}
```

---

## 4. Standard Error Format

All non-2xx responses adhere to this structure:
```json
{
  "error": "<Descriptive error message>",
  "statusCode": 404
}
```
Standard status codes used:
- `400 Bad Request` — Invalid input syntax or missing required parameters.
- `404 Not Found` — Resource, path, or entity does not exist.
- `405 Method Not Allowed` — HTTP verb not supported on route.
- `409 Conflict` — Entity identifier collision or task already running.
- `413 Payload Too Large` — Request payload exceeds limit.
- `500 Internal Server Error` — Server unexpected error (sanitized, no stack trace exposed).
