import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { runBenchmarkSession, type BenchmarkBudgetPolicy } from '../packages/benchmark/dist/index.js';
import { NebiusModelClient } from '@orchestrate/model';

export interface BenchmarkRunnerCliArgs {
  scenarios: string[];
  replications: number;
  maxTotalTokens: number;
  maxTokensPerArm?: number;
  budgetPolicy: BenchmarkBudgetPolicy;
  outputDir: string;
  modelId?: string;
  customBenchmarksDir?: string;
}

export function parseCliArgs(args: string[]): BenchmarkRunnerCliArgs {
  let scenarios: string[] = [];
  let replications = 1;
  let maxTotalTokens = 0;
  let maxTokensPerArm: number | undefined;
  let budgetPolicy: BenchmarkBudgetPolicy = 'ADAPTIVE_SESSION_BUDGET';
  let explicitPolicySpecified = false;
  let outputDir = '';
  let modelId: string | undefined;
  let customBenchmarksDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(`
Orchestrate Benchmark Evaluation Runner

Usage:
  node --experimental-strip-types scripts/benchmark-runner.ts [options]

Required Options:
  --scenarios <ids>       Comma-separated scenario IDs or aliases (e.g. auth-protected-api)
  --max-tokens <number>   Hard aggregate token budget across entire run (e.g. 50000)
  --output <dir>          Directory to persist results and reports (e.g. benchmark-results)

Optional Options:
  --policy <policy>       Budget policy: adaptive (default) or controlled
  --max-arm-tokens <num>  Maximum token ceiling per individual arm execution
  --model <id>            Model identifier (default: nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B)
  --replications <n>      Number of replications per scenario (default: 1)
  --custom-dir <path>     Custom fixtures directory
  --help, -h              Show this help message
`);
      process.exit(0);
    } else if (arg === '--scenarios' || arg === '--scenario') {
      const val = args[++i];
      if (val) {
        scenarios = val.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else if (arg === '--replications') {
      replications = parseInt(args[++i], 10) || 1;
    } else if (arg === '--max-tokens') {
      maxTotalTokens = parseInt(args[++i], 10) || 0;
    } else if (arg === '--max-arm-tokens') {
      maxTokensPerArm = parseInt(args[++i], 10) || undefined;
    } else if (arg === '--policy') {
      const val = args[++i]?.toLowerCase();
      if (val === 'controlled') {
        budgetPolicy = 'CONTROLLED_PER_ARM_BUDGET';
        explicitPolicySpecified = true;
      } else if (val === 'adaptive') {
        budgetPolicy = 'ADAPTIVE_SESSION_BUDGET';
        explicitPolicySpecified = true;
      } else {
        throw new Error(`Invalid --policy: "${val}". Expected "adaptive" or "controlled".`);
      }
    } else if (arg === '--output') {
      outputDir = args[++i] ?? '';
    } else if (arg === '--model') {
      modelId = args[++i];
    } else if (arg === '--custom-dir') {
      customBenchmarksDir = args[++i];
    } else {
      throw new Error(`Unknown option: "${arg}". Use --help to list supported options.`);
    }
  }

  if (scenarios.length === 0) {
    throw new Error('Missing required option: --scenarios <ids>');
  }

  if (maxTotalTokens <= 0 || !Number.isFinite(maxTotalTokens)) {
    throw new Error(
      'Missing or invalid required option: --max-tokens <positive-number>. Unbounded execution is prohibited.'
    );
  }

  if (!outputDir) {
    throw new Error('Missing required option: --output <dir>');
  }

  if (maxTokensPerArm !== undefined && !explicitPolicySpecified) {
    budgetPolicy = 'CONTROLLED_PER_ARM_BUDGET';
  }

  return {
    scenarios,
    replications,
    maxTotalTokens,
    maxTokensPerArm,
    budgetPolicy,
    outputDir,
    modelId,
    customBenchmarksDir,
  };
}

async function main() {
  try {
    process.loadEnvFile?.();
  } catch {
    // Ignore if .env is missing or already loaded
  }

  const cliArgs = parseCliArgs(process.argv.slice(2));

  // Check output collision upfront to preserve prior benchmark artifacts
  const resolvedOut = resolve(cliArgs.outputDir.trim());
  const existingSummary = join(resolvedOut, 'benchmark-summary.json');
  const existingReport = join(resolvedOut, 'benchmark-report.md');
  if (existsSync(existingSummary) || existsSync(existingReport)) {
    console.error(`[BENCHMARK ERROR] Output destination "${cliArgs.outputDir}" already contains prior benchmark artifacts.`);
    console.error('Specify a fresh, unique output directory to preserve historical evidence immutability.');
    process.exit(1);
  }

  // In live production execution, Nebius Token Factory is required
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    console.error('[BENCHMARK ERROR] Missing NEBIUS_API_KEY environment variable.');
    console.error('Nebius is the required model provider for live benchmark execution.');
    process.exit(1);
  }

  const modelClient = new NebiusModelClient({ apiKey: apiKey.trim() });

  const totalPlannedArms = cliArgs.scenarios.length * cliArgs.replications * 3;
  const effectiveArmCap =
    cliArgs.maxTokensPerArm ?? Math.floor(cliArgs.maxTotalTokens / totalPlannedArms);

  console.log('===============================================================');
  console.log(' Orchestrate Benchmark Evaluation Session');
  console.log(` Scenarios:          ${cliArgs.scenarios.join(', ')}`);
  console.log(` Replications:       ${cliArgs.replications}`);
  console.log(` Model ID:           ${cliArgs.modelId || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B (default)'}`);
  console.log(` Budget Policy:      ${cliArgs.budgetPolicy}`);
  console.log(` Token Budget Cap:   ${cliArgs.maxTotalTokens}`);
  if (cliArgs.budgetPolicy === 'CONTROLLED_PER_ARM_BUDGET') {
    console.log(` Per-Arm Cap:        ${effectiveArmCap}${cliArgs.maxTokensPerArm ? ' (custom)' : ' (auto-allocated)'}`);
  } else {
    console.log(` Per-Arm Cap:        Shared pool (${cliArgs.maxTokensPerArm ? `soft ceiling ${cliArgs.maxTokensPerArm}` : 'no fixed per-arm ceiling'})`);
  }
  console.log(` Output Directory:   ${cliArgs.outputDir}`);
  console.log('===============================================================\n');

  const sessionResult = await runBenchmarkSession({
    scenarios: cliArgs.scenarios,
    replications: cliArgs.replications,
    maxTotalTokens: cliArgs.maxTotalTokens,
    maxTokensPerArm: cliArgs.maxTokensPerArm,
    budgetPolicy: cliArgs.budgetPolicy,
    outputDir: cliArgs.outputDir,
    modelClient,
    customBenchmarksDir: cliArgs.customBenchmarksDir,
    controls: cliArgs.modelId ? { modelId: cliArgs.modelId } : undefined,
  });

  console.log(sessionResult.markdownReport);
  console.log('===============================================================');
  console.log(` Benchmark evaluation complete. Results saved to: ${cliArgs.outputDir}`);
  console.log('===============================================================');
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Boolean(process.argv?.[1]) &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  main().catch((err) => {
    console.error('[BENCHMARK FATAL ERROR]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
