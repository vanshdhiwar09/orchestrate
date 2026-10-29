export type {
  FactProvenance,
  FactStatus,
  ProjectFact,
  Project,
  Task,
  Handoff,
  VerificationRecord,
  SourceSnapshotIdentity,
  DeriveTrustStateOptions,
  PromoteTaskOptions,
  PromotionResult,
  DecisionStatus,
  Decision,
  TaskTrustState,
  TaskMetrics,
  TaskAttempt,
} from './types.js';

export { SourceFreshnessError, PromotionError } from './types.js';

export type {
  CreateProjectInput,
  AddProjectFactInput,
  CreateTaskInput,
  BrainStore,
} from './brain.js';

export { MemoryProjectBrain } from './memory.js';
export { SqliteProjectBrain, type SqliteProjectBrainOptions } from './sqlite.js';
