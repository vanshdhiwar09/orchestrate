import type { ArtifactFile } from '../manifest/types.js';
import { parseUnifiedDiff } from './diff-parser.js';
import {
  extractUpstreamSymbolSpans,
  matchHunkAgainstSpans,
} from './symbol-matcher.js';
import {
  ReworkEvaluationError,
  type AmbiguousReworkRecord,
  type ReworkEvaluationInput,
  type ReworkEvaluationReport,
  type ReworkEvaluator,
  type ReworkEvent,
} from './types.js';

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj as Readonly<T>;
}

function cleanPath(p: string): string {
  let cleaned = p.trim();
  if (cleaned === '/dev/null' || cleaned === 'dev/null') {
    return '/dev/null';
  }
  cleaned = cleaned.replace(/\\+/g, '/').replace(/^\/+/, '');
  if (cleaned === 'dev/null' || cleaned === '/dev/null') {
    return '/dev/null';
  }
  if (cleaned.startsWith('a/')) cleaned = cleaned.slice(2);
  else if (cleaned.startsWith('b/')) cleaned = cleaned.slice(2);
  return cleaned;
}

/**
 * Evaluates downstream Git diff against the frozen upstream ArtifactManifest and
 * frozen upstream workspace state to produce the deterministic rework_events metric.
 */
