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
  samplingConfig?: {
    temperature?: number;
    maxTokens?: number;
  };
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

import type {
  GitCommit,
  GitRepository,
  GitStatus,
  Workspace,
} from '@orchestrate/workspace';
import type {
  VerificationCheck,
  VerificationEvidence,
  VerificationStatus,
} from '@orchestrate/verification';

/**
 * Standard usage shape conforming to benchmark metrics protocol.
 */
export interface ExecutionUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  usage_available: boolean;
}

/**
 * Chronological model completion event recorded by InstrumentedModelClient.
 */
export interface ModelCallEvent {
  sequence: number;
  type: 'MODEL_CALL';
  model: string;
  request: {
    messagesCount: number;
    toolsCount: number;
    temperature?: number;
    maxTokens?: number;
  };
  response?: {
    id: string;
    model: string;
    finishReason: string;
    toolCalls?: readonly {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }[];
    contentPreview?: string | null;
  };
  usage: ExecutionUsage;
  durationMs: number;
  error?: string;
}

/**
 * Chronological tool invocation event recorded by InstrumentedToolRegistry.
 */
export interface ToolCallEvent {
  sequence: number;
  type: 'TOOL_CALL';
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
  error?: string;
}

export type ExecutionOutcome =
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED_NEEDS_HUMAN';

/**
 * Complete raw execution evidence captured for one arm execution.
 * Append-only record prior to verification and measurement.
 */
export interface RawExecutionEvidence {
  trialId: string;
  armId: BenchmarkArmId;
  snapshotCommitSha: string;
  workspacePath: string;
  modelIdentity: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: ExecutionOutcome;
  modelEvents: readonly ModelCallEvent[];
  toolEvents: readonly ToolCallEvent[];
  finalResponse: {
    content: string | null;
    finishReason?: string;
  } | null;
  usage: ExecutionUsage;
  error?: {
    message: string;
    stack?: string;
  };
  evidenceContentHash: string;
}

/**
 * Isolated disposable workspace provisioned for an arm execution.
 */
export interface BenchmarkWorkspace {
  path: string;
  workspace: Workspace;
  git: GitRepository;
  cleanup(): Promise<void>;
}

/**
 * Factory creating isolated workspaces starting at the canonical snapshot commit.
 */
export interface WorkspaceFactory {
  create(snapshotCommitSha: string): Promise<BenchmarkWorkspace>;
  cleanup(path: string): Promise<void>;
}

/**
 * Result of executing an arm via AgentExecutionAdapter.
 * Pairs sealed, machine-independent evidence with the live workspace handle for subsequent verification.
 */
export interface ArmExecutionResult {
  evidence: RawExecutionEvidence;
  workspace: BenchmarkWorkspace;
}

/**
 * Summary of changed files categorized by Git status and unified diff analysis.
 */
export interface DownstreamChangeSummary {
  added: readonly string[];
  modified: readonly string[];
  deleted: readonly string[];
  renamed: readonly { from: string; to: string }[];
}

/**
 * Downstream repository diff capture comparing current workspace against the canonical Task-A snapshot.
 */
export interface DownstreamDiffCapture {
  snapshotCommitSha: string;
  headCommitSha: string | null;
  headCommit: GitCommit | null;
  gitStatus: GitStatus;
  changes: DownstreamChangeSummary;
  diff: string;
  capturedAt: string;
}

/**
 * Exact binding proving which workspace state was verified.
 */
export interface WorkspaceBindingEvidence {
  snapshotCommitSha: string;
  workspacePath: string;
  headCommitSha: string | null;
  headCommit: GitCommit | null;
  gitStatus: GitStatus;
}

/**
 * Input contract for VerificationAdapter.
 */
export interface BenchmarkVerificationInput {
  armId: BenchmarkArmId;
  taskId: string;
  snapshotCommitSha: string;
  workspace: BenchmarkWorkspace;
  checks: VerificationCheck[];
  customSecrets?: string[];
}

/**
 * Complete, sealed benchmark verification evidence for a single arm execution.
 */
export interface BenchmarkVerificationEvidence {
  armId: BenchmarkArmId;
  taskId: string;
  snapshotCommitSha: string;
  workspacePath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: VerificationStatus;
  checks: readonly VerificationEvidence[];
  workspaceBinding: WorkspaceBindingEvidence;
  diffCapture: DownstreamDiffCapture;
  evidenceContentHash: string;
}
