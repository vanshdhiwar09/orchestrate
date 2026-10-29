# Orchestrate Manual Deployment & Operations Guide

**Document Version:** 1.0.0  
**Target Environment:** Localhost, Bare Metal Linux/Windows/macOS, or Self-Hosted Container / VM  
**Deployment Policy:** Human-in-the-Loop Manual Deployment (No autonomous cloud agent deploys)

---

## 1. System Architecture & Topology

Orchestrate consists of two primary operational components:

```
┌─────────────────────────────────────────────────────────────┐
│                 Client Browser / Web UI                     │
│                (Vite + React Single-Page App)               │
│                Default: http://localhost:3000                │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP / JSON
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Orchestrate Engine API                    │
│           (Node.js HTTP Server, default: port 3001)         │
├──────────────────────────────┬──────────────────────────────┤
│ • Context Compiler           │ • Independent Verifier       │
│ • Tool Registry & Sandboxing │ • Structured Handoff Manager │
└──────────────────────────────┴──────────────────────────────┘
                               │ SQLite C-Bindings (WAL mode)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Persistent Project Brain                    │
│                 (SQLite: orchestrate.sqlite)                │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Prerequisites

- **Node.js**: `v22.8.0` or higher (tested on Node 22 & Node 24).
- **npm**: `v10.0.0` or higher.
- **Git**: Installed and available in system `PATH`.
- **Memory**: Minimum 2 GB RAM.
- **Disk**: 500 MB free space for workspace caches and SQLite database.

---

## 3. Step-by-Step Manual Deployment Procedure

### Step 3.1: Clone and Install
```bash
git clone <repository-url>
cd orchestrate
npm install
```

### Step 3.2: Configure Environment
Copy the root `.env.example` template:
```bash
cp .env.example .env
```

Review and adjust variables in `.env`:
```ini
# Node Environment
NODE_ENV=production

# Engine Server
ORCHESTRATE_HOST=127.0.0.1
ORCHESTRATE_PORT=3001
ORCHESTRATE_DB_PATH=./orchestrate.sqlite
ORCHESTRATE_CORS_ORIGIN=http://localhost:3000

# Nebius Token Factory (Inference credentials)
# Note: Evaluation is officially frozen; needed only if live agent loops are executed
NEBIUS_API_KEY=<your-nebius-api-key>
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
NEBIUS_DEFAULT_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B

# Web Client Engine Binding
VITE_ENGINE_URL=http://127.0.0.1:3001
```

### Step 3.3: Seed Historical Evaluation Data
Populate the SQLite Project Brain with Run 4 verified trial evidence, active architectural decisions, and project facts:
```bash
npm run seed
```
This script is strictly idempotent and safe to run multiple times.

### Step 3.4: Compile Codebase & Build Web Bundle
Compile TypeScript across all monorepo packages and build the frontend client:
```bash
npm run build
npm run web:build
```
This produces:
- Compiled TypeScript libraries in `packages/*/dist/` and `apps/engine/dist/`.
- Production single-page application bundle in `apps/web/dist/`.

### Step 3.5: Run Preflight Smoke Test
Verify all 6 engine endpoints and error handling against a running or ephemeral engine instance:
```bash
npm run smoke:test
```
Ensure the smoke test outputs:
```
OVERALL STATUS: ALL CHECKS PASSED (VERIFIED)
```

---

## 4. Running the Services

### Option A: Local Development / Demonstration (Recommended for Hackathon Evaluation)

Terminal 1 — Start the Engine API:
```bash
npm run engine:dev
```
*Listens on `http://127.0.0.1:3001`.*

Terminal 2 — Start the Web UI Dev Server:
```bash
npm run web:dev
```
*Available in browser at `http://localhost:3000`.*

---

### Option B: Production Server / Process Manager (PM2 / Systemd)

1. **Serve the Engine API**:
   Using Node.js directly or with a process manager like PM2:
   ```bash
   node --experimental-strip-types scripts/start-engine.ts
   # or with pm2:
   pm2 start "node --experimental-strip-types scripts/start-engine.ts" --name orchestrate-engine
   ```

2. **Serve the Web UI**:
   - **Static HTTP Server (Nginx / Caddy / Serve):**
     Point your web server root to `apps/web/dist` with fallback to `index.html`.
     Example with `serve`:
     ```bash
     npx serve -s apps/web/dist -l 3000
     ```
   - **Vite Preview:**
     ```bash
     npx vite preview apps/web --port 3000 --host 127.0.0.1
     ```

---

## 5. Operations & Health Verification

### Health Check Endpoint
Query the engine directly:
```bash
curl -s http://127.0.0.1:3001/health | jq
```
Expected output:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "process": {
    "uptimeSeconds": 150,
    "memoryUsageMb": 38
  },
  "model": {
    "provider": "nebius",
    "hasApiKey": true
  }
}
```

### Database Maintenance & Backup
The Project Brain is stored in a single SQLite file (`orchestrate.sqlite`) operating in WAL (`write-ahead logging`) mode.
To create a safe online backup:
```bash
sqlite3 orchestrate.sqlite ".backup 'backup-orchestrate-$(date +%Y%m%d).sqlite'"
```

---

## 6. Security & Hardening Checklist

1. **Host Binding:** Ensure `ORCHESTRATE_HOST` is set to `127.0.0.1` unless fronted by an authenticated reverse proxy (e.g. Nginx with TLS and Basic Auth).
2. **CORS Restrictions:** Keep `ORCHESTRATE_CORS_ORIGIN` restricted to the exact domain hosting the web frontend.
3. **No Secret Leakage:** Never inject `NEBIUS_API_KEY` into frontend environment variables (`VITE_*`). Frontend communicates solely with the backend engine.
4. **Filesystem Isolation:** The Engine executes tool commands strictly inside dedicated temporary workspaces; host directories remain protected.
