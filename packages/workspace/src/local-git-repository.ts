import { isAbsolute, normalize, sep } from 'node:path';
import type { CommandExecutor, ExecuteCommandOptions } from './executor-types.js';
import type {
  GitCommit,
  GitDiffOptions,
  GitFileChange,
  GitFileStatusCode,
  GitRepository,
  GitStatus,
} from './git-types.js';

export interface LocalGitRepositoryOptions {
  /**
   * Command executor to run git commands through.
   */
  executor: CommandExecutor;

  /**
   * Optional subdirectory relative to the executor's workspace root.
   * Must not escape workspace root.
   */
  cwd?: string;
}

export class LocalGitRepository implements GitRepository {
  private readonly executor: CommandExecutor;
  private readonly cwd?: string;
  private readonly execOptions: ExecuteCommandOptions;

  constructor(options: LocalGitRepositoryOptions | CommandExecutor) {
    if (!options) {
      throw new Error('LocalGitRepository requires an executor.');
    }

    if ('execute' in options && typeof options.execute === 'function') {
      this.executor = options;
      this.cwd = undefined;
      this.execOptions = {};
    } else {
      const opts = options as LocalGitRepositoryOptions;
      if (!opts.executor || typeof opts.executor.execute !== 'function') {
        throw new Error('LocalGitRepository requires a CommandExecutor.');
      }
      this.executor = opts.executor;
      if (opts.cwd !== undefined) {
        this.validateRelativePath(opts.cwd, 'cwd');
        this.cwd = opts.cwd;
        this.execOptions = { cwd: this.cwd };
      } else {
        this.execOptions = {};
      }
    }
  }

  // ── Validation Helpers ──────────────────────────────────────────────────────

  private validateRelativePath(pathValue: string, paramName: string): void {
    if (typeof pathValue !== 'string' || pathValue.trim() === '') {
      throw new Error(`${paramName} must be a non-empty string.`);
    }

    if (pathValue.includes('\0')) {
      throw new Error(`${paramName} cannot contain null bytes.`);
    }

    if (isAbsolute(pathValue)) {
      throw new Error(
        `${paramName} must be a relative path within the repository; absolute path rejected: "${pathValue}"`
      );
    }

    const normalized = normalize(pathValue);
    if (
      normalized === '..' ||
      normalized.startsWith(`..${sep}`) ||
      normalized.startsWith('../') ||
      normalized.startsWith('..\\')
    ) {
      throw new Error(
        `Path traversal denied: "${pathValue}" escapes repository root.`
      );
    }
  }

  // ── Git Execution ───────────────────────────────────────────────────────────

  private async execGit(args: string[]): Promise<string> {
    const result = await this.executor.execute('git', args, this.execOptions);

    if (result.timedOut) {
      throw new Error(`Git command timed out: git ${args.join(' ')}`);
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      if (stderr.includes('not a git repository')) {
        throw new Error(`Not a git repository: ${stderr}`);
      }
      throw new Error(
        `Git command failed (exit code ${result.exitCode}): ${stderr || stdout || 'Unknown error'}`
      );
    }

    return result.stdout;
  }

  // ── Parsing Helpers ─────────────────────────────────────────────────────────

  private parseStatusCode(code: string): GitFileStatusCode {
    switch (code) {
      case 'A':
        return 'added';
      case 'M':
        return 'modified';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      case 'C':
        return 'copied';
      case 'U':
        return 'unmerged';
      case '?':
        return 'untracked';
      case '!':
        return 'ignored';
      default:
        return 'unknown';
    }
  }

  private unquotePath(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return trimmed;
  }

  private parseBranchHeader(headerLine: string): { branch: string | null; detached: boolean } {
    // Header format: "## <branch-info>"
    const content = headerLine.slice(2).trim();

    if (content === 'HEAD (no branch)' || content.startsWith('HEAD (no branch)')) {
      return { branch: null, detached: true };
    }

    const noCommitsMatch = content.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/);
    if (noCommitsMatch) {
      return { branch: noCommitsMatch[1].trim(), detached: false };
    }

    // Branch with upstream: "main...origin/main [ahead 1]"
    const upstreamIndex = content.indexOf('...');
    if (upstreamIndex !== -1) {
      const branchName = content.slice(0, upstreamIndex).trim();
      return { branch: branchName || null, detached: false };
    }

