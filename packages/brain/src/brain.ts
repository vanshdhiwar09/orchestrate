import type {
  Decision,
  Handoff,
  Project,
  ProjectFact,
  Task,
  TaskAttempt,
  TaskMetrics,
  TaskTrustState,
  VerificationRecord,
} from './types.js';

export interface CreateProjectInput {
  id: string;
  name: string;
  createdAt?: string;
}

export interface AddProjectFactInput {
  key: string;
  value: string;
  provenance: ProjectFact['provenance'];
  status: ProjectFact['status'];
  recordedAt?: string;
}

export interface CreateTaskInput {
  id: string;
  projectId: string;
  title: string;
  description: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Provider-independent storage and retrieval contract for Project Brain.
 * Enforces append-only history, project boundaries, and invariants.
 */
export interface BrainStore {
  // Project operations
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(id: string): Promise<Project | null>;

  // Fact operations (append-only)
  addProjectFact(projectId: string, input: AddProjectFactInput): Promise<ProjectFact>;
  getProjectFacts(projectId: string): Promise<ProjectFact[]>;
  getCurrentFact(projectId: string, key: string): Promise<ProjectFact | null>;
  getFactHistory(projectId: string, key: string): Promise<ProjectFact[]>;

  // Task operations
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  listTasks(projectId: string): Promise<Task[]>;

  // Handoff operations (append-only)
  addHandoff(handoff: Handoff): Promise<Handoff>;
  getHandoff(taskId: string, attemptNumber: number): Promise<Handoff | null>;
  getHandoffById(id: string): Promise<Handoff | null>;

  // Verification operations (append-only)
  addVerificationRecord(record: VerificationRecord): Promise<VerificationRecord>;
  getVerificationRecord(taskId: string, attemptNumber: number): Promise<VerificationRecord | null>;
  getVerificationRecordById(id: string): Promise<VerificationRecord | null>;

  // Decision operations (append-only lineage)
  addDecision(decision: Decision): Promise<Decision>;
  getDecision(id: string): Promise<Decision | null>;
  listDecisions(projectId: string): Promise<Decision[]>;
  getActiveDecisions(projectId: string): Promise<Decision[]>;

  // Derived state & history
  deriveTaskTrustState(taskId: string): Promise<TaskTrustState>;
  markTaskBlocked(taskId: string, reason?: string): Promise<void>;
  getTaskHistory(taskId: string): Promise<TaskAttempt[]>;
  getTaskMetrics(taskId: string): Promise<TaskMetrics>;
}
