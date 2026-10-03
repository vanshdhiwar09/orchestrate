import { describe, it, expect } from 'vitest';
import {
  computeEvidenceContentHash,
  computeVerificationEvidenceContentHash,
  sealEvidence,
  sealVerificationEvidence,
  verifyEvidenceSeal,
  verifyVerificationEvidenceSeal,
} from '../../src/harness/evidence-sealer.js';
import type {
  BenchmarkVerificationEvidence,
  RawExecutionEvidence,
} from '../../src/harness/types.js';

describe('EvidenceSealer', () => {
  const dummyEvidence: Omit<RawExecutionEvidence, 'evidenceContentHash'> = {
    trialId: 'trial-001',
    armId: 'ARM_A_BASELINE',
    snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
    workspacePath: '/tmp/orch-arm-123',
    modelIdentity: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
    startedAt: '2026-10-01T12:00:00.000Z',
    completedAt: '2026-10-01T12:01:00.000Z',
    durationMs: 60000,
    outcome: 'COMPLETED',
    modelEvents: [
      {
        sequence: 1,
        type: 'MODEL_CALL',
        model: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
        request: { messagesCount: 2, toolsCount: 3 },
        response: { id: 'resp-1', model: 'llama', finishReason: 'stop' },
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          estimated_cost_usd: 0,
          usage_available: true,
        },
        durationMs: 1200,
      },
    ],
    toolEvents: [],
    finalResponse: { content: 'Task completed successfully', finishReason: 'stop' },
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      estimated_cost_usd: 0,
      usage_available: true,
    },
  };

  it('computes deterministic SHA-256 content hash', () => {
    const hash1 = computeEvidenceContentHash(dummyEvidence);
    const hash2 = computeEvidenceContentHash(dummyEvidence);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('changes hash when evidence content changes', () => {
    const hash1 = computeEvidenceContentHash(dummyEvidence);
    const modified = {
      ...dummyEvidence,
      durationMs: 60001,
    };
    const hash2 = computeEvidenceContentHash(modified);

    expect(hash1).not.toBe(hash2);
  });

  it('redacts secrets before computing hash', () => {
    const withSecret: typeof dummyEvidence = {
      ...dummyEvidence,
      finalResponse: {
        content: 'Authorization: Bearer my-secret-api-key-12345',
        finishReason: 'stop',
      },
    };

    const sealed = sealEvidence(withSecret);
    expect(sealed.finalResponse?.content).not.toContain('my-secret-api-key-12345');
    expect(sealed.finalResponse?.content).toContain('[REDACTED]');

    // Verification check passes
    expect(verifyEvidenceSeal(sealed)).toBe(true);
  });

  it('seals evidence into an immutable record excluding hash from hashed content', () => {
    const sealed = sealEvidence(dummyEvidence);

    expect(sealed.evidenceContentHash).toBeDefined();
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(verifyEvidenceSeal(sealed)).toBe(true);

    // Tampering fails verification
    const tampered = {
      ...sealed,
      durationMs: 99999,
    };
    expect(verifyEvidenceSeal(tampered)).toBe(false);
  });

  describe('Verification Evidence Sealing', () => {
    const dummyVerificationEvidence: Omit<BenchmarkVerificationEvidence, 'evidenceContentHash'> = {
      armId: 'ARM_A_BASELINE',
      taskId: 'task-auth',
      snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
      workspacePath: 'workspace://ARM_A_BASELINE',
      startedAt: '2026-10-01T12:00:00.000Z',
      completedAt: '2026-10-01T12:01:00.000Z',
      durationMs: 60000,
      status: 'VERIFIED',
      checks: [
        {
          checkId: 'check-1',
          name: 'Check 1',
          command: 'node',
          args: ['-e', 'process.exit(0)'],
          exitCode: 0,
          signal: null,
          stdout: 'ok',
          stderr: '',
          timedOut: false,
          durationMs: 50,
          verifiedAt: '2026-10-01T12:00:50.000Z',
          passed: true,
        },
      ],
      workspaceBinding: {
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        workspacePath: 'workspace://ARM_A_BASELINE',
        headCommitSha: '0123456789abcdef0123456789abcdef01234567',
        headCommit: {
          hash: '0123456789abcdef0123456789abcdef01234567',
          subject: 'Baseline',
          author: 'Tester',
          timestamp: '2026-10-01T00:00:00Z',
        },
        gitStatus: {
          clean: true,
          branch: 'main',
          detached: false,
          staged: [],
          unstaged: [],
          untracked: [],
        },
      },
      diffCapture: {
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        headCommitSha: '0123456789abcdef0123456789abcdef01234567',
        headCommit: {
          hash: '0123456789abcdef0123456789abcdef01234567',
          subject: 'Baseline',
          author: 'Tester',
          timestamp: '2026-10-01T00:00:00Z',
        },
        gitStatus: {
          clean: true,
          branch: 'main',
          detached: false,
          staged: [],
          unstaged: [],
          untracked: [],
        },
        changes: {
          added: [],
          modified: [],
          deleted: [],
          renamed: [],
        },
        diff: '',
        capturedAt: '2026-10-01T12:00:00.000Z',
      },
    };

    it('computes deterministic verification evidence hash', () => {
      const hash1 = computeVerificationEvidenceContentHash(dummyVerificationEvidence);
      const hash2 = computeVerificationEvidenceContentHash(dummyVerificationEvidence);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('changes hash when verification status changes', () => {
      const hash1 = computeVerificationEvidenceContentHash(dummyVerificationEvidence);
      const modified = {
        ...dummyVerificationEvidence,
        status: 'FAILED' as const,
      };
      const hash2 = computeVerificationEvidenceContentHash(modified);

      expect(hash1).not.toBe(hash2);
    });

    it('seals verification evidence into immutable record and detects tampering', () => {
      const sealed = sealVerificationEvidence(dummyVerificationEvidence);

      expect(sealed.evidenceContentHash).toBeDefined();
      expect(Object.isFrozen(sealed)).toBe(true);
      expect(verifyVerificationEvidenceSeal(sealed)).toBe(true);

      // Tampered status fails seal verification
      const tampered = { ...sealed, status: 'FAILED' as const };
      expect(verifyVerificationEvidenceSeal(tampered)).toBe(false);

      // Invalid object returns false
      expect(verifyVerificationEvidenceSeal(null as any)).toBe(false);
      expect(verifyVerificationEvidenceSeal({} as any)).toBe(false);
    });

    it('redacts custom secrets from verification evidence checks before sealing', () => {
      const customSecret = 'my-verification-secret-xyz';
      const withSecret: typeof dummyVerificationEvidence = {
        ...dummyVerificationEvidence,
        checks: [
          {
            ...dummyVerificationEvidence.checks[0],
            stdout: `Check completed with secret: ${customSecret}`,
          },
        ],
      };

      const sealed = sealVerificationEvidence(withSecret, [customSecret]);

      expect(sealed.checks[0].stdout).not.toContain(customSecret);
      expect(sealed.checks[0].stdout).toContain('[REDACTED]');
      expect(verifyVerificationEvidenceSeal(sealed, [customSecret])).toBe(true);
    });
  });
});
