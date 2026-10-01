import type {
  ArtifactFile,
  ArtifactManifest,
  ArtifactSymbol,
} from './types.js';

/**
 * Normalizes and canonicalizes an ArtifactManifest:
 * - Replaces backslashes in paths with canonical forward slashes
 * - Trims whitespace from paths and symbol names
 * - Trims signatures if provided
 * - Sorts files deterministically by path (ASCII order)
 * - Sorts symbols deterministically by name (ASCII order)
 */
export function canonicalizeManifest(input: ArtifactManifest): ArtifactManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('canonicalizeManifest: input must be an object.');
  }

  const normalizedFiles: ArtifactFile[] = (Array.isArray(input.files) ? input.files : []).map(
    (file) => {
      const rawPath =
        typeof file?.path === 'string' ? file.path.trim().replace(/\\+/g, '/') : '';

      const normalizedSymbols: ArtifactSymbol[] = (
        Array.isArray(file?.symbols) ? file.symbols : []
      ).map((sym) => {
        const symRecord: ArtifactSymbol = {
          name: typeof sym?.name === 'string' ? sym.name.trim() : sym?.name,
          kind: sym?.kind,
        };

        if (sym?.signature !== undefined) {
          symRecord.signature =
            typeof sym.signature === 'string' ? sym.signature.trim() : sym.signature;
        }

        return symRecord;
      });

      // ASCII code point alphabetical sort
      normalizedSymbols.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      return {
        path: rawPath,
        status: file?.status,
        symbols: normalizedSymbols,
      };
    }
  );

  // ASCII code point alphabetical sort
  normalizedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    taskId: typeof input.taskId === 'string' ? input.taskId.trim() : input.taskId,
    attemptNumber: input.attemptNumber,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.trim() : input.createdAt,
    files: normalizedFiles,
  };
}
