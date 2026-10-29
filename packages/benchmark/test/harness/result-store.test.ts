import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  TrialResultStore,
  FileCollisionError,
} from '../../src/harness/result-store.js';
import type { TrialRunResult } from '../../src/harness/trial-runner.js';

describe('TrialResultStore', () => {
  let tmpDir: string;
  let store: TrialResultStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'orchestrate-result-store-test-'));
    store = new TrialResultStore({ storageDir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const dummyResult: TrialRunResult = {
    valid: true,
    trial: {
      identity: {
        runId: 'trial-store-test-1',
        scenarioId: 'auth-protected-api',
        replication: 1,
        taskAId: 'task-a',
        taskBId: 'task-b',
        snapshotId: 'snap-1',
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
      },
      controls: {} as any,
      controlFingerprint: {} as any,
      state: 'COMPLETE',
      armOrderSeed: 12345,
      executionOrder: ['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE'],
    },
    integrityPreflight: { valid: true, violations: [] },
    armResults: {
      ARM_A_BASELINE: {
        armId: 'ARM_A_BASELINE',
        status: 'COMPLETED',
        rawEvidence: null,
        verificationEvidence: null,
        diffCapture: null,
        discoveryReport: null,
        reworkReport: null,
      },
    },
  };

  it('persists a complete trial result cleanly with atomic write', async () => {
    const savedPath = await store.saveTrialResult(dummyResult);
    expect(existsSync(savedPath)).toBe(true);

    const loaded = await store.loadTrialResult('trial-store-test-1');
    expect(loaded.complete).toBe(true);
    expect(loaded.interrupted).toBe(false);
    expect(loaded.runId).toBe('trial-store-test-1');
    expect(loaded.result.valid).toBe(true);
    expect(loaded.result.trial.identity.runId).toBe('trial-store-test-1');
  });

  it('rejects silent overwrites and throws FileCollisionError when file exists', async () => {
    await store.saveTrialResult(dummyResult);

    await expect(store.saveTrialResult(dummyResult)).rejects.toThrow(
      FileCollisionError
    );
  });

  it('allows overwrite only when explicitly requested', async () => {
    await store.saveTrialResult(dummyResult);

    const updated = {
      ...dummyResult,
      trial: {
        ...dummyResult.trial,
        state: 'INVALID' as const,
      },
      valid: false,
      invalidationReason: 'Rerun invalidation',
    };

    const savedPath = await store.saveTrialResult(updated, { overwrite: true });
    expect(existsSync(savedPath)).toBe(true);

    const loaded = await store.loadTrialResult(savedPath);
    expect(loaded.complete).toBe(false);
    expect(loaded.result.valid).toBe(false);
  });

  it('explicitly marks interrupted and incomplete evidence', async () => {
    const interruptedResult: TrialRunResult = {
      valid: false,
      trial: {
        ...dummyResult.trial,
        identity: {
          ...dummyResult.trial.identity,
          runId: 'trial-interrupted-run',
        },
        state: 'INVALID',
      },
      integrityPreflight: { valid: true, violations: [] },
      armResults: {},
      invalidationReason: 'Interrupted by SIGINT',
    };

    const savedPath = await store.saveTrialResult(interruptedResult, { interrupted: true });
    const loaded = await store.loadTrialResult(savedPath);

    expect(loaded.complete).toBe(false);
    expect(loaded.interrupted).toBe(true);
    expect(loaded.result.invalidationReason).toBe('Interrupted by SIGINT');
  });
});
