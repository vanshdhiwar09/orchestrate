import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { SCENARIO_CATALOG } from './catalog.js';
import type { MaterializedScenario, ScenarioDefinition } from './types.js';
import type { TaskASnapshotRecord } from '../harness/types.js';
import { LocalGitRepository, LocalCommandExecutor } from '@orchestrate/workspace';

const execFileAsync = promisify(execFile);

const FIXED_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Agent A',
  GIT_AUTHOR_EMAIL: 'agent-a@orchestrate.local',
  GIT_AUTHOR_DATE: '2026-10-01T14:00:00Z',
  GIT_COMMITTER_NAME: 'Orchestrate Harness',
  GIT_COMMITTER_EMAIL: 'harness@orchestrate.local',
  GIT_COMMITTER_DATE: '2026-10-01T14:00:00Z',
};

const BASE_GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Orchestrate Initializer',
  GIT_AUTHOR_EMAIL: 'init@orchestrate.local',
  GIT_AUTHOR_DATE: '2026-10-01T12:00:00Z',
  GIT_COMMITTER_NAME: 'Orchestrate Harness',
  GIT_COMMITTER_EMAIL: 'harness@orchestrate.local',
  GIT_COMMITTER_DATE: '2026-10-01T12:00:00Z',
};

async function runGit(args: string[], cwd: string, env = FIXED_GIT_ENV): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env, shell: false });
  return stdout.toString().trim();
}

/**
 * Resolves a scenario definition by exact scenarioId or standard alias.
 */
export function getScenarioDefinition(scenarioIdOrAlias: string): ScenarioDefinition {
  const normalized = scenarioIdOrAlias.trim().toLowerCase();
  for (const def of Object.values(SCENARIO_CATALOG)) {
    if (
      def.scenarioId.toLowerCase() === normalized ||
      def.alias?.toLowerCase() === normalized
    ) {
      return def;
    }
  }
  const available = Object.keys(SCENARIO_CATALOG).join(', ');
  throw new Error(
    `Unknown benchmark scenario "${scenarioIdOrAlias}". Available scenarios: ${available}`
  );
}

/**
 * Returns canonical repository path for a scenario inside the project's benchmarks directory.
 */
export function getCanonicalScenarioRepoDir(scenarioId: string, customRoot?: string): string {
  const root = customRoot ?? resolve(process.cwd(), 'benchmarks');
  return join(root, scenarioId);
}

/**
 * Materializes a concrete, self-contained Git repository for a scenario at targetDir.
 * Deterministic commits ensure the resulting Task-A snapshot commit SHA is reproducible.
 */
