export interface ModuleResolutionCheckOptions {
  enforceEsmExtensions?: boolean;
  allowTsExtensions?: boolean;
  allowedExtensions?: string[];
}

export interface ModuleResolutionIssue {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

export interface ModuleResolutionReport {
  passed: boolean;
  active: boolean;
  checkedFilesCount: number;
  issues: ModuleResolutionIssue[];
  summary: string;
}

const DEFAULT_TS_ALLOWED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
];

const DEFAULT_JS_ONLY_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];

/**
 * Strips comments and non-import string literals while preserving exact character
 * offsets and line numbers across the content.
 * Only module specifiers immediately following `from`, `import(`, or `import` are preserved.
 */
function stripCommentsAndNonImportStrings(content: string): string {
  const chars = content.split('');
  const n = chars.length;
  let i = 0;

  while (i < n) {
    // 1. Single-line comment: //
    if (chars[i] === '/' && chars[i + 1] === '/') {
      while (i < n && chars[i] !== '\n' && chars[i] !== '\r') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    // 2. Multi-line comment: /* ... */
    if (chars[i] === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < n && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n' && chars[i] !== '\r') {
          chars[i] = ' ';
        }
        i++;
      }
      if (i < n) {
        chars[i] = ' '; // '*'
        if (i + 1 < n) chars[i + 1] = ' '; // '/'
        i += 2;
      }
      continue;
    }

    // 3. String literals: ', ", or `
    if (chars[i] === "'" || chars[i] === '"' || chars[i] === '`') {
      const quote = chars[i];
      const startQuoteIdx = i;

      // Look back to see what token preceded the string quote
      let back = startQuoteIdx - 1;
      while (back >= 0 && /\s/.test(content[back])) {
        back--;
      }

      let isImportSpecifier = false;
      if (back >= 3 && content.slice(back - 3, back + 1) === 'from') {
        // Preceded by keyword "from"
        isImportSpecifier = true;
      } else if (back >= 0 && content[back] === '(') {
        // Check if "(" is preceded by "import"
        let beforeParen = back - 1;
        while (beforeParen >= 0 && /\s/.test(content[beforeParen])) {
          beforeParen--;
        }
        if (beforeParen >= 5 && content.slice(beforeParen - 5, beforeParen + 1) === 'import') {
          isImportSpecifier = true;
        }
      } else if (back >= 5 && content.slice(back - 5, back + 1) === 'import') {
        // Preceded by keyword "import" (side-effect import: import './path')
        isImportSpecifier = true;
      }

      i++; // advance past opening quote
      while (i < n && chars[i] !== quote) {
        if (chars[i] === '\\' && i + 1 < n) {
          if (!isImportSpecifier) {
            chars[i] = ' ';
            if (chars[i + 1] !== '\n' && chars[i + 1] !== '\r') {
              chars[i + 1] = ' ';
            }
          }
          i += 2;
        } else {
          if (!isImportSpecifier && chars[i] !== '\n' && chars[i] !== '\r') {
            chars[i] = ' ';
          }
          i++;
        }
      }
      if (i < n) {
        i++; // advance past closing quote
      }
      continue;
    }

    i++;
  }

  return chars.join('');
}

/**
 * Validates relative import specifiers in a single file content.
 * Robust against single-line, multiline, dynamic, type-only, side-effect, and re-export statements.
 * Also flags unsupported dynamic-import expressions that cannot be verified statically.
 */
