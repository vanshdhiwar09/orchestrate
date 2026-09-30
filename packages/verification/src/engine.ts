import type { CommandExecutor } from '@orchestrate/workspace';
import type {
  VerificationCheck,
  VerificationEngineOptions,
  VerificationEvidence,
  VerificationPlan,
  VerificationResult,
} from './types.js';

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Allowlisted executables permitted in verification checks.
 * Matches the provider-agnostic command set supported by LocalCommandExecutor.
 */
export const ALLOWED_VERIFICATION_COMMANDS = new Set([
  'node',
  'npm',
  'npx',
  'tsc',
  'git',
]);

export class VerificationEngine {
  private readonly executor: CommandExecutor;

  constructor(options: VerificationEngineOptions) {
    if (!options?.executor || typeof options.executor.execute !== 'function') {
      throw new Error(
        'VerificationEngine requires a valid CommandExecutor instance.'
      );
    }
    this.executor = options.executor;
  }

  /**
   * Validates the entire VerificationPlan before any check is executed.
   * Throws an Error if any invariant is violated.
   */
  private validatePlan(plan: VerificationPlan): void {
    if (!plan || typeof plan !== 'object') {
      throw new Error('VerificationPlan must be a non-null object.');
    }

    if (!Array.isArray(plan.checks)) {
      throw new Error('VerificationPlan.checks must be an array.');
    }

    if (plan.checks.length === 0) {
      throw new Error(
        'VerificationPlan is invalid: checks must contain at least one check.'
      );
    }

    const seenIds = new Set<string>();

    for (let i = 0; i < plan.checks.length; i++) {
      const check = plan.checks[i];
      if (!check || typeof check !== 'object') {
        throw new Error(`VerificationCheck at index ${i} must be an object.`);
      }

      // Check ID
      if (typeof check.id !== 'string' || check.id.trim() === '') {
        throw new Error(
          `VerificationCheck at index ${i} must have a non-empty string "id".`
        );
      }
      if (seenIds.has(check.id)) {
        throw new Error(
          `Duplicate verification check ID: "${check.id}". Each check must have a unique ID.`
        );
      }
      seenIds.add(check.id);

      // Check name
      if (typeof check.name !== 'string' || check.name.trim() === '') {
        throw new Error(
          `VerificationCheck "${check.id}" must have a non-empty string "name".`
        );
      }

      // Command
      if (typeof check.command !== 'string' || check.command.trim() === '') {
        throw new Error(
          `VerificationCheck "${check.id}" must have a non-empty string "command".`
        );
      }
      const normalizedCommand = check.command.trim();
      if (!ALLOWED_VERIFICATION_COMMANDS.has(normalizedCommand)) {
        throw new Error(
          `Command not allowed in verification check "${check.id}": "${normalizedCommand}". Allowed commands: ${[...ALLOWED_VERIFICATION_COMMANDS].join(', ')}.`
        );
      }

      // Arguments
      if (!Array.isArray(check.args)) {
        throw new Error(
          `VerificationCheck "${check.id}" must have an array "args".`
        );
      }
      for (let j = 0; j < check.args.length; j++) {
        if (typeof check.args[j] !== 'string') {
          throw new Error(
            `VerificationCheck "${check.id}": args[${j}] must be a string.`
          );
        }
      }

      // Working directory (optional)
      if (check.cwd !== undefined) {
        if (typeof check.cwd !== 'string' || check.cwd.trim() === '') {
          throw new Error(
            `VerificationCheck "${check.id}": "cwd", if provided, must be a non-empty string.`
          );
        }
      }

      // Timeout (optional)
      if (check.timeoutMs !== undefined) {
        if (
          typeof check.timeoutMs !== 'number' ||
          !Number.isFinite(check.timeoutMs) ||
          check.timeoutMs <= 0
        ) {
          throw new Error(
            `VerificationCheck "${check.id}": "timeoutMs", if provided, must be a finite positive number.`
          );
        }
        if (check.timeoutMs > MAX_TIMEOUT_MS) {
          throw new Error(
            `VerificationCheck "${check.id}": timeoutMs (${check.timeoutMs}ms) exceeds maximum allowed timeout (${MAX_TIMEOUT_MS}ms).`
          );
        }
      }
    }
  }

  /**
   * Independently executes configured verification checks and captures evidence.
   *
   * Checks execute sequentially in the exact order specified in plan.checks.
   * All checks are executed even if an earlier check fails.
   */
  async verify(plan: VerificationPlan): Promise<VerificationResult> {
    // Upfront validation: validate the entire plan before executing any check.
    this.validatePlan(plan);

    const planStart = performance.now();
    const executedAt = new Date().toISOString();
    const evidenceList: VerificationEvidence[] = [];

    for (const check of plan.checks) {
      const effectiveTimeout = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      const checkStart = performance.now();
      const execResult = await this.executor.execute(
        check.command,
        check.args,
        {
          cwd: check.cwd,
          timeoutMs: effectiveTimeout,
        }
      );
      const durationMs = Math.round(performance.now() - checkStart);

      // Check success criteria: exitCode === 0 && !timedOut && signal === null
      const passed =
        execResult.exitCode === 0 &&
        !execResult.timedOut &&
        execResult.signal === null;

      evidenceList.push({
        checkId: check.id,
        name: check.name,
        command: check.command,
        args: [...check.args],
        cwd: check.cwd,
        exitCode: execResult.exitCode,
        signal: execResult.signal,
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        timedOut: execResult.timedOut,
        durationMs,
        verifiedAt: new Date().toISOString(),
        passed,
      });
    }

    const totalDurationMs = Math.round(performance.now() - planStart);
    const allPassed = evidenceList.every((e) => e.passed);

    return {
      status: allPassed ? 'VERIFIED' : 'FAILED',
      checks: evidenceList,
      executedAt,
      totalDurationMs,
    };
  }
}
