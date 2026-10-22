import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  type CommandExecutor,
  LocalCommandExecutor,
} from '@orchestrate/workspace';
import {
  type VerificationCheck,
  VerificationEngine,
  type VerificationPlan,
  type VerificationResult,
} from '@orchestrate/verification';
import { captureDownstreamDiff } from './diff-capture.js';
import { sealVerificationEvidence } from './evidence-sealer.js';
import {
  BENCHMARK_ARM_IDS,
  type BenchmarkVerificationEvidence,
  type BenchmarkVerificationInput,
  type WorkspaceBindingEvidence,
} from './types.js';

export interface VerificationAdapterOptions {
  /**
   * Optional custom VerificationEngine for dependency injection in tests.
   */
  verificationEngine?: VerificationEngine;

  /**
   * Optional factory for creating CommandExecutor for a workspace root.
   */
  executorFactory?: (workspaceRoot: string) => CommandExecutor;

  /**
   * Optional custom secrets for field-aware redaction before evidence sealing.
   */
  customSecrets?: string[];
}

const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;

function isValidCommitSha(sha: string): boolean {
  return typeof sha === 'string' && COMMIT_SHA_REGEX.test(sha.trim());
}

/**
 * Validates that an evaluator file path is strictly contained within the workspace root
 * and does not escape via lexical traversal, absolute paths, or symlink components.
 * Also verifies that existing filesystem entries at target paths do not collide with directories.
 */
export async function validateEvaluatorPath(
  workspaceRoot: string,
  filePath: string
): Promise<string> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Evaluator file path must be a non-empty string.');
  }

  const trimmed = filePath.trim();

  // 1. Reject absolute paths
  if (isAbsolute(trimmed)) {
    throw new Error(`Evaluator file path "${trimmed}" must be relative, got absolute path.`);
  }

  const resolvedRoot = resolve(workspaceRoot);
  const resolvedTarget = resolve(resolvedRoot, trimmed);

  // 2. Lexical containment check
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
    throw new Error(`Evaluator file path "${trimmed}" escapes workspace root "${resolvedRoot}".`);
  }

  // 3. Symlink escape check for existing parent components
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }

  const isWindows = process.platform === 'win32';
  const normRealRoot = isWindows ? realRoot.toLowerCase() : realRoot;

  // Split relative path into components and verify existing components
  const parts = rel.split(/[\\/]/);
  let current = resolvedRoot;

  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const lstatInfo = await lstat(current);

      // Check realpath of existing component
      const realComponent = await realpath(current);
      const normComponent = isWindows ? realComponent.toLowerCase() : realComponent;
      const relToRealRoot = relative(normRealRoot, normComponent);

      if (relToRealRoot.startsWith('..') || isAbsolute(relToRealRoot)) {
        throw new Error(
          `Evaluator file path "${trimmed}" resolves through symlink outside workspace root.`
        );
      }

      // If this is the target file itself (last segment)
      if (i === parts.length - 1) {
        if (lstatInfo.isDirectory()) {
          throw new Error(
            `Cannot inject evaluator file at "${trimmed}": an existing directory already exists at this path.`
          );
        }
        if (!lstatInfo.isFile() && !lstatInfo.isSymbolicLink()) {
          throw new Error(
            `Cannot inject evaluator file at "${trimmed}": an incompatible filesystem entry exists at this path.`
          );
        }
      } else {
        // Intermediate directory component
        if (!lstatInfo.isDirectory() && !lstatInfo.isSymbolicLink()) {
          throw new Error(
            `Cannot inject evaluator file at "${trimmed}": intermediate path component "${parts[i]}" is not a directory.`
          );
        }
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // Component does not exist yet; remaining path will be created safely
        break;
      }
      throw err;
    }
  }

  return resolvedTarget;
}

/**
 * VerificationAdapter independently evaluates configured verification checks against
 * the exact workspace returned by a completed arm execution, captures Git/diff state,
 * and produces sealed, machine-independent benchmark verification evidence.
 *
 * Invariants:
 * - Operates directly on the provided live BenchmarkWorkspace; does not create a second checkout.
 * - Does not trust agent statements, handoffs, or model confidence.
 * - VERIFIED means all configured checks passed.
 * - FAILED means one or more checks failed.
 * - Does not perform automated repair or calculate benchmark metrics.
 * - Leaves workspace lifecycle / teardown to the caller.
 */
export class VerificationAdapter {
  private readonly verificationEngine?: VerificationEngine;
  private readonly executorFactory?: (workspaceRoot: string) => CommandExecutor;
  private readonly customSecrets?: string[];

  constructor(options?: VerificationAdapterOptions) {
    this.verificationEngine = options?.verificationEngine;
    this.executorFactory = options?.executorFactory;
    this.customSecrets = options?.customSecrets;
  }

