import { describe, it, expect, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SCENARIO_CATALOG,
  getScenarioDefinition,
  ensureCanonicalScenarioRepo,
  SnapshotLoader,
  validateSnapshotRecord,
  validateManifest,
  LocalWorkspaceFactory,
  type BenchmarkWorkspace,
} from '../../src/index.js';
import { LocalCommandExecutor, LocalGitRepository } from '@orchestrate/workspace';

describe('Scenario Fixtures & Canonical Repositories', () => {
  const scenarioIds = [
    'auth-protected-api',
    'auth-password-reset',
    'data-model-feature',
    'profile-validation',
  ] as const;
  const workspacesToClean: BenchmarkWorkspace[] = [];

  afterEach(async () => {
    while (workspacesToClean.length > 0) {
      const ws = workspacesToClean.pop();
      if (ws) {
        await ws.cleanup();
      }
    }
  });

  describe('Scenario Definitions Catalog', () => {
    it('contains all three benchmark scenarios', () => {
      expect(Object.keys(SCENARIO_CATALOG).sort()).toEqual([...scenarioIds].sort());
    });

    it('returns definition for valid scenario ID', () => {
      for (const id of scenarioIds) {
        const def = getScenarioDefinition(id);
        expect(def.scenarioId).toBe(id);
        expect(def.taskAId).toBeTruthy();
        expect(def.taskBId).toBeTruthy();
        expect(def.taskBPrompt.length).toBeGreaterThan(10);
        expect(def.baseFiles.length).toBeGreaterThan(0);
        expect(def.verificationChecksTaskA.length).toBeGreaterThan(0);
        expect(def.verificationChecksTaskB.length).toBeGreaterThan(0);
        expect(def.evaluatorFilesTaskB?.length).toBeGreaterThan(0);
        expect(def.manifest.files.length).toBeGreaterThan(0);
        expect(() => validateManifest(def.manifest)).not.toThrow();
      }
    });

    it('throws error for unknown scenario ID', () => {
      expect(() => getScenarioDefinition('non-existent-scenario')).toThrow(
        /Unknown benchmark scenario "non-existent-scenario"/
      );
    });
  });

  describe('Materialization, Snapshot Integrity, and Workspace Execution', () => {
    for (const scenarioId of scenarioIds) {
      describe(`Scenario: ${scenarioId}`, () => {
        it('materializes canonical repository and resolves snapshot commit matching catalog SHA', async () => {
          const scenario = getScenarioDefinition(scenarioId);
          const materialized = await ensureCanonicalScenarioRepo(scenarioId);

          expect(materialized.scenarioId).toBe(scenarioId);
          expect(materialized.snapshotCommitSha).toBe(scenario.canonicalSnapshotCommitSha);
          expect(materialized.baseCommitSha).toBe(scenario.baseCommitSha);

          // Resolve snapshot via SnapshotLoader
          const executor = new LocalCommandExecutor({ workspaceRoot: materialized.repoPath });
          const gitRepo = new LocalGitRepository(executor);
          const loader = new SnapshotLoader({ repo: gitRepo, executor });

          const resolution = await loader.resolveSnapshot(materialized.snapshotCommitSha);
          expect(resolution.resolvable).toBe(true);
          expect(resolution.commitSha).toBe(scenario.canonicalSnapshotCommitSha);
        });

        it('has valid .orchestrate/manifest.json and .orchestrate/snapshot.json', async () => {
          const scenario = getScenarioDefinition(scenarioId);
          const materialized = await ensureCanonicalScenarioRepo(scenarioId);

          const manifestPath = join(materialized.repoPath, '.orchestrate', 'manifest.json');
          const manifestRaw = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(manifestRaw);
          expect(() => validateManifest(manifest)).not.toThrow();
          expect(manifest.files.length).toBeGreaterThan(0);

          const snapshotPath = join(materialized.repoPath, '.orchestrate', 'snapshot.json');
          const snapshotRaw = await readFile(snapshotPath, 'utf8');
          const snapshot = JSON.parse(snapshotRaw);
          expect(() => validateSnapshotRecord(snapshot)).not.toThrow();
          expect(snapshot.commitSha).toBe(scenario.canonicalSnapshotCommitSha);
          expect(snapshot.baseCommitSha).toBe(scenario.baseCommitSha);
          expect(snapshot.scenarioId).toBe(scenarioId);
        });

        it('reconstructs .orchestrate/snapshot.json if missing on disk without untracked state', async () => {
          const scenario = getScenarioDefinition(scenarioId);
          const materialized = await ensureCanonicalScenarioRepo(scenarioId);
          const snapshotPath = join(materialized.repoPath, '.orchestrate', 'snapshot.json');

          // Delete snapshot.json to simulate fresh state without untracked files
          const { rm } = await import('node:fs/promises');
          await rm(snapshotPath, { force: true });

          const rematerialized = await ensureCanonicalScenarioRepo(scenarioId);
          expect(rematerialized.snapshotCommitSha).toBe(scenario.canonicalSnapshotCommitSha);
          expect(rematerialized.baseCommitSha).toBe(scenario.baseCommitSha);
          expect(rematerialized.snapshotRecord.commitSha).toBe(scenario.canonicalSnapshotCommitSha);
          expect(rematerialized.snapshotRecord.baseCommitSha).toBe(scenario.baseCommitSha);
        });

        it('clones into isolated arm workspace and passes Task A verification checks', async () => {
          const materialized = await ensureCanonicalScenarioRepo(scenarioId);
          const scenario = getScenarioDefinition(scenarioId);

          const factory = new LocalWorkspaceFactory({
            sourceRepoPath: materialized.repoPath,
          });

          const armWorkspace = await factory.create(materialized.snapshotCommitSha);
          workspacesToClean.push(armWorkspace);

          // Verify HEAD commit matches snapshot SHA
          const headCommit = await armWorkspace.git.getHeadCommit();
          expect(headCommit.hash).toBe(materialized.snapshotCommitSha);

          // Verify workspace is clean
          const status = await armWorkspace.git.getStatus();
          expect(status.clean).toBe(true);

          // Execute each Task A verification check in the isolated workspace
          const armExecutor = new LocalCommandExecutor({ workspaceRoot: armWorkspace.path });
          for (const check of scenario.verificationChecksTaskA) {
            const result = await armExecutor.execute(
              check.command,
              check.args ?? [],
              { timeoutMs: 30000 }
            );
            expect(result.exitCode).toBe(0);
          }
        });
      });
    }
  });
});
