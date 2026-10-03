/**
 * Core type definitions for the Orchestrate benchmark evaluation harness.
 *
 * Grounded in the frozen experimental contracts:
 * - docs/TASK_A_SNAPSHOT_CONTRACT.md (M6A)
 * - docs/EXPERIMENTAL_ARM_ISOLATION.md (M6A)
 * - docs/TRIAL_RUN_CONTRACT.md (M6B)
 * - docs/HARNESS_EXECUTION_CONTRACT.md (M6C)
 */

export type BenchmarkArmId =
  | 'ARM_A_BASELINE'
  | 'ARM_B_UNVERIFIED_HANDOFF'
  | 'ARM_C_ORCHESTRATE';

export const BENCHMARK_ARM_IDS: readonly BenchmarkArmId[] = [
  'ARM_A_BASELINE',
  'ARM_B_UNVERIFIED_HANDOFF',
  'ARM_C_ORCHESTRATE',
] as const;

export type TrialLifecycleState =
  | 'CREATED'
  | 'SNAPSHOT_READY'
  | 'ARMS_READY'
  | 'EXECUTING'
  | 'EVIDENCE_CAPTURED'
  | 'MEASURED'
  | 'COMPLETE'
  | 'INVALID';

export type ArmExecutionStatus =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED_NEEDS_HUMAN';

/**
 * Immutable identity identifying a single experimental trial.
 */
export interface TrialIdentity {
  runId: string;
  scenarioId: string;
  replication: number;
  taskAId: string;
  taskBId: string;
  snapshotId: string;
  snapshotCommitSha: string;
}

/**
 * Canonical Task-A snapshot record conforming to M6A §2.
 */
export interface TaskASnapshotRecord {
  snapshotId: string;
  commitSha: string;
  scenarioId: string;
  taskAId: string;
  agentARunId: string;
  baseCommitSha: string;
  dependencyStateSha256: string;
  environmentFingerprint: string;
  createdAt: string;
}

/**
 * Immutable execution controls invariant across all arms of a trial.
 */
export interface HarnessExecutionControls {
  modelId: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  baseSystemInstructions: string;
  toolDefinitions: readonly Record<string, unknown>[];
  toolPermissions: readonly string[];
  taskTimeoutMs: number;
  maxSteps: number;
  commandTimeoutMs: number;
  sanitizedEnv: Readonly<Record<string, string>>;
  harnessVersion: string;
}

/**
 * Control fingerprint proving identical execution conditions across arms A/B/C.
 * Must satisfy ControlFingerprint(A) == ControlFingerprint(B) == ControlFingerprint(C).
 */
export interface ControlFingerprint {
  snapshotCommitSha: string;
  taskBPromptHash: string;
  modelIdentity: string;
  inferenceConfigHash: string;
  systemInstructionsHash: string;
  toolDefinitionsHash: string;
  toolPermissionsHash: string;
  environmentDependencyFingerprint: string;
  executionLimitsHash: string;
  filesystemPolicyHash: string;
  networkPolicyHash: string;
  harnessVersion: string;
  runtimeConfigHash: string;
}

/**
 * Treatment fingerprint capturing the intentional experimental context difference.
 */
export interface TreatmentFingerprint {
  armId: BenchmarkArmId;
  treatmentPayloadHash: string;
}

/**
 * Arm treatment context envelope injected into Agent B.
 */
export interface TreatmentContextEnvelope {
  armId: BenchmarkArmId;
  rawPayload: string | null;
  formattedBlock: string | null;
  treatmentPayloadHash: string;
}

/**
 * Complete input provided to Agent B for execution in an isolated arm workspace.
 */
export interface ArmExecutionInput {
  trialId: string;
  armId: BenchmarkArmId;
  snapshotCommitSha: string;
  taskBPrompt: string;
  systemPrompt: string;
  contextEnvelope: TreatmentContextEnvelope | null;
  controlFingerprint: ControlFingerprint;
  treatmentFingerprint: TreatmentFingerprint;
}

/**
 * Arm-level container within a trial.
 */
export interface TrialArmRecord {
  armId: BenchmarkArmId;
  status: ArmExecutionStatus;
  input: ArmExecutionInput;
}

/**
 * Complete trial record constructed by TrialBuilder.
 */
export interface TrialRecord {
  identity: TrialIdentity;
  controls: HarnessExecutionControls;
  controlFingerprint: ControlFingerprint;
  state: TrialLifecycleState;
  armOrderSeed: number;
  executionOrder: BenchmarkArmId[];
  arms?: Record<BenchmarkArmId, TrialArmRecord>;
  createdAt: string;
}
