export interface ScannedLine {
  lineNumber: number;
  startDepth: number;
  endDepth: number;
  cleanCode: string;
  rawLine: string;
}

export interface LexicalScanResult {
  lines: ScannedLine[];
  isBalanced: boolean;
}

/**
 * Lightweight, zero-dependency lexical state machine that scans source text:
 * - Strips line comments (//) and block comments (/* *\/)
 * - Masks single-quote, double-quote, and template strings
 * - Accurately tracks brace depth ({ and }) across lines
 * - Identifies whether source lexical boundaries are balanced
 */
export function scanLexicalStructure(sourceText: string): LexicalScanResult {
  const rawLines = sourceText.replace(/\r\n/g, '\n').split('\n');
  const scannedLines: ScannedLine[] = [];

  let depth = 0;
  let inBlockComment = false;
  let inSingleString = false;
  let inDoubleString = false;
  let inTemplateString = false;
  const templateExpressionDepths: number[] = [];

  for (let idx = 0; idx < rawLines.length; idx++) {
    const rawLine = rawLines[idx];
    const lineStartDepth = depth;
    let cleanCode = '';
    let i = 0;

    while (i < rawLine.length) {
      const char = rawLine[i];
      const next = rawLine[i + 1];

      // Handle escape characters inside strings
      if (inSingleString || inDoubleString || inTemplateString) {
        if (char === '\\' && i + 1 < rawLine.length) {
          cleanCode += '  ';
          i += 2;
          continue;
        }
      }

      // Handle inside block comments
      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false;
          cleanCode += '  ';
          i += 2;
          continue;
        }
        cleanCode += ' ';
        i++;
        continue;
      }

      // Handle inside single-quoted string
      if (inSingleString) {
        if (char === "'") {
          inSingleString = false;
        }
        cleanCode += ' ';
        i++;
        continue;
      }

      // Handle inside double-quoted string
      if (inDoubleString) {
        if (char === '"') {
          inDoubleString = false;
        }
        cleanCode += ' ';
        i++;
        continue;
      }

      // Handle inside template literal
      if (inTemplateString) {
        if (char === '`') {
          inTemplateString = false;
          cleanCode += ' ';
          i++;
          continue;
        }
        if (char === '$' && next === '{') {
          // Entering template expression: ${expr}
          templateExpressionDepths.push(depth);
          depth++;
          cleanCode += '  ';
          i += 2;
          continue;
        }
        cleanCode += ' ';
        i++;
        continue;
      }

      // ── Unquoted code ──

      // Line comment
      if (char === '/' && next === '/') {
        // Rest of the line is a comment
        break;
      }

      // Block comment start
      if (char === '/' && next === '*') {
        inBlockComment = true;
        cleanCode += '  ';
        i += 2;
        continue;
      }

      // String literal starts
      if (char === "'") {
        inSingleString = true;
        cleanCode += ' ';
        i++;
        continue;
      }

      if (char === '"') {
        inDoubleString = true;
        cleanCode += ' ';
        i++;
        continue;
      }

      if (char === '`') {
        inTemplateString = true;
        cleanCode += ' ';
        i++;
        continue;
      }

      // Open brace
      if (char === '{') {
        depth++;
        cleanCode += '{';
        i++;
        continue;
      }

      // Close brace
      if (char === '}') {
        depth = Math.max(0, depth - 1);
        if (
          templateExpressionDepths.length > 0 &&
          depth === templateExpressionDepths[templateExpressionDepths.length - 1]
        ) {
          templateExpressionDepths.pop();
          inTemplateString = true;
        }
        cleanCode += '}';
        i++;
        continue;
      }

      cleanCode += char;
      i++;
    }

    scannedLines.push({
      lineNumber: idx + 1,
      startDepth: lineStartDepth,
      endDepth: depth,
      cleanCode,
      rawLine,
    });
  }

  const isBalanced =
    depth === 0 &&
    !inBlockComment &&
    !inSingleString &&
    !inDoubleString &&
    !inTemplateString &&
    templateExpressionDepths.length === 0;

  return {
    lines: scannedLines,
    isBalanced,
  };
}
