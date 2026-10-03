import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalCommandExecutor,
  LocalGitRepository,
  LocalWorkspace,
} from '@orchestrate/workspace';
import type { VerificationCheck } from '@orchestrate/verification';
import { verifyVerificationEvidenceSeal } from '../../src/harness/evidence-sealer.js';
import { VerificationAdapter } from '../../src/harness/verification-adapter.js';
import type {
  BenchmarkWorkspace,
  BenchmarkVerificationInput,
} from '../../src/harness/types.js';

describe('VerificationAdapter', () => {
  let tmpDir: string;
  let executor: LocalCommandExecutor;
  let gitRepo: LocalGitRepository;
  let workspace: LocalWorkspace;
  let benchWorkspace: BenchmarkWorkspace;
  let initialSha: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), 'orc-verif-test-'));
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

    // Initialize real git repo with baseline commit
    await executor.execute('git', ['init']);
    await executor.execute('git', ['config', 'user.name', 'Verification Auditor']);
    await executor.execute('git', ['config', 'user.email', 'auditor@example.com']);

    await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '1.0.0' }));
    await executor.execute('git', ['add', 'package.json']);
    await executor.execute('git', ['commit', '-m', 'Initial baseline']);

    const head = await gitRepo.getHeadCommit();
    initialSha = head!.hash;
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies the exact live arm workspace without creating a second checkout', async () => {
    const adapter = new VerificationAdapter();

    // Create a file in the workspace
    await writeFile(join(tmpDir, 'result.txt'), 'hello verification');

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_A_BASELINE',
      taskId: 'task-auth-impl',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'check-git-status',
          name: 'Check git status',
          command: 'git',
          args: ['status', '--porcelain'],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    expect(evidence.armId).toBe('ARM_A_BASELINE');
    expect(evidence.taskId).toBe('task-auth-impl');
    expect(evidence.snapshotCommitSha).toBe(initialSha);
    expect(evidence.workspacePath).toBe('workspace://ARM_A_BASELINE');
    expect(evidence.workspacePath).not.toContain(os.tmpdir());

    // Verified that it checked the exact live workspace
    expect(evidence.status).toBe('VERIFIED');
    expect(evidence.checks).toHaveLength(1);
    expect(evidence.checks[0].checkId).toBe('check-git-status');
    expect(evidence.checks[0].passed).toBe(true);
    expect(evidence.checks[0].stdout).toContain('result.txt');

    // Live workspace is preserved on disk (teardown is caller responsibility)
    expect(existsSync(tmpDir)).toBe(true);
  });

  it('returns VERIFIED when all configured checks pass', async () => {
    const adapter = new VerificationAdapter();

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_C_ORCHESTRATE',
      taskId: 'task-test-passing',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'check-1',
          name: 'Node print true',
          command: 'node',
          args: ['-e', 'process.exit(0)'],
        },
        {
          id: 'check-2',
          name: 'Git rev-parse',
          command: 'git',
          args: ['rev-parse', 'HEAD'],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    expect(evidence.status).toBe('VERIFIED');
    expect(evidence.checks).toHaveLength(2);
    expect(evidence.checks[0].passed).toBe(true);
    expect(evidence.checks[1].passed).toBe(true);
    expect(evidence.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns FAILED when any check fails and preserves stdout/stderr/exitCode', async () => {
    const adapter = new VerificationAdapter();

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_B_UNVERIFIED_HANDOFF',
      taskId: 'task-test-failing',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'check-passing',
          name: 'Passing check',
          command: 'node',
          args: ['-e', 'console.log("Check 1 passed"); process.exit(0);'],
        },
        {
          id: 'check-failing',
          name: 'Failing check',
          command: 'node',
          args: ['-e', 'console.error("Assertion failed: expected 42 got 0"); process.exit(1);'],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    expect(evidence.status).toBe('FAILED');
    expect(evidence.checks).toHaveLength(2);

    expect(evidence.checks[0].passed).toBe(true);
    expect(evidence.checks[0].stdout).toContain('Check 1 passed');

    expect(evidence.checks[1].passed).toBe(false);
    expect(evidence.checks[1].exitCode).toBe(1);
    expect(evidence.checks[1].stderr).toContain('Assertion failed: expected 42 got 0');
  });

  it('preserves execution order across multiple checks', async () => {
    const adapter = new VerificationAdapter();

    const checks: VerificationCheck[] = [
      { id: 'step-1', name: 'Step 1', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'step-2', name: 'Step 2', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'step-3', name: 'Step 3', command: 'node', args: ['-e', 'process.exit(0)'] },
    ];

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_A_BASELINE',
      taskId: 'task-ordering',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks,
    };

    const evidence = await adapter.verify(input);

    expect(evidence.checks.map((c) => c.checkId)).toEqual(['step-1', 'step-2', 'step-3']);
  });

  it('binds exact snapshot SHA, HEAD commit, and working tree state', async () => {
    const adapter = new VerificationAdapter();

    // Agent committed a change
    await writeFile(join(tmpDir, 'auth.ts'), 'export const auth = true;');
    await executor.execute('git', ['add', 'auth.ts']);
    await executor.execute('git', ['commit', '-m', 'Agent commit']);

    const newHead = (await gitRepo.getHeadCommit())!.hash;

    // Agent also left an uncommitted file
    await writeFile(join(tmpDir, 'notes.md'), 'uncommitted notes');

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_C_ORCHESTRATE',
      taskId: 'task-workspace-binding',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'check-noop',
          name: 'Noop',
          command: 'node',
          args: ['-e', 'process.exit(0)'],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    // Exact workspace binding
    expect(evidence.workspaceBinding.snapshotCommitSha).toBe(initialSha);
    expect(evidence.workspaceBinding.workspacePath).toBe('workspace://ARM_C_ORCHESTRATE');
    expect(evidence.workspaceBinding.headCommitSha).toBe(newHead);
    expect(evidence.workspaceBinding.headCommit?.subject).toBe('Agent commit');
    expect(evidence.workspaceBinding.gitStatus.untracked).toContain('notes.md');

    // Diff capture
    expect(evidence.diffCapture.changes.added).toContain('auth.ts');
    expect(evidence.diffCapture.changes.added).toContain('notes.md');
    expect(evidence.diffCapture.diff).toContain('export const auth = true;');
  });

  it('seals verification evidence with cryptographic hash and detects tampering', async () => {
    const adapter = new VerificationAdapter();

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_A_BASELINE',
      taskId: 'task-sealing',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'check-seal',
          name: 'Check sealing',
          command: 'node',
          args: ['-e', 'process.exit(0)'],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    expect(evidence.evidenceContentHash).toBeDefined();
    expect(evidence.evidenceContentHash).toMatch(/^[0-9a-f]{64}$/);

    // Valid verification
    expect(verifyVerificationEvidenceSeal(evidence)).toBe(true);

    // Tampered verification fails
    const tamperedStatus = { ...evidence, status: 'FAILED' as const };
    expect(verifyVerificationEvidenceSeal(tamperedStatus)).toBe(false);

    const tamperedCheck = {
      ...evidence,
      checks: [
        {
          ...evidence.checks[0],
          passed: false,
        },
      ],
    };
    expect(verifyVerificationEvidenceSeal(tamperedCheck)).toBe(false);
  });

  it('redacts sensitive values in check output before sealing', async () => {
    const secretKey = 'super-secret-password-12345';
    const adapter = new VerificationAdapter({
      customSecrets: [secretKey],
    });

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_A_BASELINE',
      taskId: 'task-redaction',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'check-secret-output',
          name: 'Output secret',
          command: 'node',
          args: ['-e', `console.log("Logged with key: ${secretKey}"); process.exit(0);`],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    expect(evidence.checks[0].stdout).not.toContain(secretKey);
    expect(evidence.checks[0].stdout).toContain('[REDACTED]');
    expect(verifyVerificationEvidenceSeal(evidence, [secretKey])).toBe(true);
  });

  it('rejects invalid inputs and infrastructure failures cleanly', async () => {
    const adapter = new VerificationAdapter();

    // Invalid snapshot commit format
    await expect(
      adapter.verify({
        armId: 'ARM_A_BASELINE',
        taskId: 't1',
        snapshotCommitSha: 'bad-sha',
        workspace: benchWorkspace,
        checks: [],
      })
    ).rejects.toThrow('snapshotCommitSha must be an exact 40-character hexadecimal string');

    // Missing taskId
    await expect(
      adapter.verify({
        armId: 'ARM_A_BASELINE',
        taskId: '',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [],
      })
    ).rejects.toThrow('taskId must be a non-empty string');

    // Empty checks array rejected by VerificationEngine
    await expect(
      adapter.verify({
        armId: 'ARM_A_BASELINE',
        taskId: 't1',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [],
      })
    ).rejects.toThrow('checks must contain at least one check');

    // Disallowed command (e.g. rm) rejected by VerificationEngine
    await expect(
      adapter.verify({
        armId: 'ARM_A_BASELINE',
        taskId: 't1',
        snapshotCommitSha: initialSha,
        workspace: benchWorkspace,
        checks: [{ id: 'bad-cmd', name: 'rm', command: 'rm', args: ['-rf', '/'] }],
      })
    ).rejects.toThrow('Command not allowed in verification check');
  });

  // ==========================================================================
  // Section 16 — TEST THE IMPORTANT EXPERIMENTAL PROPERTY (Independence)
  // ==========================================================================

  it('EXPERIMENTAL INDEPENDENCE 1: Agent claims success, but independent verification fails -> FAILED', async () => {
    // Simulated Agent B execution claims: "I have implemented all features and verified all tests pass!"
    const agentExecutionClaim = {
      finalResponseContent: 'I have finished the task. All unit tests and verification checks passed with 100% coverage.',
      outcome: 'COMPLETED',
    };
    expect(agentExecutionClaim.finalResponseContent).toContain('All unit tests and verification checks passed');

    // However, the actual configured independent verification check tests the code and finds a failing assertion
    const adapter = new VerificationAdapter();

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_B_UNVERIFIED_HANDOFF',
      taskId: 'auth-protected-endpoint',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'test-endpoint-auth',
          name: 'Endpoint returns 401 without bearer token',
          command: 'node',
          // Intentionally fails: endpoint returns 200 instead of 401
          args: ['-e', 'console.error("FAIL: expected HTTP 401, got 200"); process.exit(1);'],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    // CRITICAL INVARIANT: The agent's statement is an untrusted claim; independent verification determines status.
    expect(evidence.status).toBe('FAILED');
    expect(evidence.checks[0].passed).toBe(false);
    expect(evidence.checks[0].stderr).toContain('FAIL: expected HTTP 401, got 200');
  });

  it('EXPERIMENTAL INDEPENDENCE 2: Agent claims failure, but independent verification passes -> VERIFIED', async () => {
    // Simulated Agent B execution claims: "I could not resolve the dependencies and tests failed."
    const agentExecutionClaim = {
      finalResponseContent: 'I encountered an error and could not complete the assignment. Tests failed.',
      outcome: 'FAILED',
    };
    expect(agentExecutionClaim.finalResponseContent).toContain('Tests failed');

    // However, the actual repository state satisfies the independent verification suite
    const adapter = new VerificationAdapter();

    const input: BenchmarkVerificationInput = {
      armId: 'ARM_A_BASELINE',
      taskId: 'auth-protected-endpoint',
      snapshotCommitSha: initialSha,
      workspace: benchWorkspace,
      checks: [
        {
          id: 'test-auth-requirement',
          name: 'Package json is present and valid',
          command: 'node',
          args: ['-e', 'const pkg = require("./package.json"); if (pkg.name !== "test-pkg") process.exit(1); process.exit(0);'],
        },
      ],
    };

    const evidence = await adapter.verify(input);

    // CRITICAL INVARIANT: Verification evidence reflects actual command execution, not agent claims.
    expect(evidence.status).toBe('VERIFIED');
    expect(evidence.checks[0].passed).toBe(true);
  });
});
