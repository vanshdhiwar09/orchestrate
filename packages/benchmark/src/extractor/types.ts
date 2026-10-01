import type { ArtifactManifest } from '../manifest/types.js';
import type { GitRepository, Workspace } from '@orchestrate/workspace';

/**
 * Dedicated error thrown when manifest extraction encounters an unrecoverable
 * infrastructure failure (e.g. directory is not a Git repo, file read fails).
 */
export class ManifestExtractionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ManifestExtractionError';
  }
}

/**
 * Optional tuning options for the extractor.
 * Note: createdAt is strictly excluded from options to guarantee determinism.
 */
export interface ManifestExtractionOptions {
  /**
   * Glob-style path patterns to ignore (defaults to standard build/tooling paths).
   */
  ignoredPatterns?: string[];

  /**
   * File extensions subject to lexical symbol scanning.
   * Defaults to ['.ts', '.js', '.tsx', '.jsx'].
   */
  sourceExtensions?: string[];
}

/**
 * Input contract for manifest extraction.
 *
 * DETERMINISM INVARIANT:
 * createdAt is REQUIRED. The extractor never generates timestamps internally
 * so that running extraction on the same repository state always produces
 * byte-for-byte identical output.
 */
export interface ManifestExtractionInput {
  /** Target task identifier (e.g. "task-auth-middleware"). */
  taskId: string;

  /** Attempt sequence number (must be >= 1). */
  attemptNumber: number;

  /**
   * Deterministic ISO 8601 UTC timestamp provided by the benchmark harness.
   * REQUIRED. The extractor never calls Date.now() or generates timestamps.
   */
  createdAt: string;

  /** Read-only workspace interface for reading file contents. */
  workspace: Pick<Workspace, 'readFile'>;

  /** Read-only Git abstraction for retrieving repository status. */
  git: Pick<GitRepository, 'getStatus' | 'isRepository'>;

  /** Optional extractor configuration (ignore lists, extensions). */
  options?: ManifestExtractionOptions;
}

export interface ManifestExtractor {
  extract(input: ManifestExtractionInput): Promise<Readonly<ArtifactManifest>>;
}
