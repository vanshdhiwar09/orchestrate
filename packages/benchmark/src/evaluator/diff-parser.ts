export interface ParsedDiffLine {
  type: 'add' | 'delete' | 'context';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface ParsedDiffHunk {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  header: string;
  lines: ParsedDiffLine[];
  rawText: string;
}

export interface ParsedFileDiff {
  oldPath: string;
  newPath: string;
  changeType: 'modified' | 'added' | 'deleted' | 'renamed';
  hunks: ParsedDiffHunk[];
  isMalformed?: boolean;
}

export interface ParsedDiffResult {
  files: ParsedFileDiff[];
  hasMalformedDiff: boolean;
  malformedErrors: string[];
}

function cleanPath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  if (p === '/dev/null' || p === 'dev/null') {
    return '/dev/null';
  }
  p = p.replace(/\\+/g, '/').replace(/^\/+/, '');
  if (p === 'dev/null' || p === '/dev/null') {
    return '/dev/null';
  }
  if (p.startsWith('a/')) {
    p = p.slice(2);
  } else if (p.startsWith('b/')) {
    p = p.slice(2);
  }
  return p;
}

const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(.*)$/;

/**
 * Pure, zero-dependency Git unified diff parser.
 * Extracts structured file diffs and hunks with line-coordinate tracking.
 */
export function parseUnifiedDiff(rawDiff: string): ParsedDiffResult {
  const result: ParsedDiffResult = {
    files: [],
    hasMalformedDiff: false,
    malformedErrors: [],
  };

  if (!rawDiff || rawDiff.trim() === '') {
    return result;
  }

  const lines = rawDiff.replace(/\r\n/g, '\n').split('\n');
  let currentFile: ParsedFileDiff | null = null;
  let currentHunk: ParsedDiffHunk | null = null;
  let currentOldLine = 0;
  let currentNewLine = 0;

  function flushHunk(): void {
    if (currentFile && currentHunk) {
      currentFile.hunks.push(currentHunk);
      currentHunk = null;
    }
  }

  function flushFile(): void {
    flushHunk();
    if (currentFile) {
      if (currentFile.oldPath === '/dev/null') {
        currentFile.changeType = 'added';
      } else if (currentFile.newPath === '/dev/null') {
        currentFile.changeType = 'deleted';
      }
      result.files.push(currentFile);
      currentFile = null;
    }
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    // File header: diff --git a/... b/...
    if (line.startsWith('diff --git ')) {
      flushFile();
      const parts = line.slice('diff --git '.length).trim().split(/\s+/);
      const oldRaw = parts[0] ?? '';
      const newRaw = parts[1] ?? '';
      currentFile = {
        oldPath: cleanPath(oldRaw),
        newPath: cleanPath(newRaw),
        changeType: 'modified',
        hunks: [],
      };
      continue;
    }

    if (!currentFile && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      currentFile = {
        oldPath: '',
        newPath: '',
        changeType: 'modified',
        hunks: [],
      };
    }

    if (currentFile) {
      if (line.startsWith('deleted file mode')) {
        currentFile.changeType = 'deleted';
        continue;
      }
      if (line.startsWith('new file mode')) {
        currentFile.changeType = 'added';
        continue;
      }
      if (line.startsWith('rename from ')) {
        currentFile.oldPath = cleanPath(line.slice('rename from '.length));
        currentFile.changeType = 'renamed';
        continue;
      }
      if (line.startsWith('rename to ')) {
        currentFile.newPath = cleanPath(line.slice('rename to '.length));
        currentFile.changeType = 'renamed';
        continue;
      }
      if (line.startsWith('--- ')) {
        currentFile.oldPath = cleanPath(line.slice(4));
        continue;
      }
      if (line.startsWith('+++ ')) {
        currentFile.newPath = cleanPath(line.slice(4));
        continue;
      }
    }

    // Hunk header: @@ -oldStart,oldLen +newStart,newLen @@
    if (line.startsWith('@@')) {
      flushHunk();
      const match = line.match(HUNK_HEADER_REGEX);
      if (!match) {
        result.hasMalformedDiff = true;
        result.malformedErrors.push(`Malformed hunk header at line ${idx + 1}: "${line}"`);
        if (currentFile) {
          currentFile.isMalformed = true;
        }
        continue;
      }

      if (!currentFile) {
        currentFile = {
          oldPath: 'unknown',
          newPath: 'unknown',
          changeType: 'modified',
          hunks: [],
        };
      }

      const oldStart = parseInt(match[1], 10);
      const oldLen = match[2] !== undefined ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newLen = match[4] !== undefined ? parseInt(match[4], 10) : 1;
      const header = match[5].trim();

      // If oldLen === 0, the insertion occurs after oldStart
      currentOldLine = oldLen === 0 ? oldStart + 1 : oldStart;
      currentNewLine = newStart;

      currentHunk = {
        oldStartLine: oldStart,
        oldLineCount: oldLen,
        newStartLine: newStart,
        newLineCount: newLen,
        header,
        lines: [],
        rawText: line,
      };
      continue;
    }

    // Hunk content
    if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'delete',
          text: line.slice(1),
          oldLineNumber: currentOldLine++,
        });
        currentHunk.rawText += '\n' + line;
      } else if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'add',
          text: line.slice(1),
          oldLineNumber: currentOldLine,
          newLineNumber: currentNewLine++,
        });
        currentHunk.rawText += '\n' + line;
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          text: line.slice(1),
          oldLineNumber: currentOldLine++,
          newLineNumber: currentNewLine++,
        });
        currentHunk.rawText += '\n' + line;
      } else if (line === '') {
        currentHunk.lines.push({
          type: 'context',
          text: '',
          oldLineNumber: currentOldLine++,
          newLineNumber: currentNewLine++,
        });
        currentHunk.rawText += '\n' + line;
      } else if (line.startsWith('\\')) {
        currentHunk.rawText += '\n' + line;
      }
    }
  }

  flushFile();
  return result;
}
