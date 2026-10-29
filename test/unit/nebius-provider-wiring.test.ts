import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NebiusModelClient } from '@orchestrate/model';
import { createEngineServer, type EngineServerInstance } from '../../apps/engine/src/server.js';
import { DeterministicTestModelClient } from '../../apps/engine/src/test-model-client.js';
import { SqliteProjectBrain } from '@orchestrate/brain';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCommandExecutor } from '@orchestrate/workspace';

describe('Nebius Provider Wiring & Default Nemotron Verification', () => {
  let tmpDir: string;
  let dbPath: string;
  let testRepoDir: string;
  let brain: SqliteProjectBrain;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nebius-wiring-test-'));
    dbPath = join(tmpDir, 'test.sqlite');
    testRepoDir = join(tmpDir, 'test-repo');

    await mkdir(join(testRepoDir, 'src'), { recursive: true });
    await writeFile(join(testRepoDir, 'package.json'), JSON.stringify({ name: 'test-pkg', type: 'module' }));
    await writeFile(join(testRepoDir, 'src', 'index.js'), 'export function test() { return 1; }\n');

    const exec = new LocalCommandExecutor({ workspaceRoot: testRepoDir });
    await exec.execute('git', ['init']);
    await exec.execute('git', ['config', 'user.name', 'Test User']);
    await exec.execute('git', ['config', 'user.email', 'test@example.local']);
    await exec.execute('git', ['add', '-A']);
    await exec.execute('git', ['commit', '-m', 'Initial commit']);

    brain = new SqliteProjectBrain({ databasePath: dbPath });
  });

  afterEach(async () => {
    try {
      brain.close();
    } catch {
      // ignore
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('NebiusModelClient defaults to Nebius Token Factory endpoint and throws when API key is missing', () => {
    const origKey = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      expect(() => new NebiusModelClient()).toThrowError(/Nebius API key is required/);
    } finally {
      if (origKey) process.env.NEBIUS_API_KEY = origKey;
    }
  });

  it('NebiusModelClient formats request for NVIDIA Nemotron with messages and tools', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-nemotron-1',
        model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Plan formulated for Nemotron execution.',
            },
          },
        ],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 15,
          total_tokens: 57,
        },
      }),
    });

    const client = new NebiusModelClient({
      apiKey: 'secret-test-token-key-abc',
      fetchFn: mockFetch as unknown as typeof fetch,
      defaultModel: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    });

    const response = await client.complete({
      messages: [{ role: 'user', content: 'Implement feature X' }],
      tools: [
        {
          name: 'write_file',
          description: 'Writes a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      ],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.tokenfactory.nebius.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer secret-test-token-key-abc');
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody.model).toBe('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
    expect(parsedBody.tools).toBeDefined();
    expect(parsedBody.tools[0].function.name).toBe('write_file');
    expect(response.message.content).toBe('Plan formulated for Nemotron execution.');
  });

  it('Engine rejects task run when NEBIUS_API_KEY is missing without silent fallback to mock', async () => {
    const origKey = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;

    let serverInstance: EngineServerInstance | undefined;
    try {
      serverInstance = createEngineServer({
        brain,
        port: 0,
        host: '127.0.0.1',
        workspacesDir: join(tmpDir, 'workspaces'),
        devMode: true,
      });
      const info = await serverInstance.start();

      // Create project
      const projRes = await fetch(`${info.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'test-proj-fail-closed',
          name: 'Test Project',
        }),
      });
      expect(projRes.status).toBe(201);

      // Attach repository
      const importRes = await fetch(`${info.url}/projects/test-proj-fail-closed/repository/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'local', path: testRepoDir }),
      });
      expect(importRes.status).toBe(200);

      // Create task
      const taskRes = await fetch(`${info.url}/projects/test-proj-fail-closed/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'task-fail-closed-1',
          title: 'Failing Task due to missing key',
          description: 'Should fail closed',
        }),
      });
      expect(taskRes.status).toBe(201);
      const taskBody = await taskRes.json();
      const taskId = taskBody.task.id;

      // Run task without key
      const runRes = await fetch(`${info.url}/projects/test-proj-fail-closed/tasks/${taskId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const runBody = await runRes.json();

      // Must fail closed with error explaining how to configure NEBIUS_API_KEY
      expect(runRes.status).toBeGreaterThanOrEqual(400);
      expect(runBody.error).toMatch(/Nebius API key is not configured/);
      expect(runBody.error).toMatch(/nvidia\/NVIDIA-Nemotron-3-Nano-30B-A3B/);
    } finally {
      if (serverInstance) await serverInstance.stop();
      if (origKey) process.env.NEBIUS_API_KEY = origKey;
    }
  }, 15000);

  it('Engine allows deterministic test mode client when explicitly configured', async () => {
    const serverInstance = createEngineServer({
      brain,
      port: 0,
      host: '127.0.0.1',
      modelClient: new DeterministicTestModelClient(),
      workspacesDir: join(tmpDir, 'workspaces'),
      devMode: true,
    });
    const info = await serverInstance.start();

    try {
      const projRes = await fetch(`${info.url}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'deterministic-proj',
          name: 'Deterministic Project',
        }),
      });
      expect(projRes.status).toBe(201);

      // Attach repository
      const importRes = await fetch(`${info.url}/projects/deterministic-proj/repository/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'local', path: testRepoDir }),
      });
      expect(importRes.status).toBe(200);

      const taskRes = await fetch(`${info.url}/projects/deterministic-proj/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'task-det-1',
          title: 'Deterministic Test Task',
          description: 'Testing fallback flag',
          verificationCommand: 'node',
          verificationArgs: ['-e', 'process.exit(0)'],
        }),
      });
      expect(taskRes.status).toBe(201);
      const taskBody = await taskRes.json();
      const taskId = taskBody.task.id;

      const runRes = await fetch(`${info.url}/projects/deterministic-proj/tasks/${taskId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const runBody = await runRes.json();
      expect(runRes.status).toBe(200);
      expect(runBody.isRealInference).toBe(false);
      expect(runBody.provider).toBe('test');
      expect(runBody.executionTimeline).toBeDefined();
      expect(runBody.executionTimeline.length).toBeGreaterThan(0);
    } finally {
      await serverInstance.stop();
    }
  }, 15000);
});
