import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCommandExecutor } from '../src/local-command-executor.js';
import { LocalGitRepository } from '../src/local-git-repository.js';
import type { CommandExecutor } from '../src/executor-types.js';

let tmpDir: string;
let executor: LocalCommandExecutor;
let repo: LocalGitRepository;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'orc-git-test-'));
  executor = new LocalCommandExecutor({ workspaceRoot: tmpDir });
  repo = new LocalGitRepository(executor);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function initGitRepo(): Promise<void> {
  await executor.execute('git', ['init']);
  await executor.execute('git', ['config', 'user.name', 'Test Committer']);
  await executor.execute('git', ['config', 'user.email', 'test@example.com']);
}

describe('LocalGitRepository', () => {
  // 1. non-Git directory
  it('1. non-Git directory: isRepository returns false and inspection methods reject', async () => {
    const isRepo = await repo.isRepository();
    expect(isRepo).toBe(false);

    await expect(repo.getStatus()).rejects.toThrow(/Not a git repository/);
    await expect(repo.getCurrentBranch()).rejects.toThrow(/Not a git repository/);
    await expect(repo.getHeadCommit()).rejects.toThrow(/Not a git repository/);
    await expect(repo.getRecentCommits()).rejects.toThrow(/Not a git repository/);
    await expect(repo.getDiff()).rejects.toThrow(/Not a git repository/);
  });

  // 2. initialized repository
  it('2. initialized repository: isRepository returns true, empty history handled gracefully', async () => {
    await initGitRepo();

    const isRepo = await repo.isRepository();
    expect(isRepo).toBe(true);

    const status = await repo.getStatus();
    expect(status.clean).toBe(true);
    expect(status.detached).toBe(false);
    expect(typeof status.branch).toBe('string');
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);

    const branch = await repo.getCurrentBranch();
    expect(typeof branch).toBe('string');

    const head = await repo.getHeadCommit();
    expect(head).toBeNull();

    const commits = await repo.getRecentCommits();
    expect(commits).toEqual([]);

    const diff = await repo.getDiff();
    expect(diff).toBe('');
  });

  // 3. clean repository
  it('3. clean repository: returns clean=true after committing', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'file.txt'), 'hello world', 'utf-8');
    await executor.execute('git', ['add', 'file.txt']);
    await executor.execute('git', ['commit', '-m', 'initial commit']);

    const status = await repo.getStatus();
    expect(status.clean).toBe(true);
    expect(status.staged).toHaveLength(0);
    expect(status.unstaged).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);
  });

  // 4. untracked file
  it('4. untracked file: correctly detected in untracked array', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'file.txt'), 'hello world', 'utf-8');
    await executor.execute('git', ['add', 'file.txt']);
    await executor.execute('git', ['commit', '-m', 'initial commit']);

    await writeFile(join(tmpDir, 'untracked.txt'), 'untracked content', 'utf-8');

    const status = await repo.getStatus();
    expect(status.clean).toBe(false);
    expect(status.untracked).toEqual(['untracked.txt']);
    expect(status.staged).toHaveLength(0);
    expect(status.unstaged).toHaveLength(0);
  });

  // 5. modified file
  it('5. modified file: correctly detected in unstaged array', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'tracked.txt'), 'initial content', 'utf-8');
    await executor.execute('git', ['add', 'tracked.txt']);
    await executor.execute('git', ['commit', '-m', 'initial commit']);

    await writeFile(join(tmpDir, 'tracked.txt'), 'modified content', 'utf-8');

    const status = await repo.getStatus();
    expect(status.clean).toBe(false);
    expect(status.staged).toHaveLength(0);
    expect(status.unstaged).toHaveLength(1);
    expect(status.unstaged[0]?.path).toBe('tracked.txt');
    expect(status.unstaged[0]?.statusCode).toBe('modified');
    expect(status.untracked).toHaveLength(0);
  });

  // 6. staged file
  it('6. staged file: distinguishes staged additions and staged modifications', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'tracked.txt'), 'v1', 'utf-8');
    await executor.execute('git', ['add', 'tracked.txt']);
    await executor.execute('git', ['commit', '-m', 'initial commit']);

    // Staged modification
    await writeFile(join(tmpDir, 'tracked.txt'), 'v2', 'utf-8');
    await executor.execute('git', ['add', 'tracked.txt']);

    // Staged addition
    await writeFile(join(tmpDir, 'newfile.txt'), 'new', 'utf-8');
    await executor.execute('git', ['add', 'newfile.txt']);

    const status = await repo.getStatus();
    expect(status.clean).toBe(false);
    expect(status.unstaged).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);
    expect(status.staged).toHaveLength(2);

    const trackedStaged = status.staged.find((s) => s.path === 'tracked.txt');
    const newStaged = status.staged.find((s) => s.path === 'newfile.txt');

    expect(trackedStaged).toBeDefined();
    expect(trackedStaged?.statusCode).toBe('modified');
    expect(newStaged).toBeDefined();
    expect(newStaged?.statusCode).toBe('added');
  });

  // 7. mixed staged + unstaged state
  it('7. mixed staged + unstaged state: file present in both staged and unstaged', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'mixed.txt'), 'initial', 'utf-8');
    await executor.execute('git', ['add', 'mixed.txt']);
    await executor.execute('git', ['commit', '-m', 'initial commit']);

    // Stage a change
    await writeFile(join(tmpDir, 'mixed.txt'), 'staged edit', 'utf-8');
    await executor.execute('git', ['add', 'mixed.txt']);

    // Make another change without staging
    await writeFile(join(tmpDir, 'mixed.txt'), 'unstaged edit', 'utf-8');

    const status = await repo.getStatus();
    expect(status.clean).toBe(false);
    expect(status.staged).toHaveLength(1);
    expect(status.staged[0]?.path).toBe('mixed.txt');
    expect(status.staged[0]?.statusCode).toBe('modified');

    expect(status.unstaged).toHaveLength(1);
    expect(status.unstaged[0]?.path).toBe('mixed.txt');
    expect(status.unstaged[0]?.statusCode).toBe('modified');
  });

  // 8. current branch
  it('8. current branch: returns active branch name and tracks branch switches', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'file.txt'), 'content', 'utf-8');
    await executor.execute('git', ['add', 'file.txt']);
    await executor.execute('git', ['commit', '-m', 'commit']);

    const initialBranch = await repo.getCurrentBranch();
    expect(initialBranch).toBeTruthy();

    await executor.execute('git', ['checkout', '-b', 'feature-branch']);
    const featureBranch = await repo.getCurrentBranch();
    expect(featureBranch).toBe('feature-branch');

    const status = await repo.getStatus();
    expect(status.branch).toBe('feature-branch');
    expect(status.detached).toBe(false);
  });

  // 9. HEAD commit
  it('9. HEAD commit: returns commit with hash, subject, author, timestamp', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'file.txt'), 'content', 'utf-8');
    await executor.execute('git', ['add', 'file.txt']);
    await executor.execute('git', ['commit', '-m', 'feat: initial implementation']);

    const head = await repo.getHeadCommit();
    expect(head).not.toBeNull();
    expect(head?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head?.subject).toBe('feat: initial implementation');
    expect(head?.author).toBe('Test Committer');
    expect(typeof head?.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(head!.timestamp))).toBe(false);
  });

  // 10. recent commits
  it('10. recent commits: returns commits in reverse chronological order respecting limit', async () => {
    await initGitRepo();

    for (let i = 1; i <= 3; i++) {
      await writeFile(join(tmpDir, 'file.txt'), `content ${i}`, 'utf-8');
      await executor.execute('git', ['add', 'file.txt']);
      await executor.execute('git', ['commit', '-m', `commit ${i}`]);
    }

    const allCommits = await repo.getRecentCommits();
    expect(allCommits).toHaveLength(3);
    expect(allCommits[0]?.subject).toBe('commit 3');
    expect(allCommits[1]?.subject).toBe('commit 2');
    expect(allCommits[2]?.subject).toBe('commit 1');

    const limitedCommits = await repo.getRecentCommits(2);
    expect(limitedCommits).toHaveLength(2);
    expect(limitedCommits[0]?.subject).toBe('commit 3');
    expect(limitedCommits[1]?.subject).toBe('commit 2');

    // Invalid limit rejection
    await expect(repo.getRecentCommits(0)).rejects.toThrow(/positive integer/);
    await expect(repo.getRecentCommits(-1)).rejects.toThrow(/positive integer/);
    await expect(repo.getRecentCommits(1.5)).rejects.toThrow(/positive integer/);
  });

  // 11. diff
  it('11. diff: handles unstaged, staged, and path-filtered diffs', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'file1.txt'), 'file 1 line 1\n', 'utf-8');
    await writeFile(join(tmpDir, 'file2.txt'), 'file 2 line 1\n', 'utf-8');
    await executor.execute('git', ['add', '.']);
    await executor.execute('git', ['commit', '-m', 'initial']);

    // Make unstaged changes to both files
    await writeFile(join(tmpDir, 'file1.txt'), 'file 1 line 1\nfile 1 line 2\n', 'utf-8');
    await writeFile(join(tmpDir, 'file2.txt'), 'file 2 line 1\nfile 2 line 2\n', 'utf-8');

    // Full unstaged diff
    const unstagedDiff = await repo.getDiff();
    expect(unstagedDiff).toContain('file1.txt');
    expect(unstagedDiff).toContain('file2.txt');
    expect(unstagedDiff).toContain('+file 1 line 2');
    expect(unstagedDiff).toContain('+file 2 line 2');

    // Path-filtered diff
    const pathDiff = await repo.getDiff({ path: 'file1.txt' });
    expect(pathDiff).toContain('file1.txt');
    expect(pathDiff).not.toContain('file2.txt');

    // Stage changes for file1 only
    await executor.execute('git', ['add', 'file1.txt']);

    const stagedDiff = await repo.getDiff({ staged: true });
    expect(stagedDiff).toContain('file1.txt');
    expect(stagedDiff).not.toContain('file2.txt');

    // Unstaged diff now only has file2
    const remainingUnstaged = await repo.getDiff();
    expect(remainingUnstaged).not.toContain('file1.txt');
    expect(remainingUnstaged).toContain('file2.txt');
  });

  // 12. detached HEAD if practical
  it('12. detached HEAD: correctly detected in status and branch returns null', async () => {
    await initGitRepo();
    await writeFile(join(tmpDir, 'file.txt'), 'v1', 'utf-8');
    await executor.execute('git', ['add', 'file.txt']);
    await executor.execute('git', ['commit', '-m', 'first commit']);

    const firstCommit = await repo.getHeadCommit();
    expect(firstCommit).not.toBeNull();

    await writeFile(join(tmpDir, 'file.txt'), 'v2', 'utf-8');
    await executor.execute('git', ['add', 'file.txt']);
    await executor.execute('git', ['commit', '-m', 'second commit']);

    // Detach HEAD to first commit
    await executor.execute('git', ['checkout', firstCommit!.hash]);

    const status = await repo.getStatus();
    expect(status.detached).toBe(true);
    expect(status.branch).toBeNull();
    expect(status.clean).toBe(true);

    const branch = await repo.getCurrentBranch();
    expect(branch).toBeNull();

    const head = await repo.getHeadCommit();
    expect(head?.hash).toBe(firstCommit!.hash);
  });

  // 13. failed Git operation
  it('13. failed Git operation: does not silently convert failure into clean state', async () => {
    // Failing executor that simulates git command failure
    const failingExecutor: CommandExecutor = {
      async execute() {
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'fatal: repository is corrupted',
          timedOut: false,
        };
      },
    };

    const failingRepo = new LocalGitRepository(failingExecutor);
    await expect(failingRepo.getStatus()).rejects.toThrow(/fatal: repository is corrupted/);
    await expect(failingRepo.getCurrentBranch()).rejects.toThrow(/fatal: repository is corrupted/);
    await expect(failingRepo.getRecentCommits()).rejects.toThrow(/fatal: repository is corrupted/);
    await expect(failingRepo.getDiff()).rejects.toThrow(/fatal: repository is corrupted/);

    // Timeout failure
    const timeoutExecutor: CommandExecutor = {
      async execute() {
        return {
          exitCode: null,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
          timedOut: true,
        };
      },
    };
    const timeoutRepo = new LocalGitRepository(timeoutExecutor);
    await expect(timeoutRepo.getStatus()).rejects.toThrow(/timed out/);
  });

  // 14. repository path containment
  it('14. repository path containment: prevents cwd and path traversal', async () => {
    // Rejects null bytes in cwd
    expect(() => new LocalGitRepository({ executor, cwd: 'foo\0bar' })).toThrow(/null bytes/);

    // Rejects absolute path in cwd
    const absPath = process.platform === 'win32' ? 'C:\\escaped' : '/escaped';
    expect(() => new LocalGitRepository({ executor, cwd: absPath })).toThrow(/absolute path/);

    // Rejects parent directory traversal in cwd
    expect(() => new LocalGitRepository({ executor, cwd: '../outside' })).toThrow(/Path traversal denied/);
    expect(() => new LocalGitRepository({ executor, cwd: 'foo/../../outside' })).toThrow(/Path traversal denied/);

    // Rejects traversal and absolute paths in getDiff
    await initGitRepo();
    await expect(repo.getDiff({ path: 'foo\0bar' })).rejects.toThrow(/null bytes/);
    await expect(repo.getDiff({ path: absPath })).rejects.toThrow(/absolute path/);
    await expect(repo.getDiff({ path: '../outside.txt' })).rejects.toThrow(/Path traversal denied/);
  });

  // Subdirectory repository inside workspace
  it('supports working in a subdirectory repository inside workspace', async () => {
    const subRepoDir = join(tmpDir, 'sub-repo');
    await mkdir(subRepoDir);

    const subExecutor = new LocalCommandExecutor({ workspaceRoot: tmpDir });
    await subExecutor.execute('git', ['init'], { cwd: 'sub-repo' });
    await subExecutor.execute('git', ['config', 'user.name', 'Sub Committer'], { cwd: 'sub-repo' });
    await subExecutor.execute('git', ['config', 'user.email', 'sub@example.com'], { cwd: 'sub-repo' });

    await writeFile(join(subRepoDir, 'subfile.txt'), 'sub content', 'utf-8');

    const subRepo = new LocalGitRepository({ executor: subExecutor, cwd: 'sub-repo' });
    const isRepo = await subRepo.isRepository();
    expect(isRepo).toBe(true);

    const status = await subRepo.getStatus();
    expect(status.clean).toBe(false);
    expect(status.untracked).toEqual(['subfile.txt']);
  });
});