export async function evaluateRework(
  input: ReworkEvaluationInput
): Promise<Readonly<ReworkEvaluationReport>> {
  if (!input || typeof input !== 'object') {
    throw new ReworkEvaluationError('evaluateRework: input must be a non-null object.');
  }

  if (!input.manifest || typeof input.manifest !== 'object' || !Array.isArray(input.manifest.files)) {
    throw new ReworkEvaluationError('evaluateRework: manifest must be a valid ArtifactManifest object.');
  }

  if (
    !input.upstreamWorkspace ||
    typeof input.upstreamWorkspace.readFile !== 'function'
  ) {
    throw new ReworkEvaluationError(
      'evaluateRework: upstreamWorkspace is REQUIRED and must provide readFile.'
    );
  }

  if (typeof input.diff !== 'string') {
    throw new ReworkEvaluationError('evaluateRework: diff must be a string.');
  }

  const manifestFileMap = new Map<string, ArtifactFile>();
  const manifestPaths = new Set<string>();
  for (const file of input.manifest.files) {
    const norm = cleanPath(file.path);
    manifestFileMap.set(norm, file);
    manifestPaths.add(norm);
  }

  const diffResult = parseUnifiedDiff(input.diff);

  const events: ReworkEvent[] = [];
  const ambiguous: AmbiguousReworkRecord[] = [];
  const diffPaths = new Set<string>();

  // If the diff syntax itself was malformed, emit ambiguous records
  if (diffResult.hasMalformedDiff) {
    for (let errIdx = 0; errIdx < diffResult.malformedErrors.length; errIdx++) {
      ambiguous.push({
        id: `amb:diff:DIFF_SYNTAX_UNPARSEABLE:${errIdx}`,
        filePath: 'diff',
        reason: 'DIFF_SYNTAX_UNPARSEABLE',
        evidence: diffResult.malformedErrors[errIdx],
      });
    }
  }

  for (const fileDiff of diffResult.files) {
    const oldNorm = cleanPath(fileDiff.oldPath);
    const newNorm = cleanPath(fileDiff.newPath);

    if (oldNorm && oldNorm !== '/dev/null' && oldNorm !== 'dev/null') diffPaths.add(oldNorm);
    if (newNorm && newNorm !== '/dev/null' && newNorm !== 'dev/null') diffPaths.add(newNorm);

    // Look up in manifest
    const manifestFile =
      manifestFileMap.get(oldNorm) ??
      manifestFileMap.get(newNorm);

    if (!manifestFile) {
      // Downstream-added file or unrelated change outside manifest -> NON_REWORK
      continue;
    }

    const filePath = manifestFile.path;

    // ── 1. Upstream ADDED File ──────────────────────────────────────────────
    if (manifestFile.status === 'ADDED') {
      const evidence =
        fileDiff.hunks.map((h) => h.rawText).join('\n') ||
        `${fileDiff.changeType} ${filePath}`;

      if (fileDiff.changeType === 'deleted') {
        events.push({
          id: `rw:${filePath}`,
          filePath,
          upstreamStatus: 'ADDED',
          reason: 'UPSTREAM_ADDED_FILE_DELETED',
          evidence,
        });
      } else if (fileDiff.changeType === 'renamed') {
        events.push({
          id: `rw:${filePath}`,
          filePath,
          upstreamStatus: 'ADDED',
          reason: 'UPSTREAM_ADDED_FILE_RENAMED',
          destinationPath: newNorm,
          evidence,
        });
      } else {
        // Any line mutation in an upstream ADDED file is rework
        events.push({
          id: `rw:${filePath}`,
          filePath,
          upstreamStatus: 'ADDED',
          reason: 'UPSTREAM_ADDED_FILE_MODIFIED',
          evidence,
        });
      }
      continue;
    }

    // ── 2. Upstream MODIFIED File ───────────────────────────────────────────
    if (manifestFile.status === 'MODIFIED') {
      const evidence =
        fileDiff.hunks.map((h) => h.rawText).join('\n') ||
        `${fileDiff.changeType} ${filePath}`;

      if (fileDiff.changeType === 'deleted') {
        events.push({
          id: `rw:${filePath}:file`,
          filePath,
          upstreamStatus: 'MODIFIED',
          reason: 'UPSTREAM_MODIFIED_FILE_DELETED',
          evidence,
        });
        continue;
      }

      if (fileDiff.changeType === 'renamed') {
        events.push({
          id: `rw:${filePath}:file`,
          filePath,
          upstreamStatus: 'MODIFIED',
          reason: 'UPSTREAM_MODIFIED_FILE_RENAMED',
          destinationPath: newNorm,
          evidence,
        });
        continue;
      }

      // Read frozen upstream source
      let upstreamContent: string;
      try {
        upstreamContent = await input.upstreamWorkspace.readFile(filePath);
      } catch (err: unknown) {
        ambiguous.push({
          id: `amb:${filePath}:MODIFIED_FILE_SYMBOL_LINE_MAPPING_UNAVAILABLE:0`,
          filePath,
          reason: 'MODIFIED_FILE_SYMBOL_LINE_MAPPING_UNAVAILABLE',
          evidence: `Failed to read frozen upstream file "${filePath}".`,
        });
        continue;
      }

      // If upstream manifest has no symbols, attribution is ambiguous
      if (manifestFile.symbols.length === 0) {
        ambiguous.push({
          id: `amb:${filePath}:MODIFIED_FILE_NO_UPSTREAM_SYMBOLS:0`,
          filePath,
          reason: 'MODIFIED_FILE_NO_UPSTREAM_SYMBOLS',
          evidence,
        });
        continue;
      }

      const { spans, isBalanced } = extractUpstreamSymbolSpans(
        upstreamContent,
        manifestFile.symbols
      );

      if (!isBalanced) {
        ambiguous.push({
          id: `amb:${filePath}:MODIFIED_FILE_SYMBOL_LINE_MAPPING_UNAVAILABLE:0`,
          filePath,
          reason: 'MODIFIED_FILE_SYMBOL_LINE_MAPPING_UNAVAILABLE',
          evidence: `Frozen upstream file "${filePath}" lexical structure is unbalanced.`,
        });
        continue;
      }

      // Match hunks against spans
      const fileReworkSymbols = new Map<
        string,
        {
          reason: ReworkEvent['reason'];
          targetSymbol: ArtifactFile['symbols'][0];
          evidence: string;
        }
      >();
      let hasSharedRegion = false;
      let sharedRegionEvidence = '';

      for (let hIdx = 0; hIdx < fileDiff.hunks.length; hIdx++) {
        const hunk = fileDiff.hunks[hIdx];
        const match = matchHunkAgainstSpans(hunk, spans);

        for (const [symName, info] of match.reworkSymbols.entries()) {
          const existing = fileReworkSymbols.get(symName);
          if (!existing) {
            fileReworkSymbols.set(symName, info);
          } else if (info.reason === 'UPSTREAM_MODIFIED_SYMBOL_DELETED') {
            fileReworkSymbols.set(symName, info);
          }
        }

        if (match.hasAmbiguousSharedRegion) {
          hasSharedRegion = true;
          if (!sharedRegionEvidence) {
            sharedRegionEvidence = match.ambiguousEvidence ?? hunk.rawText;
          }
        }
      }

      // Emit at most one event per mutated symbol
      for (const [symName, info] of fileReworkSymbols.entries()) {
        events.push({
          id: `rw:${filePath}:${symName}`,
          filePath,
          upstreamStatus: 'MODIFIED',
          targetSymbol: {
            name: info.targetSymbol.name,
            kind: info.targetSymbol.kind,
            ...(info.targetSymbol.signature ? { signature: info.targetSymbol.signature } : {}),
          },
          reason: info.reason,
          evidence: info.evidence,
        });
      }

      if (hasSharedRegion) {
        ambiguous.push({
          id: `amb:${filePath}:MODIFIED_FILE_SHARED_REGION_EDIT:0`,
          filePath,
          reason: 'MODIFIED_FILE_SHARED_REGION_EDIT',
          evidence: sharedRegionEvidence,
        });
      }
    }
  }

  // Canonical alphabetical sorting
  events.sort((a, b) => a.id.localeCompare(b.id));
  ambiguous.sort((a, b) => a.id.localeCompare(b.id));

  // Compute set-cardinality summary counters
  const totalEvaluatedSet = new Set<string>();
  for (const p of manifestPaths) totalEvaluatedSet.add(p);
  for (const p of diffPaths) totalEvaluatedSet.add(p);

  const reworkFilesSet = new Set(events.map((e) => e.filePath));
  const ambiguousFilesSet = new Set(ambiguous.map((a) => a.filePath));

  const report: ReworkEvaluationReport = {
    upstreamTaskId: input.manifest.taskId,
    ...(input.downstreamTaskId ? { downstreamTaskId: input.downstreamTaskId } : {}),
    rework_events: events.length,
    events,
    ambiguous,
    summary: {
      totalFilesEvaluated: totalEvaluatedSet.size,
      upstreamFilesChecked: manifestPaths.size,
      reworkFilesCount: reworkFilesSet.size,
      ambiguousFilesCount: ambiguousFilesSet.size,
    },
  };

  return deepFreeze(report);
}

/**
 * Default implementation of ReworkEvaluator.
 */
export class DefaultReworkEvaluator implements ReworkEvaluator {
  async evaluate(input: ReworkEvaluationInput): Promise<Readonly<ReworkEvaluationReport>> {
    return evaluateRework(input);
  }
}
