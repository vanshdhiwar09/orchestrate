/**
 * Provider-agnostic Git abstraction types.
 *
 * Designed for read-only repository inspection and clean status reporting.
 */

export type GitFileStatusCode =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked'
  | 'ignored'
  | 'unknown';

export interface GitFileChange {
  /** Relative path of the file within the repository */
  path: string;
  /** Categorized status code */
  statusCode: GitFileStatusCode;
  /** Raw 2-character porcelain status code (e.g. "M ", " M", "A ", "MM") */
  rawStatus: string;
  /** Original path before rename or copy, if applicable */
  originalPath?: string;
}

export interface GitStatus {
  /** True when there are no staged changes, no unstaged changes, and no untracked files */
  clean: boolean;
  /** Current branch name, or null if detached HEAD */
  branch: string | null;
  /** True when repository is in a detached HEAD state */
  detached: boolean;
  /** Files with staged changes ready to commit */
  staged: GitFileChange[];
  /** Files with unstaged modifications or deletions in working tree */
  unstaged: GitFileChange[];
  /** Relative paths of untracked files in working tree */
  untracked: string[];
}

export interface GitCommit {
  /** Full 40-character commit hash */
  hash: string;
  /** First line / subject of the commit message */
  subject: string;
  /** Commit author name and/or email */
  author: string;
  /** ISO 8601 commit timestamp */
  timestamp: string;
}

export interface GitDiffOptions {
  /** If true, return diff of staged changes against HEAD. Defaults to false (unstaged working tree changes). */
  staged?: boolean;
  /** Optional file or directory path relative to the repository to restrict diff */
  path?: string;
}

export interface GitRepository {
  /**
   * Checks whether the configured directory is inside a Git repository.
   */
  isRepository(): Promise<boolean>;

  /**
   * Retrieves structured repository status distinguishing clean, staged, unstaged, and untracked files.
   * Throws if the directory is not a valid Git repository or if the Git operation fails.
   */
  getStatus(): Promise<GitStatus>;

  /**
   * Returns current branch name, or null if HEAD is detached.
   * Throws if the directory is not a valid Git repository.
   */
  getCurrentBranch(): Promise<string | null>;

  /**
   * Returns the commit at HEAD, or null if the repository has no commits yet (empty history).
   * Throws if the directory is not a valid Git repository.
   */
  getHeadCommit(): Promise<GitCommit | null>;

  /**
   * Returns recent commits in reverse chronological order up to limit (default: 10).
   * Returns empty array if repository has no commits yet (empty history).
   * Throws if the directory is not a valid Git repository.
   */
  getRecentCommits(limit?: number): Promise<GitCommit[]>;

  /**
   * Retrieves unified diff for unstaged or staged changes, optionally filtered by path.
   * Throws if the directory is not a valid Git repository.
   */
  getDiff(options?: GitDiffOptions): Promise<string>;
}
