/**
 * Dedicated error thrown when discovery evaluation encounters an unrecoverable failure.
 */
export class DiscoveryEvaluationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DiscoveryEvaluationError';
  }
}

/**
 * Types of structured references supplied in Agent B's starting context envelope.
 */
export type SuppliedContextType =
  | 'TASK'
  | 'FILE'
  | 'DIRECTORY'
  | 'SYMBOL'
  | 'DECISION'
  | 'FACT'
  | 'VERIFICATION'
  | 'HANDOFF'
  | 'GIT_STATE'
  | 'GIT_HISTORY'
  | 'GIT_DIFF';

/**
 * A concrete, structured reference supplied to Agent B before downstream execution.
 * The evaluator performs exact syntactic matching against these references without
 * attempting semantic interpretation of natural language text.
 */
export interface SuppliedContextReference {
  /** Structural category of the supplied context item. */
  type: SuppliedContextType;

  /**
   * Canonical syntactic value:
   * - For 'FILE': Canonical repository-relative path (e.g. "src/middleware/auth.ts").
   * - For 'DIRECTORY': Canonical repository-relative directory path ending with '/' (e.g. "src/").
   * - For 'SYMBOL': Exact identifier name (e.g. "authenticateToken", "AuthRequest").
   * - For 'GIT_STATE' / 'GIT_HISTORY' / 'GIT_DIFF': Canonical Git context indicator (e.g. "status", "HEAD", "").
   * - For 'DECISION' / 'FACT' / 'TASK' / 'VERIFICATION' / 'HANDOFF': Canonical reference identifier.
   */
  value: string;
}

/**
 * Supported structural categories for repository discovery actions.
 */
export type DiscoveryCategory =
  | 'FILE_READ'
  | 'FILE_LIST'
  | 'SEARCH'
  | 'SYMBOL_LOOKUP'
  | 'GIT_STATE'
  | 'GIT_HISTORY'
  | 'GIT_DIFF';

/**
 * A discrete tool invocation event executed by Agent B.
 * Ordered strictly by monotonically increasing sequence number (not timestamps).
 */
export interface DiscoveryEvent {
  /**
   * Monotonically increasing execution sequence index (1, 2, 3, ...).
   * Primary ordering mechanism; timestamps must NOT be used for ordering.
   */
  sequence: number;

  /** Name of the tool invoked by the agent (e.g. "read_file", "git_status"). */
  toolName: string;

  /**
   * Structured target of the invocation:
   * - FILE_READ: Normalized repository-relative file path (e.g. "src/auth.ts").
   * - FILE_LIST: Normalized repository-relative directory path (e.g. "src/").
   * - SEARCH: Exact search term or query string (e.g. "requireAuth").
   * - SYMBOL_LOOKUP: Exact symbol identifier name (e.g. "requireAuth").
   * - GIT_STATE: Canonical state identifier ("status").
   * - GIT_HISTORY: Target ref or commit specifier ("HEAD" or "").
   * - GIT_DIFF: Target diff ref or path specifier ("" or "HEAD").
   */
  target?: string;

  /** Qualifying discovery category. */
  category: DiscoveryCategory;
}

/**
 * An event that could not be deterministically classified as discovery or non-discovery.
 * Recorded separately for scientific auditability; strictly excluded from discovery_actions.
 */
export interface UnclassifiedEvent {
  sequence: number;
  toolName: string;
  rawInput?: unknown;
  reason: string;
}

/**
 * Input contract for the Discovery Evaluator.
 */
export interface DiscoveryEvaluationInput {
  /** Downstream task identifier. */
  taskId: string;

  /**
   * Structured references supplied to Agent B before execution.
   * For Arm A: Typically empty [].
   * For Arm B: Unverified handoff file/symbol/directory references.
   * For Arm C: Verified Brain context references.
   */
  suppliedContext: readonly SuppliedContextReference[];

  /**
   * Chronological list of tool invocation events executed by Agent B,
   * ordered by sequence index.
   */
  events: readonly DiscoveryEvent[];

  /**
   * Optional unclassified or unknown events encountered in the trace.
   */
  unclassifiedEvents?: readonly UnclassifiedEvent[];
}

/**
 * Machine-readable report emitted by the Discovery Evaluator.
 */
export interface DiscoveryEvaluationReport {
  /** Downstream task identifier. */
  taskId: string;

  /**
   * Primary benchmark metric: count of qualifying discovery actions.
   * Unclassified events and supplied-context hits are STRICTLY EXCLUDED.
   */
  discovery_actions: number;

  /** List of qualifying discovery events that contributed to the metric. */
  qualifyingEvents: DiscoveryEvent[];

  /** List of events that matched supplied context and thus were NOT discovery. */
  suppliedHits: DiscoveryEvent[];

  /** List of unclassified tool invocations. */
  unclassified: UnclassifiedEvent[];

  /** Summary statistics. */
  summary: {
    totalEventsEvaluated: number;
    qualifyingCount: number;
    suppliedHitCount: number;
    unclassifiedCount: number;
  };
}

/**
 * Type aliases for backward compatibility or alternate naming conventions.
 */
export type DiscoveryMeasurementInput = DiscoveryEvaluationInput;
export type DiscoveryMeasurementReport = DiscoveryEvaluationReport;

/**
 * Evaluator interface for discovery measurement.
 */
export interface DiscoveryEvaluator {
  evaluate(input: DiscoveryEvaluationInput): Readonly<DiscoveryEvaluationReport>;
}

export type DiscoveryMeasurementEvaluator = DiscoveryEvaluator;