    // Branch without upstream: "main" or "main [ahead 1]"
    const spaceIndex = content.indexOf(' ');
    const branchName = spaceIndex !== -1 ? content.slice(0, spaceIndex).trim() : content;
    return { branch: branchName || null, detached: false };
  }

  private parseStatus(output: string): GitStatus {
    const lines = output.split('\n').filter((l) => l.length > 0);

    let branch: string | null = null;
    let detached = false;
    const staged: GitFileChange[] = [];
    const unstaged: GitFileChange[] = [];
    const untracked: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;

      if (line.startsWith('## ')) {
        const parsed = this.parseBranchHeader(line);
        branch = parsed.branch;
        detached = parsed.detached;
        continue;
      }

      if (line.length < 3) continue;

      const x = line[0];
      const y = line[1];
      const rest = line.slice(3).trim();

      // Untracked files: "??"
      if (x === '?' && y === '?') {
        untracked.push(this.unquotePath(rest));
        continue;
      }

      // Check for renames / copies ("orig -> dest")
      let filePath = rest;
      let originalPath: string | undefined;
      const arrowIndex = rest.indexOf(' -> ');
      if (arrowIndex !== -1) {
        originalPath = this.unquotePath(rest.slice(0, arrowIndex));
        filePath = this.unquotePath(rest.slice(arrowIndex + 4));
      } else {
        filePath = this.unquotePath(rest);
      }

      // Staged changes: index status X
      if (x !== ' ' && x !== '?' && x !== '!') {
        staged.push({
          path: filePath,
          statusCode: this.parseStatusCode(x),
          rawStatus: `${x}${y}`,
          ...(originalPath ? { originalPath } : {}),
        });
      }

      // Unstaged changes: working tree status Y
      if (y !== ' ' && y !== '?' && y !== '!') {
        unstaged.push({
          path: filePath,
          statusCode: this.parseStatusCode(y),
          rawStatus: `${x}${y}`,
          ...(originalPath ? { originalPath } : {}),
        });
      }
    }

    const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;

    return {
      clean,
      branch,
      detached,
      staged,
      unstaged,
      untracked,
    };
  }

  private parseCommits(output: string): GitCommit[] {
    const lines = output.split('\n').filter((l) => l.trim().length > 0);
    const commits: GitCommit[] = [];

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const parts = line.split('\x1f');
      if (parts.length >= 4) {
        commits.push({
          hash: parts[0],
          subject: parts[1],
          author: parts[2],
          timestamp: parts[3],
        });
      }
    }

    return commits;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async isRepository(): Promise<boolean> {
    const result = await this.executor.execute(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      this.execOptions
    );
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  async getStatus(): Promise<GitStatus> {
    const stdout = await this.execGit(['status', '--porcelain=v1', '--branch']);
    return this.parseStatus(stdout);
  }

  async getCurrentBranch(): Promise<string | null> {
    const result = await this.executor.execute(
      'git',
      ['branch', '--show-current'],
      this.execOptions
    );

    if (result.timedOut) {
      throw new Error('Git command timed out: git branch --show-current');
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.includes('not a git repository')) {
        throw new Error(`Not a git repository: ${stderr}`);
      }
      throw new Error(
        `Git command failed (exit code ${result.exitCode}): ${stderr || result.stdout.trim() || 'Unknown error'}`
      );
    }

    const branch = result.stdout.trim();
    if (branch === '') {
      // Detached HEAD or no current branch
      return null;
    }
    return branch;
  }

  async getHeadCommit(): Promise<GitCommit | null> {
    const commits = await this.getRecentCommits(1);
    return commits[0] ?? null;
  }

  async getRecentCommits(limit: number = 10): Promise<GitCommit[]> {
    if (typeof limit !== 'number' || limit <= 0 || !Number.isInteger(limit)) {
      throw new Error('limit must be a positive integer.');
    }

    const result = await this.executor.execute(
      'git',
      ['log', `-n`, String(limit), '--format=%H%x1f%s%x1f%an%x1f%aI'],
      this.execOptions
    );

    if (result.timedOut) {
      throw new Error('Git command timed out: git log');
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.includes('not a git repository')) {
        throw new Error(`Not a git repository: ${stderr}`);
      }

      // Empty history handling
      if (
        stderr.includes('does not have any commits yet') ||
        stderr.includes('unknown revision or path not in the working tree') ||
        stderr.includes("bad default revision 'HEAD'") ||
        stderr.includes('Needed a single revision')
      ) {
        return [];
      }

      throw new Error(
        `Git command failed (exit code ${result.exitCode}): ${stderr || result.stdout.trim() || 'Unknown error'}`
      );
    }

    return this.parseCommits(result.stdout);
  }

  async getDiff(options?: GitDiffOptions): Promise<string> {
    const args = ['diff'];

    if (options?.staged) {
      args.push('--staged');
    }

    if (options?.path !== undefined) {
      this.validateRelativePath(options.path, 'path');
      args.push('--', options.path);
    }

    return await this.execGit(args);
  }
}
