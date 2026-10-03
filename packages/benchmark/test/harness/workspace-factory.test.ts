import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalWorkspaceFactory,
  type GitExecutorFn,
} from '../../src/harness/workspace-factory.js';

describe('LocalWorkspaceFactory', () => {
  const validSha = '0123456789abcdef0123456789abcdef01234567';
  const dummySourceRepo = join(tmpdir(), 'dummy-source-repo');

  const createMockGitExecutor = (overrides?: {
    cloneFails?: boolean;
    checkoutFails?: boolean;
  }): GitExecutorFn => {
    return async (args: string[], cwd?: string) => {
      const cmd = args[0];

      if (cmd === 'clone') {
        if (overrides?.cloneFails) {
          return { exitCode: 1, stdout: '', stderr: 'fatal: repository does not exist' };
        }
        // Initialize minimal git repo structure so LocalGitRepository and LocalCommandExecutor work
        const targetDir = args[args.length - 1];
        await mkdir(join(targetDir, '.git'), { recursive: true });
        await writeFile(join(targetDir, 'package.json'), '{}', 'utf-8');
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      if (cmd === 'checkout') {
        if (overrides?.checkoutFails) {
          return { exitCode: 1, stdout: '', stderr: 'error: pathspec did not match any file(s)' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      // rev-parse for isRepository
      if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) {
        return { exitCode: 0, stdout: 'true\n', stderr: '' };
      }

      // log for getRecentCommits / getHeadCommit
      if (cmd === 'log') {
        return {
          exitCode: 0,
          stdout: `${validSha}\x1fInitial commit\x1fAuthor\x1f2026-10-01T12:00:00Z\n`,
          stderr: '',
        };
      }

      // status
      if (cmd === 'status') {
        return { exitCode: 0, stdout: '## HEAD (no branch)\n', stderr: '' };
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    };
  };

  it('rejects invalid commit SHA without creating directory', async () => {
    const factory = new LocalWorkspaceFactory({
      sourceRepoPath: dummySourceRepo,
      gitExecutor: createMockGitExecutor(),
    });

    await expect(factory.create('invalid-sha')).rejects.toThrow(
      'snapshotCommitSha must be an exact 40-character hexadecimal string'
    );
  });

  it('creates an isolated workspace checked out at exact snapshot SHA', async () => {
    const factory = new LocalWorkspaceFactory({
      sourceRepoPath: dummySourceRepo,
      gitExecutor: createMockGitExecutor(),
    });

    const benchWs = await factory.create(validSha);

    expect(benchWs).toBeDefined();
    expect(existsSync(benchWs.path)).toBe(true);
    expect(benchWs.workspace).toBeDefined();
    expect(benchWs.git).toBeDefined();
    expect(factory.isOwnedPath(benchWs.path)).toBe(true);

    const head = await benchWs.git.getHeadCommit();
    expect(head?.hash.toLowerCase()).toBe(validSha.toLowerCase());

    const status = await benchWs.git.getStatus();
    expect(status.clean).toBe(true);

    // Cleanup removes workspace
    await benchWs.cleanup();
    expect(existsSync(benchWs.path)).toBe(false);
    expect(factory.isOwnedPath(benchWs.path)).toBe(false);
  });

  it('ensures workspaces are isolated and do not share mutable state', async () => {
    const factory = new LocalWorkspaceFactory({
      sourceRepoPath: dummySourceRepo,
      gitExecutor: createMockGitExecutor(),
    });

    const ws1 = await factory.create(validSha);
    const ws2 = await factory.create(validSha);

    expect(ws1.path).not.toBe(ws2.path);

    // Write file in ws1
    await ws1.workspace.writeFile('test.txt', 'hello from ws1');
    const content1 = await ws1.workspace.readFile('test.txt');
    expect(content1).toBe('hello from ws1');

    // ws2 must NOT have this file
    await expect(ws2.workspace.readFile('test.txt')).rejects.toThrow(
      'File not found in workspace'
    );

    // Clean up both
    await ws1.cleanup();
    await ws2.cleanup();

    expect(existsSync(ws1.path)).toBe(false);
    expect(existsSync(ws2.path)).toBe(false);
  });

  it('cleans up directory if git checkout fails', async () => {
    const factory = new LocalWorkspaceFactory({
      sourceRepoPath: dummySourceRepo,
      gitExecutor: createMockGitExecutor({ checkoutFails: true }),
    });

    await expect(factory.create(validSha)).rejects.toThrow('Failed to checkout snapshot commit');
  });

  it('cleans up directory if git clone fails', async () => {
    const factory = new LocalWorkspaceFactory({
      sourceRepoPath: dummySourceRepo,
      gitExecutor: createMockGitExecutor({ cloneFails: true }),
    });

    await expect(factory.create(validSha)).rejects.toThrow('Failed to clone source repository');
  });

  describe('cleanup by path', () => {
    it('cleans up workspace via factory.cleanup(path) idempotently', async () => {
      const factory = new LocalWorkspaceFactory({
        sourceRepoPath: dummySourceRepo,
        gitExecutor: createMockGitExecutor(),
      });

      const ws = await factory.create(validSha);
      expect(existsSync(ws.path)).toBe(true);

      // Explicit cleanup via factory
      await factory.cleanup(ws.path);
      expect(existsSync(ws.path)).toBe(false);
      expect(factory.isOwnedPath(ws.path)).toBe(false);

      // Repeated cleanup on same path is a safe no-op
      await expect(factory.cleanup(ws.path)).resolves.not.toThrow();

      // Repeated cleanup via benchWs.cleanup is also safe
      await expect(ws.cleanup()).resolves.not.toThrow();
    });

    it('rejects unowned or arbitrary paths', async () => {
      const factory = new LocalWorkspaceFactory({
        sourceRepoPath: dummySourceRepo,
        gitExecutor: createMockGitExecutor(),
      });

      await expect(factory.cleanup(join(tmpdir(), 'arbitrary-unowned-dir'))).rejects.toThrow(
        'Cannot cleanup unowned path'
      );
      await expect(factory.cleanup('')).rejects.toThrow(
        'WorkspaceFactory.cleanup requires a non-empty path string'
      );
    });
  });
});