  /**
   * Independently verifies the workspace against configured verification checks
   * and returns sealed verification evidence paired with exact workspace/diff binding.
   */
  async verify(input: BenchmarkVerificationInput): Promise<BenchmarkVerificationEvidence> {
    if (!input || typeof input !== 'object') {
      throw new Error('VerificationAdapter.verify: input must be a valid BenchmarkVerificationInput object.');
    }

    if (!input.workspace || typeof input.workspace !== 'object' || !input.workspace.path) {
      throw new Error('VerificationAdapter.verify: workspace must be a valid BenchmarkWorkspace instance.');
    }

    if (!input.armId || !BENCHMARK_ARM_IDS.includes(input.armId)) {
      throw new Error(`VerificationAdapter.verify: invalid armId "${input.armId}".`);
    }

    if (!input.taskId || typeof input.taskId !== 'string' || input.taskId.trim() === '') {
      throw new Error('VerificationAdapter.verify: taskId must be a non-empty string.');
    }

    if (!isValidCommitSha(input.snapshotCommitSha)) {
      throw new Error(
        `VerificationAdapter.verify: snapshotCommitSha must be an exact 40-character hexadecimal string, got "${input.snapshotCommitSha}".`
      );
    }

    if (!Array.isArray(input.checks)) {
      throw new Error('VerificationAdapter.verify: checks must be an array of VerificationCheck.');
    }

    // 1. Capture CommandExecutor for this workspace
    const executor = this.executorFactory
      ? this.executorFactory(input.workspace.path)
      : new LocalCommandExecutor({ workspaceRoot: input.workspace.path });

    // 2. Capture downstream Git diff and repository changes relative to canonical snapshot
    const diffCapture = await captureDownstreamDiff(input.workspace, input.snapshotCommitSha, { executor });

    // 3. Bind exact workspace state at verification time
    const workspaceBinding: WorkspaceBindingEvidence = Object.freeze({
      snapshotCommitSha: input.snapshotCommitSha.trim(),
      workspacePath: `workspace://${input.armId}`,
      headCommitSha: diffCapture.headCommitSha,
      headCommit: diffCapture.headCommit,
      gitStatus: diffCapture.gitStatus,
    });

    // 4. Construct verification plan and engine
    const plan: VerificationPlan = Object.freeze({
      checks: input.checks,
    });

    const engine = this.verificationEngine ?? new VerificationEngine({ executor });

    // 5. Independently execute checks with evaluator-owned file injection and cleanup
    const startedAt = new Date().toISOString();
    const startTimeMs = performance.now();

    interface InjectedFileRecord {
      fullPath: string;
      existed: boolean;
      priorContent: Buffer | null;
    }
    const injectedRecords: InjectedFileRecord[] = [];
    let verificationResult: VerificationResult | undefined;
    let verificationError: unknown = null;

    try {
      if (input.evaluatorFiles && input.evaluatorFiles.length > 0) {
        // Phase 1: Validate all evaluator file paths BEFORE injecting any file
        const validatedFiles: { fullPath: string; content: string }[] = [];
        for (const file of input.evaluatorFiles) {
          const fullPath = await validateEvaluatorPath(input.workspace.path, file.path);
          validatedFiles.push({ fullPath, content: file.content });
        }

        // Phase 2: Inject validated files
        for (const file of validatedFiles) {
          const existed = existsSync(file.fullPath);
          const priorContent = existed ? await readFile(file.fullPath) : null;
          await mkdir(dirname(file.fullPath), { recursive: true });
          await writeFile(file.fullPath, file.content, 'utf-8');
          injectedRecords.push({ fullPath: file.fullPath, existed, priorContent });
        }
      }

      verificationResult = await engine.verify(plan);
    } catch (err: unknown) {
      verificationError = err;
    } finally {
      // Reliably clean up all injected files, attempting cleanup for every entry even if earlier cleanups fail
      const cleanupErrors: Error[] = [];
      for (const item of injectedRecords) {
        try {
          if (item.existed && item.priorContent !== null) {
            await writeFile(item.fullPath, item.priorContent);
          } else {
            await rm(item.fullPath, { force: true });
          }
        } catch (cleanupErr: unknown) {
          cleanupErrors.push(
            new Error(
              `Failed to cleanup injected evaluator file "${item.fullPath}": ${
                cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
              }`
            )
          );
        }
      }

      // If verification threw, preserve the original error while also reporting any cleanup failures
      if (verificationError) {
        if (cleanupErrors.length > 0) {
          const combinedMsg = `${
            verificationError instanceof Error ? verificationError.message : String(verificationError)
          }\nAdditionally, ${cleanupErrors.length} evaluator cleanup failure(s) occurred:\n${cleanupErrors
            .map((e) => `  - ${e.message}`)
            .join('\n')}`;
          const combined = new Error(combinedMsg);
          (combined as any).cause = verificationError;
          (combined as any).cleanupErrors = cleanupErrors;
          throw combined;
        }
        throw verificationError;
      }

      // If verification did not throw but cleanup failed, surface cleanup errors to prevent silent workspace contamination
      if (cleanupErrors.length > 0) {
        const cleanupErrMsg = `Evaluator file cleanup failed for ${cleanupErrors.length} file(s):\n${cleanupErrors
          .map((e) => `  - ${e.message}`)
          .join('\n')}`;
        const cleanupErr = new Error(cleanupErrMsg);
        (cleanupErr as any).cleanupErrors = cleanupErrors;
        throw cleanupErr;
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Math.round(performance.now() - startTimeMs);

    // 6. Assemble unsealed evidence using machine-independent workspace identity
    const mergedSecrets = [
      ...(this.customSecrets ?? []),
      ...(input.customSecrets ?? []),
    ];

    if (!verificationResult) {
      throw new Error('VerificationAdapter: verification result is unavailable.');
    }

    const unsealedEvidence: Omit<BenchmarkVerificationEvidence, 'evidenceContentHash'> = {
      armId: input.armId,
      taskId: input.taskId.trim(),
      snapshotCommitSha: input.snapshotCommitSha.trim(),
      workspacePath: `workspace://${input.armId}`,
      startedAt,
      completedAt,
      durationMs,
      status: verificationResult.status,
      checks: verificationResult.checks,
      workspaceBinding,
      diffCapture,
    };

    // 7. Sanitize secrets, serialize canonically, and seal with SHA-256 content hash
    return sealVerificationEvidence(unsealedEvidence, mergedSecrets.length > 0 ? mergedSecrets : undefined);
  }
}
