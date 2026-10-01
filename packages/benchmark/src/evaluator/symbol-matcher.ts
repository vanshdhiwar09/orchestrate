import type { ArtifactSymbol, ArtifactSymbolKind } from '../manifest/types.js';
import { scanLexicalStructure } from '../extractor/lexical-scanner.js';
import type { ParsedDiffHunk } from './diff-parser.js';
import type { AmbiguousReworkReason, ReworkEventReason } from './types.js';

export interface UpstreamSymbolSpan {
  name: string;
  kind: ArtifactSymbolKind;
  startLine: number;
  endLine: number;
  declarationLine: number;
  declarationText: string;
  isManifestSymbol: boolean;
  manifestSymbol?: ArtifactSymbol;
}

export interface MatchHunkResult {
  reworkSymbols: Map<string, {
    reason: ReworkEventReason;
    targetSymbol: ArtifactSymbol;
    evidence: string;
  }>;
  hasAmbiguousSharedRegion: boolean;
  ambiguousEvidence?: string;
  isNonRework: boolean;
}

/**
 * Scans frozen upstream source to locate exact [startLine, endLine] boundaries
 * for top-level declarations and methods.
 */
export function extractUpstreamSymbolSpans(
  sourceText: string,
  manifestSymbols: readonly ArtifactSymbol[]
): { spans: UpstreamSymbolSpan[]; isBalanced: boolean } {
  const scan = scanLexicalStructure(sourceText);
  if (!scan.isBalanced) {
    return { spans: [], isBalanced: false };
  }

  const manifestSymbolMap = new Map<string, ArtifactSymbol>();
  for (const s of manifestSymbols) {
    manifestSymbolMap.set(s.name, s);
  }

  const spans: UpstreamSymbolSpan[] = [];
  let activeContainer: { kind: 'class' | 'interface'; name: string; startLine: number } | null = null;

  for (let i = 0; i < scan.lines.length; i++) {
    const line = scan.lines[i];
    const text = line.cleanCode.trim();
    if (!text) continue;

    if (line.startDepth === 0) {
      activeContainer = null;
    }

    // ── 1. Top-Level Declarations (depth 0) ──────────────────────────────────
    if (line.startDepth === 0) {
      // 1. Function
      const funcMatch = text.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z0-9_$]+)/
      );
      if (funcMatch) {
        const name = funcMatch[1];
        const startLine = line.lineNumber;
        let endLine = line.lineNumber;
        if (line.endDepth > 0) {
          for (let j = i + 1; j < scan.lines.length; j++) {
            if (scan.lines[j].endDepth === 0) {
              endLine = scan.lines[j].lineNumber;
              break;
            }
          }
        }
        spans.push({
          name,
          kind: 'function',
          startLine,
          endLine,
          declarationLine: startLine,
          declarationText: line.rawLine.trim(),
          isManifestSymbol: manifestSymbolMap.has(name),
          manifestSymbol: manifestSymbolMap.get(name),
        });
        continue;
      }

      // 2. Class
      const classMatch = text.match(
        /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/
      );
      if (classMatch) {
        const name = classMatch[1];
        const startLine = line.lineNumber;
        let endLine = line.lineNumber;
        if (line.endDepth > 0) {
          for (let j = i + 1; j < scan.lines.length; j++) {
            if (scan.lines[j].endDepth === 0) {
              endLine = scan.lines[j].lineNumber;
              break;
            }
          }
        }
        activeContainer = { kind: 'class', name, startLine };
        spans.push({
          name,
          kind: 'class',
          startLine,
          endLine,
          declarationLine: startLine,
          declarationText: line.rawLine.trim(),
          isManifestSymbol: manifestSymbolMap.has(name),
          manifestSymbol: manifestSymbolMap.get(name),
        });
        continue;
      }

      // 3. Interface
      const interfaceMatch = text.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (interfaceMatch) {
        const name = interfaceMatch[1];
        const startLine = line.lineNumber;
        let endLine = line.lineNumber;
        if (line.endDepth > 0) {
          for (let j = i + 1; j < scan.lines.length; j++) {
            if (scan.lines[j].endDepth === 0) {
              endLine = scan.lines[j].lineNumber;
              break;
            }
          }
        }
        activeContainer = { kind: 'interface', name, startLine };
        spans.push({
          name,
          kind: 'interface',
          startLine,
          endLine,
          declarationLine: startLine,
          declarationText: line.rawLine.trim(),
          isManifestSymbol: manifestSymbolMap.has(name),
          manifestSymbol: manifestSymbolMap.get(name),
        });
        continue;
      }

      // 4. Type alias
      const typeMatch = text.match(/^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*=/);
      if (typeMatch) {
        const name = typeMatch[1];
        const startLine = line.lineNumber;
        let endLine = line.lineNumber;
        if (!text.endsWith(';')) {
          for (let j = i + 1; j < scan.lines.length; j++) {
            if (scan.lines[j].cleanCode.includes(';') || scan.lines[j].endDepth === 0) {
              endLine = scan.lines[j].lineNumber;
              break;
            }
          }
        }
        spans.push({
          name,
          kind: 'type',
          startLine,
          endLine,
          declarationLine: startLine,
          declarationText: line.rawLine.trim(),
          isManifestSymbol: manifestSymbolMap.has(name),
          manifestSymbol: manifestSymbolMap.get(name),
        });
        continue;
      }

      // 5. Arrow function variable
      const arrowMatch = text.match(
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/
      );
      if (arrowMatch) {
        const name = arrowMatch[1];
        const startLine = line.lineNumber;
        let endLine = line.lineNumber;
        if (line.endDepth > 0) {
          for (let j = i + 1; j < scan.lines.length; j++) {
            if (scan.lines[j].endDepth === 0) {
              endLine = scan.lines[j].lineNumber;
              break;
            }
          }
        }
        spans.push({
          name,
          kind: 'function',
          startLine,
          endLine,
          declarationLine: startLine,
          declarationText: line.rawLine.trim(),
          isManifestSymbol: manifestSymbolMap.has(name),
          manifestSymbol: manifestSymbolMap.get(name),
        });
        continue;
      }

      // 6. Ordinary variable
      const varMatch = text.match(
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=/
      );
      if (varMatch) {
        const name = varMatch[1];
        const startLine = line.lineNumber;
        let endLine = line.lineNumber;
        if (line.endDepth > 0) {
          for (let j = i + 1; j < scan.lines.length; j++) {
            if (scan.lines[j].endDepth === 0) {
              endLine = scan.lines[j].lineNumber;
              break;
            }
          }
        }
        spans.push({
          name,
          kind: 'variable',
          startLine,
          endLine,
          declarationLine: startLine,
          declarationText: line.rawLine.trim(),
          isManifestSymbol: manifestSymbolMap.has(name),
          manifestSymbol: manifestSymbolMap.get(name),
        });
        continue;
      }
    }

    // ── 2. Direct Class / Interface Methods (depth 1) ───────────────────────
    if (line.startDepth === 1 && activeContainer !== null) {
      if (/\bprivate\b/.test(text) || text.includes('#') || /^constructor\s*\(/.test(text)) {
        continue;
      }
      const methodMatch = text.match(
        /^(?:public\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+|get\s+|set\s+)*([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?/
      );
      if (methodMatch) {
        const name = methodMatch[1];
        if (name !== 'constructor') {
          const startLine = line.lineNumber;
          let endLine = line.lineNumber;
          if (line.endDepth > 1) {
            for (let j = i + 1; j < scan.lines.length; j++) {
              if (scan.lines[j].endDepth <= 1) {
                endLine = scan.lines[j].lineNumber;
                break;
              }
            }
          }
          spans.push({
            name,
            kind: 'method',
            startLine,
            endLine,
            declarationLine: startLine,
            declarationText: line.rawLine.trim(),
            isManifestSymbol: manifestSymbolMap.has(name),
            manifestSymbol: manifestSymbolMap.get(name),
          });
          continue;
        }
      }
    }
  }

  return { spans, isBalanced: true };
}

/**
 * Checks if added lines represent a self-contained, balanced top-level declaration.
 * (e.g. export function foo() { ... } with matched braces).
 */
function isSelfContainedTopLevelDeclaration(addedLines: string[]): boolean {
  const combined = addedLines.join('\n').trim();
  if (!combined) return false;

  // Must match a top-level declaration header
  const isDeclHeader =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*)?\s+[A-Za-z0-9_$]+/.test(combined) ||
    /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z0-9_$]+/.test(combined) ||
    /^(?:export\s+)?interface\s+[A-Za-z0-9_$]+/.test(combined) ||
    /^(?:export\s+)?type\s+[A-Za-z0-9_$]+/.test(combined) ||
    /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_$]+.*=>/.test(combined);

  if (!isDeclHeader) {
    return false;
  }

  // Check brace balance of the added block
  const scan = scanLexicalStructure(combined);
  return scan.isBalanced;
}

