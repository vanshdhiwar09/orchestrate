import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { TrialRunResult } from './trial-runner.js';

export class FileCollisionError extends Error {
  public readonly filePath: string;
  constructor(message: string, filePath: string) {
    super(message);
    this.name = 'FileCollisionError';
    this.filePath = filePath;
  }
}

export interface TrialResultStoreOptions {
  storageDir: string;
}

export interface SaveTrialResultOptions {
  overwrite?: boolean;
  interrupted?: boolean;
}

export interface PersistedTrialEnvelope {
  persistedAt: string;
  complete: boolean;
  interrupted: boolean;
  runId: string;
  scenarioId?: string;
  replication?: number;
  result: TrialRunResult;
}

/**
 * Durable persistence store for benchmark trial results and evidence.
 *
 * Invariants:
 * - Atomic write via temporary file rename to prevent partial/corrupted records.
 * - Exclusive creation ('wx' flag / collision check) preventing silent overwrites.
 * - Explicitly marks incomplete, failed, or interrupted runs so they cannot be
 *   confused with complete sealed evaluations.
 */
export class TrialResultStore {
  private readonly storageDir: string;

  constructor(options: TrialResultStoreOptions) {
    if (!options?.storageDir || typeof options.storageDir !== 'string' || !options.storageDir.trim()) {
      throw new Error('TrialResultStore: storageDir must be a non-empty string.');
    }
    this.storageDir = resolve(options.storageDir.trim());
  }

  get directory(): string {
    return this.storageDir;
  }

  /**
   * Resolves the target JSON file path for a trial run.
   */
  resolveFilePath(runId: string): string {
    if (!runId || typeof runId !== 'string' || !runId.trim()) {
      throw new Error('TrialResultStore: runId must be a non-empty string.');
    }
    const safeName = runId.trim().replace(/[^a-zA-Z0-9_.-]/g, '_');
    return join(this.storageDir, `${safeName}.json`);
  }

  /**
   * Persists a trial run result to disk with atomic, exclusive-write semantics.
   * If the file already exists and overwrite is not true, throws FileCollisionError.
   */
  async saveTrialResult(
    result: TrialRunResult,
    options?: SaveTrialResultOptions
  ): Promise<string> {
    if (!result || typeof result !== 'object') {
      throw new Error('TrialResultStore.saveTrialResult: result must be a valid TrialRunResult.');
    }

    const runId = result.trial?.identity?.runId;
    if (!runId) {
      throw new Error('TrialResultStore.saveTrialResult: result.trial.identity.runId is missing.');
    }

    await mkdir(this.storageDir, { recursive: true });
    const targetPath = this.resolveFilePath(runId);

    if (!options?.overwrite && existsSync(targetPath)) {
      throw new FileCollisionError(
        `Trial result already exists at "${targetPath}". Exclusive creation prevented silent overwrite.`,
        targetPath
      );
    }

    // Wrap with explicit persistence metadata
    const isComplete = result.valid && result.trial.state === 'COMPLETE';
    const isInterrupted =
      options?.interrupted ??
      (result.trial.state === 'INVALID' &&
        /interrupted/i.test(result.invalidationReason ?? ''));

    const persistentEnvelope: PersistedTrialEnvelope = {
      persistedAt: new Date().toISOString(),
      complete: isComplete,
      interrupted: isInterrupted,
      runId,
      scenarioId: result.trial?.identity?.scenarioId,
      replication: result.trial?.identity?.replication,
      result,
    };

    const content = JSON.stringify(persistentEnvelope, null, 2) + '\n';

    // Atomic write pattern:
    // 1. Write to an ephemeral temporary file in the target directory
    const tempPath = join(
      this.storageDir,
      `.tmp-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
    );

    try {
      await writeFile(tempPath, content, { flag: 'wx', encoding: 'utf-8' });

      // If overwrite not allowed, verify target does not exist right before atomic rename
      if (!options?.overwrite && existsSync(targetPath)) {
        await rm(tempPath, { force: true });
        throw new FileCollisionError(
          `Trial result already exists at "${targetPath}". Exclusive creation prevented silent overwrite.`,
          targetPath
        );
      }

      await rename(tempPath, targetPath);
      return targetPath;
    } catch (err: unknown) {
      // Clean up temporary file on failure
      try {
        if (existsSync(tempPath)) {
          await rm(tempPath, { force: true });
        }
      } catch {
        // ignore secondary cleanup errors
      }
      throw err;
    }
  }

  /**
   * Loads a persisted trial result from disk.
   */
  async loadTrialResult(runIdOrPath: string): Promise<PersistedTrialEnvelope> {
    const filePath = isAbsolute(runIdOrPath)
      ? runIdOrPath
      : existsSync(runIdOrPath)
        ? resolve(runIdOrPath)
        : this.resolveFilePath(runIdOrPath);

    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as PersistedTrialEnvelope;
  }
}
