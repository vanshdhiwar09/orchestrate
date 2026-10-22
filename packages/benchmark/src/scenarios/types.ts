import type { ArtifactManifest } from '../manifest/types.js';
import type { TaskASnapshotRecord } from '../harness/types.js';
import type { VerificationCheck } from '@orchestrate/verification';

export interface ScenarioFileContent {
  path: string;
  content: string;
}

export interface ScenarioDefinition {
  scenarioId: string;
  alias?: string;
  title: string;
  description: string;
  taskAId: string;
  taskBId: string;
  baseCommitMessage: string;
  taskACommitMessage: string;
  baseCommitSha: string;
  canonicalSnapshotCommitSha: string;
  baseFiles: ScenarioFileContent[];
  taskAFiles: ScenarioFileContent[];
  manifest: ArtifactManifest;
  taskBPrompt: string;
  armBUnverifiedHandoff: string;
  armCCompiledContext: string;
  verificationChecksTaskA: VerificationCheck[];
  verificationChecksTaskB: VerificationCheck[];
  evaluatorFilesTaskB?: ScenarioFileContent[];
}

export interface MaterializedScenario {
  scenarioId: string;
  repoPath: string;
  baseCommitSha: string;
  snapshotCommitSha: string;
  snapshotRecord: TaskASnapshotRecord;
  manifest: ArtifactManifest;
}
