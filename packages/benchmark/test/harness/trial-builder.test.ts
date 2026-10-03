import { describe, it, expect } from 'vitest';
import {
  deriveDefaultArmOrderSeed,
  generateArmOrder,
  validateTrialIdentity,
  buildTrial,
} from '../../src/harness/trial-builder.js';
import type { HarnessExecutionControls, TrialIdentity } from '../../src/harness/types.js';

describe('TrialBuilder', () => {
  const dummyControls: HarnessExecutionControls = {
    modelId: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
    temperature: 0.2,
    baseSystemInstructions: 'You are a senior software engineer.',
    toolDefinitions: [],
    toolPermissions: ['file_read'],
    taskTimeoutMs: 600000,
    maxSteps: 30,
    commandTimeoutMs: 30000,
    sanitizedEnv: { PATH: '/usr/bin' },
    harnessVersion: '1.0.0',
  };

  const validIdentity: TrialIdentity = {
    runId: 'trial-run-123',
    scenarioId: 'auth-protected-api',
    replication: 1,
    taskAId: 'task-a-impl',
    taskBId: 'task-b-impl',
    snapshotId: 'snap-456',
    snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
  };

  const validPrompt = 'Implement the protected authentication endpoint according to requirements.';
  const envFingerprint = 'node:22.0.0|npm:10.0.0|os:win32';

  describe('deriveDefaultArmOrderSeed', () => {
    it('is deterministic for same scenarioId and replication', () => {
      const seed1 = deriveDefaultArmOrderSeed('auth-protected-api', 1);
      const seed2 = deriveDefaultArmOrderSeed('auth-protected-api', 1);
      expect(seed1).toBe(seed2);
      expect(typeof seed1).toBe('number');
    });

    it('differs across replications and scenarios', () => {
      const seed1 = deriveDefaultArmOrderSeed('auth-protected-api', 1);
      const seed2 = deriveDefaultArmOrderSeed('auth-protected-api', 2);
      const seed3 = deriveDefaultArmOrderSeed('auth-password-reset', 1);
      expect(seed1).not.toBe(seed2);
      expect(seed1).not.toBe(seed3);
    });
  });

  describe('generateArmOrder', () => {
    it('produces an order containing exactly the 3 canonical arms', () => {
      const order = generateArmOrder(12345);
      expect(order).toHaveLength(3);
      expect(order).toContain('ARM_A_BASELINE');
      expect(order).toContain('ARM_B_UNVERIFIED_HANDOFF');
      expect(order).toContain('ARM_C_ORCHESTRATE');
    });

    it('is strictly deterministic for a fixed seed', () => {
      const order1 = generateArmOrder(999);
      const order2 = generateArmOrder(999);
      expect(order1).toEqual(order2);
    });

    it('supports replaying with recorded seed', () => {
      const recordedSeed = 882194;
      const original = generateArmOrder(recordedSeed);
      const replay = generateArmOrder(recordedSeed);
      expect(replay).toEqual(original);
    });
  });

  describe('validateTrialIdentity', () => {
    it('passes a valid trial identity', () => {
      expect(() => validateTrialIdentity(validIdentity)).not.toThrow();
    });

    it('rejects invalid commit SHA', () => {
      expect(() =>
        validateTrialIdentity({
          ...validIdentity,
          snapshotCommitSha: 'short-sha',
        })
      ).toThrow('snapshotCommitSha must be an exact 40-character hexadecimal string');
    });

    it('rejects replication < 1 or non-integer', () => {
      expect(() =>
        validateTrialIdentity({
          ...validIdentity,
          replication: 0,
        })
      ).toThrow('replication must be a positive integer >= 1');

      expect(() =>
        validateTrialIdentity({
          ...validIdentity,
          replication: 1.5,
        })
      ).toThrow('replication must be a positive integer >= 1');
    });

    it('rejects missing fields', () => {
      expect(() =>
        validateTrialIdentity({
          ...validIdentity,
          runId: '',
        })
      ).toThrow('runId must be a non-empty string');
    });
  });

  describe('buildTrial', () => {
    it('builds an immutable TrialRecord in CREATED state', () => {
      const trial = buildTrial({
        identity: validIdentity,
        taskBPrompt: validPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
      });

      expect(trial.state).toBe('CREATED');
      expect(trial.identity.runId).toBe('trial-run-123');
      expect(trial.executionOrder).toHaveLength(3);
      expect(trial.controlFingerprint).toBeDefined();
      expect(trial.controlFingerprint.snapshotCommitSha).toBe(validIdentity.snapshotCommitSha);

      // Verify immutability
      expect(Object.isFrozen(trial)).toBe(true);
      expect(Object.isFrozen(trial.identity)).toBe(true);
      expect(Object.isFrozen(trial.controls)).toBe(true);
    });

    it('uses provided armOrderSeed when specified', () => {
      const customSeed = 777;
      const trial = buildTrial({
        identity: validIdentity,
        taskBPrompt: validPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
        armOrderSeed: customSeed,
      });

      expect(trial.armOrderSeed).toBe(customSeed);
      expect(trial.executionOrder).toEqual(generateArmOrder(customSeed));
    });
  });
});