export function validateRelativeImportsInContent(
  filePath: string,
  content: string,
  options?: ModuleResolutionCheckOptions
): ModuleResolutionIssue[] {
  const allowTs = options?.allowTsExtensions ?? true;
  const allowedExts =
    options?.allowedExtensions ??
    (allowTs ? DEFAULT_TS_ALLOWED_EXTENSIONS : DEFAULT_JS_ONLY_EXTENSIONS);

  const issues: ModuleResolutionIssue[] = [];
  const seenIssues = new Set<string>();

  // Check for unsupported dynamic-import expressions (non-literal argument)
  const dynamicPattern = /\bimport\s*\(\s*([^)]+)\)/g;
  let dynamicMatch: RegExpExecArray | null;
  while ((dynamicMatch = dynamicPattern.exec(content)) !== null) {
    const rawExpr = dynamicMatch[1].trim();
    if (!rawExpr) continue;

    const isStringLiteral =
      (rawExpr.startsWith("'") && rawExpr.endsWith("'") && rawExpr.length >= 2) ||
      (rawExpr.startsWith('"') && rawExpr.endsWith('"') && rawExpr.length >= 2);

    if (!isStringLiteral) {
      const line = content.slice(0, dynamicMatch.index).split(/\r?\n/).length;
      const dedupeKey = `${line}:dynamic:${rawExpr}`;
      if (!seenIssues.has(dedupeKey)) {
        seenIssues.add(dedupeKey);
        issues.push({
          file: filePath,
          line,
          specifier: rawExpr,
          reason: `Dynamic import with non-literal expression "${rawExpr}" cannot be statically verified for explicit ESM extensions and cannot be represented as verified coverage.`,
        });
      }
    }
  }

  // Clean code: comments and non-import strings stripped preserving exact character offsets
  const cleanedContent = stripCommentsAndNonImportStrings(content);

  // Discrete import/export patterns matching statement syntax
  const patterns: RegExp[] = [
    // 1. Static import with from clause (single or multiline)
    /\bimport\s+(?:type\s+)?(?:(?:[\w$]+|\*\s+as\s+[\w$]+|\{[^}]*\}|(?:[\w$]+\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+)))\s+from\s+)['"]([^'"]+)['"]/g,
    // 2. Side-effect static import
    /(?:^|[\r\n;])\s*import\s+['"]([^'"]+)['"]/g,
    // 3. Dynamic import call with string literal
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // 4. Re-export with from clause (single or multiline)
    /\bexport\s+(?:type\s+)?(?:\*|\*\s+as\s+[\w$]+|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleanedContent)) !== null) {
      const specifier = match[1];
      if (!specifier) continue;

      // Only evaluate relative imports
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        continue;
      }

      // Calculate exact line number where the specifier appears
      const specifierOffset = match[0].lastIndexOf(specifier);
      const absoluteCharIndex = match.index + (specifierOffset >= 0 ? specifierOffset : 0);
      const line = content.slice(0, absoluteCharIndex).split(/\r?\n/).length;

      const dedupeKey = `${line}:${specifier}`;
      if (seenIssues.has(dedupeKey)) {
        continue;
      }
      seenIssues.add(dedupeKey);

      // Extract file extension from the last path segment
      const lastSegment = specifier.split('/').pop() || '';
      const extMatch = lastSegment.match(/\.[a-zA-Z0-9]+$/);
      const ext = extMatch ? extMatch[0].toLowerCase() : '';

      if (!ext) {
        issues.push({
          file: filePath,
          line,
          specifier,
          reason: `Relative import "${specifier}" is missing an explicit file extension. Under NodeNext moduleResolution in an ESM repository, relative imports must include an explicit extension (e.g. "${specifier}.ts" or "${specifier}.js").`,
        });
      } else if (!allowedExts.includes(ext)) {
        if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
          issues.push({
            file: filePath,
            line,
            specifier,
            reason: `Relative import "${specifier}" uses TypeScript extension "${ext}", but allowImportingTsExtensions is not enabled in tsconfig.json.`,
          });
        } else {
          issues.push({
            file: filePath,
            line,
            specifier,
            reason: `Relative import "${specifier}" has unsupported extension "${ext}". Allowed: ${allowedExts.join(', ')}.`,
          });
        }
      }
    }
  }

  // Sort issues stably by line number
  issues.sort((a, b) => a.line - b.line);

  return issues;
}

/**
 * Detects whether the repository's configuration mandates explicit ESM import extensions.
 */
export async function detectRepositoryModuleResolutionRule(
  readFile: (path: string) => Promise<string | null>
): Promise<ModuleResolutionCheckOptions | null> {
  let isEsm = false;
  let pkgRaw: string | null = null;
  try {
    pkgRaw = await readFile('package.json');
  } catch (err: unknown) {
    throw new Error(
      `Failed to read package.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (pkgRaw !== null) {
    let pkg: any;
    try {
      pkg = JSON.parse(pkgRaw);
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    isEsm = pkg?.type === 'module';
  }

  let tsconfigRaw: string | null = null;
  try {
    tsconfigRaw = await readFile('tsconfig.json');
  } catch (err: unknown) {
    throw new Error(
      `Failed to read tsconfig.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let isNodeNext = false;
  let allowTsExtensions = false;

  if (tsconfigRaw !== null) {
    let tsconfig: any;
    try {
      // Strip comments
      const stripped = tsconfigRaw
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
        .replace(/,\s*([}\]])/g, '$1');
      tsconfig = JSON.parse(stripped);
    } catch (err: unknown) {
      throw new Error(
        `Failed to parse tsconfig.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const opts = tsconfig?.compilerOptions || {};
    const mod = String(opts.module || '').toLowerCase();
    const res = String(opts.moduleResolution || '').toLowerCase();

    if (
      mod === 'nodenext' ||
      mod === 'node16' ||
      res === 'nodenext' ||
      res === 'node16'
    ) {
      isNodeNext = true;
    }
    allowTsExtensions = Boolean(opts.allowImportingTsExtensions);
  }

  if (!isEsm || !isNodeNext) {
    return null;
  }

  return {
    enforceEsmExtensions: true,
    allowTsExtensions,
  };
}

/**
 * Verifies that relative import specifiers in candidate files satisfy the
 * repository's configured module resolution contract.
 */
export async function verifyModuleResolution(
  readFile: (path: string) => Promise<string | null>,
  candidateFiles: string[],
  optionsOverride?: ModuleResolutionCheckOptions
): Promise<ModuleResolutionReport> {
  const options =
    optionsOverride ?? (await detectRepositoryModuleResolutionRule(readFile));

  if (!options || options.enforceEsmExtensions === false) {
    return {
      passed: true,
      active: false,
      checkedFilesCount: 0,
      issues: [],
      summary:
        'Module-resolution check skipped: repository configuration does not require explicit NodeNext ESM import extensions.',
    };
  }

  const allIssues: ModuleResolutionIssue[] = [];
  let checkedCount = 0;

  for (const filePath of candidateFiles) {
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx') && !filePath.endsWith('.js')) {
      continue;
    }
    const content = await readFile(filePath);
    if (content === null) continue;

    checkedCount++;
    const issues = validateRelativeImportsInContent(filePath, content, options);
    allIssues.push(...issues);
  }

  const passed = allIssues.length === 0;
  const summary = passed
    ? `Module-resolution check passed across ${checkedCount} files.`
    : `Module-resolution check failed with ${allIssues.length} issue(s) across ${checkedCount} file(s).`;

  return {
    passed,
    active: true,
    checkedFilesCount: checkedCount,
    issues: allIssues,
    summary,
  };
}
