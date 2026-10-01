import type { GitStatus } from '@orchestrate/workspace';
import type { ArtifactFileStatus } from '../manifest/types.js';

export interface ChangedFileRecord {
  path: string;
  status: ArtifactFileStatus;
}

const DEFAULT_IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

const DEFAULT_IGNORED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const DEFAULT_IGNORED_EXTENSIONS = new Set([
  '.tsbuildinfo',
  '.log',
]);

function normalizePath(p: string): string {
  return p.trim().replace(/\\+/g, '/').replace(/^\/+/, '');
}

/**
 * Checks whether a repository-relative path should be ignored.
 */
export function isIgnoredPath(filePath: string, customPatterns?: string[]): boolean {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/');
  const fileName = segments[segments.length - 1];

  // 1. Check directory segments
  for (let i = 0; i < segments.length - 1; i++) {
    if (DEFAULT_IGNORED_SEGMENTS.has(segments[i])) {
      return true;
    }
  }

  // Check top-level or matching segment
  if (DEFAULT_IGNORED_SEGMENTS.has(segments[0])) {
    return true;
  }

  // 2. Check exact ignored file names
  if (DEFAULT_IGNORED_FILES.has(fileName)) {
    return true;
  }

  // 3. Check ignored extensions
  for (const ext of DEFAULT_IGNORED_EXTENSIONS) {
    if (fileName.endsWith(ext)) {
      return true;
    }
  }

  // 4. Custom patterns if supplied
  if (customPatterns && customPatterns.length > 0) {
    for (const pattern of customPatterns) {
      const cleanPattern = normalizePath(pattern);
      if (cleanPattern.endsWith('/**')) {
        const prefix = cleanPattern.slice(0, -3);
        if (normalized === prefix || normalized.startsWith(prefix + '/')) {
          return true;
        }
      } else if (cleanPattern.startsWith('*.')) {
        const ext = cleanPattern.slice(1);
        if (fileName.endsWith(ext)) {
          return true;
        }
      } else if (normalized === cleanPattern || fileName === cleanPattern) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extracts and categorizes changed files from GitStatus according to frozen benchmark rules:
 * - untracked -> ADDED
 * - staged added -> ADDED
 * - staged renamed -> destination ADDED
 * - staged copied -> destination ADDED
 * - staged modified -> MODIFIED
 * - unstaged modified -> MODIFIED
 * - deleted -> excluded
 */
export function getChangedFilesFromGitStatus(
  gitStatus: GitStatus,
  customIgnoredPatterns?: string[]
): ChangedFileRecord[] {
  const fileMap = new Map<string, ArtifactFileStatus>();
  const deletedPaths = new Set<string>();

  // 1. Identify all deletions (staged & unstaged)
  for (const file of gitStatus.staged ?? []) {
    if (file.statusCode === 'deleted') {
      deletedPaths.add(normalizePath(file.path));
    }
  }
  for (const file of gitStatus.unstaged ?? []) {
    if (file.statusCode === 'deleted') {
      deletedPaths.add(normalizePath(file.path));
    }
  }

  // 2. Process staged changes
  for (const file of gitStatus.staged ?? []) {
    const norm = normalizePath(file.path);
    if (deletedPaths.has(norm)) continue;
    if (isIgnoredPath(norm, customIgnoredPatterns)) continue;

    if (
      file.statusCode === 'added' ||
      file.statusCode === 'copied' ||
      file.statusCode === 'renamed'
    ) {
      fileMap.set(norm, 'ADDED');
    } else if (file.statusCode === 'modified') {
      fileMap.set(norm, 'MODIFIED');
    }
  }

  // 3. Process untracked files -> ADDED
  for (const rawPath of gitStatus.untracked ?? []) {
    const norm = normalizePath(rawPath);
    if (deletedPaths.has(norm)) continue;
    if (isIgnoredPath(norm, customIgnoredPatterns)) continue;

    fileMap.set(norm, 'ADDED');
  }

  // 4. Process unstaged modifications
  for (const file of gitStatus.unstaged ?? []) {
    const norm = normalizePath(file.path);
    if (deletedPaths.has(norm)) continue;
    if (isIgnoredPath(norm, customIgnoredPatterns)) continue;

    if (file.statusCode === 'modified') {
      // If already recorded as ADDED in staged, retain ADDED status
      if (!fileMap.has(norm)) {
        fileMap.set(norm, 'MODIFIED');
      }
    }
  }

  const result: ChangedFileRecord[] = [];
  for (const [path, status] of fileMap.entries()) {
    result.push({ path, status });
  }

  return result;
}
