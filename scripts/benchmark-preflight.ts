import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureCanonicalScenarioRepo,
  getScenarioDefinition,
  SCENARIO_CATALOG,
  buildTrial,
  attachArmTriad,
  validateTrialIntegrity,
  SnapshotLoader,
  canonicalJson,
  sha256,
  type HarnessExecutionControls,
  type TrialIdentity,
  type TrialRecord,
} from '../packages/benchmark/dist/index.js';
import { LocalCommandExecutor, LocalGitRepository } from '@orchestrate/workspace';

export interface PreflightOptions {
  scenarioId?: string;
  all?: boolean;
  replication?: number;
  customBenchmarksDir?: string;
}

export interface ScenarioPreflightReport {
  scenarioId: string;
  replication: number;
  valid: boolean;
  runId: string;
  snapshotCommitSha: string;
  controlFingerprint: string;
  armATreatmentFingerprint: string;
  armBTreatmentFingerprint: string;
  armCTreatmentFingerprint: string;
  violations?: readonly { code: string; message: string }[];
}

export interface PreflightSummary {
  success: boolean;
  reports: ScenarioPreflightReport[];
  error?: string;
}

export const DEFAULT_PREFLIGHT_CONTROLS: HarnessExecutionControls = {
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

export const DEFAULT_ENV_FINGERPRINT = 'node:22.0.0|npm:10.0.0|os:win32';

/**
 * Validates a single scenario's trial specification without executing models or creating arm workspaces.
 */
export async function preflightScenario(
  scenarioIdOrAlias: string,
  replication = 1,
  customBenchmarksDir?: string
): Promise<ScenarioPreflightReport> {
  const scenario = getScenarioDefinition(scenarioIdOrAlias);
  const materialized = await ensureCanonicalScenarioRepo(scenario.scenarioId, customBenchmarksDir);

  // 1. Verify snapshot resolvable via SnapshotLoader
  const executor = new LocalCommandExecutor({ workspaceRoot: materialized.repoPath });
  const gitRepo = new LocalGitRepository(executor);
  const snapshotLoader = new SnapshotLoader({ repo: gitRepo, executor });
  const resolution = await snapshotLoader.resolveSnapshot(materialized.snapshotCommitSha);

  if (!resolution.resolvable) {
    throw new Error(
      `Snapshot commit "${materialized.snapshotCommitSha}" is not resolvable in "${materialized.repoPath}".`
    );
  }

  // 2. Build TrialIdentity
  const identity: TrialIdentity = {
    runId: `trial-${scenario.scenarioId}-r${replication}-preflight`,
    scenarioId: scenario.scenarioId,
    replication,
    taskAId: scenario.taskAId,
    taskBId: scenario.taskBId,
    snapshotId: `snap-${scenario.scenarioId}-r${replication}`,
    snapshotCommitSha: resolution.commitSha,
  };

  // 3. Build TrialRecord (CREATED)
  const trial = buildTrial({
    identity,
    taskBPrompt: scenario.taskBPrompt,
    controls: DEFAULT_PREFLIGHT_CONTROLS,
    environmentDependencyFingerprint: DEFAULT_ENV_FINGERPRINT,
  });

  // 4. Attach arms (ARMS_READY)
  const armsReadyTrial = attachArmTriad(trial, {
    taskBPrompt: scenario.taskBPrompt,
    armBUnverifiedHandoff: scenario.armBUnverifiedHandoff,
    armCCompiledContext: scenario.armCCompiledContext,
  });

  // 5. Run Integrity Guard preflight validation
  const integrity = validateTrialIntegrity(armsReadyTrial);

  const arms = armsReadyTrial.arms!;
  return {
    scenarioId: scenario.scenarioId,
    replication,
    valid: integrity.valid,
    runId: identity.runId,
    snapshotCommitSha: resolution.commitSha,
    controlFingerprint: sha256(canonicalJson(trial.controlFingerprint)),
    armATreatmentFingerprint: arms.ARM_A_BASELINE.input.treatmentFingerprint.treatmentPayloadHash,
    armBTreatmentFingerprint: arms.ARM_B_UNVERIFIED_HANDOFF.input.treatmentFingerprint.treatmentPayloadHash,
    armCTreatmentFingerprint: arms.ARM_C_ORCHESTRATE.input.treatmentFingerprint.treatmentPayloadHash,
    violations: integrity.violations.length > 0 ? integrity.violations : undefined,
  };
}

/**
 * Runs preflight validation across requested scenarios.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightSummary> {
  const reports: ScenarioPreflightReport[] = [];
  const replication = options.replication ?? 1;

  if (options.all) {
    for (const scenarioId of Object.keys(SCENARIO_CATALOG)) {
      const report = await preflightScenario(scenarioId, replication, options.customBenchmarksDir);
      reports.push(report);
    }
  } else if (options.scenarioId) {
    const report = await preflightScenario(options.scenarioId, replication, options.customBenchmarksDir);
    reports.push(report);
  } else {
    return {
      success: false,
      reports: [],
      error: 'Missing required argument: specify --scenario <id> or --all.',
    };
  }

  const allValid = reports.length > 0 && reports.every((r) => r.valid);
  return {
    success: allValid,
    reports,
  };
}

export interface ParsedCliArgs {
  scenarioId?: string;
  all?: boolean;
  replication?: number;
  help?: boolean;
}

/**
 * Parses command-line arguments for preflight CLI.
 */
export function parseArgs(args: string[]): ParsedCliArgs {
  let scenarioId: string | undefined;
  let all = false;
  let replication = 1;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      all = true;
    } else if (arg === '--scenario' || arg === '-s') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        throw new Error('Missing value for --scenario');
      }
      scenarioId = args[++i];
    } else if (arg.startsWith('--scenario=')) {
      scenarioId = arg.split('=')[1];
    } else if (arg === '--replication' || arg === '-r') {
      if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
        throw new Error('Missing value for --replication');
      }
      replication = Number.parseInt(args[++i], 10);
    } else if (arg.startsWith('--replication=')) {
      replication = Number.parseInt(arg.split('=')[1], 10);
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { scenarioId, all, replication, help };
}

