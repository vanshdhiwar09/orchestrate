import {
  canonicalizeManifest,
  freezeManifest,
  validateManifest,
  type ArtifactFile,
  type ArtifactManifest,
} from '../manifest/index.js';
import { getChangedFilesFromGitStatus } from './changed-files.js';
import { parseSourceSymbols } from './symbol-parser.js';
import {
  ManifestExtractionError,
  type ManifestExtractionInput,
  type ManifestExtractor,
} from './types.js';

const DEFAULT_SOURCE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx'];

/**
 * Extracts a frozen, canonicalized, and validated ArtifactManifest from a
 * finished Task 1 repository state.
 *
 * Implements the frozen benchmark extraction pipeline:
 * git.getStatus() -> changed files -> symbol scanning -> canonicalize -> validate -> freeze
 */
export async function extractArtifactManifest(
  input: ManifestExtractionInput
): Promise<Readonly<ArtifactManifest>> {
  if (!input || typeof input !== 'object') {
    throw new ManifestExtractionError('extractArtifactManifest: input must be a non-null object.');
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim() === '') {
    throw new ManifestExtractionError('extractArtifactManifest: taskId must be a non-empty string.');
  }

  if (
    typeof input.attemptNumber !== 'number' ||
    !Number.isInteger(input.attemptNumber) ||
    input.attemptNumber < 1
  ) {
    throw new ManifestExtractionError(
      `extractArtifactManifest: attemptNumber must be a positive integer (>= 1). Received: ${input.attemptNumber}.`
    );
  }

  if (typeof input.createdAt !== 'string' || input.createdAt.trim() === '') {
    throw new ManifestExtractionError(
      'extractArtifactManifest: createdAt is REQUIRED and must be a valid ISO timestamp string.'
    );
  }

  if (!input.workspace || typeof input.workspace.readFile !== 'function') {
    throw new ManifestExtractionError(
      'extractArtifactManifest: workspace must provide a valid readFile implementation.'
    );
  }

  if (!input.git || typeof input.git.getStatus !== 'function' || typeof input.git.isRepository !== 'function') {
    throw new ManifestExtractionError(
      'extractArtifactManifest: git must provide a valid GitRepository implementation.'
    );
  }

  // 1. Verify Git repository boundary
  let isRepo: boolean;
  try {
    isRepo = await input.git.isRepository();
  } catch (err: unknown) {
    throw new ManifestExtractionError('Failed to inspect repository validity.', err);
  }

  if (!isRepo) {
    throw new ManifestExtractionError('Specified workspace is not a valid Git repository.');
  }

  // 2. Query Git status
  let gitStatus;
  try {
    gitStatus = await input.git.getStatus();
  } catch (err: unknown) {
    throw new ManifestExtractionError('Failed to retrieve Git status from workspace.', err);
  }

  // 3. Changed-file detection & ignore filtering
  const changedFiles = getChangedFilesFromGitStatus(
    gitStatus,
    input.options?.ignoredPatterns
  );

  const sourceExtensions = input.options?.sourceExtensions ?? DEFAULT_SOURCE_EXTENSIONS;
  const artifactFiles: ArtifactFile[] = [];

  // 4. Read changed files and extract symbols
  for (const changed of changedFiles) {
    const isSource = sourceExtensions.some((ext) => changed.path.endsWith(ext));

    if (!isSource) {
      // Non-source files (e.g. .json, .sql, .md) are recorded with empty symbols
      artifactFiles.push({
        path: changed.path,
        status: changed.status,
        symbols: [],
      });
      continue;
    }

    let content: string;
    try {
      content = await input.workspace.readFile(changed.path);
    } catch (err: unknown) {
      throw new ManifestExtractionError(
        `Failed to read changed file from workspace: "${changed.path}".`,
        err
      );
    }

    const symbols = parseSourceSymbols(content);

    artifactFiles.push({
      path: changed.path,
      status: changed.status,
      symbols,
    });
  }

  // 5. Construct raw manifest
  const rawManifest: ArtifactManifest = {
    taskId: input.taskId.trim(),
    attemptNumber: input.attemptNumber,
    createdAt: input.createdAt.trim(),
    files: artifactFiles,
  };

  // 6. Pipeline: canonicalize -> validate with checkSorted -> freeze
  try {
    const canonical = canonicalizeManifest(rawManifest);
    validateManifest(canonical, { checkSorted: true });
    return freezeManifest(canonical);
  } catch (err: unknown) {
    throw new ManifestExtractionError('Failed to canonicalize or validate extracted manifest.', err);
  }
}

/**
 * Default implementation of ManifestExtractor interface.
 */
export class DefaultManifestExtractor implements ManifestExtractor {
  async extract(input: ManifestExtractionInput): Promise<Readonly<ArtifactManifest>> {
    return extractArtifactManifest(input);
  }
}
