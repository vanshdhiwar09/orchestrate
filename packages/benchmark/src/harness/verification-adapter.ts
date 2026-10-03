import {
  type CommandExecutor,
  LocalCommandExecutor,
} from '@orchestrate/workspace';
import {
  type VerificationCheck,
  VerificationEngine,
  type VerificationPlan,
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

    // 5. Independently execute checks
    const startedAt = new Date().toISOString();
    const startTimeMs = performance.now();

    const verificationResult = await engine.verify(plan);

    const completedAt = new Date().toISOString();
    const durationMs = Math.round(performance.now() - startTimeMs);

    // 6. Assemble unsealed evidence using machine-independent workspace identity
    const mergedSecrets = [
      ...(this.customSecrets ?? []),
      ...(input.customSecrets ?? []),
    ];

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
