import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteProjectBrain } from '@orchestrate/brain';
import { LocalCommandExecutor } from '@orchestrate/workspace';
import { createEngineServer, type EngineServerInstance } from '../src/server.js';
import { DeterministicTestModelClient } from '../src/test-model-client.js';

describe('Engine Repository Onboarding, Task Management & Orchestration API', () => {
  let tmpDir: string;
  let dbPath: string;
  let testRepoDir: string;
  let brain: SqliteProjectBrain;
  let engineInstance: EngineServerInstance;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'orchestrate-tasks-test-'));
    dbPath = join(tmpDir, 'test.sqlite');
    testRepoDir = join(tmpDir, 'test-repo');

    // Create a temporary git repo to test against
    await mkdir(join(testRepoDir, 'src'), { recursive: true });
    await writeFile(join(testRepoDir, 'package.json'), JSON.stringify({ name: 'test-pkg', type: 'module' }));
    await writeFile(join(testRepoDir, 'src', 'index.js'), 'export function test() { return 1; }\n');

    // Git init
    const exec = new LocalCommandExecutor({ workspaceRoot: testRepoDir });
    await exec.execute('git', ['init']);
    await exec.execute('git', ['config', 'user.name', 'Test User']);
    await exec.execute('git', ['config', 'user.email', 'test@example.local']);
    await exec.execute('git', ['add', '-A']);
    await exec.execute('git', ['commit', '-m', 'Initial commit']);

    brain = new SqliteProjectBrain({ databasePath: dbPath });
    engineInstance = createEngineServer({
      brain,
      port: 0, // OS assigned
      host: '127.0.0.1',
      modelClient: new DeterministicTestModelClient(),
      workspacesDir: join(tmpDir, 'workspaces'),
      devMode: true,
    });

    const info = await engineInstance.start();
    baseUrl = info.url;
  });

  afterEach(async () => {
    if (engineInstance) {
      await engineInstance.stop();
    }
    if (brain) {
      brain.close();
    }
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('GET and POST /config/model manages provider configuration safely', async () => {
    const getRes = await fetch(`${baseUrl}/config/model`);
    expect(getRes.status).toBe(200);
    const config = await getRes.json();
    expect(config.defaultModel).toBeDefined();

    const postRes = await fetch(`${baseUrl}/config/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'sk-test-mock-key',
        testMode: true,
      }),
    });
    expect(postRes.status).toBe(200);
    const updated = await postRes.json();
    expect(updated.success).toBe(true);
    expect(updated.hasApiKey).toBe(true);
    expect(updated.testMode).toBe(true);
    // Never expose raw api key back in payload
    expect(updated.apiKey).toBeUndefined();
  });

  it('validates local repository paths and GitHub URLs', async () => {
    // 1. Create project
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'repo-test-proj', name: 'Repo Test Project' }),
    });

    // 2. Validate valid local repo
    const validLocal = await fetch(`${baseUrl}/projects/repo-test-proj/repository/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'local', path: testRepoDir }),
    });
    expect(validLocal.status).toBe(200);
    const localData = await validLocal.json();
    expect(localData.valid).toBe(true);
    expect(localData.isGit).toBe(true);
    expect(localData.isClean).toBe(true);

    // 3. Validate non-existent directory
    const invalidLocal = await fetch(`${baseUrl}/projects/repo-test-proj/repository/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'local', path: join(tmpDir, 'does-not-exist') }),
    });
    const invalidData = await invalidLocal.json();
    expect(invalidData.valid).toBe(false);
    expect(invalidData.error).toContain('does not exist');

    // 4. Validate GitHub URL
    const validGithub = await fetch(`${baseUrl}/projects/repo-test-proj/repository/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'github', url: 'https://github.com/owner/sample-repo.git' }),
    });
    const ghData = await validGithub.json();
    expect(ghData.valid).toBe(true);
    expect(ghData.owner).toBe('owner');
    expect(ghData.repo).toBe('sample-repo');
  });

  it('imports local repository and queries status', async () => {
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'import-proj', name: 'Import Project' }),
    });

    const importRes = await fetch(`${baseUrl}/projects/import-proj/repository/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'local', path: testRepoDir }),
    });
    expect(importRes.status).toBe(200);
    const importData = await importRes.json();
    expect(importData.success).toBe(true);
    expect(importData.repository.type).toBe('local');

    const statusRes = await fetch(`${baseUrl}/projects/import-proj/repository/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.connected).toBe(true);
    expect(statusData.isGit).toBe(true);
    expect(statusData.isClean).toBe(true);
  });

  it('creates, lists, and retrieves tasks with trust states', async () => {
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'task-proj', name: 'Task Project' }),
    });

    // Create task
    const createRes = await fetch(`${baseUrl}/projects/task-proj/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-101',
        title: 'Implement Validation Feature',
        description: 'Create validation function in src/feature.js',
        acceptanceCriteria: 'Function returns success true',
        verificationCommand: 'node',
        verificationArgs: ['-e', 'process.exit(0)'],
      }),
    });
    expect(createRes.status).toBe(201);
    const createData = await createRes.json();
    expect(createData.task.id).toBe('task-101');
    expect(createData.task.title).toBe('Implement Validation Feature');
    expect(createData.trustState).toBe('UNVERIFIED');

    // List tasks
    const listRes = await fetch(`${baseUrl}/projects/task-proj/tasks`);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.tasks.length).toBe(1);
    expect(listData.tasks[0].id).toBe('task-101');
    expect(listData.tasks[0].trustState).toBe('UNVERIFIED');

    // Get task detail
    const getRes = await fetch(`${baseUrl}/projects/task-proj/tasks/task-101`);
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.task.id).toBe('task-101');
    expect(getData.trustState).toBe('UNVERIFIED');
    expect(getData.acceptanceCriteria).toBe('Function returns success true');
  });

  it('executes a task end-to-end with agent tools, independent verification, and diff tracking', async () => {
    // 1. Create project with repository attached
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'exec-proj',
        name: 'Execution Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    // 2. Create task with verification check
    await fetch(`${baseUrl}/projects/exec-proj/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'exec-task-1',
        title: 'Add execute function to src/feature.js',
        description: 'Implement execute() in src/feature.js returning success true',
        verificationCommand: 'node',
        verificationArgs: ['--check', 'src/feature.js'],
      }),
    });

    // 3. Run task
    const runRes = await fetch(`${baseUrl}/projects/exec-proj/tasks/exec-task-1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelProvider: 'test' }),
    });

    expect(runRes.status).toBe(200);
    const runData = await runRes.json();
    expect(runData.success).toBe(true);
    expect(runData.status).toBe('VERIFIED');
    expect(runData.handoff).toBeDefined();
    expect(runData.handoff.status).toBe('CLAIMED');
    expect(runData.verificationResult.status).toBe('VERIFIED');
    expect(runData.diff).toContain('feature.js');

    // 4. Confirm task trust state updated in Project Brain
    const taskRes = await fetch(`${baseUrl}/projects/exec-proj/tasks/exec-task-1`);
    const taskData = await taskRes.json();
    expect(taskData.trustState).toBe('VERIFIED');
    expect(taskData.history.length).toBe(1);

    // 5. Query task diff endpoint
    const diffRes = await fetch(`${baseUrl}/projects/exec-proj/tasks/exec-task-1/diff`);
    expect(diffRes.status).toBe(200);
    const diffData = await diffRes.json();
    expect(diffData.diff).toContain('feature.js');
  });

  it('rejects task execution when project has no attached repository', async () => {
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'no-repo-proj',
        name: 'No Repo Project',
        repositoryType: 'none',
      }),
    });

    await fetch(`${baseUrl}/projects/no-repo-proj/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-no-repo',
        title: 'Cannot run without repo',
      }),
    });

    const runRes = await fetch(`${baseUrl}/projects/no-repo-proj/tasks/task-no-repo/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(runRes.status).toBe(400);
    const err = await runRes.json();
    expect(err.error).toContain('no attached repository');
  });

  it('marks task as FAILED when independent verification checks fail', async () => {
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'fail-proj',
        name: 'Failing Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    await fetch(`${baseUrl}/projects/fail-proj/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'fail-task',
        title: 'Task that will fail verification',
        description: 'FAIL_VERIFICATION please',
        // Deliberately configure a check that exits with code 1
        verificationCommand: 'node',
        verificationArgs: ['-e', 'process.exit(1)'],
      }),
    });

    const runRes = await fetch(`${baseUrl}/projects/fail-proj/tasks/fail-task/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelProvider: 'test' }),
    });

    expect(runRes.status).toBe(200);
    const runData = await runRes.json();
    expect(runData.status).toBe('FAILED');
    expect(runData.verificationResult.status).toBe('FAILED');

    // Confirm task trust state in brain is FAILED, not VERIFIED
    const taskRes = await fetch(`${baseUrl}/projects/fail-proj/tasks/fail-task`);
    const taskData = await taskRes.json();
    expect(taskData.trustState).toBe('FAILED');
  });

  it('fails closed when sandbox executor is required in production and container daemon is unavailable', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      await fetch(`${baseUrl}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'sandbox-guard-proj',
          name: 'Sandbox Guard Project',
          repositoryType: 'local',
          repositoryPath: testRepoDir,
        }),
      });

      await fetch(`${baseUrl}/projects/sandbox-guard-proj/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'sandbox-guard-task',
          title: 'Task in Production Mode',
          description: 'Should fail closed without Docker daemon',
        }),
      });

      const runRes = await fetch(`${baseUrl}/projects/sandbox-guard-proj/tasks/sandbox-guard-task/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelProvider: 'test' }),
      });

      // Must fail closed with 500 containing Sandbox runtime error
      expect(runRes.status).toBe(500);
      const runData = await runRes.json();
      expect(runData.error).toMatch(/Sandbox runtime/i);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
