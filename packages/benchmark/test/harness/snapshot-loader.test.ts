import { describe, it, expect } from 'vitest';
import type { CommandExecutor, ExecutionResult, GitCommit, GitRepository, GitStatus } from '@orchestrate/workspace';
import {
  isValidCommitSha,
  validateSnapshotRecord,
  SnapshotLoader,
} from '../../src/harness/snapshot-loader.js';
import type { TaskASnapshotRecord } from '../../src/harness/types.js';

describe('SnapshotLoader & Validation', () => {
  const validSha = '0123456789abcdef0123456789abcdef01234567';

  const validRecord: TaskASnapshotRecord = {
    snapshotId: 'snap-1',
    commitSha: validSha,
    scenarioId: 'auth-protected-api',
    taskAId: 'task-a',
    agentARunId: 'agent-run-1',
    baseCommitSha: 'abcdef0123456789abcdef0123456789abcdef01',
    dependencyStateSha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    environmentFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
    createdAt: '2026-10-01T12:00:00.000Z',
  };

  describe('isValidCommitSha', () => {
    it('returns true for 40-character hex strings', () => {
      expect(isValidCommitSha(validSha)).toBe(true);
      expect(isValidCommitSha('ABCDEF0123456789ABCDEF0123456789ABCDEF01')).toBe(true);
    });

    it('returns false for invalid lengths or non-hex chars', () => {
      expect(isValidCommitSha('')).toBe(false);
      expect(isValidCommitSha('1234567')).toBe(false); // short 7-char sha
      expect(isValidCommitSha('0123456789abcdef0123456789abcdef0123456z')).toBe(false); // 'z' is not hex
      expect(isValidCommitSha(validSha + '0')).toBe(false); // 41 chars
    });
  });

  describe('validateSnapshotRecord', () => {
    it('validates a correct TaskASnapshotRecord', () => {
      expect(() => validateSnapshotRecord(validRecord)).not.toThrow();
    });

    it('rejects invalid commitSha or baseCommitSha', () => {
      expect(() =>
        validateSnapshotRecord({
          ...validRecord,
          commitSha: 'not-a-sha',
        })
      ).toThrow('commitSha must be an exact 40-character hexadecimal string');

      expect(() =>
        validateSnapshotRecord({
          ...validRecord,
          baseCommitSha: 'not-a-sha',
        })
      ).toThrow('baseCommitSha must be an exact 40-character hexadecimal string');
    });

    it('rejects invalid createdAt date string', () => {
      expect(() =>
        validateSnapshotRecord({
          ...validRecord,
          createdAt: 'not-a-date',
        })
      ).toThrow('createdAt must be a valid ISO-8601 date string');
    });

    it('rejects missing string IDs', () => {
      expect(() =>
        validateSnapshotRecord({
          ...validRecord,
          snapshotId: '',
        })
      ).toThrow('snapshotId must be a non-empty string');
    });
  });

  describe('SnapshotLoader', () => {
    const dummyStatus: GitStatus = {
      isClean: true,
      staged: [],
      unstaged: [],
      untracked: [],
      currentBranch: 'main',
      trackingBranch: null,
      ahead: 0,
      behind: 0,
    };

    const createMockRepo = (overrides?: Partial<GitRepository>): GitRepository => ({
      isRepository: async () => true,
      getStatus: async () => dummyStatus,
      getCurrentBranch: async () => 'main',
      getHeadCommit: async () => ({
        hash: validSha,
        subject: 'Task A commit',
        author: 'Agent A',
        timestamp: '2026-10-01T12:00:00Z',
      } as GitCommit),
      getRecentCommits: async () => [],
      getDiff: async () => '',
      ...overrides,
    });

    it('resolves snapshot matching HEAD commit', async () => {
      const repo = createMockRepo();
      const loader = new SnapshotLoader({ repo });

      const res = await loader.resolveSnapshot(validSha);
      expect(res.resolvable).toBe(true);
      expect(res.commitSha).toBe(validSha.toLowerCase());
      expect(res.isHead).toBe(true);
      expect(res.status.isClean).toBe(true);
    });

    it('resolves historical snapshot via recent commits when not at HEAD', async () => {
      const historicalSha = 'abcdef0123456789abcdef0123456789abcdef01';
      const repo = createMockRepo({
        getHeadCommit: async () => ({
          hash: validSha,
          subject: 'Later commit',
          author: 'Dev',
          timestamp: '2026-10-02T12:00:00Z',
        } as GitCommit),
        getRecentCommits: async () => [
          {
            hash: historicalSha,
            subject: 'Historical commit',
            author: 'Agent A',
            timestamp: '2026-10-01T12:00:00Z',
          } as GitCommit,
        ],
      });

      const loader = new SnapshotLoader({ repo });
      const res = await loader.resolveSnapshot(historicalSha);
      expect(res.resolvable).toBe(true);
      expect(res.isHead).toBe(false);
    });

    it('resolves historical snapshot via CommandExecutor git cat-file', async () => {
      const historicalSha = 'abcdef0123456789abcdef0123456789abcdef01';
      const repo = createMockRepo({
        getHeadCommit: async () => null,
      });

      const mockExecutor: CommandExecutor = {
        execute: async (cmd: string, args: readonly string[]): Promise<ExecutionResult> => {
          if (cmd === 'git' && args[0] === 'cat-file' && args[1] === '-e') {
            return {
              exitCode: 0,
              stdout: '',
              stderr: '',
              timedOut: false,
              durationMs: 5,
            };
          }
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Not found',
            timedOut: false,
            durationMs: 5,
          };
        },
      };

      const loader = new SnapshotLoader({ repo, executor: mockExecutor });
      const res = await loader.resolveSnapshot(historicalSha);
      expect(res.resolvable).toBe(true);
      expect(res.isHead).toBe(false);
    });

    it('throws if directory is not a Git repository', async () => {
      const repo = createMockRepo({
        isRepository: async () => false,
      });

      const loader = new SnapshotLoader({ repo });
      await expect(loader.resolveSnapshot(validSha)).rejects.toThrow(
        'Target path is not a valid Git repository'
      );
    });

    it('throws if snapshot commit is not found anywhere in repo', async () => {
      const missingSha = 'fedcba9876543210fedcba9876543210fedcba98';
      const repo = createMockRepo({
        getHeadCommit: async () => null,
        getRecentCommits: async () => [],
      });

      const loader = new SnapshotLoader({ repo });
      await expect(loader.resolveSnapshot(missingSha)).rejects.toThrow(
        `Snapshot commit "${missingSha}" is not resolvable in the repository.`
      );
    });
  });
});
