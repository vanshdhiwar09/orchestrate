import type { ArtifactSymbol } from '../manifest/types.js';
import { scanLexicalStructure } from './lexical-scanner.js';

/**
 * Normalizes a declaration signature snippet:
 * - Strips implementation body block ({ ... })
 * - Strips line and block comments
 * - Strips trailing semicolons
 * - Collapses consecutive whitespace to a single space
 */
export function normalizeSignature(rawLine: string): string {
  let sig = rawLine
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/, '');

  const braceIdx = sig.indexOf('{');
  if (braceIdx !== -1) {
    sig = sig.slice(0, braceIdx);
  }

  sig = sig.replace(/;+\s*$/, '').trim();
  return sig.replace(/\s+/g, ' ');
}

/**
 * Deterministically parses top-level declarations and direct class/interface
 * methods from TypeScript/JavaScript source code according to the frozen precedence rules.
 */
export function parseSourceSymbols(sourceText: string): ArtifactSymbol[] {
  const scan = scanLexicalStructure(sourceText);

  // Requirement 8: If declaration boundaries cannot be safely determined
  // because lexical structure is unbalanced, return empty symbols.
  if (!scan.isBalanced) {
    return [];
  }

  const symbols: ArtifactSymbol[] = [];
  const seenNames = new Set<string>();

  function addSymbol(name: string, kind: ArtifactSymbol['kind'], signature?: string): void {
    if (!name || seenNames.has(name)) {
      return;
    }
    seenNames.add(name);
    symbols.push({
      name,
      kind,
      ...(signature ? { signature } : {}),
    });
  }

  let activeContainer: { kind: 'class' | 'interface'; name: string } | null = null;

  for (const line of scan.lines) {
    const text = line.cleanCode.trim();
    const raw = line.rawLine.trim();

    if (!text) {
      continue;
    }

    // Reset container when returning to top-level
    if (line.startDepth === 0) {
      activeContainer = null;
    }

    // ── 1. Top-Level Declarations (depth === 0) ─────────────────────────────
    if (line.startDepth === 0) {
      // 1. Function declaration
      const funcMatch = text.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z0-9_$]+)/
      );
      if (funcMatch) {
        addSymbol(funcMatch[1], 'function', normalizeSignature(raw));
        continue;
      }

      // 2. Class declaration
      const classMatch = text.match(
        /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/
      );
      if (classMatch) {
        const className = classMatch[1];
        addSymbol(className, 'class', normalizeSignature(raw));
        activeContainer = { kind: 'class', name: className };
        continue;
      }

      // 3. Interface declaration
      const interfaceMatch = text.match(/^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/);
      if (interfaceMatch) {
        const interfaceName = interfaceMatch[1];
        addSymbol(interfaceName, 'interface', normalizeSignature(raw));
        activeContainer = { kind: 'interface', name: interfaceName };
        continue;
      }

      // 4. Type alias declaration
      const typeMatch = text.match(
        /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*=/
      );
      if (typeMatch) {
        addSymbol(typeMatch[1], 'type', normalizeSignature(raw));
        continue;
      }

      // 5. Arrow-function variable (precedence before ordinary variable)
      const arrowMatch = text.match(
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/
      );
      if (arrowMatch) {
        addSymbol(arrowMatch[1], 'function', normalizeSignature(raw));
        continue;
      }

      // 6. Ordinary variable declaration
      const varMatch = text.match(
        /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::\s*[^=]+)?\s*=/
      );
      if (varMatch) {
        addSymbol(varMatch[1], 'variable', normalizeSignature(raw));
        continue;
      }

      // 7. Export specifiers list: export { foo, bar as baz }
      const exportListMatch = text.match(/^export\s*\{([^}]+)\}/);
      if (exportListMatch) {
        const specifiers = exportListMatch[1].split(',');
        for (const spec of specifiers) {
          const item = spec.trim();
          if (!item) continue;
          if (item.includes(' as ')) {
            const parts = item.split(/\s+as\s+/);
            const exportedName = parts[1]?.trim();
            if (exportedName) {
              addSymbol(exportedName, 'export');
            }
          } else {
            addSymbol(item, 'export');
          }
        }
        continue;
      }

      // Wildcard export: export * from '...' -> strictly no symbols in V1
      if (text.startsWith('export *')) {
        continue;
      }
    }

    // ── 2. Direct Class / Interface Methods (depth === 1) ───────────────────
    if (line.startDepth === 1 && activeContainer !== null) {
      // Exclude private methods
      if (/\bprivate\b/.test(text) || text.includes('#')) {
        continue;
      }

      // Exclude constructor
      if (/^constructor\s*\(/.test(text) || /\bconstructor\s*\(/.test(text)) {
        continue;
      }

      // Match method declaration header
      const methodMatch = text.match(
        /^(?:public\s+|protected\s+|static\s+|async\s+|readonly\s+|override\s+|get\s+|set\s+)*([A-Za-z0-9_$]+)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?/
      );

      if (methodMatch) {
        const methodName = methodMatch[1];
        if (methodName !== 'constructor' && !methodName.startsWith('#')) {
          addSymbol(methodName, 'method', normalizeSignature(raw));
          continue;
        }
      }
    }
  }

  return symbols;
}
