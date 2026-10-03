import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  sha256,
  computeControlFingerprint,
  computeTreatmentFingerprint,
} from '../../src/harness/fingerprints.js';
import type { HarnessExecutionControls } from '../../src/harness/types.js';

describe('Harness Fingerprints', () => {
  const dummyControls: HarnessExecutionControls = {
    modelId: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
    temperature: 0.2,
    topP: 0.95,
    maxTokens: 4096,
    seed: 42,
    baseSystemInstructions: 'You are a senior software engineer.',
    toolDefinitions: [{ name: 'file_read', description: 'Read file contents' }],
    toolPermissions: ['file_read', 'file_write'],
    taskTimeoutMs: 600000,
    maxSteps: 30,
    commandTimeoutMs: 30000,
    sanitizedEnv: { PATH: '/usr/bin' },
    harnessVersion: '1.0.0',
  };

  const validSnapshotSha = '0123456789abcdef0123456789abcdef01234567';
  const validTaskBPrompt = 'Implement the protected authentication endpoint according to requirements.';
  const envFingerprint = 'node:22.0.0|npm:10.0.0|os:win32';

  describe('canonicalJson', () => {
    it('sorts object keys deterministically', () => {
      const obj1 = { z: 1, a: 2, m: { b: 3, a: 4 } };
      const obj2 = { a: 2, m: { a: 4, b: 3 }, z: 1 };
      expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
      expect(canonicalJson(obj1)).toBe('{"a":2,"m":{"a":4,"b":3},"z":1}');
    });

    it('handles arrays and primitives correctly', () => {
      expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
      expect(canonicalJson('hello')).toBe('"hello"');
      expect(canonicalJson(123)).toBe('123');
      expect(canonicalJson(true)).toBe('true');
      expect(canonicalJson(null)).toBe('null');
      expect(canonicalJson(undefined)).toBe('null');
    });
  });

  describe('sha256', () => {
    it('computes expected SHA-256 hash', () => {
      const hash = sha256('hello world');
      expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    });
  });

  describe('computeControlFingerprint', () => {
    it('computes deterministic control fingerprint', () => {
      const fp1 = computeControlFingerprint({
        snapshotCommitSha: validSnapshotSha,
        taskBPrompt: validTaskBPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
      });

      const fp2 = computeControlFingerprint({
        snapshotCommitSha: validSnapshotSha,
        taskBPrompt: validTaskBPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
      });

      expect(fp1).toEqual(fp2);
      expect(fp1.snapshotCommitSha).toBe(validSnapshotSha);
      expect(fp1.modelIdentity).toBe(dummyControls.modelId);
      expect(fp1.harnessVersion).toBe('1.0.0');
      expect(fp1.taskBPromptHash).toHaveLength(64);
    });

    it('rejects missing or empty snapshotCommitSha', () => {
      expect(() =>
        computeControlFingerprint({
          snapshotCommitSha: '',
          taskBPrompt: validTaskBPrompt,
          controls: dummyControls,
          environmentDependencyFingerprint: envFingerprint,
        })
      ).toThrow('snapshotCommitSha must be a non-empty string');
    });

    it('rejects missing or empty taskBPrompt', () => {
      expect(() =>
        computeControlFingerprint({
          snapshotCommitSha: validSnapshotSha,
          taskBPrompt: '   ',
          controls: dummyControls,
          environmentDependencyFingerprint: envFingerprint,
        })
      ).toThrow('taskBPrompt must be a non-empty string');
    });
  });

  describe('computeTreatmentFingerprint', () => {
    it('computes empty payload hash for ARM_A_BASELINE', () => {
      const fp = computeTreatmentFingerprint('ARM_A_BASELINE', null);
      expect(fp.armId).toBe('ARM_A_BASELINE');
      expect(fp.treatmentPayloadHash).toBe(sha256(''));
    });

    it('computes payload hash for ARM_B_UNVERIFIED_HANDOFF', () => {
      const payload = 'Task A created the login endpoint at /api/login';
      const fp = computeTreatmentFingerprint('ARM_B_UNVERIFIED_HANDOFF', payload);
      expect(fp.armId).toBe('ARM_B_UNVERIFIED_HANDOFF');
      expect(fp.treatmentPayloadHash).toBe(sha256(canonicalJson(payload.trim())));
    });

    it('computes payload hash for ARM_C_ORCHESTRATE', () => {
      const payload = 'Verified facts: Login handler exports POST at /api/login';
      const fp = computeTreatmentFingerprint('ARM_C_ORCHESTRATE', payload);
      expect(fp.armId).toBe('ARM_C_ORCHESTRATE');
      expect(fp.treatmentPayloadHash).toBe(sha256(canonicalJson(payload.trim())));
    });

    it('throws if ARM_B or ARM_C has empty payload', () => {
      expect(() => computeTreatmentFingerprint('ARM_B_UNVERIFIED_HANDOFF', '')).toThrow(
        'ARM_B_UNVERIFIED_HANDOFF requires a non-empty rawPayload'
      );
      expect(() => computeTreatmentFingerprint('ARM_C_ORCHESTRATE', '  ')).toThrow(
        'ARM_C_ORCHESTRATE requires a non-empty rawPayload'
      );
    });

    it('satisfies Core Experimental Invariant: Control equality and Treatment inequality', () => {
      // 1. Control fingerprints across arms A, B, C are identical
      const controlA = computeControlFingerprint({
        snapshotCommitSha: validSnapshotSha,
        taskBPrompt: validTaskBPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
      });
      const controlB = computeControlFingerprint({
        snapshotCommitSha: validSnapshotSha,
        taskBPrompt: validTaskBPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
      });
      const controlC = computeControlFingerprint({
        snapshotCommitSha: validSnapshotSha,
        taskBPrompt: validTaskBPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
      });

      expect(canonicalJson(controlA)).toBe(canonicalJson(controlB));
      expect(canonicalJson(controlB)).toBe(canonicalJson(controlC));

      // 2. Treatment fingerprints across arms A, B, C are strictly unequal
      const treatmentA = computeTreatmentFingerprint('ARM_A_BASELINE', null);
      const treatmentB = computeTreatmentFingerprint(
        'ARM_B_UNVERIFIED_HANDOFF',
        'Upstream unverified notes'
      );
      const treatmentC = computeTreatmentFingerprint(
        'ARM_C_ORCHESTRATE',
        'Verified Project Brain facts'
      );

      expect(treatmentA.treatmentPayloadHash).not.toBe(treatmentB.treatmentPayloadHash);
      expect(treatmentB.treatmentPayloadHash).not.toBe(treatmentC.treatmentPayloadHash);
      expect(treatmentA.treatmentPayloadHash).not.toBe(treatmentC.treatmentPayloadHash);
    });
  });
});
