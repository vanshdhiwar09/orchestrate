import {
  computeControlFingerprint,
} from './fingerprints.js';
import { isValidCommitSha } from './snapshot-loader.js';
import {
  type BenchmarkArmId,
  BENCHMARK_ARM_IDS,
  type HarnessExecutionControls,
  type TrialIdentity,
  type TrialRecord,
} from './types.js';

export interface CreateTrialInput {
  identity: TrialIdentity;
  taskBPrompt: string;
  controls: HarnessExecutionControls;
  environmentDependencyFingerprint: string;
  armOrderSeed?: number;
  createdAt?: string;
}

/**
 * Deterministic pseudo-random number generator (Mulberry32) for reproducible arm permutation.
 */
function createMulberry32(seed: number): () => number {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically shuffles the three experimental arms using a seeded PRNG.
 */
export function generateArmOrder(seed: number): BenchmarkArmId[] {
  const arms: BenchmarkArmId[] = [...BENCHMARK_ARM_IDS];
  const rng = createMulberry32(seed);

  // Fisher-Yates shuffle
  for (let i = arms.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = arms[i];
    arms[i] = arms[j];
    arms[j] = temp;
  }

  return arms;
}

/**
 * Derives a deterministic default 32-bit integer seed from scenarioId and replication.
 */
export function deriveDefaultArmOrderSeed(scenarioId: string, replication: number): number {
  let hash = 0;
  const str = `${scenarioId.trim()}:${replication}:arm_order`;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/**
 * Validates the structural identity fields of a trial.
 */
export function validateTrialIdentity(identity: TrialIdentity): void {
  if (!identity || typeof identity !== 'object') {
    throw new Error('validateTrialIdentity: identity must be a non-null object.');
  }

  if (typeof identity.runId !== 'string' || identity.runId.trim() === '') {
    throw new Error('validateTrialIdentity: runId must be a non-empty string.');
  }

  if (typeof identity.scenarioId !== 'string' || identity.scenarioId.trim() === '') {
    throw new Error('validateTrialIdentity: scenarioId must be a non-empty string.');
  }

  if (
    typeof identity.replication !== 'number' ||
    !Number.isInteger(identity.replication) ||
    identity.replication < 1
  ) {
    throw new Error(
      `validateTrialIdentity: replication must be a positive integer >= 1, got ${identity.replication}.`
    );
  }

  if (typeof identity.taskAId !== 'string' || identity.taskAId.trim() === '') {
    throw new Error('validateTrialIdentity: taskAId must be a non-empty string.');
  }

  if (typeof identity.taskBId !== 'string' || identity.taskBId.trim() === '') {
    throw new Error('validateTrialIdentity: taskBId must be a non-empty string.');
  }

  if (typeof identity.snapshotId !== 'string' || identity.snapshotId.trim() === '') {
    throw new Error('validateTrialIdentity: snapshotId must be a non-empty string.');
  }

  if (!isValidCommitSha(identity.snapshotCommitSha)) {
    throw new Error(
      `validateTrialIdentity: snapshotCommitSha must be an exact 40-character hexadecimal string, got "${identity.snapshotCommitSha}".`
    );
  }
}

/**
 * Deterministically constructs an immutable TrialRecord.
 * Does NOT execute models, does NOT create workspaces, and does NOT perform verification.
 */
export function buildTrial(input: CreateTrialInput): TrialRecord {
  if (!input || typeof input !== 'object') {
    throw new Error('buildTrial: input must be a non-null object.');
  }

  validateTrialIdentity(input.identity);

  if (!input.taskBPrompt || typeof input.taskBPrompt !== 'string' || input.taskBPrompt.trim() === '') {
    throw new Error('buildTrial: taskBPrompt must be a non-empty string.');
  }

  if (!input.environmentDependencyFingerprint || typeof input.environmentDependencyFingerprint !== 'string') {
    throw new Error('buildTrial: environmentDependencyFingerprint must be a non-empty string.');
  }

  const armOrderSeed =
    input.armOrderSeed !== undefined
      ? input.armOrderSeed
      : deriveDefaultArmOrderSeed(input.identity.scenarioId, input.identity.replication);

  const executionOrder = generateArmOrder(armOrderSeed);

  const controlFingerprint = computeControlFingerprint({
    snapshotCommitSha: input.identity.snapshotCommitSha,
    taskBPrompt: input.taskBPrompt,
    controls: input.controls,
    environmentDependencyFingerprint: input.environmentDependencyFingerprint,
  });

  const createdAt = input.createdAt ?? new Date().toISOString();

  return Object.freeze({
    identity: Object.freeze({
      runId: input.identity.runId.trim(),
      scenarioId: input.identity.scenarioId.trim(),
      replication: input.identity.replication,
      taskAId: input.identity.taskAId.trim(),
      taskBId: input.identity.taskBId.trim(),
      snapshotId: input.identity.snapshotId.trim(),
      snapshotCommitSha: input.identity.snapshotCommitSha.toLowerCase().trim(),
    }),
    controls: Object.freeze({ ...input.controls }),
    controlFingerprint,
    state: 'CREATED',
    armOrderSeed,
    executionOrder: Object.freeze(executionOrder) as unknown as BenchmarkArmId[],
    createdAt,
  });
}
