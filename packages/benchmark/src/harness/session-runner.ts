import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ModelClient } from '@orchestrate/model';
import { LocalCommandExecutor, LocalGitRepository } from '@orchestrate/workspace';
import { ensureCanonicalScenarioRepo, getScenarioDefinition } from '../scenarios/fixture-manager.js';
import { LocalWorkspaceFactory } from './workspace-factory.js';
import { TokenBudgetGuard, validateBudgetFeasibility, type BudgetWarningEvent } from './budget-guard.js';
import { TrialResultStore, FileCollisionError } from './result-store.js';
import { BenchmarkReporter, type BenchmarkReportSummary } from './reporter.js';
import { InterruptionHandler } from './interruption-handler.js';
import { TrialRunner, type RunTrialInput, type TrialRunResult } from './trial-runner.js';
import type {
  BenchmarkBudgetPolicy,
  HarnessExecutionControls,
  TrialIdentity,
} from './types.js';

export interface BenchmarkSessionOptions {
  /** List of scenario IDs or aliases to execute. */
  scenarios: string[];

  /** Number of replications per scenario (defaults to 1). */
  replications?: number;

  /**
   * Mandatory hard total token budget shared across all trials and arms in this session.
   * There is NO default or unbounded fallback; must be an explicit positive finite number.
   */
  maxTotalTokens: number;

  /**
   * Optional maximum token allocation per arm execution.
   * Under CONTROLLED_PER_ARM_BUDGET, defaults to Math.floor(maxTotalTokens / totalPlannedArms).
   * Under ADAPTIVE_SESSION_BUDGET, optional per-arm ceiling; defaults to shared session capacity.
   */
  maxTokensPerArm?: number;

  /**
   * Budget allocation policy across arms.
   * 'ADAPTIVE_SESSION_BUDGET' allows flexible capacity sharing;
   * 'CONTROLLED_PER_ARM_BUDGET' enforces strict per-arm partitions.
   * Defaults to ADAPTIVE_SESSION_BUDGET (or CONTROLLED if maxTokensPerArm is specified).
   */
  budgetPolicy?: BenchmarkBudgetPolicy;

  /**
   * Warning thresholds as fractions of the budget limit (e.g. [0.70, 0.85, 0.95]).
   */
  warningThresholds?: readonly number[];

  /**
   * Callback invoked whenever a warning threshold is crossed.
   */
  onBudgetWarning?: (warning: BudgetWarningEvent) => void;

  /** Directory where durable trial records and summary reports will be stored. */
  outputDir: string;

  /** ModelClient instance (real provider client or mock for integration tests). */
  modelClient: ModelClient;

  /** Execution controls override (optional). */
  controls?: Partial<HarnessExecutionControls>;

  /** Custom root directory for canonical scenario fixtures (optional). */
  customBenchmarksDir?: string;

  /** Whether to exit process on SIGINT/SIGTERM (set false for testing). */
  exitOnSignal?: boolean;
}

export interface BenchmarkSessionResult {
  summary: BenchmarkReportSummary;
  trialResults: TrialRunResult[];
  markdownReport: string;
  persistedFilePaths: string[];
  budgetGuard: TokenBudgetGuard;
}

export const CANONICAL_SMOKE_CONTROLS: HarnessExecutionControls = {
  modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  temperature: 0.2,
  topP: 0.95,
  maxTokens: 4096,
  seed: 42,
  baseSystemInstructions: 'You are a senior software engineer completing a task in an existing repository.',
  toolDefinitions: [
    { name: 'read_file', description: 'Read file contents' },
    { name: 'write_file', description: 'Write or create a file' },
    { name: 'replace_file_content', description: 'Replace content in a file' },
    { name: 'execute_command', description: 'Run a command in workspace' },
  ],
  toolPermissions: ['read_file', 'write_file', 'replace_file_content', 'execute_command'],
  taskTimeoutMs: 600000,
  maxSteps: 30,
  commandTimeoutMs: 30000,
  sanitizedEnv: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
  harnessVersion: '1.0.0',
};