/**
 * Matches a diff hunk against upstream symbol spans and classifies the changes.
 */
export function matchHunkAgainstSpans(
  hunk: ParsedDiffHunk,
  spans: UpstreamSymbolSpan[]
): MatchHunkResult {
  const reworkSymbols = new Map<
    string,
    { reason: ReworkEventReason; targetSymbol: ArtifactSymbol; evidence: string }
  >();

  const deletedLines = hunk.lines.filter((l) => l.type === 'delete');
  const addedLines = hunk.lines.filter((l) => l.type === 'add');

  const isNewDeclHunk =
    deletedLines.length === 0 &&
    addedLines.length > 0 &&
    isSelfContainedTopLevelDeclaration(addedLines.map((l) => l.text));

  // Check if declaration of any manifest symbol was deleted
  for (const span of spans) {
    if (!span.isManifestSymbol || !span.manifestSymbol) continue;

    const declDeleted = deletedLines.some(
      (l) =>
        l.oldLineNumber === span.declarationLine ||
        l.text.includes(span.name)
    );

    if (declDeleted) {
      // Check if declaration was re-added with same name in added lines
      const reAdded = addedLines.some((l) => l.text.includes(span.name));
      const reason: ReworkEventReason = reAdded
        ? 'UPSTREAM_MODIFIED_SYMBOL_CHANGED'
        : 'UPSTREAM_MODIFIED_SYMBOL_DELETED';

      reworkSymbols.set(span.name, {
        reason,
        targetSymbol: span.manifestSymbol,
        evidence: hunk.rawText,
      });
      continue;
    }

    if (!isNewDeclHunk) {
      // Check if lines within body were deleted, modified, or added
      const bodyModified = hunk.lines.some(
        (l) =>
          (l.type === 'delete' || l.type === 'add') &&
          l.oldLineNumber !== undefined &&
          l.oldLineNumber >= span.startLine &&
          l.oldLineNumber <= span.endLine
      );

      if (bodyModified) {
        if (!reworkSymbols.has(span.name)) {
          reworkSymbols.set(span.name, {
            reason: 'UPSTREAM_MODIFIED_SYMBOL_CHANGED',
            targetSymbol: span.manifestSymbol,
            evidence: hunk.rawText,
          });
        }
      }
    }
  }

  if (reworkSymbols.size > 0) {
    return {
      reworkSymbols,
      hasAmbiguousSharedRegion: false,
      isNonRework: false,
    };
  }

  // Check if changes fall strictly inside a pre-existing non-manifest symbol
  const touchesPreExistingSymbol = hunk.lines.some((l) => {
    if (l.type !== 'delete' && l.type !== 'add') return false;
    if (l.oldLineNumber === undefined) return false;
    const lineNum = l.oldLineNumber;
    return spans.some(
      (s) => !s.isManifestSymbol && lineNum >= s.startLine && lineNum <= s.endLine
    );
  });

  if (touchesPreExistingSymbol && !isNewDeclHunk) {
    return {
      reworkSymbols,
      hasAmbiguousSharedRegion: false,
      isNonRework: true,
    };
  }

  // Check if hunk is a pure addition of a self-contained new declaration
  if (isNewDeclHunk) {
    return {
      reworkSymbols,
      hasAmbiguousSharedRegion: false,
      isNonRework: true,
    };
  }

  // Otherwise, edits in shared region (imports, module statements, comments, etc.)
  return {
    reworkSymbols,
    hasAmbiguousSharedRegion: true,
    ambiguousEvidence: hunk.rawText,
    isNonRework: false,
  };
}
