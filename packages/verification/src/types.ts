import type { CommandExecutor } from '@orchestrate/workspace';

/**
 * Definition of a single verification check.
 */
export interface VerificationCheck {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

/**
 * An immutable plan containing one or more ordered verification checks.
 */
export interface VerificationPlan {
  checks: VerificationCheck[];
}

/**
 * Self-contained, immutable evidence captured from executing a single check.
 *
 * ARCHITECTURAL BOUNDARY NOTE:
 * Raw VerificationEvidence is trusted evidence storage inside the verification layer.
 * Raw stdout and stderr are preserved exactly as returned by CommandExecutor because
 * diagnostic output is evidence.
 * Before evidence is:
 *  - sent to an LLM
 *  - sent to LangSmith/telemetry
 *  - persisted into externally visible project state
 * a downstream consumer MUST apply appropriate secret/path/data redaction.
 */
export interface VerificationEvidence {
  checkId: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;

  exitCode: number | null;
  signal: NodeJS.Signals | null;

  stdout: string;
  stderr: string;

  timedOut: boolean;

  durationMs: number;

  verifiedAt: string;

  passed: boolean;
}

/**
 * Overall outcome of the verification plan.
 * V1 supports only binary outcomes: all passed (VERIFIED) or any failed (FAILED).
 */
export type VerificationStatus =
  | 'VERIFIED'
  | 'FAILED';

/**
 * Final structured verification result returned by the VerificationEngine.
 */
export interface VerificationResult {
  status: VerificationStatus;

  checks: VerificationEvidence[];

  executedAt: string;

  totalDurationMs: number;
}

export interface VerificationEngineOptions {
  executor: CommandExecutor;
}