/**
 * Orchestrates a complete benchmark evaluation session across multiple trials
 * enforcing run-level shared token budget, durable persistence, safe interruption,
 * and honest reporting without provider leakage.
 */
export async function runBenchmarkSession(
  options: BenchmarkSessionOptions
): Promise<BenchmarkSessionResult> {
  if (!options || typeof options !== 'object') {
    throw new Error('runBenchmarkSession: options must be an object.');
  }

  if (!Array.isArray(options.scenarios) || options.scenarios.length === 0) {
    throw new Error('runBenchmarkSession: scenarios must be a non-empty array.');
  }

  // 1. Enforce explicit positive aggregate token cap with no unbounded fallback
  if (
    typeof options.maxTotalTokens !== 'number' ||
    options.maxTotalTokens <= 0 ||
    !Number.isFinite(options.maxTotalTokens)
  ) {
    throw new Error(
      'runBenchmarkSession: maxTotalTokens must be an explicit positive finite number. Unbounded execution is prohibited.'
    );
  }

  if (!options.outputDir || typeof options.outputDir !== 'string' || !options.outputDir.trim()) {
    throw new Error('runBenchmarkSession: outputDir must be a non-empty string.');
  }

  if (!options.modelClient) {
    throw new Error('runBenchmarkSession: modelClient is required.');
  }

  const replications = options.replications ?? 1;
  const resolvedOutputDir = resolve(options.outputDir.trim());

  // Refuse to proceed if destination already contains prior benchmark artifacts
  const preflightSummaryPath = join(resolvedOutputDir, 'benchmark-summary.json');
  const preflightReportPath = join(resolvedOutputDir, 'benchmark-report.md');
  if (existsSync(preflightSummaryPath) || existsSync(preflightReportPath)) {
    throw new FileCollisionError(
      `Output directory collision: "${resolvedOutputDir}" already contains benchmark artifacts (benchmark-summary.json or benchmark-report.md). The runner refuses to proceed to prevent overwriting prior evaluation evidence.`,
      resolvedOutputDir
    );
  }

  const totalPlannedArms = options.scenarios.length * replications * 3;

  // Resolve budget policy: explicit option, or controlled if maxTokensPerArm is specified, else adaptive
  const budgetPolicy: BenchmarkBudgetPolicy =
    options.budgetPolicy ??
    (options.maxTokensPerArm !== undefined
      ? 'CONTROLLED_PER_ARM_BUDGET'
      : 'ADAPTIVE_SESSION_BUDGET');

  const maxTokensPerArm =
    budgetPolicy === 'CONTROLLED_PER_ARM_BUDGET'
      ? (options.maxTokensPerArm ?? Math.floor(options.maxTotalTokens / totalPlannedArms))
      : options.maxTokensPerArm;

  const warningThresholds = options.warningThresholds ?? [0.70, 0.85, 0.95];

  const baseControls: HarnessExecutionControls = {
    ...CANONICAL_SMOKE_CONTROLS,
    ...options.controls,
    maxTokensPerArm,
    budgetPolicy,
    warningThresholds,
  };

  // 2. Validate budget feasibility preflight before any workspace provisioning or model calls
  validateBudgetFeasibility({
    maxTotalTokens: options.maxTotalTokens,
    maxTokensPerArm,
    totalPlannedArms,
    singleRequestReservation: baseControls.maxTokens ?? 4096,
    policy: budgetPolicy,
  });

  // 3. Initialize Run-Scope Safety Components
  const budgetGuard = new TokenBudgetGuard({
    maxTotalTokens: options.maxTotalTokens,
    label: 'Session',
    policy: budgetPolicy,
    warningThresholds,
    onWarning: options.onBudgetWarning,
  });
  const resultStore = new TrialResultStore({ storageDir: resolvedOutputDir });
  const reporter = new BenchmarkReporter();
  const persistedFilePaths: string[] = [];
  const trialResults: TrialRunResult[] = [];

  const interruptionHandler = new InterruptionHandler({
    exitOnSignal: options.exitOnSignal ?? true,
    onInterrupted: async (signal) => {
      // Record interruption across session
    },
  });
  interruptionHandler.attach();

  try {
    for (const scenarioSpec of options.scenarios) {
      if (interruptionHandler.interrupted) break;

      const scenario = getScenarioDefinition(scenarioSpec);
      const materialized = await ensureCanonicalScenarioRepo(
        scenario.scenarioId,
        options.customBenchmarksDir
      );

      const repoExecutor = new LocalCommandExecutor({ workspaceRoot: materialized.repoPath });
      const snapshotRepo = new LocalGitRepository(repoExecutor);

      for (let rep = 1; rep <= replications; rep++) {
        if (interruptionHandler.interrupted) break;

        const runId = `trial-${scenario.scenarioId}-r${rep}-${Date.now()}`;
        const identity: TrialIdentity = {
          runId,
          scenarioId: scenario.scenarioId,
          replication: rep,
          taskAId: scenario.taskAId,
          taskBId: scenario.taskBId,
          snapshotId: `snap-${scenario.scenarioId}-r${rep}`,
          snapshotCommitSha: materialized.snapshotCommitSha,
        };

        const workspaceFactory = new LocalWorkspaceFactory({
          sourceRepoPath: materialized.repoPath,
        });

        const unregisterWsCleanup = interruptionHandler.registerWorkspaceCleanup(
          runId,
          async () => {
            await workspaceFactory.cleanupAll();
          }
        );

        const trialRunner = new TrialRunner({
          snapshotRepo,
          workspaceFactory,
          modelClient: options.modelClient,
          budgetGuard,
        });

        const trialInput: RunTrialInput = {
          identity,
          taskBPrompt: scenario.taskBPrompt,
          armBUnverifiedHandoff: scenario.armBUnverifiedHandoff,
          armCCompiledContext: scenario.armCCompiledContext,
          controls: baseControls,
          environmentDependencyFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
          verificationChecks: scenario.verificationChecksTaskB,
          manifest: scenario.manifest,
          evaluatorFiles: scenario.evaluatorFilesTaskB,
        };

        let result: TrialRunResult;
        try {
          result = await trialRunner.runTrial(trialInput);
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          // Infrastructure failure during run
          result = {
            valid: false,
            trial: {
              identity,
              controls: baseControls,
              controlFingerprint: {} as any,
              state: 'INVALID',
              createdAt: new Date().toISOString(),
              armOrderSeed: 0,
              executionOrder: ['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE'],
            },
            integrityPreflight: { valid: false, violations: [] },
            armResults: {},
            invalidationReason: reason,
          };
        } finally {
          unregisterWsCleanup();
          await workspaceFactory.cleanupAll();
        }

        trialResults.push(result);

        // Durable, exclusive persistence
        const savedFilePath = await resultStore.saveTrialResult(result, {
          interrupted: interruptionHandler.interrupted,
        });
        persistedFilePaths.push(savedFilePath);
      }
    }
  } finally {
    interruptionHandler.detach();
  }

  // Generate aggregate reports
  const summary = reporter.generateSummary(trialResults);
  const markdownReport = reporter.renderMarkdown(trialResults);

  // Persist summary artifacts with exclusive-write semantics ('wx')
  const summaryPath = join(resolvedOutputDir, 'benchmark-summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', encoding: 'utf-8' });
  persistedFilePaths.push(summaryPath);

  const reportPath = join(resolvedOutputDir, 'benchmark-report.md');
  await writeFile(reportPath, markdownReport, { flag: 'wx', encoding: 'utf-8' });
  persistedFilePaths.push(reportPath);

  return {
    summary,
    trialResults,
    markdownReport,
    persistedFilePaths,
    budgetGuard,
  };
}

export { FileCollisionError } from './result-store.js';
