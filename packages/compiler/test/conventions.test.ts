import { describe, expect, it } from 'vitest';
import type { ProjectFact } from '@orchestrate/brain';
import {
  ContextCompilerCore,
  ContextSerializer,
  RepositoryConventionExtractor,
} from '../src/index.js';
import { createMockSnapshot } from './fixtures.js';

describe('RepositoryConventionExtractor & Context Serialization', () => {
  it('1. extracts explicit configuration from package.json and tsconfig.json', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({
        name: 'sample-project',
        type: 'module',
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowImportingTsExtensions: true,
        },
      }),
    };

    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async (p) => files[p] ?? null,
    });

    expect(conventions.items).toHaveLength(5);
    const byKey = Object.fromEntries(conventions.items.map((i) => [i.key, i]));

    expect(byKey['module_system']).toEqual({
      key: 'module_system',
      value: 'ESM (type: "module")',
      nature: 'EXPLICIT_CONFIG',
      provenance: 'package.json#type',
    });

    expect(byKey['module']).toEqual({
      key: 'module',
      value: 'NodeNext',
      nature: 'EXPLICIT_CONFIG',
      provenance: 'tsconfig.json#compilerOptions.module',
    });

    expect(byKey['module_resolution']).toEqual({
      key: 'module_resolution',
      value: 'NodeNext',
      nature: 'EXPLICIT_CONFIG',
      provenance: 'tsconfig.json#compilerOptions.moduleResolution',
    });

    expect(byKey['allow_importing_ts_extensions']).toEqual({
      key: 'allow_importing_ts_extensions',
      value: 'true',
      nature: 'EXPLICIT_CONFIG',
      provenance: 'tsconfig.json#compilerOptions.allowImportingTsExtensions',
    });

    expect(byKey['type_import_convention']).toEqual({
      key: 'type_import_convention',
      value:
        'Use "import type" for TypeScript interfaces and type aliases; use standard "import" only for runtime values (functions, classes, constants). Node.js type-stripping removes type declarations at runtime.',
      nature: 'EXPLICIT_CONFIG',
      provenance: 'tsconfig.json#compilerOptions.allowImportingTsExtensions',
    });
  });

  it('2. handles missing or unparseable configuration gracefully without fabrication', async () => {
    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async () => null,
    });

    expect(conventions.items).toEqual([]);
  });

  it('3. extracts inferred relative import conventions from source and test files', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'module' }),
      'src/users.ts': `import type { User } from './types.ts';\nexport const USERS = {};`,
      'src/middleware/auth.ts': `import { USERS } from '../users.ts';\nimport type { UserPayload } from '../types.ts';`,
      'test/auth.test.ts': `import { auth } from '../src/middleware/auth.ts';`,
    };

    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async (p) => files[p] ?? null,
      candidateFiles: Object.keys(files),
    });

    const relItem = conventions.items.find((i) => i.key === 'relative_import_extensions');
    expect(relItem).toBeDefined();
    expect(relItem?.nature).toBe('INFERRED_CONVENTION');
    expect(relItem?.value).toContain('explicit .ts extension (observed in 4 of 4 relative imports)');
    expect(relItem?.provenance).toContain('src/users.ts:1');
    expect(relItem?.provenance).toContain('src/middleware/auth.ts:1');
  });

  it('4. accurately reports conflicting evidence when import conventions are mixed', async () => {
    const files: Record<string, string> = {
      'src/a.ts': `import { b } from './b.ts';`,
      'src/c.ts': `import { d } from './d';`,
      'src/e.ts': `import { f } from './f.js';`,
    };

    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async (p) => files[p] ?? null,
      candidateFiles: Object.keys(files),
    });

    const relItem = conventions.items.find((i) => i.key === 'relative_import_extensions');
    expect(relItem).toBeDefined();
    expect(relItem?.nature).toBe('INFERRED_CONVENTION');
    expect(relItem?.value).toBe('mixed relative import extensions (1 .ts, 1 .js, 1 none)');
  });

  it('5. preserves hierarchy: current CODE outranks stale Brain facts where they conflict', async () => {
    const files: Record<string, string> = {
      'src/c.ts': `import { d } from './d.ts';`,
    };

    // Stale Brain fact claiming something different
    const staleBrainFact: ProjectFact = {
      key: 'global.env.relative_import_extensions',
      value: 'extensionless relative imports',
      provenance: 'AGENT',
      status: 'VERIFIED',
      recordedAt: '2026-09-01T12:00:00.000Z',
    };

    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async (p) => files[p] ?? null,
      candidateFiles: Object.keys(files),
      existingFacts: [staleBrainFact],
    });

    const relItem = conventions.items.find((i) => i.key === 'relative_import_extensions');
    expect(relItem).toBeDefined();
    expect(relItem?.nature).toBe('INFERRED_CONVENTION');
    expect(relItem?.value).toContain('explicit .ts extension (observed in 1 of 1 relative imports)');
    expect(relItem?.provenance).toContain('current CODE outranks stale ProjectBrain#global.env.relative_import_extensions');
  });

  it('6. uses verified Brain facts as authoritative fallback when direct source files are absent', async () => {
    const brainFact: ProjectFact = {
      key: 'global.env.relative_import_extensions',
      value: 'explicit .ts extension',
      provenance: 'CODE',
      status: 'VERIFIED',
      recordedAt: '2026-10-01T12:00:00.000Z',
    };

    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async () => null,
      candidateFiles: [],
      existingFacts: [brainFact],
    });

    const relItem = conventions.items.find((i) => i.key === 'relative_import_extensions');
    expect(relItem).toBeDefined();
    expect(relItem?.nature).toBe('EXPLICIT_CONFIG');
    expect(relItem?.value).toBe('explicit .ts extension');
    expect(relItem?.provenance).toContain('ProjectBrain#global.env.relative_import_extensions (CODE)');
  });

  it('7. serializes compact <environment_conventions> section into XML context', async () => {
    const conventions = {
      items: [
        {
          key: 'module_resolution',
          value: 'NodeNext',
          nature: 'EXPLICIT_CONFIG' as const,
          provenance: 'tsconfig.json#compilerOptions.moduleResolution',
        },
        {
          key: 'relative_import_extensions',
          value: 'explicit .ts extension (observed in 3 of 3 relative imports)',
          nature: 'INFERRED_CONVENTION' as const,
          provenance: 'src/users.ts:1, src/middleware/auth.ts:2',
        },
      ],
    };

    const snapshot = createMockSnapshot();
    snapshot.environmentConventions = conventions;

    const compiled = ContextCompilerCore.compile(snapshot);
    const xml = ContextSerializer.serialize(compiled);

    expect(xml).toContain('<environment_conventions>');
    expect(xml).toContain('</environment_conventions>');
    expect(xml).toContain(
      '<convention key="module_resolution" nature="EXPLICIT_CONFIG" provenance="tsconfig.json#compilerOptions.moduleResolution">NodeNext</convention>'
    );
    expect(xml).toContain(
      '<convention key="relative_import_extensions" nature="INFERRED_CONVENTION" provenance="src/users.ts:1, src/middleware/auth.ts:2">explicit .ts extension (observed in 3 of 3 relative imports)</convention>'
    );
  });

  it('8. extracts inferred type_import_convention when candidate files contain interfaces or type imports', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'module' }),
      'src/types.ts': `export interface ValidationResult { valid: boolean; errors: string[]; }\nexport interface UserProfile { name: string; }`,
      'test/sample.test.ts': `import type { ValidationResult } from '../src/types.ts';`,
    };

    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async (p) => files[p] ?? null,
      candidateFiles: Object.keys(files),
    });

    const item = conventions.items.find((i) => i.key === 'type_import_convention');
    expect(item).toBeDefined();
    expect(item?.nature).toBe('INFERRED_CONVENTION');
    expect(item?.value).toContain('Use "import type" for TypeScript interfaces');
    expect(item?.provenance).toContain('src/types.ts:1');
  });

  it('9. preserves hierarchy for type_import_convention: CODE outranks stale Brain fact', async () => {
    const files: Record<string, string> = {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { allowImportingTsExtensions: true },
      }),
    };

    const staleFact: ProjectFact = {
      key: 'type_import_convention',
      value: 'standard import only',
      provenance: 'AGENT',
      status: 'VERIFIED',
      recordedAt: '2026-09-01T12:00:00.000Z',
    };

    const conventions = await RepositoryConventionExtractor.extract({
      readFile: async (p) => files[p] ?? null,
      existingFacts: [staleFact],
    });

    const item = conventions.items.find((i) => i.key === 'type_import_convention');
    expect(item).toBeDefined();
    expect(item?.nature).toBe('EXPLICIT_CONFIG');
    expect(item?.value).toContain('Use "import type"');
    expect(item?.provenance).toContain('current CODE outranks stale ProjectBrain#type_import_convention');
  });
});
