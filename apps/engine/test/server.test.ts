import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path, { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEngineServer,
  MemoryProjectBrain,
  SqliteProjectBrain,
  type EngineServerInstance,
  type VerificationRecord,
} from '../src/index.js';

describe('HTTP Engine Server', () => {
  let brain: MemoryProjectBrain;
  let serverInstance: EngineServerInstance;

  beforeEach(async () => {
    brain = new MemoryProjectBrain();
    serverInstance = createEngineServer({
      brain,
      port: 0, // dynamic port for tests
      host: '127.0.0.1',
      devMode: true,
    });
    await serverInstance.start();
  });

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.stop();
    }
  });

  // ==========================================================================
  // SERVER LIFECYCLE & CORS
  // ==========================================================================

  describe('Server Lifecycle & CORS', () => {
    it('binds to 127.0.0.1 and returns valid url with allocated port', () => {
      expect(serverInstance.host).toBe('127.0.0.1');
      expect(serverInstance.port).toBeGreaterThan(0);
      expect(serverInstance.url).toBe(`http://127.0.0.1:${serverInstance.port}`);
    });

    it('handles OPTIONS preflight with CORS headers', async () => {
      const res = await fetch(`${serverInstance.url}/projects`, {
        method: 'OPTIONS',
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(res.headers.get('access-control-allow-methods')).toContain('GET, POST, OPTIONS');
    });

    it('returns 404 JSON for unknown routes', async () => {
      const res = await fetch(`${serverInstance.url}/unknown-endpoint`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data).toEqual({
        error: 'Not Found',
        statusCode: 404,
      });
    });

    it('stop() resolves safely if called before start or called multiple times', async () => {
      const freshServer = createEngineServer({
        brain: new MemoryProjectBrain(),
        port: 0,
        host: '127.0.0.1',
        devMode: true,
      });
      // Call stop before start: must resolve cleanly without error
      await expect(freshServer.stop()).resolves.toBeUndefined();

      // Start server
      await freshServer.start();
      // First stop: must resolve cleanly
      await expect(freshServer.stop()).resolves.toBeUndefined();
      // Second stop: must resolve cleanly without error
      await expect(freshServer.stop()).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // GET /health
  // ==========================================================================

  describe('GET /health', () => {
    it('returns 200 with status ok and version', async () => {
      const res = await fetch(`${serverInstance.url}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.version).toBe('0.1.0');
      expect(data.timestamp).toBeDefined();

      // Safe process and model diagnostics without secret exposure
      expect(data.process).toBeDefined();
      expect(typeof data.process.pid).toBe('number');
      expect(typeof data.process.uptimeSeconds).toBe('number');
      expect(typeof data.process.nodeVersion).toBe('string');
      expect(typeof data.process.memoryUsageMb).toBe('number');

      expect(data.model).toBeDefined();
      expect(data.model.provider).toBe('nebius');
      expect(typeof data.model.defaultModel).toBe('string');
      expect(typeof data.model.hasApiKey).toBe('boolean');
      expect(typeof data.model.baseUrl).toBe('string');
      // Must not expose secret API keys or credentials
      expect(data.model.apiKey).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain('NEBIUS_API_KEY=');

      expect(data.capabilities).toBeDefined();
      expect(Array.isArray(data.capabilities.tools)).toBe(true);
      expect(data.capabilities.tools).toContain('read_file');
      expect(data.capabilities.tools).toContain('write_file');
      expect(data.capabilities.tools).toContain('execute_command');
      expect(data.capabilities.tools).toContain('get_project_info');
    });

    it('rejects POST to /health with 405 Method Not Allowed', async () => {
      const res = await fetch(`${serverInstance.url}/health`, { method: 'POST' });
      expect(res.status).toBe(405);
      const data = await res.json();
      expect(data.error).toBe('Method Not Allowed');
    });
  });

  // ==========================================================================
  // POST /projects & GET /projects/:projectId
  // ==========================================================================

  describe('Project Management Endpoints', () => {
    it('creates a new project and retrieves it', async () => {
      // 1. Create project
      const createRes = await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'proj-eng-1',
          name: 'Engine Project 1',
        }),
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      expect(created.id).toBe('proj-eng-1');
      expect(created.name).toBe('Engine Project 1');
      expect(created.facts).toEqual([]);

      // 2. Retrieve project
      const getRes = await fetch(`${serverInstance.url}/projects/proj-eng-1`);
      expect(getRes.status).toBe(200);
      const retrieved = await getRes.json();
      expect(retrieved.id).toBe('proj-eng-1');
      expect(retrieved.name).toBe('Engine Project 1');
    });

    it('lists empty and multiple projects via GET /projects and persists across SQLite reopen', async () => {
      // 1. Empty list on initial server
      const emptyRes = await fetch(`${serverInstance.url}/projects`);
      expect(emptyRes.status).toBe(200);
      expect(await emptyRes.json()).toEqual({ projects: [] });

      // 2. Persistent SQLite database across server restarts
      const tempDir = await mkdtemp(join(tmpdir(), 'orchestrate-engine-proj-'));
      const dbPath = join(tempDir, 'engine.sqlite');
      try {
        const sqliteBrain1 = new SqliteProjectBrain({ databasePath: dbPath });
        const srv1 = createEngineServer({ brain: sqliteBrain1, port: 0, host: '127.0.0.1', devMode: true });
        await srv1.start();

        await fetch(`${srv1.url}/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'first-app', name: 'First App' }),
        });
        await fetch(`${srv1.url}/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'second-app', name: 'Second App' }),
        });

        await srv1.stop();
        sqliteBrain1.close();

        // Reopen SQLite brain in a new server instance
        const sqliteBrain2 = new SqliteProjectBrain({ databasePath: dbPath });
        const srv2 = createEngineServer({ brain: sqliteBrain2, port: 0, host: '127.0.0.1', devMode: true });
        await srv2.start();

        const listRes = await fetch(`${srv2.url}/projects`);
        expect(listRes.status).toBe(200);
        const listData = (await listRes.json()) as {
          projects: Array<{ id: string; name: string; createdAt: string; facts: unknown[] }>;
        };
        expect(listData.projects).toHaveLength(2);
        expect(listData.projects.map((p) => p.id)).toEqual(['first-app', 'second-app']);
        expect(listData.projects[0].name).toBe('First App');
        expect(listData.projects[0].facts).toEqual([]);

        // Reject unsupported method on /projects
        const delRes = await fetch(`${srv2.url}/projects`, { method: 'DELETE' });
        expect(delRes.status).toBe(405);

        await srv2.stop();
        sqliteBrain2.close();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects duplicate project IDs with 409 Conflict', async () => {
      await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'proj-dup', name: 'Original' }),
      });

      const dupRes = await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'proj-dup', name: 'Duplicate' }),
      });

      expect(dupRes.status).toBe(409);
      const data = await dupRes.json();
      expect(data.error).toMatch(/already exists/);
    });

    it('validates required fields on POST /projects', async () => {
      const resEmptyId = await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '', name: 'Test' }),
      });
      expect(resEmptyId.status).toBe(400);

      const resEmptyName = await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'valid-id', name: '  ' }),
      });
      expect(resEmptyName.status).toBe(400);

      const resInvalidJson = await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json',
      });
      expect(resInvalidJson.status).toBe(400);
    });

    it('returns 404 for non-existent projects', async () => {
      const res = await fetch(`${serverInstance.url}/projects/does-not-exist`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toMatch(/not found/i);
    });

    it('returns 400 for malformed percent-encoded route parameters', async () => {
      const res = await fetch(`${serverInstance.url}/projects/%E0%A4%A`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/malformed/i);
    });

    it('returns 413 Payload Too Large when request body exceeds 1 MB limit', async () => {
      const oversizedName = 'x'.repeat(1024 * 1024 + 100);
      const res = await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'proj-big', name: oversizedName }),
      });
      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.error).toMatch(/payload too large/i);
    });

    it('accepts request body within 1 MB limit', async () => {
      const largeName = 'x'.repeat(500 * 1024); // 500 KB
      const res = await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'proj-acceptable', name: largeName }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe('proj-acceptable');
    });
  });

  // ==========================================================================
  // GET /projects/:projectId/handoffs & /verifications
  // ==========================================================================

  describe('Handoff and Verification Query Endpoints', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-demo', name: 'Demo Project' });
      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-demo',
        title: 'Task 1',
        description: 'First task',
      });
      await brain.createTask({
        id: 'task-2',
        projectId: 'proj-demo',
        title: 'Task 2',
        description: 'Second task',
      });

      // Add handoffs
      await brain.addHandoff({
        id: 'h-1',
        taskId: 'task-1',
        attemptNumber: 1,
        agentId: 'agent-1',
        model: 'nebius-model',
        status: 'CLAIMED',
        summary: 'Completed Task 1',
        changes: 'created greeting',
        filesAffected: ['src/greeting.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

      await brain.addHandoff({
        id: 'h-2',
        taskId: 'task-2',
        attemptNumber: 1,
        agentId: 'agent-2',
        model: 'nebius-model',
        status: 'CLAIMED',
        summary: 'Completed Task 2',
        changes: 'created consumer',
        filesAffected: ['src/index.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

      // Add verification for Task 1
      const verifRecord: VerificationRecord = {
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        handoffId: 'h-1',
        result: {
          status: 'VERIFIED',
          checks: [
            {
              checkId: 'chk-1',
              name: 'Build',
              command: 'npm',
              args: ['run', 'build'],
              status: 'PASSED',
              passed: true,
              exitCode: 0,
              signal: null,
              stdout: 'ok',
              stderr: '',
              timedOut: false,
              durationMs: 100,
              verifiedAt: new Date().toISOString(),
            },
          ],
          executedAt: new Date().toISOString(),
          totalDurationMs: 120,
        },
        recordedAt: new Date().toISOString(),
      };
      await brain.addVerificationRecord(verifRecord);
    });

    it('returns all handoffs across all project tasks', async () => {
      const res = await fetch(`${serverInstance.url}/projects/proj-demo/handoffs`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.handoffs).toHaveLength(2);
      expect(data.handoffs.map((h: { id: string }) => h.id).sort()).toEqual(['h-1', 'h-2']);
    });

    it('filters handoffs by taskId when query param is provided', async () => {
      const res = await fetch(`${serverInstance.url}/projects/proj-demo/handoffs?taskId=task-1`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.handoffs).toHaveLength(1);
      expect(data.handoffs[0].id).toBe('h-1');
    });

    it('returns all verifications for the project', async () => {
      const res = await fetch(`${serverInstance.url}/projects/proj-demo/verifications`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.verifications).toHaveLength(1);
      expect(data.verifications[0].id).toBe('v-1');
      expect(data.verifications[0].result.status).toBe('VERIFIED');
    });

    it('filters verifications by taskId', async () => {
      const res1 = await fetch(`${serverInstance.url}/projects/proj-demo/verifications?taskId=task-1`);
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.verifications).toHaveLength(1);

      const res2 = await fetch(`${serverInstance.url}/projects/proj-demo/verifications?taskId=task-2`);
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.verifications).toHaveLength(0);
    });

    it('returns 404 for non-existent project on handoffs and verifications', async () => {
      const resH = await fetch(`${serverInstance.url}/projects/non-existent/handoffs`);
      expect(resH.status).toBe(404);

      const resV = await fetch(`${serverInstance.url}/projects/non-existent/verifications`);
      expect(resV.status).toBe(404);
    });
  });

  // ==========================================================================
  // GET /projects/:projectId/context (ContextCompiler integration)
  // ==========================================================================

  describe('Context Compilation Endpoint', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-context', name: 'Context Test Project' });
      await brain.addProjectFact('proj-context', {
        key: 'global.framework',
        value: 'Fastify',
        provenance: 'CODE',
        status: 'VERIFIED',
      });

      await brain.createTask({
        id: 'task-a',
        projectId: 'proj-context',
        title: 'Task A',
        description: 'Module creation',
      });

      await brain.createTask({
        id: 'task-b',
        projectId: 'proj-context',
        title: 'Task B',
        description: 'Module consumer',
      });

      const hA = await brain.addHandoff({
        id: 'h-a',
        taskId: 'task-a',
        attemptNumber: 1,
        agentId: 'agent-1',
        model: 'nebius-model',
        status: 'CLAIMED',
        summary: 'Created greeting module',
        changes: 'export createGreeting',
        filesAffected: ['src/greeting.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

      await brain.addVerificationRecord({
        id: 'v-a',
        taskId: 'task-a',
        attemptNumber: 1,
        handoffId: hA.id,
        result: {
          status: 'VERIFIED',
          checks: [
            {
              checkId: 'c1',
              name: 'Tests',
              command: 'npm',
              args: ['test'],
              status: 'PASSED',
              passed: true,
              exitCode: 0,
              signal: null,
              stdout: 'ok',
              stderr: '',
              timedOut: false,
              durationMs: 80,
              verifiedAt: new Date().toISOString(),
            },
          ],
          executedAt: new Date().toISOString(),
          totalDurationMs: 90,
        },
        recordedAt: new Date().toISOString(),
      });

      await brain.addDecision({
        id: 'dec-1',
        projectId: 'proj-context',
        statement: 'Use TypeScript strict mode',
        rationale: 'Prevent runtime type errors',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      });
    });

    it('requires targetTaskId query parameter', async () => {
      const res = await fetch(`${serverInstance.url}/projects/proj-context/context`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/targetTaskId.*required/i);
    });

    it('compiles context and returns structured context + XML serialization', async () => {
      const url = `${serverInstance.url}/projects/proj-context/context?targetTaskId=task-b&upstreamTaskId=task-a`;
      const res = await fetch(url);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.context).toBeDefined();
      expect(data.serialized).toBeDefined();

      // Check structured context
      expect(data.context.metadata.targetTaskId).toBe('task-b');
      expect(data.context.metadata.upstreamTaskId).toBe('task-a');
      expect(data.context.upstreamWork?.taskId).toBe('task-a');
      expect(data.context.upstreamWork?.trustState).toBe('VERIFIED');
      expect(data.context.decisions).toHaveLength(1);
      expect(data.context.decisions[0].statement).toBe('Use TypeScript strict mode');
      expect(data.context.facts).toHaveLength(1);
      expect(data.context.facts[0].key).toBe('global.framework');

      // Check XML serialized output
      expect(data.serialized).toContain('<orchestrate_context>');
      expect(data.serialized).toContain('</orchestrate_context>');
      expect(data.serialized).toContain('Use TypeScript strict mode');
      expect(data.serialized).toContain('VERIFIED');
    });

    it('returns 404 when target task does not exist', async () => {
      const url = `${serverInstance.url}/projects/proj-context/context?targetTaskId=task-missing`;
      const res = await fetch(url);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toMatch(/target task "task-missing" not found/i);
    });

    it('returns 404 when target task belongs to another project', async () => {
      await brain.createProject({ id: 'proj-other', name: 'Other Project' });
      await brain.createTask({
        id: 'task-other-proj',
        projectId: 'proj-other',
        title: 'Other Task',
        description: 'Belongs to other project',
      });

      const url = `${serverInstance.url}/projects/proj-context/context?targetTaskId=task-other-proj`;
      const res = await fetch(url);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toMatch(/not found in project "proj-context"/i);
    });

    it('returns 404 when upstream task belongs to another project', async () => {
      await brain.createProject({ id: 'proj-foreign', name: 'Foreign Project' });
      await brain.createTask({
        id: 'task-foreign',
        projectId: 'proj-foreign',
        title: 'Foreign Task',
        description: 'Belongs to foreign project',
      });

      const url = `${serverInstance.url}/projects/proj-context/context?targetTaskId=task-b&upstreamTaskId=task-foreign`;
      const res = await fetch(url);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toMatch(/upstream task "task-foreign" not found in project "proj-context"/i);
    });
  });

  // ==========================================================================
  // PERSISTENCE & RECOVERY ACROSS ENGINE RESTARTS WITH SQLITE
  // ==========================================================================

  describe('Engine + SqliteProjectBrain Recovery Across Restarts', () => {
    let tempDir: string;
    let dbPath: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'orchestrate-engine-test-'));
      dbPath = join(tempDir, 'engine-brain.sqlite');
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('recovers all project state, handoffs, and verifications over HTTP after restart', async () => {
      // 1. Start Engine 1 with SqliteProjectBrain
      const brain1 = new SqliteProjectBrain({ databasePath: dbPath });
      const engine1 = createEngineServer({
        brain: brain1,
        port: 0,
        host: '127.0.0.1',
        devMode: true,
      });
      await engine1.start();

      try {
        // Create project over HTTP
        const createRes = await fetch(`${engine1.url}/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'proj-restart', name: 'Restart Test' }),
        });
        expect(createRes.status).toBe(201);

        // Add task and handoff directly via brain
        await brain1.createTask({
          id: 'task-r1',
          projectId: 'proj-restart',
          title: 'Restart Task',
          description: 'Testing restart',
        });

        const handoff = await brain1.addHandoff({
          id: 'h-restart-1',
          taskId: 'task-r1',
          attemptNumber: 1,
          agentId: 'agent-1',
          model: 'nebius-model',
          status: 'CLAIMED',
          summary: 'Persistent handoff',
          changes: 'files',
          filesAffected: ['file.ts'],
          decisionsCreated: [],
          assumptions: [],
          limitations: [],
          recommendedFollowUp: [],
          createdAt: new Date().toISOString(),
        });

        await brain1.addVerificationRecord({
          id: 'v-restart-1',
          taskId: 'task-r1',
          attemptNumber: 1,
          handoffId: handoff.id,
          result: {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'check-restart',
                name: 'Restart Acceptance Check',
                command: 'node',
                args: ['--test'],
                passed: true,
                exitCode: 0,
                signal: null,
                stdout: 'Restart check passed',
                stderr: '',
                timedOut: false,
                durationMs: 50,
                verifiedAt: new Date().toISOString(),
              },
            ],
            executedAt: new Date().toISOString(),
            totalDurationMs: 50,
          },
          recordedAt: new Date().toISOString(),
        });
      } finally {
        await engine1.stop();
        brain1.close();
      }

      // 2. Start Engine 2 with new brain pointing to the SAME SQLite file
      const brain2 = new SqliteProjectBrain({ databasePath: dbPath });
      const engine2 = createEngineServer({
        brain: brain2,
        port: 0,
        host: '127.0.0.1',
        devMode: true,
      });
      await engine2.start();

      try {
        // Query project over HTTP
        const getProj = await fetch(`${engine2.url}/projects/proj-restart`);
        expect(getProj.status).toBe(200);
        const projData = await getProj.json();
        expect(projData.id).toBe('proj-restart');
        expect(projData.name).toBe('Restart Test');

        // Query handoffs over HTTP
        const getHandoffs = await fetch(`${engine2.url}/projects/proj-restart/handoffs`);
        expect(getHandoffs.status).toBe(200);
        const handoffsData = await getHandoffs.json();
        expect(handoffsData.handoffs).toHaveLength(1);
        expect(handoffsData.handoffs[0].id).toBe('h-restart-1');

        // Query verifications over HTTP
        const getVerifs = await fetch(`${engine2.url}/projects/proj-restart/verifications`);
        expect(getVerifs.status).toBe(200);
        const verifsData = await getVerifs.json();
        expect(verifsData.verifications).toHaveLength(1);
        expect(verifsData.verifications[0].id).toBe('v-restart-1');
      } finally {
        await engine2.stop();
        brain2.close();
      }
    });

    it('returns repository file tree and file contents for Project Explorer', async () => {
      await fetch(`${serverInstance.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'proj-tree', name: 'Tree Test' }),
      });

      const treeRes = await fetch(`${serverInstance.url}/projects/proj-tree/repository/tree`);
      expect(treeRes.status).toBe(200);
      const treeData = await treeRes.json();
      expect(treeData).toHaveProperty('connected');

      // Test task events endpoint
      const eventsRes = await fetch(`${serverInstance.url}/projects/proj-tree/tasks/task-1/events`);
      expect(eventsRes.status).toBe(200);
      const eventsData = await eventsRes.json();
      expect(eventsData).toHaveProperty('isRunning');
      expect(eventsData).toHaveProperty('timeline');
      expect(Array.isArray(eventsData.timeline)).toBe(true);
    });

    it('returns Nebius model registry with multi-agent roles on GET /config/model/registry', async () => {
      const res = await fetch(`${serverInstance.url}/config/model/registry`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('registry');
      expect(data.registry['zai-org/GLM-5.3-Flash']).toBeDefined();
      expect(data.registry['moonshotai/Kimi-K2.6']).toBeDefined();
      expect(data.registry['nvidia/Nemotron-3.5-Super-VL']).toBeDefined();
      expect(data.roles.planner).toBe('zai-org/GLM-5.3-Flash');
      expect(data.roles.implementer).toBe('moonshotai/Kimi-K2.6');
      expect(data.roles.reviewer).toBe('nvidia/Nemotron-3.5-Super-VL');
    });

    it('opens a local folder as a project via POST /projects/open-folder', async () => {
      const testDir = path.resolve('./packages/core');
      const res = await fetch(`${serverInstance.url}/projects/open-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: testDir, name: 'Core Package' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.project.name).toBe('Core Package');
      expect(data.repository.type).toBe('local');
      expect(data.repository.path).toBe(testDir);
    });
  });
});
