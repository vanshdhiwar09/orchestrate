import {
  type CommandExecutor,
  LocalCommandExecutor,
} from '@orchestrate/workspace';
import { parseUnifiedDiff } from '../evaluator/diff-parser.js';
import type {
  BenchmarkWorkspace,
  DownstreamChangeSummary,
  DownstreamDiffCapture,
} from './types.js';

export interface DiffCaptureOptions {
  /**
   * Optional custom executor for running git diff commands.
   */
  executor?: CommandExecutor;
}

const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;

function normalizeRepoPath(raw: string): string {
  let cleaned = raw.trim().replace(/\\+/g, '/').replace(/^\/+/, '');
  if (cleaned.startsWith('a/')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('b/')) {
    cleaned = cleaned.slice(2);
  }
  return cleaned;
}

function isValidCommitSha(sha: string): boolean {
  return typeof sha === 'string' && COMMIT_SHA_REGEX.test(sha.trim());
}

/**
 * Captures the downstream Git state and unified diff of a benchmark workspace relative
 * to the canonical Task-A snapshot commit.
 *
 * Captures:
 * - current repository HEAD commit
 * - structured GitStatus (staged, unstaged, untracked, branch, clean)
 * - raw unified diff relative to snapshotCommitSha
 * - categorized change summary (added, modified, deleted, renamed)
 */
export async function captureDownstreamDiff(
  workspace: BenchmarkWorkspace,
  snapshotCommitSha: string,
  options?: DiffCaptureOptions
): Promise<DownstreamDiffCapture> {
  if (!workspace || typeof workspace !== 'object' || !workspace.path) {
    throw new Error('captureDownstreamDiff: workspace must be a valid BenchmarkWorkspace.');
  }

  if (!isValidCommitSha(snapshotCommitSha)) {
    throw new Error(
      `captureDownstreamDiff: snapshotCommitSha must be an exact 40-character hexadecimal string, got "${snapshotCommitSha}".`
    );
  }

  const isRepo = await workspace.git.isRepository();
  if (!isRepo) {
    throw new Error(`captureDownstreamDiff: workspace path "${workspace.path}" is not a valid Git repository.`);
  }

  // 1. Capture current HEAD
  const headCommit = await workspace.git.getHeadCommit();
  const headCommitSha = headCommit?.hash ?? null;

  // 2. Capture working-tree status
  const gitStatus = await workspace.git.getStatus();

  // 3. Capture raw unified diff relative to snapshot commit
  const executor = options?.executor ?? new LocalCommandExecutor({ workspaceRoot: workspace.path });
  const diffResult = await executor.execute('git', ['diff', snapshotCommitSha.trim()]);

  if (diffResult.timedOut) {
    throw new Error(`captureDownstreamDiff: git diff timed out against snapshot commit ${snapshotCommitSha}.`);
  }

  if (diffResult.exitCode !== 0) {
    const stderr = diffResult.stderr.trim();
    if (
      stderr.includes('unknown revision') ||
      stderr.includes('bad object') ||
      stderr.includes('fatal: ambiguous argument')
    ) {
      throw new Error(
        `captureDownstreamDiff: snapshot commit "${snapshotCommitSha}" not found in workspace repository: ${stderr}`
      );
    }
    throw new Error(
      `captureDownstreamDiff: git diff failed (exit code ${diffResult.exitCode}): ${stderr || 'Unknown error'}`
    );
  }

  const rawDiff = diffResult.stdout;

  // 4. Parse unified diff to extract file changes
  const parsedDiff = parseUnifiedDiff(rawDiff);

  const addedSet = new Set<string>();
  const modifiedSet = new Set<string>();
  const deletedSet = new Set<string>();
  const renamedList: { from: string; to: string }[] = [];

  for (const file of parsedDiff.files) {
    const oldPath = normalizeRepoPath(file.oldPath);
    const newPath = normalizeRepoPath(file.newPath);

    if (file.changeType === 'added') {
      if (newPath && newPath !== '/dev/null' && newPath !== 'dev/null') {
        addedSet.add(newPath);
      }
    } else if (file.changeType === 'modified') {
      if (newPath && newPath !== '/dev/null' && newPath !== 'dev/null') {
        modifiedSet.add(newPath);
      }
    } else if (file.changeType === 'deleted') {
      if (oldPath && oldPath !== '/dev/null' && oldPath !== 'dev/null') {
        deletedSet.add(oldPath);
      }
    } else if (file.changeType === 'renamed') {
      if (oldPath && newPath) {
        renamedList.push({ from: oldPath, to: newPath });
      }
    }
  }

  // 5. Fold deletions from gitStatus (staged & unstaged)
  for (const file of gitStatus.staged ?? []) {
    if (file.statusCode === 'deleted') {
      const clean = normalizeRepoPath(file.path);
      if (clean && clean !== '/dev/null' && clean !== 'dev/null') {
        deletedSet.add(clean);
      }
    }
  }
  for (const file of gitStatus.unstaged ?? []) {
    if (file.statusCode === 'deleted') {
      const clean = normalizeRepoPath(file.path);
      if (clean && clean !== '/dev/null' && clean !== 'dev/null') {
        deletedSet.add(clean);
      }
    }
  }

  // 6. Fold untracked files into added list
  for (const untracked of gitStatus.untracked ?? []) {
    const cleanUntracked = normalizeRepoPath(untracked);
    if (cleanUntracked && cleanUntracked !== '/dev/null' && cleanUntracked !== 'dev/null') {
      addedSet.add(cleanUntracked);
    }
  }

  // Ensure deleted files are not retained in added or modified sets
  for (const deleted of deletedSet) {
    addedSet.delete(deleted);
    modifiedSet.delete(deleted);
  }

  const changes: DownstreamChangeSummary = Object.freeze({
    added: Object.freeze([...addedSet].sort()),
    modified: Object.freeze([...modifiedSet].sort()),
    deleted: Object.freeze([...deletedSet].sort()),
    renamed: Object.freeze(
      renamedList.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    ),
  });

  return Object.freeze({
    snapshotCommitSha: snapshotCommitSha.trim(),
    headCommitSha,
    headCommit,
    gitStatus,
    changes,
    diff: rawDiff,
    capturedAt: new Date().toISOString(),
  });
}
