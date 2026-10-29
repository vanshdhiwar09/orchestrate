import type { ProjectFact } from '@orchestrate/brain';
import type {
  ConventionNature,
  EnvironmentConventionItem,
  EnvironmentConventions,
} from './types.js';

export interface RepositoryConventionExtractorOptions {
  readFile: (relativePath: string) => Promise<string | null>;
  candidateFiles?: string[];
  existingFacts?: ProjectFact[];
}

/**
 * Strips single-line and multi-line comments from text.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
}

/**
 * Parses JSON with permissive comment stripping for configs like tsconfig.json.
 */
function parseJsonLenient(raw: string): any {
  const stripped = stripComments(raw).trim();
  // Remove trailing commas before closing braces/brackets
  const clean = stripped.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(clean);
}

/**
 * Deterministic extractor for relevant repository environment conventions.
 *
 * Adheres to Orchestrate hierarchy:
 * CODE > VERIFICATION EVIDENCE > PROJECT BRAIN > AGENT CLAIMS
 *
 * Distinguishes explicit configuration (from package.json / tsconfig.json)
 * from inferred conventions (observed from source/test files).
 * Never fabricates settings or overwrites verified Brain facts with weaker heuristics.
 */
export class RepositoryConventionExtractor {
  public static async extract(
    options: RepositoryConventionExtractorOptions
  ): Promise<EnvironmentConventions> {
    const items: EnvironmentConventionItem[] = [];

    // ------------------------------------------------------------------------
    // 1. Explicit Configuration from package.json
    // ------------------------------------------------------------------------
    try {
      const packageJsonRaw = await options.readFile('package.json');
      if (packageJsonRaw !== null) {
        const pkg = parseJsonLenient(packageJsonRaw);
        if (pkg && typeof pkg === 'object') {
          if (pkg.type === 'module') {
            items.push({
              key: 'module_system',
              value: 'ESM (type: "module")',
              nature: 'EXPLICIT_CONFIG',
              provenance: 'package.json#type',
            });
          } else if (pkg.type === 'commonjs') {
            items.push({
              key: 'module_system',
              value: 'CommonJS',
              nature: 'EXPLICIT_CONFIG',
              provenance: 'package.json#type',
            });
          }
        }
      }
    } catch {
      // Malformed or inaccessible package.json; do not fabricate
    }

    // ------------------------------------------------------------------------
    // 2. Explicit Configuration from tsconfig.json
    // ------------------------------------------------------------------------
    let explicitTypeImportConvention: EnvironmentConventionItem | null = null;
    try {
      const tsconfigRaw = await options.readFile('tsconfig.json');
      if (tsconfigRaw !== null) {
        const tsconfig = parseJsonLenient(tsconfigRaw);
        const compilerOptions = tsconfig?.compilerOptions;
        if (compilerOptions && typeof compilerOptions === 'object') {
          if (compilerOptions.module !== undefined) {
            items.push({
              key: 'module',
              value: String(compilerOptions.module),
              nature: 'EXPLICIT_CONFIG',
              provenance: 'tsconfig.json#compilerOptions.module',
            });
          }
          if (compilerOptions.moduleResolution !== undefined) {
            items.push({
              key: 'module_resolution',
              value: String(compilerOptions.moduleResolution),
              nature: 'EXPLICIT_CONFIG',
              provenance: 'tsconfig.json#compilerOptions.moduleResolution',
            });
          }
          if (compilerOptions.allowImportingTsExtensions !== undefined) {
            items.push({
              key: 'allow_importing_ts_extensions',
              value: String(compilerOptions.allowImportingTsExtensions),
              nature: 'EXPLICIT_CONFIG',
              provenance: 'tsconfig.json#compilerOptions.allowImportingTsExtensions',
            });
          }

          // Modern TypeScript runtimes executing TypeScript directly without emit (Node.js 22/24 type-stripping)
          // require type-only imports for interfaces and type aliases.
          if (
            compilerOptions.allowImportingTsExtensions === true ||
            compilerOptions.allowImportingTsExtensions === 'true' ||
            compilerOptions.verbatimModuleSyntax === true ||
            compilerOptions.verbatimModuleSyntax === 'true'
          ) {
            const flag =
              compilerOptions.allowImportingTsExtensions === true ||
              compilerOptions.allowImportingTsExtensions === 'true'
                ? 'allowImportingTsExtensions'
                : 'verbatimModuleSyntax';
            explicitTypeImportConvention = {
              key: 'type_import_convention',
              value:
                'Use "import type" for TypeScript interfaces and type aliases; use standard "import" only for runtime values (functions, classes, constants). Node.js type-stripping removes type declarations at runtime.',
              nature: 'EXPLICIT_CONFIG',
              provenance: `tsconfig.json#compilerOptions.${flag}`,
            };
          }
        }
      }
    } catch {
      // Malformed or inaccessible tsconfig.json; do not fabricate
    }

    // ------------------------------------------------------------------------
    // 3. Inferred Conventions from Source and Test Files
    // ------------------------------------------------------------------------
    let inferredImportConvention: EnvironmentConventionItem | null = null;
    let inferredTypeImportConvention: EnvironmentConventionItem | null = null;
    if (options.candidateFiles && options.candidateFiles.length > 0) {
      let tsCount = 0;
      let jsCount = 0;
      let noneCount = 0;
      const observedLocations: string[] = [];
      const typeLocations: string[] = [];
      let hasTypeImportsOrExports = false;

      for (const entry of options.candidateFiles) {
        const filePath = typeof entry === 'string' ? entry : (entry as any)?.path;
        if (!filePath || typeof filePath !== 'string') {
          continue;
        }
        if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx') && !filePath.endsWith('.js')) {
          continue;
        }

        try {
          const content = await options.readFile(filePath);
          if (content === null) continue;

          const lines = content.split('\n');
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const rawLine = lines[lineIndex];
            // Skip commented lines
            const line = stripComments(rawLine).trim();
            if (!line) continue;

            const loc = `${filePath}:${lineIndex + 1}`;

            // Check for type imports or interface/type declarations
            if (/\bimport\s+type\b|\bimport\s*\{[^}]*\btype\s+/.test(line)) {
              hasTypeImportsOrExports = true;
              typeLocations.push(loc);
            }
            if (/^\s*export\s+(?:interface|type)\s+/.test(line)) {
              hasTypeImportsOrExports = true;
              typeLocations.push(loc);
            }

            // Match relative imports/exports: from './...' or from '../...'
            const importMatch = line.match(
              /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/
            );
            if (importMatch && importMatch[1]) {
              const specifier = importMatch[1];

              if (specifier.endsWith('.ts') || specifier.endsWith('.tsx')) {
                tsCount++;
                observedLocations.push(loc);
              } else if (specifier.endsWith('.js') || specifier.endsWith('.mjs')) {
                jsCount++;
                observedLocations.push(loc);
              } else {
                noneCount++;
                observedLocations.push(loc);
              }
            }
          }
        } catch {
          // Inaccessible file; skip
        }
      }

