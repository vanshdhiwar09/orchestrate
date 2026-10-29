import { readFile as fsReadFile } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import type { CommandExecutor } from '@orchestrate/workspace';
import {
  detectRepositoryModuleResolutionRule,
  validateRelativeImportsInContent,
  type ModuleResolutionCheckOptions,
  type ModuleResolutionIssue,
} from './esm-verifier.js';
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
  private readonly workspaceRoot?: string;
  private readonly readFileFn?: (path: string) => Promise<string | null>;
  private readonly checkModuleResolution: boolean;

  constructor(options: VerificationEngineOptions) {
    if (!options?.executor || typeof options.executor.execute !== 'function') {
      throw new Error(
        'VerificationEngine requires a valid CommandExecutor instance.'
      );
    }
    this.executor = options.executor;
    this.workspaceRoot =
      options.workspaceRoot ?? (options.executor as any).workspaceRoot;
    this.readFileFn = options.readFile;
    this.checkModuleResolution = options.checkModuleResolution ?? true;
  }

  private async getFileReader(): Promise<((path: string) => Promise<string | null>) | null> {
    if (this.readFileFn) {
      return this.readFileFn;
    }
    const root = this.workspaceRoot;
    if (root) {
      return async (relPath: string) => {
        try {
          const full = pathResolve(root, relPath);
          return await fsReadFile(full, 'utf8');
        } catch {
          return null;
        }
      };
    }
    return null;
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
        optional: check.optional === true,
      });
    }

    // Repository module-resolution verification: operates only when repository config requires NodeNext ESM
    if (
      this.checkModuleResolution &&
      !plan.checks.some((c) => c.id === 'check-node-next-module-resolution')
    ) {
      const reader = await this.getFileReader();
      if (reader) {
        let rule: ModuleResolutionCheckOptions | null = null;
        let configError: string | null = null;
        try {
          rule = await detectRepositoryModuleResolutionRule(reader);
        } catch (err: unknown) {
          configError = err instanceof Error ? err.message : String(err);
        }

        if (configError) {
          evidenceList.push({
            checkId: 'check-node-next-module-resolution',
            name: 'node_next_module_resolution_gate',
            command: 'node',
            args: ['--check-module-resolution'],
            cwd: undefined,
            exitCode: 1,
            signal: null,
            stdout: '',
            stderr: `Module-resolution check failed: repository configuration could not be read: ${configError}`,
            timedOut: false,
            durationMs: 0,
            verifiedAt: new Date().toISOString(),
            passed: false,
            optional: false,
          });
        } else if (rule) {
          const staticStart = performance.now();
          let candidateFiles: string[] = [];
          try {
            const lsTracked = await this.executor.execute('git', ['ls-files']);
            const lsUntracked = await this.executor.execute('git', [
              'ls-files',
              '-o',
              '--exclude-standard',
            ]);
            const allFiles = (lsTracked.stdout + '\n' + lsUntracked.stdout)
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean);
            candidateFiles = [...new Set(allFiles)].filter(
              (f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js')
            );
          } catch {
            candidateFiles = [];
          }

          const issues: ModuleResolutionIssue[] = [];
          for (const f of candidateFiles) {
            const content = await reader(f);
            if (content !== null) {
              issues.push(...validateRelativeImportsInContent(f, content, rule));
            }
          }

          const staticDurationMs = Math.round(performance.now() - staticStart);
          const staticPassed = issues.length === 0;

          evidenceList.push({
            checkId: 'check-node-next-module-resolution',
            name: 'node_next_module_resolution_gate',
            command: 'node',
            args: ['--check-module-resolution'],
            cwd: undefined,
            exitCode: staticPassed ? 0 : 1,
            signal: null,
            stdout: staticPassed
              ? `Module-resolution check passed across ${candidateFiles.length} file(s).`
              : '',
            stderr: staticPassed
              ? ''
              : `Module-resolution check failed with ${issues.length} issue(s):\n` +
                issues.map((i) => `  - ${i.file}:${i.line}: ${i.reason}`).join('\n'),
            timedOut: false,
            durationMs: staticDurationMs,
            verifiedAt: new Date().toISOString(),
            passed: staticPassed,
            optional: false,
          });
        }
      }
    }

    const totalDurationMs = Math.round(performance.now() - planStart);
    const requiredEvidence = evidenceList.filter((e) => e.optional !== true);
    const allRequiredPassed =
      requiredEvidence.length > 0 &&
      requiredEvidence.every(
        (e) =>
          e.passed === true &&
          e.exitCode === 0 &&
          !e.timedOut &&
          e.signal === null
      );

    return {
      status: allRequiredPassed ? 'VERIFIED' : 'FAILED',
      checks: evidenceList,
      executedAt,
      totalDurationMs,
    };
  }
}