/**
 * CLI runner for benchmark preflight.
 */
export async function main(): Promise<void> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(`[PREFLIGHT ERROR] ${(err as Error).message}`);
    process.exit(1);
  }

  const { scenarioId, all, replication } = parsed;

  if (parsed.help) {
    console.log(`
Orchestrate Benchmark Preflight CLI
====================================
Validates trial specifications, control fingerprints, arm isolation, and snapshot
commit integrity WITHOUT running model inference or creating execution workspaces.

Usage:
  node --experimental-strip-types scripts/benchmark-preflight.ts --scenario <scenario-id> [--replication <N>]
  node --experimental-strip-types scripts/benchmark-preflight.ts --all

Available Scenarios:
  auth-protected-api (alias: sc-auth-api)
  auth-password-reset (alias: sc-pass-reset)
  data-model-feature  (alias: sc-data-model)
  profile-validation  (alias: sc-profile-val)
`);
    process.exit(0);
  }

  if (!scenarioId && !all) {
    console.error('[PREFLIGHT ERROR] Missing required argument: specify --scenario <id> or --all.');
    console.error('Run with --help for usage information.');
    process.exit(1);
  }

  console.log('===============================================================');
  console.log(' Orchestrate Benchmark Preflight Validation');
  console.log(' Model Inference: DISABLED | Workspace Creation: DISABLED');
  console.log('===============================================================\n');

  try {
    const summary = await runPreflight({ scenarioId, all, replication });

    for (const report of summary.reports) {
      console.log(`--- Scenario: ${report.scenarioId} (Replication ${report.replication}) ---`);
      console.log(`  Trial Run ID:         ${report.runId}`);
      console.log(`  Snapshot Commit SHA:  ${report.snapshotCommitSha}`);
      console.log(`  Control Fingerprint:  ${report.controlFingerprint}`);
      console.log(`  Treatment A (Base):   ${report.armATreatmentFingerprint}`);
      console.log(`  Treatment B (Handoff): ${report.armBTreatmentFingerprint}`);
      console.log(`  Treatment C (Orch):   ${report.armCTreatmentFingerprint}`);
      console.log(`  Integrity Status:     ${report.valid ? 'PASSED (Clean)' : 'FAILED'}`);

      if (report.violations) {
        console.error('  Violations:');
        for (const v of report.violations) {
          console.error(`    - [${v.code}] ${v.message}`);
        }
      }
      console.log('');
    }

    if (summary.success) {
      console.log('===============================================================');
      console.log(' [PREFLIGHT NOTICE] Preflight validation SUCCESSFUL.');
      console.log(' This confirms trial controls, snapshot integrity, and arm isolation.');
      console.log(' This is a static preflight validation only; no model inference');
      console.log(' or benchmark trial execution occurred.');
      console.log('===============================================================');
      process.exit(0);
    } else {
      console.error('[PREFLIGHT ERROR] Preflight validation failed for one or more scenarios.');
      process.exit(1);
    }
  } catch (err: unknown) {
    console.error('[PREFLIGHT FATAL ERROR]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Boolean(process.argv?.[1]) &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  main().catch((err) => {
    console.error('[PREFLIGHT FATAL]', err);
    process.exit(1);
  });
}
