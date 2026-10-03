import { describe, it, expect } from 'vitest';
import {
  computeEvidenceContentHash,
  sealEvidence,
  verifyEvidenceSeal,
} from '../../src/harness/evidence-sealer.js';
import type { RawExecutionEvidence } from '../../src/harness/types.js';

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
});
