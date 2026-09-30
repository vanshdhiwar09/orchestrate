import type { GitCommit, GitRepository, GitStatus } from './git-types.js';

export interface GitTool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: TInput): Promise<TOutput>;
}

// ── git_status ──────────────────────────────────────────────────────────────

export function createGitStatusTool(
  repo: GitRepository
): GitTool<Record<string, unknown>, GitStatus> {
  return {
    name: 'git_status',
    description:
      'Inspects the working tree and staging area of the Git repository. ' +
      'Returns current branch, detached state, clean flag, staged changes, unstaged changes, and untracked files.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(): Promise<GitStatus> {
      return await repo.getStatus();
    },
  };
}

// ── git_diff ────────────────────────────────────────────────────────────────

export interface GitDiffToolInput extends Record<string, unknown> {
  staged?: boolean;
  path?: string;
}

export interface GitDiffToolResult {
  diff: string;
}

export function createGitDiffTool(
  repo: GitRepository
): GitTool<GitDiffToolInput, GitDiffToolResult> {
  return {
    name: 'git_diff',
    description:
      'Shows changes between the working tree and the index (staged) or commit history. ' +
      'Can inspect staged or unstaged changes, optionally filtered by file path.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: {
          type: 'boolean',
          description:
            'If true, shows changes staged for the next commit. If false or omitted, shows unstaged changes.',
        },
        path: {
          type: 'string',
          description:
            'Optional relative path to a specific file or directory to inspect.',
        },
      },
    },
    async execute(input?: GitDiffToolInput): Promise<GitDiffToolResult> {
      if (input?.staged !== undefined && typeof input.staged !== 'boolean') {
        throw new Error('git_diff: "staged", if provided, must be a boolean.');
      }
      if (input?.path !== undefined && typeof input.path !== 'string') {
        throw new Error('git_diff: "path", if provided, must be a string.');
      }

      const diff = await repo.getDiff({
        staged: input?.staged,
        path: input?.path,
      });

      return { diff };
    },
  };
}

// ── git_log ─────────────────────────────────────────────────────────────────

export interface GitLogToolInput extends Record<string, unknown> {
  limit?: number;
}

export interface GitLogToolResult {
  commits: GitCommit[];
}

export function createGitLogTool(
  repo: GitRepository
): GitTool<GitLogToolInput, GitLogToolResult> {
  return {
    name: 'git_log',
    description:
      'Retrieves recent commit history from the Git repository. ' +
      'Each commit contains hash, subject, author, and ISO timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description:
            'Maximum number of commits to retrieve (default: 10, max: 100).',
        },
      },
    },
    async execute(input?: GitLogToolInput): Promise<GitLogToolResult> {
      let limit = 10;
      if (input?.limit !== undefined) {
        if (
          typeof input.limit !== 'number' ||
          !Number.isInteger(input.limit) ||
          input.limit <= 0
        ) {
          throw new Error('git_log: "limit", if provided, must be a positive integer.');
        }
        limit = Math.min(input.limit, 100);
      }

      const commits = await repo.getRecentCommits(limit);
      return { commits };
    },
  };
}

// ── Convenience aggregate ───────────────────────────────────────────────────

export function createGitTools(repo: GitRepository): GitTool[] {
  return [
    createGitStatusTool(repo),
    createGitDiffTool(repo),
    createGitLogTool(repo),
  ];
}
