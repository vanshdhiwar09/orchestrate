import type { ArtifactManifest } from './types.js';

/**
 * Recursively freezes an object and all its nested properties.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const value = (obj as Record<string, unknown>)[name];
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj);
}

/**
 * Deeply freezes an ArtifactManifest ensuring the root, files array,
 * file objects, symbols arrays, and symbol objects are all immutable.
 */
export function freezeManifest(manifest: ArtifactManifest): Readonly<ArtifactManifest> {
  return deepFreeze(manifest);
}
