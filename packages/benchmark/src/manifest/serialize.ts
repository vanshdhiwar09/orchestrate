import { canonicalizeManifest } from './canonicalize.js';
import { freezeManifest } from './freeze.js';
import type { ArtifactManifest } from './types.js';
import { validateManifest } from './validate.js';

/**
 * Deterministically serializes an ArtifactManifest into formatted JSON (2-space indentation).
 * Validates the manifest prior to serialization.
 */
export function serializeManifest(manifest: ArtifactManifest): string {
  const canonical = canonicalizeManifest(manifest);
  validateManifest(canonical, { checkSorted: true });
  return JSON.stringify(canonical, null, 2);
}

/**
 * Deserializes an ArtifactManifest from JSON:
 * - Parses JSON
 * - Canonicalizes ordering and paths
 * - Validates all invariants
 * - Returns a deeply frozen immutable manifest
 */
export function deserializeManifest(jsonString: string): Readonly<ArtifactManifest> {
  if (typeof jsonString !== 'string' || jsonString.trim() === '') {
    throw new Error('deserializeManifest: JSON input must be a non-empty string.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`deserializeManifest: Invalid JSON format: ${msg}`);
  }

  const canonical = canonicalizeManifest(parsed as ArtifactManifest);
  validateManifest(canonical, { checkSorted: true });
  return freezeManifest(canonical);
}

/**
 * Creates, canonicalizes, validates, and deeply freezes an ArtifactManifest.
 */
export function createArtifactManifest(input: ArtifactManifest): Readonly<ArtifactManifest> {
  const canonical = canonicalizeManifest(input);
  validateManifest(canonical, { checkSorted: true });
  return freezeManifest(canonical);
}
