/**
 * Supported structural symbol kinds for V1 benchmark artifact tracking.
 * Deliberately small, language-agnostic, and syntactic.
 */
export type ArtifactSymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'method'
  | 'export';

/**
 * File modification status relative to repository state prior to Task 1.
 */
export type ArtifactFileStatus = 'ADDED' | 'MODIFIED';

/**
 * A concrete structural code entity established within a file by Task 1.
 */
export interface ArtifactSymbol {
  /** Identifier name of the symbol (e.g. "authenticateToken", "AuthRequest"). */
  name: string;

  /** Structural classification of the symbol. */
  kind: ArtifactSymbolKind;

  /**
   * Optional syntactic signature or declaration snippet.
   * Stored as provided after basic trimming.
   */
  signature?: string;
}

/**
 * A repository file established or modified during Task 1.
 */
export interface ArtifactFile {
  /**
   * Canonical repository-relative path using forward slashes (e.g. "src/middleware/auth.ts").
   * Traversal outside the repository root is strictly forbidden.
   */
  path: string;

  /** Whether the file was newly created or modified from pre-existing code. */
  status: ArtifactFileStatus;

  /** Key structural symbols established in this file by Task 1. */
  symbols: ArtifactSymbol[];
}

/**
 * Immutable measurement manifest capturing all concrete artifacts established by Task 1.
 * Frozen immediately at the conclusion of Task 1 before downstream evaluation.
 */
export interface ArtifactManifest {
  /** Target task identifier (e.g. "task-auth-middleware"). */
  taskId: string;

  /** Attempt sequence number of the task execution (must be >= 1). */
  attemptNumber: number;

  /** ISO 8601 UTC creation timestamp (e.g. "2026-10-01T12:00:00.000Z"). */
  createdAt: string;

  /** List of repository files established or modified, sorted deterministically. */
  files: ArtifactFile[];
}
