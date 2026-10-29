import type { VerificationResult } from '@orchestrate/verification';

/**
 * Provenance categories for project facts.
 */
export type FactProvenance =
  | 'CODE'
  | 'VERIFICATION'
  | 'SYSTEM'
  | 'AGENT'
  | 'HUMAN';

/**
 * Trust status of an individual project fact.
 */
export type FactStatus =
  | 'CLAIMED'
  | 'UNVERIFIED'
  | 'VERIFIED';

/**
 * An immutable, append-only factual observation about a project.
 */
export interface ProjectFact {
  key: string;
  value: string;
  provenance: FactProvenance;
  status: FactStatus;
  recordedAt: string;
}

/**
 * Root project entity scoping tasks, facts, decisions, and verification records.
 */
export interface Project {
  id: string;
  name: string;
  facts: ProjectFact[];
  createdAt: string;
  ownerId?: string;
}

/**
 * Unit of intent and specification.
 * Task trust state is derived from attempt history rather than stored as a mutable column.
 */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Agent-reported outcome and claims for a specific attempt.
 * Append-only; at most one Handoff exists per (taskId, attemptNumber).
 */
export interface Handoff {
  id: string;
  taskId: string;
  attemptNumber: number;
  agentId?: string;
  model?: string;
  status: 'CLAIMED';
  summary: string;
  changes: string;
  filesAffected: string[];
  decisionsCreated: string[];
  assumptions: string[];
  limitations: string[];
  recommendedFollowUp: string[];
  createdAt: string;
}

export interface SourceSnapshotIdentity {
  fingerprint: string;
  capturedAt: string;
  fileCount?: number;
  commitSha?: string | null;
  dirty?: boolean;
}

/**
 * Independent verification evidence for a specific task attempt.
 * Wraps VerificationResult without redefining verification types.
 * Append-only; at most one VerificationRecord exists per (taskId, attemptNumber).
 */
export interface VerificationRecord {
  id: string;
  taskId: string;
  attemptNumber: number;
  handoffId?: string;
  result: VerificationResult;
  recordedAt: string;
  sourceSnapshot?: SourceSnapshotIdentity;
}

export class SourceFreshnessError extends Error {
  public readonly code: 'SOURCE_FRESHNESS_MISMATCH' | 'SOURCE_SNAPSHOT_MISSING' | 'SOURCE_FINGERPRINT_FAILED';
  public readonly taskId: string;
  public readonly attemptNumber?: number;
  public readonly expectedFingerprint?: string;
  public readonly actualFingerprint?: string;

  constructor(
    code: 'SOURCE_FRESHNESS_MISMATCH' | 'SOURCE_SNAPSHOT_MISSING' | 'SOURCE_FINGERPRINT_FAILED',
    taskId: string,
    attemptNumber?: number,
    expectedFingerprint?: string,
    actualFingerprint?: string,
    message?: string
  ) {
    super(
      message ??
        `Source freshness violation for task "${taskId}" (attempt ${attemptNumber ?? 'unknown'}): code=${code}`
    );
    this.name = 'SourceFreshnessError';
    this.code = code;
    this.taskId = taskId;
    this.attemptNumber = attemptNumber;
    this.expectedFingerprint = expectedFingerprint;
    this.actualFingerprint = actualFingerprint;
  }
}

export class PromotionError extends Error {
  public readonly code:
    | 'TASK_NOT_VERIFIED'
    | 'ATTEMPT_MISMATCH'
    | 'TASK_BLOCKED'
    | 'TASK_NOT_FOUND'
    | 'SOURCE_SNAPSHOT_MISSING';
  public readonly taskId: string;

  constructor(
    code:
      | 'TASK_NOT_VERIFIED'
      | 'ATTEMPT_MISMATCH'
      | 'TASK_BLOCKED'
      | 'TASK_NOT_FOUND'
      | 'SOURCE_SNAPSHOT_MISSING',
    taskId: string,
    message?: string
  ) {
    super(message ?? `Promotion failed for task "${taskId}": code=${code}`);
    this.name = 'PromotionError';
    this.code = code;
    this.taskId = taskId;
  }
}

export interface DeriveTrustStateOptions {
  workspaceRoot?: string;
  currentFingerprint?: string;
  requireFreshness?: boolean;
  computeSnapshotFn?: (workspaceRoot: string) => Promise<SourceSnapshotIdentity>;
}

export interface PromoteTaskOptions {
  workspaceRoot: string;
  expectedAttemptNumber?: number;
  computeSnapshotFn?: (workspaceRoot: string) => Promise<SourceSnapshotIdentity>;
}

export interface PromotionResult {
  taskId: string;
  attemptNumber: number;
  status: 'VERIFIED';
  sourceSnapshot: SourceSnapshotIdentity;
  promotedAt: string;
}

/**
 * Lifecycle status of an architectural decision.
 */
export type DecisionStatus = 'ACTIVE' | 'SUPERSEDED';

/**
 * Cross-task architectural decision with lineage tracking.
 */
export interface Decision {
  id: string;
  projectId: string;
  taskId?: string;
  attemptNumber?: number;
  statement: string;
  rationale: string;
  status: DecisionStatus;
  supersedes?: string;
  createdAt: string;
}

/**
 * Authoritative trust state of a task, derived from its attempt history.
 */
export type TaskTrustState =
  | 'UNVERIFIED'
  | 'CLAIMED'
  | 'VERIFIED'
  | 'FAILED'
  | 'BLOCKED_NEEDS_HUMAN';

export interface TaskMetrics {
  verification_attempts: number;
  verification_failures: number;
  repair_attempts: number;
  repaired_successfully: boolean;
  verificationAttempts: number;
  verificationFailures: number;
  repairAttempts: number;
  repairedSuccessfully: boolean;
}

/**
 * Combined view of an attempt's handoff and verification record.
 */
export interface TaskAttempt {
  attemptNumber: number;
  handoff?: Handoff;
  verification?: VerificationRecord;
  verificationRecord?: VerificationRecord;
}

