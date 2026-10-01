import type {
  ArtifactFile,
  ArtifactManifest,
  ArtifactSymbol,
  ArtifactSymbolKind,
  ArtifactFileStatus,
} from './types.js';

export const VALID_SYMBOL_KINDS = new Set<ArtifactSymbolKind>([
  'function',
  'class',
  'interface',
  'type',
  'variable',
  'method',
  'export',
]);

export const VALID_FILE_STATUSES = new Set<ArtifactFileStatus>([
  'ADDED',
  'MODIFIED',
]);

// ISO 8601 UTC timestamp regex (e.g. 2026-10-01T12:00:00Z or 2026-10-01T12:00:00.000Z)
const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Validates a repository-relative file path against security and boundary rules.
 */
export function validateFilePath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('ArtifactManifest validation error: File path must be a non-empty string.');
  }

  if (filePath.includes('\0')) {
    throw new Error(`ArtifactManifest validation error: File path cannot contain null bytes: "${filePath}".`);
  }

  // Disallow unnormalized backslashes in canonical manifest
  if (filePath.includes('\\')) {
    throw new Error(
      `ArtifactManifest validation error: File path must use canonical forward slash separators: "${filePath}".`
    );
  }

  // Disallow absolute paths (POSIX leading slash or Windows drive letters)
  if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) {
    throw new Error(
      `ArtifactManifest validation error: File path must be repository-relative, not absolute: "${filePath}".`
    );
  }

  const segments = filePath.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(
        `ArtifactManifest validation error: Path traversal denied in path: "${filePath}".`
      );
    }
    if (segment === '.') {
      throw new Error(
        `ArtifactManifest validation error: Relative segment "." is not permitted in canonical path: "${filePath}".`
      );
    }
    if (segment === '') {
      throw new Error(
        `ArtifactManifest validation error: Empty path segment detected in path: "${filePath}".`
      );
    }
  }
}

/**
 * Validates a single symbol definition.
 */
export function validateSymbol(symbol: ArtifactSymbol): void {
  if (!symbol || typeof symbol !== 'object') {
    throw new Error('ArtifactManifest validation error: Symbol must be a non-null object.');
  }

  if (typeof symbol.name !== 'string' || symbol.name.trim() === '') {
    throw new Error('ArtifactManifest validation error: Symbol name must be a non-empty string.');
  }

  if (!VALID_SYMBOL_KINDS.has(symbol.kind)) {
    throw new Error(
      `ArtifactManifest validation error: Invalid symbol kind "${symbol.kind}" for symbol "${symbol.name}". Supported kinds: ${[...VALID_SYMBOL_KINDS].join(', ')}.`
    );
  }

  if (symbol.signature !== undefined && typeof symbol.signature !== 'string') {
    throw new Error(
      `ArtifactManifest validation error: Symbol signature must be a string if provided for symbol "${symbol.name}".`
    );
  }
}

/**
 * Validates a single file record in the manifest.
 */
export function validateFile(file: ArtifactFile): void {
  if (!file || typeof file !== 'object') {
    throw new Error('ArtifactManifest validation error: File record must be a non-null object.');
  }

  validateFilePath(file.path);

  if (!VALID_FILE_STATUSES.has(file.status)) {
    throw new Error(
      `ArtifactManifest validation error: Invalid file status "${file.status}" for file "${file.path}". Supported statuses: ADDED, MODIFIED.`
    );
  }

  if (!Array.isArray(file.symbols)) {
    throw new Error(
      `ArtifactManifest validation error: symbols must be an array for file "${file.path}".`
    );
  }

  const seenSymbols = new Set<string>();
  for (let i = 0; i < file.symbols.length; i++) {
    const symbol = file.symbols[i];
    validateSymbol(symbol);

    if (seenSymbols.has(symbol.name)) {
      throw new Error(
        `ArtifactManifest validation error: Duplicate symbol name "${symbol.name}" in file "${file.path}".`
      );
    }
    seenSymbols.add(symbol.name);
  }
}

/**
 * Validates an entire ArtifactManifest against all required invariants.
 */
export function validateManifest(manifest: ArtifactManifest, options?: { checkSorted?: boolean }): void {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('ArtifactManifest validation error: Manifest must be a non-null object.');
  }

  if (typeof manifest.taskId !== 'string' || manifest.taskId.trim() === '') {
    throw new Error('ArtifactManifest validation error: taskId must be a non-empty string.');
  }

  if (
    typeof manifest.attemptNumber !== 'number' ||
    !Number.isInteger(manifest.attemptNumber) ||
    manifest.attemptNumber < 1
  ) {
    throw new Error(
      `ArtifactManifest validation error: attemptNumber must be a positive integer (>= 1). Received: ${manifest.attemptNumber}.`
    );
  }

  if (
    typeof manifest.createdAt !== 'string' ||
    !ISO_UTC_REGEX.test(manifest.createdAt) ||
    Number.isNaN(Date.parse(manifest.createdAt))
  ) {
    throw new Error(
      `ArtifactManifest validation error: createdAt must be a valid ISO 8601 UTC timestamp (e.g. "2026-10-01T12:00:00.000Z"). Received: "${manifest.createdAt}".`
    );
  }

  if (!Array.isArray(manifest.files)) {
    throw new Error('ArtifactManifest validation error: files must be an array.');
  }

  const seenPaths = new Set<string>();
  for (let i = 0; i < manifest.files.length; i++) {
    const file = manifest.files[i];
    validateFile(file);

    if (seenPaths.has(file.path)) {
      throw new Error(
        `ArtifactManifest validation error: Duplicate file path "${file.path}" in manifest.`
      );
    }
    seenPaths.add(file.path);
  }

  if (options?.checkSorted) {
    for (let i = 1; i < manifest.files.length; i++) {
      if (manifest.files[i - 1].path > manifest.files[i].path) {
        throw new Error(
          `ArtifactManifest validation error: files array is not in canonical ASCII sorted order.`
        );
      }
    }

    for (const file of manifest.files) {
      for (let j = 1; j < file.symbols.length; j++) {
        if (file.symbols[j - 1].name > file.symbols[j].name) {
          throw new Error(
            `ArtifactManifest validation error: symbols in "${file.path}" are not in canonical ASCII sorted order.`
          );
        }
      }
    }
  }
}
