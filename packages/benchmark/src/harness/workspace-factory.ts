import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type CommandExecutor,
  LocalCommandExecutor,
  LocalGitRepository,
  LocalWorkspace,
} from '@orchestrate/workspace';
import { isValidCommitSha } from './snapshot-loader.js';
import type { BenchmarkWorkspace, WorkspaceFactory } from './types.js';

const execFileAsync = promisify(execFile);

export type GitExecutorFn = (
  args: string[],
  cwd?: string
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface WorkspaceFactoryOptions {
  /**
   * Path to the canonical local Git repository containing the snapshot commits.
   */
  sourceRepoPath: string;

  /**
   * Base directory where disposable arm workspaces will be created. Defaults to os.tmpdir().
   */
  baseTempDir?: string;

  /**
   * Timeout in milliseconds for git operations (clone, checkout). Default: 60,000 ms.
   */
  timeoutMs?: number;

  /**
   * Optional custom Git executor function for testing and mocking.
   */
  gitExecutor?: GitExecutorFn;
}

/**
 * Default git executor using child_process.execFile with shell: false.
 */
async function defaultGitExecutor(
  args: string[],
  cwd?: string,
  timeoutMs = 60000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      shell: false,
      timeout: timeoutMs,
    });
    return { exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err: unknown) {
    const errorObj = err as { code?: number | string; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const exitCode = typeof errorObj.code === 'number' ? errorObj.code : 1;
    const stdout = errorObj.stdout?.toString() ?? '';
    const stderr = errorObj.stderr?.toString() ?? errorObj.message ?? 'Git command failed';
    return { exitCode, stdout, stderr };
  }
}

/**
 * LocalWorkspaceFactory creates isolated, disposable workspaces initialized from
 * an exact Task-A canonical snapshot commit SHA.
 */
export class LocalWorkspaceFactory implements WorkspaceFactory {
  private readonly sourceRepoPath: string;
  private readonly baseTempDir: string;
  private readonly timeoutMs: number;
  private readonly gitExecutor: GitExecutorFn;
  private readonly isCustomGitExecutor: boolean;
  private readonly createdPaths = new Set<string>();
  private readonly cleanedUpPaths = new Set<string>();

  constructor(options: WorkspaceFactoryOptions) {
    if (!options?.sourceRepoPath || typeof options.sourceRepoPath !== 'string' || options.sourceRepoPath.trim() === '') {
      throw new Error('LocalWorkspaceFactory requires a non-empty sourceRepoPath.');
    }
    this.sourceRepoPath = resolve(options.sourceRepoPath.trim());
    this.baseTempDir = options.baseTempDir ? resolve(options.baseTempDir) : tmpdir();
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.isCustomGitExecutor = Boolean(options.gitExecutor);
    this.gitExecutor = options.gitExecutor ?? ((args, cwd) => defaultGitExecutor(args, cwd, this.timeoutMs));
  }

  /**
   * Creates an isolated workspace checked out at the exact snapshot commit SHA.
   */
  async create(snapshotCommitSha: string): Promise<BenchmarkWorkspace> {
    if (!isValidCommitSha(snapshotCommitSha)) {
      throw new Error(
        `WorkspaceFactory.create: snapshotCommitSha must be an exact 40-character hexadecimal string, got "${snapshotCommitSha}".`
      );
    }

    const normalizedSha = snapshotCommitSha.toLowerCase().trim();

    // 1. Create dedicated isolated temporary directory
    const tempDir = await mkdtemp(join(this.baseTempDir, 'orch-arm-'));
    this.createdPaths.add(tempDir);

    try {
      // 2. Clone repository metadata from source without checking out files
      const cloneResult = await this.gitExecutor([
        'clone',
        '--no-checkout',
        '--no-hardlinks',
        this.sourceRepoPath,
        tempDir,
      ]);

      if (cloneResult.exitCode !== 0) {
        throw new Error(
          `Failed to clone source repository into workspace: ${cloneResult.stderr || cloneResult.stdout}`
        );
      }

      // 3. Checkout exact commit in detached HEAD mode
      const checkoutResult = await this.gitExecutor(
        ['checkout', '--detach', normalizedSha],
        tempDir
      );

      if (checkoutResult.exitCode !== 0) {
        throw new Error(
          `Failed to checkout snapshot commit "${normalizedSha}": ${checkoutResult.stderr || checkoutResult.stdout}`
        );
      }

      // 4. Initialize workspace abstractions
      const executor: CommandExecutor = this.isCustomGitExecutor
        ? {
            execute: async (command, args, opts) => {
              if (command === 'git') {
                const res = await this.gitExecutor(args as string[], opts?.cwd ?? tempDir);
                return {
                  exitCode: res.exitCode,
                  signal: null,
                  stdout: res.stdout,
                  stderr: res.stderr,
                  timedOut: false,
                  durationMs: 1,
                };
              }
              const localExec = new LocalCommandExecutor({ workspaceRoot: tempDir });
              return localExec.execute(command, args as string[], opts);
            },
          }
        : new LocalCommandExecutor({ workspaceRoot: tempDir });

      const git = new LocalGitRepository({ executor });
      const workspace = new LocalWorkspace({ rootPath: tempDir });

      // 5. Invariant assertions
      const isRepo = await git.isRepository();
      if (!isRepo) {
        throw new Error(`Workspace at "${tempDir}" is not a valid Git repository.`);
      }

      const head = await git.getHeadCommit();
      if (!head || head.hash.toLowerCase() !== normalizedSha) {
        throw new Error(
          `Workspace HEAD commit "${head?.hash}" does not match requested snapshot SHA "${normalizedSha}".`
        );
      }

      const status = await git.getStatus();
      if (!status.clean) {
        throw new Error(
          `Workspace working tree is not clean at initialization: ${JSON.stringify(status)}.`
        );
      }

      const cleanup = async (): Promise<void> => this.cleanup(tempDir);

      return Object.freeze({
        path: tempDir,
        workspace,
        git,
        cleanup,
      });
    } catch (err) {
      // Cleanup on failure
      this.createdPaths.delete(tempDir);
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error on failure path
      }
      throw err;
    }
  }

  /**
   * Cleans up a specific workspace by path if it is owned by this factory.
   * Safe against repeated calls; rejects unowned or arbitrary paths.
   */
  async cleanup(path: string): Promise<void> {
    if (!path || typeof path !== 'string' || path.trim() === '') {
      throw new Error('WorkspaceFactory.cleanup requires a non-empty path string.');
    }
    const resolvedPath = resolve(path.trim());

    if (this.cleanedUpPaths.has(resolvedPath)) {
      return; // Repeated cleanup is safe
    }

    if (!this.createdPaths.has(resolvedPath)) {
      throw new Error(`Cannot cleanup unowned path "${path}".`);
    }

    this.createdPaths.delete(resolvedPath);
    this.cleanedUpPaths.add(resolvedPath);
    await rm(resolvedPath, { recursive: true, force: true });
  }

  /**
   * Cleans up all active workspaces created by this factory.
   */
  async cleanupAll(): Promise<void> {
    const paths = [...this.createdPaths];
    for (const dir of paths) {
      this.createdPaths.delete(dir);
      this.cleanedUpPaths.add(dir);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Returns whether a path is currently tracked as created by this factory.
   */
  isOwnedPath(pathToCheck: string): boolean {
    return this.createdPaths.has(resolve(pathToCheck));
  }
}
