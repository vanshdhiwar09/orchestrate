import type { CommandExecutor, GitRepository, GitStatus } from '@orchestrate/workspace';
import type { TaskASnapshotRecord } from './types.js';

const SHA1_REGEX = /^[0-9a-fA-F]{40}$/;

/**
 * Validates that a string is a valid full 40-character hexadecimal Git commit SHA.
 */
export function isValidCommitSha(sha: string): boolean {
  return typeof sha === 'string' && SHA1_REGEX.test(sha.trim());
}

/**
 * Validates the structural integrity of a TaskASnapshotRecord conforming to M6A §2.
 * Throws an Error if any required field is missing or invalid.
 */
export function validateSnapshotRecord(record: TaskASnapshotRecord): void {
  if (!record || typeof record !== 'object') {
    throw new Error('validateSnapshotRecord: record must be a non-null object.');
  }

  if (typeof record.snapshotId !== 'string' || record.snapshotId.trim() === '') {
    throw new Error('validateSnapshotRecord: snapshotId must be a non-empty string.');
  }

  if (!isValidCommitSha(record.commitSha)) {
    throw new Error(
      `validateSnapshotRecord: commitSha must be an exact 40-character hexadecimal string, got "${record.commitSha}".`
    );
  }

  if (typeof record.scenarioId !== 'string' || record.scenarioId.trim() === '') {
    throw new Error('validateSnapshotRecord: scenarioId must be a non-empty string.');
  }

  if (typeof record.taskAId !== 'string' || record.taskAId.trim() === '') {
    throw new Error('validateSnapshotRecord: taskAId must be a non-empty string.');
  }

  if (typeof record.agentARunId !== 'string' || record.agentARunId.trim() === '') {
    throw new Error('validateSnapshotRecord: agentARunId must be a non-empty string.');
  }

  if (!isValidCommitSha(record.baseCommitSha)) {
    throw new Error(
      `validateSnapshotRecord: baseCommitSha must be an exact 40-character hexadecimal string, got "${record.baseCommitSha}".`
    );
  }

  if (typeof record.dependencyStateSha256 !== 'string' || record.dependencyStateSha256.trim() === '') {
    throw new Error('validateSnapshotRecord: dependencyStateSha256 must be a non-empty string.');
  }

  if (typeof record.environmentFingerprint !== 'string' || record.environmentFingerprint.trim() === '') {
    throw new Error('validateSnapshotRecord: environmentFingerprint must be a non-empty string.');
  }

  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error(`validateSnapshotRecord: createdAt must be a valid ISO-8601 date string, got "${record.createdAt}".`);
  }
}

export interface SnapshotResolutionResult {
  resolvable: boolean;
  commitSha: string;
  isHead: boolean;
  status: GitStatus;
}

export interface SnapshotLoaderOptions {
  repo: GitRepository;
  executor?: CommandExecutor;
}

/**
 * SnapshotLoader resolves and verifies the canonical Task-A snapshot commit.
 *
 * Verifies:
 * 1. Snapshot commit SHA is a full 40-character SHA.
 * 2. The directory is a valid Git repository.
 * 3. The commit object is resolvable in the repository.
 * 4. Checks whether the current HEAD commit matches the requested snapshot SHA.
 * 5. Retrieves the working tree status.
 */
export class SnapshotLoader {
  private readonly repo: GitRepository;
  private readonly executor?: CommandExecutor;

  constructor(options: SnapshotLoaderOptions) {
    if (!options?.repo) {
      throw new Error('SnapshotLoader requires a GitRepository instance.');
    }
    this.repo = options.repo;
    this.executor = options.executor;
  }

  /**
   * Resolves and verifies that the snapshot commit exists and is accessible.
   */
  async resolveSnapshot(snapshotSha: string): Promise<SnapshotResolutionResult> {
    if (!isValidCommitSha(snapshotSha)) {
      throw new Error(
        `SnapshotLoader: snapshotSha must be a full 40-character hexadecimal string, got "${snapshotSha}".`
      );
    }

    const normalizedSha = snapshotSha.toLowerCase().trim();

    const isRepo = await this.repo.isRepository();
    if (!isRepo) {
      throw new Error('SnapshotLoader: Target path is not a valid Git repository.');
    }

    // 1. Check HEAD commit
    const headCommit = await this.repo.getHeadCommit();
    const isHead = headCommit !== null && headCommit.hash.toLowerCase() === normalizedSha;

    let resolvable = isHead;

    // 2. If not HEAD, verify the commit object is resolvable
    if (!resolvable) {
      if (this.executor) {
        const result = await this.executor.execute('git', [
          'cat-file',
          '-e',
          `${normalizedSha}^{commit}`,
        ]);
        resolvable = result.exitCode === 0;
      } else {
        // Fallback: search recent commits
        const recent = await this.repo.getRecentCommits(100);
        resolvable = recent.some((c) => c.hash.toLowerCase() === normalizedSha);
      }
    }

    if (!resolvable) {
      throw new Error(
        `SnapshotLoader: Snapshot commit "${normalizedSha}" is not resolvable in the repository.`
      );
    }

    const status = await this.repo.getStatus();

    return Object.freeze({
      resolvable: true,
      commitSha: normalizedSha,
      isHead,
      status,
    });
  }
}
