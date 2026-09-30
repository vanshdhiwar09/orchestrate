import type {
  Decision,
  DecisionStatus,
  FactProvenance,
  FactStatus,
  ProjectFact,
  Task,
  TaskAttempt,
  TaskTrustState,
} from '@orchestrate/brain';
import type { GitCommit, GitStatus } from '@orchestrate/workspace';

/**
 * Request payload for compiling context for a downstream agent task.
 */
export interface CompilationRequest {
  projectId: string;
  targetTaskId: string;
  upstreamTaskId?: string;
  tags?: string[];
  config?: Partial<CompilerConfig>;
}

/**
 * Budgeting and filtering options for the Context Compiler.
 */
export interface CompilerConfig {
  maxDecisions: number;
  maxDecisionsChars: number;
  maxFacts: number;
  maxFactsChars: number;
  maxVerificationChecks: number;
  maxVerificationChars: number;
  maxDiffLines: number;
  maxDiffChars: number;
  maxStderrLines: number;
  maxStderrChars: number;
  includeGitDiff: boolean;
  includeUntrackedFiles: boolean;
  excludePatterns: string[];
}

/**
 * Default compiler configuration values.
 */
export const DEFAULT_COMPILER_CONFIG: CompilerConfig = {
  maxDecisions: 10,
  maxDecisionsChars: 3000,
  maxFacts: 20,
  maxFactsChars: 2000,
  maxVerificationChecks: 15,
  maxVerificationChars: 1500,
  maxDiffLines: 100,
  maxDiffChars: 4000,
  maxStderrLines: 20,
  maxStderrChars: 1000,
  includeGitDiff: true,
  includeUntrackedFiles: true,
  excludePatterns: [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
  ],
};

/**
 * Raw Git inspection data passed into the compilation snapshot.
 */
export interface GitSnapshotData {
  status: GitStatus;
  headCommit: GitCommit | null;
  diff: string;
}

/**
 * Complete, uncompiled snapshot of project state gathered by ContextLoader.
 */
export interface CompilationSnapshot {
  request: CompilationRequest;
  targetTask: Task | null;
  upstreamTask: Task | null;
  upstreamTrustState?: TaskTrustState;
  upstreamAttempts: TaskAttempt[];
  activeDecisions: Decision[];
  projectFacts: ProjectFact[];
  git: GitSnapshotData | null;
}

/**
 * Compiled architectural decision.
 */
export interface CompiledDecision {
  id: string;
  statement: string;
  rationale: string;
  status: DecisionStatus;
  supersedes?: string;
}

/**
 * Compiled verified fact.
 */
export interface CompiledFact {
  key: string;
  value: string;
  provenance: FactProvenance;
  status: FactStatus;
}

/**
 * Compiled verification check evidence (Level 2: VERIFICATION EVIDENCE).
 */
export interface CompiledCheckEvidence {
  checkId: string;
  name: string;
  command: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  stderrSnippet?: string;
}

/**
 * Quarantined unverified claims from upstream agent handoff (Level 4: AGENT CLAIMS).
 */
export interface QuarantinedAgentClaims {
  summary?: string;
  changes?: string;
  limitations?: string[];
  assumptions?: string[];
}

/**
 * Compiled upstream work representation, strictly partitioning verification evidence
 * from unverified agent claims.
 */
export interface CompiledUpstreamWork {
  taskId: string;
  title?: string;
  trustState: TaskTrustState;
  attemptNumber: number;
  filesAffected: string[];
  verificationChecks: CompiledCheckEvidence[];
  unverifiedAgentNotes?: QuarantinedAgentClaims;
}

/**
 * Compiled Git repository state.
 */
export interface CompiledGitState {
  branch: string | null;
  headCommit: {
    hash: string;
    subject: string;
    author: string;
  } | null;
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  diff?: string;
  diffTruncated?: boolean;
}

/**
 * Metadata recorded during compilation.
 */
export interface CompiledContextMetadata {
  projectId: string;
  targetTaskId: string;
  upstreamTaskId?: string;
  totalDecisionsCount: number;
  totalFactsCount: number;
  truncatedDecisions: boolean;
  truncatedFacts: boolean;
  redactionCount: number;
}

/**
 * Final structured context compiled deterministically by ContextCompilerCore.
 */
export interface CompiledContext {
  metadata: CompiledContextMetadata;
  decisions: CompiledDecision[];
  facts: CompiledFact[];
  upstreamWork?: CompiledUpstreamWork;
  gitState?: CompiledGitState;
}
