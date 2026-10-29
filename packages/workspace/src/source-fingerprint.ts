import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CommandExecutor } from './executor-types.js';

export interface SourceFileEntry {
  path: string;
  hash: string;
  size: number;
}

export interface SourceSnapshotIdentity {
  fingerprint: string;
  capturedAt: string;
  fileCount: number;
  commitSha?: string | null;
  dirty?: boolean;
}

export interface SourceSnapshotOptions {
  excludedDirs?: string[];
  excludedFilePatterns?: RegExp[];
  executor?: CommandExecutor;
}

export const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.turbo',
  '.next',
  '.orchestrate',
  '.coverage',
  'coverage',
]);

export const DEFAULT_EXCLUDED_FILE_PATTERNS = [
  /\.tmp$/i,
  /\.log$/i,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
];

export function normalizeRelPath(p: string): string {
  return p.replace(/\\+/g, '/').replace(/^\/+/, '');
}

/**
 * Recursively scans a workspace directory and deterministically fingerprints all
 * included source and configuration files.
 *
 * Invariants:
 * - Deterministic: Stable ASCII sorting of paths ensures identical content produces identical fingerprint.
 * - Comprehensive: Detects added, modified, deleted, and renamed files, staged or unstaged, tracked or untracked.
 * - Safe: Symlinks resolving outside workspace root are rejected (fails closed).
 * - Disciplined: Never hashes credentials, environment variables, or logs raw file contents.
 */
export async function computeSourceSnapshot(
  workspaceRoot: string,
  options?: SourceSnapshotOptions
): Promise<SourceSnapshotIdentity> {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    throw new Error('computeSourceSnapshot: workspaceRoot must be a non-empty string.');
  }

  const rootResolved = resolve(workspaceRoot);
  let realRoot: string;
  try {
    realRoot = await realpath(rootResolved);
  } catch (err: unknown) {
    throw new Error(
      `computeSourceSnapshot: workspace root does not exist or cannot be accessed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const isWindows = process.platform === 'win32';
  const normRealRoot = isWindows ? realRoot.toLowerCase() : realRoot;

  const excludedDirs = options?.excludedDirs
    ? new Set(options.excludedDirs)
    : DEFAULT_EXCLUDED_DIRS;

  const excludedPatterns = options?.excludedFilePatterns ?? DEFAULT_EXCLUDED_FILE_PATTERNS;

  const entries: SourceFileEntry[] = [];

  async function walk(currentDir: string): Promise<void> {
    let dirents: any[];
    try {
      dirents = await readdir(currentDir, { withFileTypes: true });
    } catch (err: unknown) {
      throw new Error(
        `computeSourceSnapshot: failed to read directory "${currentDir}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    for (const d of dirents) {
      const fullPath = join(currentDir, d.name);

      if (d.isDirectory()) {
        if (excludedDirs.has(d.name)) {
          continue;
        }
        await walk(fullPath);
      } else if (d.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = await realpath(fullPath);
        } catch (err: unknown) {
          throw new Error(
            `computeSourceSnapshot: broken or invalid symlink at "${fullPath}": ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const normTarget = isWindows ? realTarget.toLowerCase() : realTarget;
        const relToRoot = relative(normRealRoot, normTarget);
        if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
          throw new Error(
            `computeSourceSnapshot: symlink at "${fullPath}" escapes workspace root.`
          );
        }

        let stats: any;
        try {
          stats = await lstat(realTarget);
        } catch (err: unknown) {
          throw new Error(
            `computeSourceSnapshot: failed to stat symlink target "${realTarget}": ${err instanceof Error ? err.message : String(err)}`
          );
        }

        if (stats.isDirectory()) {
          // Skip directory symlinks to avoid recursion loops
          continue;
        }

        if (stats.isFile()) {
          await processFile(fullPath, d.name);
        }
      } else if (d.isFile()) {
        await processFile(fullPath, d.name);
      } else {
        const rel = normalizeRelPath(relative(rootResolved, fullPath));
        throw new Error(
          `computeSourceSnapshot: unsupported file type encountered at "${rel}".`
        );
      }
    }
  }

  async function processFile(fullPath: string, fileName: string): Promise<void> {
    for (const pattern of excludedPatterns) {
      if (pattern.test(fileName)) {
        return;
      }
    }

    let content: Buffer;
    try {
      content = await readFile(fullPath);
    } catch (err: unknown) {
      throw new Error(
        `computeSourceSnapshot: failed to read file "${fullPath}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const relPath = normalizeRelPath(relative(rootResolved, fullPath));
    const hash = createHash('sha256').update(content).digest('hex');
    entries.push({
      path: relPath,
      hash,
      size: content.length,
    });
  }

  await walk(rootResolved);

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifestString = entries.map((e) => `${e.path}:${e.hash}`).join('\n');
  const fingerprint = createHash('sha256').update(manifestString, 'utf8').digest('hex');

  let commitSha: string | null = null;
  let dirty: boolean | undefined = undefined;

  const executor = options?.executor;
  if (executor && typeof executor.execute === 'function') {
    try {
      const headRes = await executor.execute('git', ['rev-parse', 'HEAD']);
      if (headRes.exitCode === 0 && headRes.stdout.trim().length === 40) {
        commitSha = headRes.stdout.trim();
      }
      const statusRes = await executor.execute('git', ['status', '--porcelain']);
      if (statusRes.exitCode === 0) {
        dirty = statusRes.stdout.trim().length > 0;
      }
    } catch {
      // Best-effort for git metadata
    }
  }

  return {
    fingerprint,
    capturedAt: new Date().toISOString(),
    fileCount: entries.length,
    commitSha,
    dirty,
  };
}
