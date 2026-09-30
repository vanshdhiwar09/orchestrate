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