      if (hasTypeImportsOrExports && !explicitTypeImportConvention) {
        inferredTypeImportConvention = {
          key: 'type_import_convention',
          value:
            'Use "import type" for TypeScript interfaces and type aliases; use standard "import" only for runtime values (functions, classes, constants). Node.js type-stripping removes type declarations at runtime.',
          nature: 'INFERRED_CONVENTION',
          provenance: typeLocations.slice(0, 3).join(', '),
        };
      }

      const total = tsCount + jsCount + noneCount;
      if (total > 0) {
        const provenanceSample = observedLocations.slice(0, 3).join(', ');
        if (tsCount === total) {
          inferredImportConvention = {
            key: 'relative_import_extensions',
            value: `explicit .ts extension (observed in ${tsCount} of ${total} relative imports)`,
            nature: 'INFERRED_CONVENTION',
            provenance: provenanceSample,
          };
        } else if (jsCount === total) {
          inferredImportConvention = {
            key: 'relative_import_extensions',
            value: `explicit .js extension (observed in ${jsCount} of ${total} relative imports)`,
            nature: 'INFERRED_CONVENTION',
            provenance: provenanceSample,
          };
        } else if (noneCount === total) {
          inferredImportConvention = {
            key: 'relative_import_extensions',
            value: `extensionless relative imports (observed in ${noneCount} of ${total} relative imports)`,
            nature: 'INFERRED_CONVENTION',
            provenance: provenanceSample,
          };
        } else {
          inferredImportConvention = {
            key: 'relative_import_extensions',
            value: `mixed relative import extensions (${tsCount} .ts, ${jsCount} .js, ${noneCount} none)`,
            nature: 'INFERRED_CONVENTION',
            provenance: provenanceSample,
          };
        }
      }
    }

    // ------------------------------------------------------------------------
    // 4. Merge with Existing Project Brain Facts (Preserving Hierarchy)
    // ------------------------------------------------------------------------
    // Hierarchy: CODE > VERIFICATION EVIDENCE > PROJECT BRAIN > AGENT CLAIMS
    // 1. Direct CODE evidence always outranks Brain facts where they conflict.
    // 2. Verified Brain facts serve as authoritative fallbacks when direct CODE
    //    files or conventions are absent.
    // 3. Inferred conventions are NEVER promoted to EXPLICIT_CONFIG.

    // 4a. Relative import extensions
    const brainRelFact = options.existingFacts?.find(
      (f) =>
        f.status === 'VERIFIED' &&
        (f.key === 'global.env.relative_import_extensions' ||
          f.key === 'relative_import_extensions')
    );

    if (inferredImportConvention) {
      if (brainRelFact && brainRelFact.value !== inferredImportConvention.value) {
        // Direct CODE observation outranks stale Brain fact; surface provenance accurately
        items.push({
          key: 'relative_import_extensions',
          value: inferredImportConvention.value,
          nature: 'INFERRED_CONVENTION',
          provenance: `${inferredImportConvention.provenance} (current CODE outranks stale ProjectBrain#${brainRelFact.key})`,
        });
      } else {
        items.push(inferredImportConvention);
      }
    } else if (brainRelFact) {
      // Fallback to Brain fact when direct source files are absent
      items.push({
        key: 'relative_import_extensions',
        value: brainRelFact.value,
        nature: brainRelFact.provenance === 'CODE' ? 'EXPLICIT_CONFIG' : 'INFERRED_CONVENTION',
        provenance: `ProjectBrain#${brainRelFact.key} (${brainRelFact.provenance})`,
      });
    }

    // 4b. Type-only import convention
    const chosenTypeConvention = explicitTypeImportConvention ?? inferredTypeImportConvention;
    const brainTypeFact = options.existingFacts?.find(
      (f) =>
        f.status === 'VERIFIED' &&
        (f.key === 'global.env.type_import_convention' || f.key === 'type_import_convention')
    );

    if (chosenTypeConvention) {
      if (brainTypeFact && brainTypeFact.value !== chosenTypeConvention.value) {
        items.push({
          key: 'type_import_convention',
          value: chosenTypeConvention.value,
          nature: chosenTypeConvention.nature,
          provenance: `${chosenTypeConvention.provenance} (current CODE outranks stale ProjectBrain#${brainTypeFact.key})`,
        });
      } else {
        items.push(chosenTypeConvention);
      }
    } else if (brainTypeFact) {
      items.push({
        key: 'type_import_convention',
        value: brainTypeFact.value,
        nature: brainTypeFact.provenance === 'CODE' ? 'EXPLICIT_CONFIG' : 'INFERRED_CONVENTION',
        provenance: `ProjectBrain#${brainTypeFact.key} (${brainTypeFact.provenance})`,
      });
    }

    // 4c. Fallbacks for missing package.json / tsconfig.json settings from Brain
    const configKeys = [
      { key: 'module_system', brainKey: 'global.env.module_system' },
      { key: 'module', brainKey: 'global.env.module' },
      { key: 'module_resolution', brainKey: 'global.env.module_resolution' },
      { key: 'allow_importing_ts_extensions', brainKey: 'global.env.allow_importing_ts_extensions' },
      { key: 'type_import_convention', brainKey: 'global.env.type_import_convention' },
    ];

    for (const mapping of configKeys) {
      const alreadyPresent = items.some((i) => i.key === mapping.key);
      if (!alreadyPresent) {
        const brainFact = options.existingFacts?.find(
          (f) => f.status === 'VERIFIED' && (f.key === mapping.brainKey || f.key === mapping.key)
        );
        if (brainFact) {
          items.push({
            key: mapping.key,
            value: brainFact.value,
            nature: brainFact.provenance === 'CODE' ? 'EXPLICIT_CONFIG' : 'INFERRED_CONVENTION',
            provenance: `ProjectBrain#${brainFact.key} (${brainFact.provenance})`,
          });
        }
      }
    }

    // Sort items stably by key
    items.sort((a, b) => a.key.localeCompare(b.key));

    return { items };
  }
}
