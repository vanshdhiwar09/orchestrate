import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteProjectBrain } from '@orchestrate/brain';
import { LocalCommandExecutor } from '@orchestrate/workspace';
import { createEngineServer, type EngineServerInstance } from '../../apps/engine/src/server.js';
import { DeterministicTestModelClient } from '../../apps/engine/src/test-model-client.js';
import { EngineClient } from '../../apps/web/src/services/engine-client.js';

describe('Orchestrate End-to-End Functional Verification (Workflows A - J)', () => {
  let tmpDir: string;
  let dbPath: string;
  let testRepoDir: string;
  let workspacesDir: string;
  let brain: SqliteProjectBrain;
  let engineInstance: EngineServerInstance;
  let baseUrl: string;
  let client: EngineClient;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'orchestrate-e2e-'));
    dbPath = join(tmpDir, 'test-e2e.sqlite');
    testRepoDir = join(tmpDir, 'sample-repo');
    workspacesDir = join(tmpDir, 'workspaces');

    // Create a realistic sample repository
    await mkdir(join(testRepoDir, 'src'), { recursive: true });
    await writeFile(
      join(testRepoDir, 'package.json'),
      JSON.stringify({ name: 'sample-project', version: '1.0.0', type: 'module' }, null, 2)
    );
    await writeFile(
      join(testRepoDir, 'src', 'main.js'),
      'export function greet(name) { return `Hello, ${name}!`; }\n'
    );

    // Initialize git repository
    const exec = new LocalCommandExecutor({ workspaceRoot: testRepoDir });
    await exec.execute('git', ['init']);
    await exec.execute('git', ['config', 'user.name', 'Orchestrate Test User']);
    await exec.execute('git', ['config', 'user.email', 'test@orchestrate.local']);
    await exec.execute('git', ['add', '-A']);
    await exec.execute('git', ['commit', '-m', 'Initial repository commit']);

    // Instantiate Brain & Engine in Safe Offline Test Mode (zero API credits consumed)
    brain = new SqliteProjectBrain({ databasePath: dbPath });
    engineInstance = createEngineServer({
      brain,
      port: 0,
      host: '127.0.0.1',
      modelClient: new DeterministicTestModelClient(),
      workspacesDir,
      devMode: true,
    });

    const info = await engineInstance.start();
    baseUrl = info.url;
    client = new EngineClient(baseUrl);
  });

  afterEach(async () => {
    if (engineInstance) {
      try {
        await engineInstance.stop();
      } catch {
        // Ignore stop error if already stopped
      }
    }
    if (brain) {
      try {
        brain.close();
      } catch {
        // Ignore close error if already closed
      }
    }
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW A: Project Onboarding & Repository Validation / Import
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow A: Project Onboarding (Local repository validation, import, and git status)', async () => {
    // 1. Validate local repo path via API
    const valRes = await fetch(`${baseUrl}/projects/temp-validate/repository/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'local', path: testRepoDir }),
    });
    expect(valRes.status).toBe(200);
    const valData = await valRes.json();
    expect(valData.valid).toBe(true);
    expect(valData.isGit).toBe(true);
    expect(valData.isClean).toBe(true);
    expect(valData.branch).toBeDefined();

    // 2. Create project with repository onboarding parameters
    const projRes = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-workflow-a',
        name: 'Workflow A Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });
    expect(projRes.status).toBe(201);
    const projData = await projRes.json();
    expect(projData.id).toBe('proj-workflow-a');

    // 3. Confirm repository facts persisted in SQLite Brain
    const facts = projData.facts as Array<{ key: string; value: string; provenance: string }>;
    const pathFact = facts.find((f) => f.key === 'repository_path');
    const typeFact = facts.find((f) => f.key === 'repository_type');
    const branchFact = facts.find((f) => f.key === 'repository_branch');
    expect(pathFact?.value).toBe(testRepoDir);
    expect(typeFact?.value).toBe('local');
    expect(branchFact?.value).toBeDefined();

    // 4. Query live repository status endpoint
    const statusRes = await fetch(`${baseUrl}/projects/proj-workflow-a/repository/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.connected).toBe(true);
    expect(statusData.isGit).toBe(true);
    expect(statusData.isClean).toBe(true);
    expect(statusData.branch).toBe(branchFact?.value);
    expect(statusData.headCommit).toBeDefined();
    expect(statusData.headCommit?.subject).toBe('Initial repository commit');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW B: Task Creation & Specification
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow B: Task Creation & Specification (Persistence, metadata, and UNVERIFIED initial trust state)', async () => {
    // 1. Create Project
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-workflow-b',
        name: 'Workflow B Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    // 2. Create Task with acceptance criteria and verification command
    const taskRes = await fetch(`${baseUrl}/projects/proj-workflow-b/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-b1',
        title: 'Add User Validation Helper',
        description: 'Implement src/validator.js with validateUser function.',
        acceptanceCriteria: 'validateUser must return boolean for valid user objects.',
        verificationCommand: 'node',
        verificationArgs: ['-e', 'process.exit(0)'],
      }),
    });
    expect(taskRes.status).toBe(201);
    const taskData = await taskRes.json();
    expect(taskData.task.id).toBe('task-b1');
    expect(taskData.trustState).toBe('UNVERIFIED');

    // 3. Fetch Task list & task detail to confirm Brain persistence
    const listRes = await fetch(`${baseUrl}/projects/proj-workflow-b/tasks`);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.tasks.length).toBe(1);
    expect(listData.tasks[0].id).toBe('task-b1');
    expect(listData.tasks[0].trustState).toBe('UNVERIFIED');
    expect(listData.tasks[0].attemptsCount).toBe(0);

    const detailRes = await fetch(`${baseUrl}/projects/proj-workflow-b/tasks/task-b1`);
    expect(detailRes.status).toBe(200);
    const detailData = await detailRes.json();
    expect(detailData.task.title).toBe('Add User Validation Helper');
    expect(detailData.acceptanceCriteria).toBe('validateUser must return boolean for valid user objects.');
    expect(detailData.verificationConfig?.command).toBe('node');
    expect(detailData.trustState).toBe('UNVERIFIED');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW C: Single-Task Execution Success (Tool Calls, Handoff, Verification, Diff)
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow C: Single-Task Execution Success (Agent tool call, handoff, independent verification, git diff, VERIFIED)', async () => {
    // 1. Create Project
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-workflow-c',
        name: 'Workflow C Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    // 2. Create Task configured to create src/feature.js and verify syntax via Node
    await fetch(`${baseUrl}/projects/proj-workflow-c/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-c1',
        title: 'Implement Core Feature in src/feature.js',
        description: 'Create file src/feature.js with execute method.',
        verificationCommand: 'node',
        verificationArgs: ['-e', 'import("./src/feature.js").then(m => m.execute ? process.exit(0) : process.exit(1))'],
      }),
    });

    // 3. Execute Task run endpoint
    const runRes = await fetch(`${baseUrl}/projects/proj-workflow-c/tasks/task-c1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(runRes.status).toBe(200);
    const runData = await runRes.json();
    expect(runData.success).toBe(true);
    expect(runData.attemptNumber).toBe(1);
    expect(runData.status).toBe('VERIFIED');
    expect(runData.trustState).toBe('VERIFIED');

    // 4. Verify structured handoff is recorded
    expect(runData.handoff).toBeDefined();
    expect(runData.handoff.summary).toBeDefined();
    expect(runData.handoff.filesAffected).toContain('src/feature.js');

    // 5. Verify independent verification checks passed
    expect(runData.verificationResult).toBeDefined();
    expect(runData.verificationResult.status).toBe('VERIFIED');
    expect(runData.verificationResult.checks.length).toBeGreaterThan(0);
    expect(runData.verificationResult.checks[0].passed).toBe(true);

    // 6. Verify Git Diff was captured and shows added file
    expect(runData.diff).toContain('diff --git');
    expect(runData.diff).toContain('src/feature.js');

    // 7. Check Diff API endpoint
    const diffRes = await fetch(`${baseUrl}/projects/proj-workflow-c/tasks/task-c1/diff`);
    expect(diffRes.status).toBe(200);
    const diffData = await diffRes.json();
    expect(diffData.diff).toBe(runData.diff);

    // 8. Confirm Task Detail reflects VERIFIED trust state and 1 recorded attempt
    const taskDetailRes = await fetch(`${baseUrl}/projects/proj-workflow-c/tasks/task-c1`);
    const taskDetail = await taskDetailRes.json();
    expect(taskDetail.trustState).toBe('VERIFIED');
    expect(taskDetail.history.length).toBe(1);
    expect(taskDetail.history[0].verificationRecord.result.status).toBe('VERIFIED');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW D: Verification Failure & Bounded Repair Loop (Rule 9)
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow D: Verification Failure & Bounded Repair Loop (Fails verification, blocks after 2 repairs, unblocks)', async () => {
    // 1. Create Project
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-workflow-d',
        name: 'Workflow D Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    // 2. Create Task configured with FAIL_VERIFICATION trigger in description
    // The DeterministicTestModelClient produces code that throws, and the check asserts success
    await fetch(`${baseUrl}/projects/proj-workflow-d/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-d1',
        title: 'Faulty Task FAIL_VERIFICATION',
        description: 'This task intentionally contains FAIL_VERIFICATION flag.',
        verificationCommand: 'node',
        verificationArgs: ['-e', 'import("./src/feature.js").then(m => m.execute())'],
      }),
    });

    // 3. Attempt 1: Fails verification
    const run1Res = await fetch(`${baseUrl}/projects/proj-workflow-d/tasks/task-d1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(run1Res.status).toBe(200);
    const run1Data = await run1Res.json();
    expect(run1Data.status).toBe('FAILED');
    expect(run1Data.attemptNumber).toBe(1);
    expect(run1Data.trustState).toBe('FAILED');

    // 4. Attempt 2: Automated repair attempt 2 fails again -> Reaches maximum 2 repair attempts
    const run2Res = await fetch(`${baseUrl}/projects/proj-workflow-d/tasks/task-d1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(run2Res.status).toBe(200);
    const run2Data = await run2Res.json();
    expect(run2Data.status).toBe('FAILED');
    expect(run2Data.attemptNumber).toBe(2);
    // In accordance with Rule 9, task transitions to BLOCKED_NEEDS_HUMAN
    expect(run2Data.trustState).toBe('BLOCKED_NEEDS_HUMAN');

    // 5. Subsequent run attempt must be rejected because task is blocked
    const run3Res = await fetch(`${baseUrl}/projects/proj-workflow-d/tasks/task-d1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(run3Res.status).toBe(400);
    const run3Data = await run3Res.json();
    expect(run3Data.error).toContain('BLOCKED_NEEDS_HUMAN');

    // 6. Unblock the task via unblock endpoint
    const unblockRes = await fetch(`${baseUrl}/projects/proj-workflow-d/tasks/task-d1/unblock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(unblockRes.status).toBe(200);
    const unblockData = await unblockRes.json();
    expect(unblockData.success).toBe(true);
    expect(unblockData.trustState).toBe('UNVERIFIED');

    // 7. Verify Task Detail reflects unblocked state
    const detailRes = await fetch(`${baseUrl}/projects/proj-workflow-d/tasks/task-d1`);
    const detailData = await detailRes.json();
    expect(detailData.trustState).toBe('FAILED'); // Derived from 2 failed attempts, but no longer blocked
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW E: Multi-Task Dependent Workflow (Context Compiler Pipeline)
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow E: Multi-Task Dependent Workflow (Task A verified -> Task B compiled context -> Task B verified)', async () => {
    // 1. Create Project
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-workflow-e',
        name: 'Workflow E Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    // 2. Create and run Task A (Base Feature)
    await fetch(`${baseUrl}/projects/proj-workflow-e/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-e-base',
        title: 'Task A: Create Core Module',
        description: 'Create base utility module in src/feature.js.',
        verificationCommand: 'node',
        verificationArgs: ['-e', 'process.exit(0)'],
      }),
    });

    const runARes = await fetch(`${baseUrl}/projects/proj-workflow-e/tasks/task-e-base/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const runAData = await runARes.json();
    expect(runAData.status).toBe('VERIFIED');

    // 3. Create Task B depending on Task A
    await fetch(`${baseUrl}/projects/proj-workflow-e/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-e-dependent',
        title: 'Task B: Dependent Feature Extension',
        description: 'Extend functionality building on Task A.',
        upstreamTaskId: 'task-e-base',
        verificationCommand: 'node',
        verificationArgs: ['-e', 'process.exit(0)'],
      }),
    });

    // 4. Compile context for Task B and verify Task A's verified facts are included
    // without raw chat transcript leakage
    const compileRes = await fetch(
      `${baseUrl}/projects/proj-workflow-e/context?targetTaskId=task-e-dependent&upstreamTaskId=task-e-base`
    );
    expect(compileRes.status).toBe(200);
    const compileData = await compileRes.json();
    expect(compileData.context).toBeDefined();
    expect(compileData.serialized).toBeDefined();
    // Context contains upstream task summary and affected files
    expect(compileData.serialized).toContain('task-e-base');

    // 5. Run Task B successfully
    const runBRes = await fetch(`${baseUrl}/projects/proj-workflow-e/tasks/task-e-dependent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const runBData = await runBRes.json();
    expect(runBData.status).toBe('VERIFIED');
    expect(runBData.trustState).toBe('VERIFIED');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW F: Error Handling & Edge Cases
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow F: Error Handling & Edge Cases (No repo attached, invalid paths, malformed payloads)', async () => {
    // 1. Project with NO repository cannot run coding tasks
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-workflow-f-empty',
        name: 'Empty Project',
        repositoryType: 'none',
      }),
    });

    await fetch(`${baseUrl}/projects/proj-workflow-f-empty/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-f-norepo',
        title: 'Task Without Repo',
        description: 'Should reject run',
      }),
    });

    const runNoRepoRes = await fetch(`${baseUrl}/projects/proj-workflow-f-empty/tasks/task-f-norepo/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(runNoRepoRes.status).toBe(400);
    const noRepoData = await runNoRepoRes.json();
    expect(noRepoData.error).toContain('Project has no attached repository');

    // 2. Validate non-existent repository path returns valid: false
    const invalidPathRes = await fetch(`${baseUrl}/projects/any/repository/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'local', path: join(tmpDir, 'non-existent-dir-12345') }),
    });
    expect(invalidPathRes.status).toBe(200);
    const invalidPathData = await invalidPathRes.json();
    expect(invalidPathData.valid).toBe(false);
    expect(invalidPathData.error).toContain('Directory does not exist');

    // 3. Task creation with empty title returns 400
    const emptyTitleRes = await fetch(`${baseUrl}/projects/proj-workflow-f-empty/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(emptyTitleRes.status).toBe(400);

    // 4. Task run on non-existent task returns 404
    const notFoundRunRes = await fetch(`${baseUrl}/projects/proj-workflow-f-empty/tasks/non-existent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(notFoundRunRes.status).toBe(404);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW G: Git Safety & Workspace Isolation
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow G: Git Safety & Workspace Isolation (Execution in isolated attempt dir, base repo unmutated)', async () => {
    // 1. Create Project with base repo
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-workflow-g',
        name: 'Workflow G Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    // 2. Create Task
    await fetch(`${baseUrl}/projects/proj-workflow-g/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-g1',
        title: 'Create isolated file',
        description: 'Create src/feature.js in workspace',
      }),
    });

    // 3. Run Task
    const runRes = await fetch(`${baseUrl}/projects/proj-workflow-g/tasks/task-g1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(runRes.status).toBe(200);

    // 4. Assert workspace isolation invariant:
    // Base repository on disk MUST NOT have src/feature.js created in it!
    // Changes must only exist in the isolated attempt directory.
    expect(existsSync(join(testRepoDir, 'src', 'feature.js'))).toBe(false);

    // 5. Assert the isolated attempt workspace directory exists and contains the generated file
    const attemptWorkspaceDir = join(workspacesDir, 'tasks', 'proj-workflow-g', 'task-g1', 'attempt-1');
    expect(existsSync(join(attemptWorkspaceDir, 'src', 'feature.js'))).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW H: Frontend Service Integration (EngineClient)
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow H: Frontend Service Integration (EngineClient calls all newly enabled endpoints)', async () => {
    // 1. getModelConfig and saveModelConfig
    const config = await client.getModelConfig();
    expect(config.defaultModel).toBeDefined();

    const saveRes = await client.saveModelConfig({
      apiKey: 'sk-test-client-key',
      testMode: true,
    });
    expect(saveRes.success).toBe(true);
    expect(saveRes.hasApiKey).toBe(true);

    // 2. validateRepository via client
    const valResult = await client.validateRepository('proj-h', {
      type: 'local',
      path: testRepoDir,
    });
    expect(valResult.valid).toBe(true);
    expect(valResult.isGit).toBe(true);

    // 3. createProject via client
    const project = await client.createProject({
      id: 'proj-h',
      name: 'Frontend Client Project',
      repositoryType: 'local',
      repositoryPath: testRepoDir,
    });
    expect(project.id).toBe('proj-h');
    expect(project.name).toBe('Frontend Client Project');

    // 4. getRepositoryStatus via client
    const repoStatus = await client.getRepositoryStatus('proj-h');
    expect(repoStatus.connected).toBe(true);
    expect(repoStatus.isClean).toBe(true);

    // 5. createTask via client
    const taskResult = await client.createTask('proj-h', {
      id: 'task-h1',
      title: 'Client Created Task',
      description: 'Created through EngineClient service',
    });
    expect(taskResult.task).toBeDefined();
    expect(taskResult.task?.id).toBe('task-h1');

    // 6. listTasks via client
    const tasksList = await client.listTasks('proj-h');
    expect(tasksList.length).toBe(1);
    expect(tasksList[0].id).toBe('task-h1');

    // 7. runTask via client
    const runResult = await client.runTask('proj-h', 'task-h1');
    expect(runResult.success).toBe(true);
    expect(runResult.status).toBe('VERIFIED');
    expect(runResult.diff).toContain('diff --git');

    // 8. getTaskDiff via client
    const diffData = await client.getTaskDiff('proj-h', 'task-h1');
    expect(diffData.diff).toBe(runResult.diff);

    // 9. getTask detail via client
    const detail = await client.getTask('proj-h', 'task-h1');
    expect(detail?.task.id).toBe('task-h1');
    expect(detail?.trustState).toBe('VERIFIED');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW I: Persistence Across Engine Server Restart
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow I: Persistence Across Engine Restart (SQLite database preserves projects, tasks, verifications)', async () => {
    // 1. Create Project and verified Task
    await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'proj-restart-test',
        name: 'Restart Persistence Project',
        repositoryType: 'local',
        repositoryPath: testRepoDir,
      }),
    });

    await fetch(`${baseUrl}/projects/proj-restart-test/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'task-restart-1',
        title: 'Task Before Restart',
        description: 'Should persist across server restart',
      }),
    });

    await fetch(`${baseUrl}/projects/proj-restart-test/tasks/task-restart-1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    // 2. Stop original Engine instance and close original Brain
    await engineInstance.stop();
    brain.close();

    // 3. Start a brand new Engine instance pointing to the same SQLite database
    const newBrain = new SqliteProjectBrain({ databasePath: dbPath });
    const newEngine = createEngineServer({
      brain: newBrain,
      port: 0,
      host: '127.0.0.1',
      modelClient: new DeterministicTestModelClient(),
      workspacesDir,
      devMode: true,
    });

    const newInfo = await newEngine.start();
    const newBaseUrl = newInfo.url;

    try {
      // 4. Query project from new engine instance
      const projRes = await fetch(`${newBaseUrl}/projects/proj-restart-test`);
      expect(projRes.status).toBe(200);
      const projData = await projRes.json();
      expect(projData.id).toBe('proj-restart-test');
      expect(projData.name).toBe('Restart Persistence Project');

      // 5. Query task list from new engine instance
      const taskListRes = await fetch(`${newBaseUrl}/projects/proj-restart-test/tasks`);
      expect(taskListRes.status).toBe(200);
      const taskListData = await taskListRes.json();
      expect(taskListData.tasks.length).toBe(1);
      expect(taskListData.tasks[0].id).toBe('task-restart-1');
      expect(taskListData.tasks[0].trustState).toBe('VERIFIED');
      expect(taskListData.tasks[0].attemptsCount).toBe(1);

      // 6. Query task detail and verification history from new engine instance
      const detailRes = await fetch(`${newBaseUrl}/projects/proj-restart-test/tasks/task-restart-1`);
      expect(detailRes.status).toBe(200);
      const detailData = await detailRes.json();
      expect(detailData.trustState).toBe('VERIFIED');
      expect(detailData.history.length).toBe(1);
      expect(detailData.history[0].verificationRecord.result.status).toBe('VERIFIED');
    } finally {
      await newEngine.stop();
      newBrain.close();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // WORKFLOW J: Full System Sanity & Safe Zero-Credit Verification
  // ───────────────────────────────────────────────────────────────────────────
  it('Workflow J: Safe Zero-Credit Execution Invariant (Zero model provider network calls / costs)', async () => {
    // Check engine diagnostics confirm test mode / offline deterministic model execution
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = await healthRes.json();
    expect(health.status).toBe('ok');
    expect(health.process.nodeVersion).toBeDefined();

    // Verify model diagnostics endpoint reflects test provider
    const modelRes = await fetch(`${baseUrl}/config/model`);
    const modelConfig = await modelRes.json();
    expect(modelConfig.defaultModel).toBeDefined();
    // Test mode ensures no external network requests or tokens are billed
    expect(modelConfig.testMode).toBe(true);
  });
});