export async function materializeScenarioRepo(
  scenario: ScenarioDefinition,
  targetDir: string
): Promise<MaterializedScenario> {
  const resolvedDir = resolve(targetDir);
  await mkdir(resolvedDir, { recursive: true });

  // 1. Initialize git repository
  await runGit(['init'], resolvedDir, BASE_GIT_ENV);
  await runGit(['config', 'user.name', 'Orchestrate Initializer'], resolvedDir, BASE_GIT_ENV);
  await runGit(['config', 'user.email', 'init@orchestrate.local'], resolvedDir, BASE_GIT_ENV);
  await runGit(['config', 'core.autocrlf', 'false'], resolvedDir, BASE_GIT_ENV);

  const gitInfoDir = join(resolvedDir, '.git', 'info');
  await mkdir(gitInfoDir, { recursive: true });
  await appendFile(join(gitInfoDir, 'exclude'), '\n.orchestrate/snapshot.json\n', 'utf-8');

  // 2. Write Base commit files
  for (const file of scenario.baseFiles) {
    const filePath = join(resolvedDir, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, 'utf-8');
  }

  await runGit(['add', '.'], resolvedDir, BASE_GIT_ENV);
  await runGit(['commit', '-m', scenario.baseCommitMessage], resolvedDir, BASE_GIT_ENV);
  const baseCommitSha = await runGit(['rev-parse', 'HEAD'], resolvedDir, BASE_GIT_ENV);

  if (baseCommitSha !== scenario.baseCommitSha) {
    throw new Error(
      `materializeScenarioRepo: Base commit SHA mismatch for "${scenario.scenarioId}". Expected "${scenario.baseCommitSha}", got "${baseCommitSha}".`
    );
  }

  // 3. Write Task A files
  for (const file of scenario.taskAFiles) {
    const filePath = join(resolvedDir, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, 'utf-8');
  }

  // Write .orchestrate/manifest.json
  const manifestDir = join(resolvedDir, '.orchestrate');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, 'manifest.json'),
    JSON.stringify(scenario.manifest, null, 2) + '\n',
    'utf-8'
  );

  await runGit(['add', '.'], resolvedDir, FIXED_GIT_ENV);
  await runGit(['commit', '-m', scenario.taskACommitMessage], resolvedDir, FIXED_GIT_ENV);
  const snapshotCommitSha = await runGit(['rev-parse', 'HEAD'], resolvedDir, FIXED_GIT_ENV);

  if (snapshotCommitSha !== scenario.canonicalSnapshotCommitSha) {
    throw new Error(
      `materializeScenarioRepo: Snapshot commit SHA mismatch for "${scenario.scenarioId}". Expected "${scenario.canonicalSnapshotCommitSha}", got "${snapshotCommitSha}".`
    );
  }

  // 4. Write .orchestrate/snapshot.json pointing to this exact canonical snapshotCommitSha
  const pkgContent = scenario.baseFiles.find((f) => f.path === 'package.json')?.content ?? '{}';
  const depHash = createHash('sha256').update(pkgContent).digest('hex');

  const finalSnapshotRecord: TaskASnapshotRecord = {
    snapshotId: `snap-${scenario.scenarioId}-r1`,
    commitSha: snapshotCommitSha,
    scenarioId: scenario.scenarioId,
    taskAId: scenario.taskAId,
    agentARunId: `agent-run-${scenario.scenarioId}-r1`,
    baseCommitSha,
    dependencyStateSha256: depHash,
    environmentFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
    createdAt: '2026-10-01T14:00:00.000Z',
  };

  await writeFile(
    join(manifestDir, 'snapshot.json'),
    JSON.stringify(finalSnapshotRecord, null, 2) + '\n',
    'utf-8'
  );

  // Ensure working tree is clean
  const statusOut = await runGit(['status', '--porcelain'], resolvedDir, FIXED_GIT_ENV);
  if (statusOut.trim() !== '') {
    throw new Error(`Scenario repository at "${resolvedDir}" is not clean after commit: ${statusOut}`);
  }

  return {
    scenarioId: scenario.scenarioId,
    repoPath: resolvedDir,
    baseCommitSha,
    snapshotCommitSha,
    snapshotRecord: Object.freeze(finalSnapshotRecord),
    manifest: Object.freeze(scenario.manifest),
  };
}

/**
 * Ensures the canonical scenario repository exists on disk and is ready for benchmark evaluation.
 */
export async function ensureCanonicalScenarioRepo(
  scenarioIdOrAlias: string,
  customRoot?: string
): Promise<MaterializedScenario> {
  const scenario = getScenarioDefinition(scenarioIdOrAlias);
  const repoDir = getCanonicalScenarioRepoDir(scenario.scenarioId, customRoot);

  if (existsSync(join(repoDir, '.git'))) {
    try {
      const executor = new LocalCommandExecutor({ workspaceRoot: repoDir });
      const repo = new LocalGitRepository(executor);
      const isRepo = await repo.isRepository();
      if (isRepo) {
        const head = await repo.getHeadCommit();
        if (head && head.hash === scenario.canonicalSnapshotCommitSha) {
          const snapshotJsonPath = join(repoDir, '.orchestrate', 'snapshot.json');
          let record: TaskASnapshotRecord;
          if (existsSync(snapshotJsonPath)) {
            const raw = await readFile(snapshotJsonPath, 'utf-8');
            record = JSON.parse(raw) as TaskASnapshotRecord;
          } else {
            const depContent = scenario.baseFiles.find((f) => f.path === 'package.json')?.content ?? '{}';
            const depHash = createHash('sha256').update(depContent).digest('hex');
            record = {
              snapshotId: `snap-${scenario.scenarioId}-r1`,
              commitSha: scenario.canonicalSnapshotCommitSha,
              scenarioId: scenario.scenarioId,
              taskAId: scenario.taskAId,
              agentARunId: `agent-run-${scenario.scenarioId}-r1`,
              baseCommitSha: scenario.baseCommitSha,
              dependencyStateSha256: depHash,
              environmentFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
              createdAt: '2026-10-01T14:00:00.000Z',
            };
            const manifestDir = join(repoDir, '.orchestrate');
            await mkdir(manifestDir, { recursive: true });
            await writeFile(snapshotJsonPath, JSON.stringify(record, null, 2) + '\n', 'utf-8');
          }

          return {
            scenarioId: scenario.scenarioId,
            repoPath: repoDir,
            baseCommitSha: scenario.baseCommitSha,
            snapshotCommitSha: scenario.canonicalSnapshotCommitSha,
            snapshotRecord: Object.freeze(record),
            manifest: Object.freeze(scenario.manifest),
          };
        }
      }
    } catch {
      // Re-materialize if corrupt or non-repo
    }
  }

  return materializeScenarioRepo(scenario, repoDir);
}
