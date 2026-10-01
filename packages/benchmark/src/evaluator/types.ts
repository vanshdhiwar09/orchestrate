import type { Workspace } from '@orchestrate/workspace';
import type { ArtifactFileStatus, ArtifactManifest, ArtifactSymbol } from '../manifest/types.js';

/**
 * Dedicated error thrown when rework evaluation encounters an unrecoverable failure.
 */
export class ReworkEvaluationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ReworkEvaluationError';
  }
}

/**
 * Complete, orthogonal rework event reasons covering all upstream file and symbol states.
 */
export type ReworkEventReason =
  | 'UPSTREAM_ADDED_FILE_MODIFIED'
  | 'UPSTREAM_ADDED_FILE_DELETED'
  | 'UPSTREAM_ADDED_FILE_RENAMED'
  | 'UPSTREAM_MODIFIED_FILE_DELETED'
  | 'UPSTREAM_MODIFIED_FILE_RENAMED'
  | 'UPSTREAM_MODIFIED_SYMBOL_CHANGED'
  | 'UPSTREAM_MODIFIED_SYMBOL_DELETED';

/**
 * Reasons explaining why an edit could not be deterministically proven as rework or non-rework.
 */
export type AmbiguousReworkReason =
  | 'MODIFIED_FILE_SHARED_REGION_EDIT'
  | 'MODIFIED_FILE_NO_UPSTREAM_SYMBOLS'
  | 'MODIFIED_FILE_SYMBOL_LINE_MAPPING_UNAVAILABLE'
  | 'DIFF_SYNTAX_UNPARSEABLE';

/**
 * A confirmed rework event representing a downstream edit that modifies, replaces,
 * or rewrites an upstream artifact established during Task 1.
 */
export interface ReworkEvent {
  /** Deterministic identifier, e.g. "rw:src/auth.ts" or "rw:src/server.ts:registerDataRoutes". */
  id: string;

  /** Canonical repository-relative file path in the upstream manifest. */
  filePath: string;

  /** Status of the file in the upstream manifest ('ADDED' | 'MODIFIED'). */
  upstreamStatus: ArtifactFileStatus;

  /**
   * Upstream symbol affected (value-equal to the corresponding ArtifactSymbol in manifest).
   * Present for symbol-level events in MODIFIED files.
   */
  targetSymbol?: ArtifactSymbol;

  /** Specific rework reason triggered. */
  reason: ReworkEventReason;

  /** Downstream destination path if the file was renamed. */
  destinationPath?: string;

  /** Unified diff snippet demonstrating the edit. */
  evidence: string;
}

/**
 * An edit that could not be deterministically established as rework or non-rework.
 * In accordance with the experiment protocol, ambiguous records are strictly excluded
 * from the rework_events metric count.
 */
export interface AmbiguousReworkRecord {
  /** Deterministic identifier, e.g. "amb:src/server.ts:MODIFIED_FILE_SHARED_REGION_EDIT:0". */
  id: string;

  /** Canonical repository-relative file path. */
  filePath: string;

  /** Candidate upstream symbol if partially identified. */
  candidateSymbol?: ArtifactSymbol;

  /** Specific ambiguity reason. */
  reason: AmbiguousReworkReason;

  /** Diff snippet or context explaining why deterministic classification was impossible. */
  evidence: string;
}

/**
 * Summary statistics computed using strict unique-file set cardinality.
 */
export interface ReworkEvaluationSummary {
  /** Total distinct file paths across upstream manifest and downstream diff. */
  totalFilesEvaluated: number;

  /** Total distinct file paths in the upstream manifest. */
  upstreamFilesChecked: number;

  /** Count of unique file paths with at least one confirmed ReworkEvent. */
  reworkFilesCount: number;

  /** Count of unique file paths with at least one AmbiguousReworkRecord. */
  ambiguousFilesCount: number;
}

/**
 * Complete machine-readable report emitted by the Rework Evaluator.
 */
export interface ReworkEvaluationReport {
  /** Upstream Task 1 identifier from the manifest. */
  upstreamTaskId: string;

  /** Downstream Task 2 identifier if provided. */
  downstreamTaskId?: string;

  /**
   * Primary benchmark metric: count of confirmed rework events.
   * Ambiguous records are STRICTLY EXCLUDED from this count.
   */
  rework_events: number;

  /** Alphabetically sorted list of confirmed rework events. */
  events: ReworkEvent[];

  /** Alphabetically sorted list of unresolved ambiguous rework records. */
  ambiguous: AmbiguousReworkRecord[];

  /** Summary statistics using exact unique-file semantics. */
  summary: ReworkEvaluationSummary;
}

/**
 * Input contract for the Rework Evaluator.
 */
export interface ReworkEvaluationInput {
  /** The frozen upstream artifact manifest established at the conclusion of Task 1. */
  manifest: Readonly<ArtifactManifest>;

  /**
   * Frozen read-only workspace representing the exact repository state at the end of Task 1.
   * REQUIRED. Symbol boundaries for MODIFIED files are reconstructed exclusively from this source.
   * Must NOT be the post-Task-2 workspace.
   */
  upstreamWorkspace: Pick<Workspace, 'readFile'>;

  /**
   * Raw Git unified diff representing Agent B's downstream modifications relative to Task 1.
   */
  diff: string;

  /** Optional identifier of the downstream task (for report metadata). */
  downstreamTaskId?: string;
}

/**
 * Public ReworkEvaluator service interface.
 */
export interface ReworkEvaluator {
  evaluate(input: ReworkEvaluationInput): Promise<Readonly<ReworkEvaluationReport>>;
}
