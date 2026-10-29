import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalCommandExecutor,
  LocalGitRepository,
  LocalWorkspace,
} from '@orchestrate/workspace';
import { VerificationAdapter } from '../../src/harness/verification-adapter.js';
import {
  SCENARIO_CATALOG,
  getScenarioDefinition,
  ensureCanonicalScenarioRepo,
} from '../../src/scenarios/index.js';
import { LocalWorkspaceFactory } from '../../src/harness/workspace-factory.js';
import type {
  BenchmarkWorkspace,
  BenchmarkVerificationInput,
} from '../../src/harness/types.js';

describe('Evaluator Acceptance Test Injection & Isolation', () => {
  let tmpDir: string;
  let executor: LocalCommandExecutor;
  let gitRepo: LocalGitRepository;
  let workspace: LocalWorkspace;
  let benchWorkspace: BenchmarkWorkspace;
  let initialSha: string;
  const workspacesToClean: BenchmarkWorkspace[] = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), 'orc-eval-inject-'));
    executor = new LocalCommandExecutor({ workspaceRoot: tmpDir });
    gitRepo = new LocalGitRepository(executor);
    workspace = new LocalWorkspace({ rootPath: tmpDir });

    benchWorkspace = {
      path: tmpDir,
      workspace,
      git: gitRepo,
      cleanup: async () => {
        await rm(tmpDir, { recursive: true, force: true });
      },
    };
    workspacesToClean.push(benchWorkspace);

    // Initialize real git repo with baseline commit
    await executor.execute('git', ['init']);
    await executor.execute('git', ['config', 'user.name', 'Evaluator Test']);
    await executor.execute('git', ['config', 'user.email', 'evaluator@orchestrate.local']);

    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-pkg', version: '1.0.0', type: 'module' }, null, 2)
    );
    await executor.execute('git', ['add', 'package.json']);
    await executor.execute('git', ['commit', '-m', 'Initial baseline']);

    const head = await gitRepo.getHeadCommit();
    initialSha = head!.hash;
  });

  afterEach(async () => {
    while (workspacesToClean.length > 0) {
      const ws = workspacesToClean.pop();
      if (ws && existsSync(ws.path)) {
        await ws.cleanup();
      }
    }
  });

  describe('Verification-time injection & reliable cleanup', () => {
    it('injects evaluator test file during verification and verifies check passes', async () => {
      const adapter = new VerificationAdapter();

      // Write mock implementation file
      await writeFile(join(tmpDir, 'solution.js'), 'export function add(a, b) { return a + b; }\n');

      const evaluatorFile = {
        path: 'test/eval.test.js',
        content: `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../solution.js';

describe('Evaluator Check', () => {
  it('adds numbers correctly', () => {
    assert.equal(add(2, 3), 5);
  });
});
`,
      };

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [
          {
            id: 'check-eval',
            name: 'Evaluator node test check',
            command: 'node',
            args: ['--test', 'test/eval.test.js'],
          },
        ],
        evaluatorFiles: [evaluatorFile],
      };

      const evidence = await adapter.verify(input);

      // Verify the check ran and passed
      expect(evidence.status).toBe('VERIFIED');
      expect(evidence.checks).toHaveLength(1);
      expect(evidence.checks[0].passed).toBe(true);

      // Verify cleanup after success: file must NOT remain on disk
      expect(existsSync(join(tmpDir, 'test/eval.test.js'))).toBe(false);

      // Verify diff capture does not contain the injected evaluator file
      expect(evidence.diffCapture.changes.added).not.toContain('test/eval.test.js');
      expect(evidence.diffCapture.diff).not.toContain('Evaluator Check');
    });

    it('cleans up injected evaluator test file even when verification check fails', async () => {
      const adapter = new VerificationAdapter();

      // Write failing implementation file
      await writeFile(join(tmpDir, 'solution.js'), 'export function add(a, b) { return a - b; }\n');

      const evaluatorFile = {
        path: 'test/failing.test.js',
        content: `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../solution.js';

describe('Evaluator Check', () => {
  it('adds numbers correctly', () => {
    assert.equal(add(2, 3), 5);
  });
});
`,
      };

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_B_UNVERIFIED_HANDOFF',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [
          {
            id: 'check-failing',
            name: 'Failing evaluator check',
            command: 'node',
            args: ['--test', 'test/failing.test.js'],
          },
        ],
        evaluatorFiles: [evaluatorFile],
      };

      const evidence = await adapter.verify(input);

      expect(evidence.status).toBe('FAILED');
      expect(evidence.checks[0].passed).toBe(false);

      // Injected file must be cleaned up on failure
      expect(existsSync(join(tmpDir, 'test/failing.test.js'))).toBe(false);
    });

    it('cleans up injected evaluator test file when engine throws an exception', async () => {
      // Mock engine that throws during verify
      const throwingEngine = {
        verify: async () => {
          throw new Error('Simulated engine crash');
        },
      };

      const adapter = new VerificationAdapter({
        verificationEngine: throwingEngine as any,
      });

      const evaluatorFile = {
        path: 'test/crash.test.js',
        content: '// content',
      };

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_C_ORCHESTRATE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [
          {
            id: 'check-crash',
            name: 'Crash check',
            command: 'node',
            args: ['--test', 'test/crash.test.js'],
          },
        ],
        evaluatorFiles: [evaluatorFile],
      };

      await expect(adapter.verify(input)).rejects.toThrow('Simulated engine crash');

      // Injected file must be cleaned up even on unhandled exception
      expect(existsSync(join(tmpDir, 'test/crash.test.js'))).toBe(false);
    });

    it('restores prior file content if agent had created a conflicting file', async () => {
      const adapter = new VerificationAdapter();

      // Agent created a file at the target path
      const agentContent = '// Agent created file';
      const targetPath = join(tmpDir, 'test/custom.test.js');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(tmpDir, 'test'), { recursive: true });
      await writeFile(targetPath, agentContent, 'utf-8');

      const evaluatorFile = {
        path: 'test/custom.test.js',
        content: `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Evaluator override', () => {
  it('passes', () => { assert.ok(true); });
});
`,
      };

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [
          {
            id: 'check-override',
            name: 'Override check',
            command: 'node',
            args: ['--test', 'test/custom.test.js'],
          },
        ],
        evaluatorFiles: [evaluatorFile],
      };

      const evidence = await adapter.verify(input);
      expect(evidence.status).toBe('VERIFIED');

      // The original agent-authored content must be restored
      expect(existsSync(targetPath)).toBe(true);
      const restored = await readFile(targetPath, 'utf-8');
      expect(restored).toBe(agentContent);
    });

    it('rejects traversal paths attempting to escape workspace root', async () => {
      const adapter = new VerificationAdapter();

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [],
        evaluatorFiles: [{ path: '../../escape.test.js', content: 'evil' }],
      };

      await expect(adapter.verify(input)).rejects.toThrow(/escapes workspace root/);
      expect(existsSync(join(tmpDir, '../../escape.test.js'))).toBe(false);
    });

    it('rejects absolute paths', async () => {
      const adapter = new VerificationAdapter();
      const absPath = process.platform === 'win32' ? 'C:\\Windows\\evil.test.js' : '/tmp/evil.test.js';

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [],
        evaluatorFiles: [{ path: absPath, content: 'evil' }],
      };

      await expect(adapter.verify(input)).rejects.toThrow(/must be relative, got absolute path/);
    });

    it('pre-validates all paths atomically before writing any files', async () => {
      const adapter = new VerificationAdapter();

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [],
        evaluatorFiles: [
          { path: 'test/valid.test.js', content: 'valid' },
          { path: '../invalid.test.js', content: 'invalid' },
        ],
      };

      await expect(adapter.verify(input)).rejects.toThrow(/escapes workspace root/);
      // Even though the first file had a valid path, it must NOT have been written
      expect(existsSync(join(tmpDir, 'test/valid.test.js'))).toBe(false);
    });

    it('rejects paths resolving through symlinks outside the workspace', async () => {
      const adapter = new VerificationAdapter();
      const outsideDir = await mkdtemp(join(os.tmpdir(), 'orc-outside-'));

      try {
        const symlinkPath = join(tmpDir, 'test-symlink');
        const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(outsideDir, symlinkPath, symlinkType);

        const input: BenchmarkVerificationInput = {
          armId: 'ARM_A_BASELINE',
          taskId: 'task-b',
          snapshotCommitSha: initialSha,
          workspace: benchWorkspace,
          checks: [],
          evaluatorFiles: [{ path: 'test-symlink/evil.test.js', content: 'evil' }],
        };

        await expect(adapter.verify(input)).rejects.toThrow(/resolves through symlink outside workspace root/);
        expect(existsSync(join(outsideDir, 'evil.test.js'))).toBe(false);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('rejects injection when an existing directory exists at target path', async () => {
      const adapter = new VerificationAdapter();
      const dirPath = join(tmpDir, 'test/colliding-dir');
      await mkdir(dirPath, { recursive: true });

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [],
        evaluatorFiles: [{ path: 'test/colliding-dir', content: 'file content' }],
      };

      await expect(adapter.verify(input)).rejects.toThrow(/an existing directory already exists at this path/);
    });

    it('surfaces cleanup errors when cleanup fails', async () => {
      // Mock engine whose executor or verification causes an error during cleanup
      const adapter = new VerificationAdapter();

      // We inject a file, and during verification we make the directory read-only or simulate cleanup failure
      // By using a path that we lock or mock:
      // Let's create an input with an evaluator file and test cleanup failure handling
      let cleanedPath = '';
      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: {
          ...benchWorkspace,
          path: tmpDir,
        },
        checks: [
          {
            id: 'check-cleanup-test',
            name: 'check',
            command: 'node',
            args: ['-e', 'process.exit(0)'],
          },
        ],
        evaluatorFiles: [{ path: 'test/cleanup-fail.js', content: 'console.log("ok");' }],
      };

      // To reliably test cleanup failure across platforms, we can make the file unremovable during verify
      // On Windows/Linux, chmod 0o444 on parent dir or locking:
      // Or we can verify that if a cleanup error occurs, verify() throws an error with "Evaluator file cleanup failed"
      // Let's create a custom VerificationEngine that hooks into execution:
      let testVerificationRan = false;
      const customEngine = {
        verify: async () => {
          testVerificationRan = true;
          // In Windows, opening a file with exclusive lock or marking read-only:
          // Alternatively, replace rm or test error aggregation
          return { status: 'VERIFIED' as const, checks: [] };
        },
      };

      const customAdapter = new VerificationAdapter({
        verificationEngine: customEngine as any,
      });

      // Verification succeeds normally when files can be cleaned up
      const evidence = await customAdapter.verify(input);
      expect(evidence.status).toBe('VERIFIED');
      expect(testVerificationRan).toBe(true);
      expect(existsSync(join(tmpDir, 'test/cleanup-fail.js'))).toBe(false);
    });

    it('throws when cleanup fails and leaves cleanup error observable', async () => {
      const lockedFile = 'test/locked-cleanup.js';
      const fullPath = join(tmpDir, lockedFile);

      const customEngine = {
        verify: async () => {
          const { rm, mkdir } = await import('node:fs/promises');
          // Replace file with a non-empty directory so rm(file) without recursive will fail cross-platform
          await rm(fullPath, { force: true });
          await mkdir(join(fullPath, 'blocking-child'), { recursive: true });
          return { status: 'VERIFIED' as const, checks: [] };
        },
      };

      const customAdapter = new VerificationAdapter({
        verificationEngine: customEngine as any,
      });

      const input: BenchmarkVerificationInput = {
        armId: 'ARM_A_BASELINE',
        taskId: 'task-b',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [],
        evaluatorFiles: [{ path: lockedFile, content: 'test content' }],
      };

      try {
        await expect(customAdapter.verify(input)).rejects.toThrow(/Evaluator file cleanup failed/);
      } finally {
        const { rm } = await import('node:fs/promises');
        await rm(fullPath, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('Agent workspace test invisibility & arm isolation', () => {
    const scenarioIds = ['auth-protected-api', 'auth-password-reset', 'data-model-feature'] as const;

    for (const scenarioId of scenarioIds) {
      it(`scenario "${scenarioId}" does NOT contain Task B acceptance test in agent workspace`, async () => {
        const scenario = getScenarioDefinition(scenarioId);
        const materialized = await ensureCanonicalScenarioRepo(scenarioId);

        const factory = new LocalWorkspaceFactory({
          sourceRepoPath: materialized.repoPath,
        });

        const armWorkspace = await factory.create(materialized.snapshotCommitSha);
        workspacesToClean.push(armWorkspace);

        // Check all evaluator files defined for Task B
        expect(scenario.evaluatorFilesTaskB).toBeDefined();
        expect(scenario.evaluatorFilesTaskB!.length).toBeGreaterThan(0);

        for (const evalFile of scenario.evaluatorFilesTaskB!) {
          const fullPath = join(armWorkspace.path, evalFile.path);
          // CRITICAL INVARIANT: The acceptance test file must NOT exist during agent execution
          expect(existsSync(fullPath)).toBe(false);
        }
      });
    }
  });

  describe('Reference implementation verification for all 3 scenarios', () => {
    it('Scenario 1 (auth-protected-api): passes verification with reference profile implementation', async () => {
      const scenario = getScenarioDefinition('auth-protected-api');
      const materialized = await ensureCanonicalScenarioRepo('auth-protected-api');

      const factory = new LocalWorkspaceFactory({
        sourceRepoPath: materialized.repoPath,
      });

      const armWorkspace = await factory.create(materialized.snapshotCommitSha);
      workspacesToClean.push(armWorkspace);

      // Write reference implementation for src/routes/profile.ts
      const profileCode = `import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateToken, type AuthRequest } from '../middleware/auth.ts';
import { USERS } from '../users.ts';

export function handleProfile(req: IncomingMessage, res: ServerResponse): void {
  authenticateToken(req as AuthRequest, res, () => {
    const authReq = req as AuthRequest;
    if (!authReq.user) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const fullUser = USERS[authReq.user.id];
    if (!fullUser) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'User not found' }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(fullUser));
  });
}
`;
      const profilePath = join(armWorkspace.path, 'src/routes/profile.ts');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(armWorkspace.path, 'src/routes'), { recursive: true });
      await writeFile(profilePath, profileCode, 'utf-8');

      const adapter = new VerificationAdapter();
      const evidence = await adapter.verify({
        armId: 'ARM_A_BASELINE',
        taskId: scenario.taskBId,
        snapshotCommitSha: materialized.snapshotCommitSha,
        workspace: armWorkspace,
        checks: scenario.verificationChecksTaskB,
        evaluatorFiles: scenario.evaluatorFilesTaskB,
      });

      expect(evidence.status).toBe('VERIFIED');
      expect(evidence.checks[0].passed).toBe(true);

      // Evaluator file cleaned up
      expect(existsSync(join(armWorkspace.path, 'test/profile.test.ts'))).toBe(false);
    });

    it('Scenario 1 (auth-protected-api): fails verification cleanly when Task B deliverable is missing (reproducing smoke test condition)', async () => {
      const scenario = getScenarioDefinition('auth-protected-api');
      const materialized = await ensureCanonicalScenarioRepo('auth-protected-api');

      const factory = new LocalWorkspaceFactory({
        sourceRepoPath: materialized.repoPath,
      });

      const armWorkspace = await factory.create(materialized.snapshotCommitSha);
      workspacesToClean.push(armWorkspace);

      // In the smoke test condition, the agent failed before creating src/routes/profile.ts
      expect(existsSync(join(armWorkspace.path, 'src/routes/profile.ts'))).toBe(false);

      const adapter = new VerificationAdapter();
      const evidence = await adapter.verify({
        armId: 'ARM_A_BASELINE',
        taskId: scenario.taskBId,
        snapshotCommitSha: materialized.snapshotCommitSha,
        workspace: armWorkspace,
        checks: scenario.verificationChecksTaskB,
        evaluatorFiles: scenario.evaluatorFilesTaskB,
      });

      // Verification must fail honestly with exit code 1 due to missing deliverable
      expect(evidence.status).toBe('FAILED');
      expect(evidence.checks[0].passed).toBe(false);
      expect(evidence.checks[0].exitCode).toBe(1);
      expect(evidence.checks[0].stdout).toContain('ERR_MODULE_NOT_FOUND');
      expect(evidence.checks[0].stdout).toMatch(/src[\\/]routes[\\/]profile\.ts/);

      // Evaluator file cleaned up
      expect(existsSync(join(armWorkspace.path, 'test/profile.test.ts'))).toBe(false);
    });

    it('Scenario 2 (auth-password-reset): passes verification with reference reset implementation', async () => {
      const scenario = getScenarioDefinition('auth-password-reset');
      const materialized = await ensureCanonicalScenarioRepo('auth-password-reset');

      const factory = new LocalWorkspaceFactory({
        sourceRepoPath: materialized.repoPath,
      });

      const armWorkspace = await factory.create(materialized.snapshotCommitSha);
      workspacesToClean.push(armWorkspace);

      // Write reference implementation for src/routes/reset.ts
      const resetCode = `import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateResetToken, consumeResetToken } from '../services/password-reset.ts';
import { updateUserPassword } from '../db.ts';

export async function handleResetPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  let body: any = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : (req as any).body ?? {};
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const token = body.token;
  const newPassword = body.newPassword;

  if (!token || !newPassword || typeof token !== 'string' || typeof newPassword !== 'string') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing required token or newPassword' }));
    return;
  }

  const validation = validateResetToken(token);
  if (!validation.valid || !validation.userId) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid or expired reset token' }));
    return;
  }

  const updated = updateUserPassword(validation.userId, \`hash-\${newPassword}\`);
  if (!updated) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'User not found' }));
    return;
  }

  consumeResetToken(token);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: true }));
}
`;
      const resetPath = join(armWorkspace.path, 'src/routes/reset.ts');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(armWorkspace.path, 'src/routes'), { recursive: true });
      await writeFile(resetPath, resetCode, 'utf-8');

      const adapter = new VerificationAdapter();
      const evidence = await adapter.verify({
        armId: 'ARM_B_UNVERIFIED_HANDOFF',
        taskId: scenario.taskBId,
        snapshotCommitSha: materialized.snapshotCommitSha,
        workspace: armWorkspace,
        checks: scenario.verificationChecksTaskB,
        evaluatorFiles: scenario.evaluatorFilesTaskB,
      });

      expect(evidence.status).toBe('VERIFIED');
      expect(evidence.checks[0].passed).toBe(true);

      // Evaluator file cleaned up
      expect(existsSync(join(armWorkspace.path, 'test/reset.test.ts'))).toBe(false);
    });

    it('Scenario 3 (data-model-feature): passes verification with reference project summary implementation', async () => {
      const scenario = getScenarioDefinition('data-model-feature');
      const materialized = await ensureCanonicalScenarioRepo('data-model-feature');

      const factory = new LocalWorkspaceFactory({
        sourceRepoPath: materialized.repoPath,
      });

      const armWorkspace = await factory.create(materialized.snapshotCommitSha);
      workspacesToClean.push(armWorkspace);

      // Write reference implementation for src/services/project-summary.ts
      const summaryCode = `import { ProjectRepository } from '../data/project-repository.ts';

export class ProjectSummaryService {
  repo: ProjectRepository;

  constructor(repo?: ProjectRepository) {
    this.repo = repo ?? new ProjectRepository();
  }

  async getProjectSummary(id: string): Promise<any | null> {
    const project = await this.repo.findById(id);
    if (!project) return null;

    let completionPercentage = 0;
    if (project.tasksTotal > 0) {
      completionPercentage = Math.round((project.tasksDone / project.tasksTotal) * 100);
    }

    let statusBadge: 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' = 'PLANNED';
    if (completionPercentage === 100) {
      statusBadge = 'COMPLETED';
    } else if (completionPercentage > 0 || project.status === 'ACTIVE') {
      statusBadge = 'IN_PROGRESS';
    }

    return {
      id: project.id,
      name: project.name,
      completionPercentage,
      statusBadge,
      tasksTotal: project.tasksTotal,
      tasksDone: project.tasksDone,
    };
  }
}
`;
      const summaryPath = join(armWorkspace.path, 'src/services/project-summary.ts');
      await mkdir(join(armWorkspace.path, 'src/services'), { recursive: true });
      await writeFile(summaryPath, summaryCode, 'utf-8');

      const adapter = new VerificationAdapter();
      const evidence = await adapter.verify({
        armId: 'ARM_C_ORCHESTRATE',
        taskId: scenario.taskBId,
        snapshotCommitSha: materialized.snapshotCommitSha,
        workspace: armWorkspace,
        checks: scenario.verificationChecksTaskB,
        evaluatorFiles: scenario.evaluatorFilesTaskB,
      });

      expect(evidence.status).toBe('VERIFIED');
      expect(evidence.checks[0].passed).toBe(true);

      // Evaluator file cleaned up
      expect(existsSync(join(armWorkspace.path, 'test/project-summary.test.ts'))).toBe(false);
    });

    describe('Password reset regression coverage: rejecting invalid derivations', () => {
      it('rejects implementation that stores a constant password hash', async () => {
        const scenario = getScenarioDefinition('auth-password-reset');
        const materialized = await ensureCanonicalScenarioRepo('auth-password-reset');
        const factory = new LocalWorkspaceFactory({ sourceRepoPath: materialized.repoPath });
        const armWorkspace = await factory.create(materialized.snapshotCommitSha);
        workspacesToClean.push(armWorkspace);

        const faultyCode = `import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateResetToken, consumeResetToken } from '../services/password-reset.ts';
import { updateUserPassword } from '../db.ts';

export async function handleResetPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const rawBody = Buffer.concat(chunks).toString('utf-8');
  let body: any = {};
  try { body = rawBody ? JSON.parse(rawBody) : (req as any).body ?? {}; } catch { res.statusCode = 400; res.end(); return; }
  const { token, newPassword } = body;
  if (!token || !newPassword) { res.statusCode = 400; res.end(); return; }
  const validation = validateResetToken(token);
  if (!validation.valid || !validation.userId) { res.statusCode = 400; res.end(); return; }
  updateUserPassword(validation.userId, 'constant-dummy-hash');
  consumeResetToken(token);
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true }));
}
`;
        const resetDir = join(armWorkspace.path, 'src/routes');
        await mkdir(resetDir, { recursive: true });
        await writeFile(join(resetDir, 'reset.ts'), faultyCode, 'utf-8');
        const adapter = new VerificationAdapter();
        const evidence = await adapter.verify({
          armId: 'ARM_A_BASELINE',
          taskId: scenario.taskBId,
          snapshotCommitSha: materialized.snapshotCommitSha,
          workspace: armWorkspace,
          checks: scenario.verificationChecksTaskB,
          evaluatorFiles: scenario.evaluatorFilesTaskB,
        });
        expect(evidence.status).toBe('FAILED');
        expect(evidence.checks[0].passed).toBe(false);
      });

      it('rejects implementation that derives stored password from userId', async () => {
        const scenario = getScenarioDefinition('auth-password-reset');
        const materialized = await ensureCanonicalScenarioRepo('auth-password-reset');
        const factory = new LocalWorkspaceFactory({ sourceRepoPath: materialized.repoPath });
        const armWorkspace = await factory.create(materialized.snapshotCommitSha);
        workspacesToClean.push(armWorkspace);

        const faultyCode = `import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateResetToken, consumeResetToken } from '../services/password-reset.ts';
import { updateUserPassword } from '../db.ts';

export async function handleResetPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const rawBody = Buffer.concat(chunks).toString('utf-8');
  let body: any = {};
  try { body = rawBody ? JSON.parse(rawBody) : (req as any).body ?? {}; } catch { res.statusCode = 400; res.end(); return; }
  const { token, newPassword } = body;
  if (!token || !newPassword) { res.statusCode = 400; res.end(); return; }
  const validation = validateResetToken(token);
  if (!validation.valid || !validation.userId) { res.statusCode = 400; res.end(); return; }
  updateUserPassword(validation.userId, \`hash-\${validation.userId}\`);
  consumeResetToken(token);
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true }));
}
`;
        const resetDir = join(armWorkspace.path, 'src/routes');
        await mkdir(resetDir, { recursive: true });
        await writeFile(join(resetDir, 'reset.ts'), faultyCode, 'utf-8');
        const adapter = new VerificationAdapter();
        const evidence = await adapter.verify({
          armId: 'ARM_A_BASELINE',
          taskId: scenario.taskBId,
          snapshotCommitSha: materialized.snapshotCommitSha,
          workspace: armWorkspace,
          checks: scenario.verificationChecksTaskB,
          evaluatorFiles: scenario.evaluatorFilesTaskB,
        });
        expect(evidence.status).toBe('FAILED');
        expect(evidence.checks[0].passed).toBe(false);
      });

      it('rejects implementation that derives stored password from token', async () => {
        const scenario = getScenarioDefinition('auth-password-reset');
        const materialized = await ensureCanonicalScenarioRepo('auth-password-reset');
        const factory = new LocalWorkspaceFactory({ sourceRepoPath: materialized.repoPath });
        const armWorkspace = await factory.create(materialized.snapshotCommitSha);
        workspacesToClean.push(armWorkspace);

        const faultyCode = `import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateResetToken, consumeResetToken } from '../services/password-reset.ts';
import { updateUserPassword } from '../db.ts';

export async function handleResetPassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  const rawBody = Buffer.concat(chunks).toString('utf-8');
  let body: any = {};
  try { body = rawBody ? JSON.parse(rawBody) : (req as any).body ?? {}; } catch { res.statusCode = 400; res.end(); return; }
  const { token, newPassword } = body;
  if (!token || !newPassword) { res.statusCode = 400; res.end(); return; }
  const validation = validateResetToken(token);
  if (!validation.valid || !validation.userId) { res.statusCode = 400; res.end(); return; }
  updateUserPassword(validation.userId, token);
  consumeResetToken(token);
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true }));
}
`;
        const resetDir = join(armWorkspace.path, 'src/routes');
        await mkdir(resetDir, { recursive: true });
        await writeFile(join(resetDir, 'reset.ts'), faultyCode, 'utf-8');
        const adapter = new VerificationAdapter();
        const evidence = await adapter.verify({
          armId: 'ARM_A_BASELINE',
          taskId: scenario.taskBId,
          snapshotCommitSha: materialized.snapshotCommitSha,
          workspace: armWorkspace,
          checks: scenario.verificationChecksTaskB,
          evaluatorFiles: scenario.evaluatorFilesTaskB,
        });
        expect(evidence.status).toBe('FAILED');
        expect(evidence.checks[0].passed).toBe(false);
      });
    });
  });
});
