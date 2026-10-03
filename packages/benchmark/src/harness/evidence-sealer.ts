import { canonicalJson, sha256 } from './fingerprints.js';
import { redactSecrets } from './redaction.js';
import type { RawExecutionEvidence } from './types.js';

/**
 * Computes the canonical SHA-256 hash of raw execution evidence.
 * Redacts secrets first and strictly excludes the hash field itself from hashing.
 */
export function computeEvidenceContentHash(
  evidence: Omit<RawExecutionEvidence, 'evidenceContentHash'>,
  customSecrets?: string[]
): string {
  // 1. Field-aware secret redaction
  const sanitized = redactSecrets(evidence, customSecrets);

  // 2. Canonical JSON serialization with sorted object keys
  const serialized = canonicalJson(sanitized);

  // 3. SHA-256 digest
  return sha256(serialized);
}

/**
 * Seals raw execution evidence into an immutable, hashed record.
 * Applies redaction, computes evidenceContentHash, and freezes the record.
 */
export function sealEvidence(
  evidence: Omit<RawExecutionEvidence, 'evidenceContentHash'>,
  customSecrets?: string[]
): RawExecutionEvidence {
  const sanitized = redactSecrets(evidence, customSecrets);
  const hash = computeEvidenceContentHash(sanitized, customSecrets);

  return Object.freeze({
    ...sanitized,
    evidenceContentHash: hash,
  });
}

/**
 * Verifies that a sealed execution evidence record has a valid SHA-256 content hash.
 */
export function verifyEvidenceSeal(
  sealed: RawExecutionEvidence,
  customSecrets?: string[]
): boolean {
  if (!sealed || typeof sealed !== 'object' || typeof sealed.evidenceContentHash !== 'string') {
    return false;
  }

  const { evidenceContentHash, ...unsealedPart } = sealed;
  const expectedHash = computeEvidenceContentHash(unsealedPart, customSecrets);

  return evidenceContentHash === expectedHash;
}
