import { mkdir, mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalCommandExecutor,
  LocalGitRepository,
  LocalWorkspace,
} from '@orchestrate/workspace';
import { captureDownstreamDiff } from '../../src/harness/diff-capture.js';
import type { BenchmarkWorkspace } from '../../src/harness/types.js';

describe('captureDownstreamDiff', () => {
  let tmpDir: string;
  let executor: LocalCommandExecutor;
  let gitRepo: LocalGitRepository;
  let workspace: LocalWorkspace;
  let benchWorkspace: BenchmarkWorkspace;
  let initialSha: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(os.tmpdir(), 'orc-diff-test-'));
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

    // Initialize real git repo
    await executor.execute('git', ['init']);
    await executor.execute('git', ['config', 'user.name', 'Test Auditor']);
    await executor.execute('git', ['config', 'user.email', 'auditor@example.com']);

    // Create initial commit
    await writeFile(join(tmpDir, 'existing.txt'), 'line 1\nline 2\n');
    await executor.execute('git', ['add', 'existing.txt']);
    await executor.execute('git', ['commit', '-m', 'Initial snapshot commit']);

    const head = await gitRepo.getHeadCommit();
    if (!head?.hash) {
      throw new Error('Failed to create initial commit.');
    }
    initialSha = head.hash;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects invalid snapshot commit SHA format', async () => {
    await expect(
      captureDownstreamDiff(benchWorkspace, 'not-a-valid-sha')
    ).rejects.toThrow('snapshotCommitSha must be an exact 40-character hexadecimal string');
  });

  it('rejects non-repository directory', async () => {
    const nonRepoDir = await mkdtemp(join(os.tmpdir(), 'orc-non-repo-'));
    const nonRepoExecutor = new LocalCommandExecutor({ workspaceRoot: nonRepoDir });
    const nonRepo: BenchmarkWorkspace = {
      path: nonRepoDir,
      workspace: new LocalWorkspace({ rootPath: nonRepoDir }),
      git: new LocalGitRepository(nonRepoExecutor),
      cleanup: async () => {
        await rm(nonRepoDir, { recursive: true, force: true });
      },
    };

    try {
      await expect(
        captureDownstreamDiff(nonRepo, initialSha)
      ).rejects.toThrow('is not a valid Git repository');
    } finally {
      await nonRepo.cleanup();
    }
  });

  it('captures clean workspace state when no modifications were made', async () => {
    const diffCapture = await captureDownstreamDiff(benchWorkspace, initialSha);

    expect(diffCapture.snapshotCommitSha).toBe(initialSha);
    expect(diffCapture.headCommitSha).toBe(initialSha);
    expect(diffCapture.headCommit?.hash).toBe(initialSha);
    expect(diffCapture.gitStatus.clean).toBe(true);
    expect(diffCapture.diff).toBe('');
    expect(diffCapture.changes.added).toEqual([]);
    expect(diffCapture.changes.modified).toEqual([]);
    expect(diffCapture.changes.deleted).toEqual([]);
    expect(diffCapture.changes.renamed).toEqual([]);
    expect(diffCapture.capturedAt).toBeDefined();
  });

  it('captures uncommitted file addition, modification, and deletion', async () => {
    // 1. Modify existing file
    await writeFile(join(tmpDir, 'existing.txt'), 'line 1\nline 2 modified\nline 3 added\n');

    // 2. Add an untracked file
    await writeFile(join(tmpDir, 'untracked.txt'), 'new untracked file\n');

    // 3. Add and stage a new file
    await writeFile(join(tmpDir, 'staged-new.txt'), 'staged file content\n');
    await executor.execute('git', ['add', 'staged-new.txt']);

    // 4. Create another tracked file, commit it, then delete it uncommitted
    await writeFile(join(tmpDir, 'to-delete.txt'), 'temporary\n');
    await executor.execute('git', ['add', 'to-delete.txt']);
    await executor.execute('git', ['commit', '-m', 'Add to-delete.txt']);
    const postCommitHead = (await gitRepo.getHeadCommit())!.hash;

    // Delete to-delete.txt
    await unlink(join(tmpDir, 'to-delete.txt'));

    const diffCapture = await captureDownstreamDiff(benchWorkspace, initialSha);

    expect(diffCapture.snapshotCommitSha).toBe(initialSha);
    expect(diffCapture.headCommitSha).toBe(postCommitHead);
    expect(diffCapture.gitStatus.clean).toBe(false);

    // Changes categorized correctly
    expect(diffCapture.changes.added).toContain('staged-new.txt');
    expect(diffCapture.changes.added).toContain('untracked.txt');
    expect(diffCapture.changes.modified).toContain('existing.txt');
    expect(diffCapture.changes.deleted).toContain('to-delete.txt');

    // Unified diff contains changes relative to initialSha
    expect(diffCapture.diff).toContain('existing.txt');
    expect(diffCapture.diff).toContain('+line 3 added');
    expect(diffCapture.diff).toContain('staged-new.txt');
  });

  it('captures committed changes made by agent after snapshot', async () => {
    // Agent commits a new feature
    await writeFile(join(tmpDir, 'feature.ts'), 'export const feature = true;\n');
    await executor.execute('git', ['add', 'feature.ts']);
    await executor.execute('git', ['commit', '-m', 'Agent B implements feature']);

    const committedHead = await gitRepo.getHeadCommit();
    expect(committedHead?.hash).not.toBe(initialSha);

    const diffCapture = await captureDownstreamDiff(benchWorkspace, initialSha);

    expect(diffCapture.snapshotCommitSha).toBe(initialSha);
    expect(diffCapture.headCommitSha).toBe(committedHead?.hash);
    expect(diffCapture.gitStatus.clean).toBe(true); // Working tree is clean, but committed changes exist
    expect(diffCapture.changes.added).toEqual(['feature.ts']);
    expect(diffCapture.diff).toContain('diff --git a/feature.ts b/feature.ts');
    expect(diffCapture.diff).toContain('+export const feature = true;');
  });

  it('captures file renames', async () => {
    // Rename existing.txt to renamed.txt using git mv
    await executor.execute('git', ['mv', 'existing.txt', 'renamed.txt']);

    const diffCapture = await captureDownstreamDiff(benchWorkspace, initialSha);

    expect(diffCapture.changes.renamed).toEqual([
      { from: 'existing.txt', to: 'renamed.txt' },
    ]);
    expect(diffCapture.diff).toContain('rename from existing.txt');
    expect(diffCapture.diff).toContain('rename to renamed.txt');
  });

  it('throws descriptive error if snapshot commit does not exist in repository', async () => {
    const nonexistentSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await expect(
      captureDownstreamDiff(benchWorkspace, nonexistentSha)
    ).rejects.toThrow(/not found in workspace repository/);
  });
});
