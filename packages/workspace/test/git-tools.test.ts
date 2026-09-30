import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCommandExecutor } from '../src/local-command-executor.js';
import { LocalGitRepository } from '../src/local-git-repository.js';
import {
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
  createGitTools,
} from '../src/git-tools.js';

let tmpDir: string;
let executor: LocalCommandExecutor;
let repo: LocalGitRepository;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'orc-git-tools-test-'));
  executor = new LocalCommandExecutor({ workspaceRoot: tmpDir });
  repo = new LocalGitRepository(executor);

  await executor.execute('git', ['init']);
  await executor.execute('git', ['config', 'user.name', 'Tool Tester']);
  await executor.execute('git', ['config', 'user.email', 'tester@example.com']);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Git Read-Only Tools', () => {
  it('createGitTools returns the three read-only tools', () => {
    const tools = createGitTools(repo);
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['git_status', 'git_diff', 'git_log']);
  });

  describe('git_status tool', () => {
    it('returns status for clean repository', async () => {
      const tool = createGitStatusTool(repo);
      expect(tool.name).toBe('git_status');

      const result = await tool.execute({});
      expect(result.clean).toBe(true);
      expect(result.staged).toEqual([]);
      expect(result.unstaged).toEqual([]);
      expect(result.untracked).toEqual([]);
    });

    it('returns status showing untracked and modified files', async () => {
      await writeFile(join(tmpDir, 'file.txt'), 'content', 'utf-8');
      await executor.execute('git', ['add', 'file.txt']);
      await executor.execute('git', ['commit', '-m', 'first']);

      await writeFile(join(tmpDir, 'file.txt'), 'modified', 'utf-8');
      await writeFile(join(tmpDir, 'untracked.txt'), 'new', 'utf-8');

      const tool = createGitStatusTool(repo);
      const result = await tool.execute({});
      expect(result.clean).toBe(false);
      expect(result.unstaged).toHaveLength(1);
      expect(result.unstaged[0]?.path).toBe('file.txt');
      expect(result.untracked).toEqual(['untracked.txt']);
    });
  });

  describe('git_diff tool', () => {
    it('returns empty diff when working tree is clean', async () => {
      const tool = createGitDiffTool(repo);
      expect(tool.name).toBe('git_diff');

      const result = await tool.execute({});
      expect(result.diff).toBe('');
    });

    it('returns unstaged diff and staged diff', async () => {
      await writeFile(join(tmpDir, 'file.txt'), 'line1\n', 'utf-8');
      await executor.execute('git', ['add', 'file.txt']);
      await executor.execute('git', ['commit', '-m', 'first']);

      await writeFile(join(tmpDir, 'file.txt'), 'line1\nline2\n', 'utf-8');

      const tool = createGitDiffTool(repo);
      const unstagedResult = await tool.execute({});
      expect(unstagedResult.diff).toContain('+line2');

      // Stage change
      await executor.execute('git', ['add', 'file.txt']);

      const stagedResult = await tool.execute({ staged: true });
      expect(stagedResult.diff).toContain('+line2');

      const cleanUnstaged = await tool.execute({ staged: false });
      expect(cleanUnstaged.diff).toBe('');
    });

    it('validates input arguments', async () => {
      const tool = createGitDiffTool(repo);
      // @ts-expect-error invalid input type test
      await expect(tool.execute({ staged: 'invalid' })).rejects.toThrow(/boolean/);
      // @ts-expect-error invalid input type test
      await expect(tool.execute({ path: 123 })).rejects.toThrow(/string/);
    });
  });

  describe('git_log tool', () => {
    it('returns empty commits for empty repository', async () => {
      const tool = createGitLogTool(repo);
      expect(tool.name).toBe('git_log');

      const result = await tool.execute({});
      expect(result.commits).toEqual([]);
    });

    it('returns recent commits respecting limit', async () => {
      for (let i = 1; i <= 3; i++) {
        await writeFile(join(tmpDir, 'file.txt'), `content ${i}`, 'utf-8');
        await executor.execute('git', ['add', 'file.txt']);
        await executor.execute('git', ['commit', '-m', `commit ${i}`]);
      }

      const tool = createGitLogTool(repo);
      const result = await tool.execute({ limit: 2 });
      expect(result.commits).toHaveLength(2);
      expect(result.commits[0]?.subject).toBe('commit 3');
      expect(result.commits[1]?.subject).toBe('commit 2');
    });

    it('validates limit parameter', async () => {
      const tool = createGitLogTool(repo);
      // @ts-expect-error invalid input type test
      await expect(tool.execute({ limit: 'five' })).rejects.toThrow(/positive integer/);
      await expect(tool.execute({ limit: 0 })).rejects.toThrow(/positive integer/);
      await expect(tool.execute({ limit: -5 })).rejects.toThrow(/positive integer/);
    });
  });
});
