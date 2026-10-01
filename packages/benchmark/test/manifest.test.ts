import { describe, expect, it } from 'vitest';
import {
  canonicalizeManifest,
  createArtifactManifest,
  deserializeManifest,
  freezeManifest,
  serializeManifest,
  validateManifest,
  type ArtifactManifest,
  type ArtifactSymbolKind,
  type ArtifactFileStatus,
} from '../src/index.js';

describe('ArtifactManifest Domain', () => {
  const createValidManifest = (): ArtifactManifest => ({
    taskId: 'task-auth-middleware',
    attemptNumber: 1,
    createdAt: '2026-10-01T12:00:00.000Z',
    files: [
      {
        path: 'src/middleware/auth.ts',
        status: 'ADDED',
        symbols: [
          {
            name: 'authenticateToken',
            kind: 'function',
            signature:
              'export function authenticateToken(req: Request, res: Response, next: NextFunction): void',
          },
          {
            name: 'AuthRequest',
            kind: 'interface',
            signature: 'export interface AuthRequest extends Request { user?: UserPayload; }',
          },
        ],
      },
    ],
  });

  // 1. Valid manifest
  it('1. validates and creates a valid manifest', () => {
    const raw = createValidManifest();
    const manifest = createArtifactManifest(raw);

    expect(manifest.taskId).toBe('task-auth-middleware');
    expect(manifest.attemptNumber).toBe(1);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('src/middleware/auth.ts');
    expect(manifest.files[0].status).toBe('ADDED');
  });

  // 2. Empty task ID
  it('2. rejects empty or whitespace-only taskId', () => {
    const raw = createValidManifest();
    raw.taskId = '';
    expect(() => createArtifactManifest(raw)).toThrowError(/taskId must be a non-empty string/);

    raw.taskId = '   ';
    expect(() => createArtifactManifest(raw)).toThrowError(/taskId must be a non-empty string/);
  });

  // 3. Invalid attempt number
  it('3. rejects invalid attemptNumber (< 1, float, non-number)', () => {
    const raw = createValidManifest();

    raw.attemptNumber = 0;
    expect(() => createArtifactManifest(raw)).toThrowError(/attemptNumber must be a positive integer/);

    raw.attemptNumber = -1;
    expect(() => createArtifactManifest(raw)).toThrowError(/attemptNumber must be a positive integer/);

    raw.attemptNumber = 1.5;
    expect(() => createArtifactManifest(raw)).toThrowError(/attemptNumber must be a positive integer/);

    // @ts-expect-error testing invalid type
    raw.attemptNumber = '1';
    expect(() => createArtifactManifest(raw)).toThrowError(/attemptNumber must be a positive integer/);
  });

  // 4. Invalid timestamp
  it('4. rejects invalid createdAt timestamp (not ISO 8601 UTC)', () => {
    const raw = createValidManifest();

    raw.createdAt = 'not-a-timestamp';
    expect(() => createArtifactManifest(raw)).toThrowError(/createdAt must be a valid ISO 8601 UTC timestamp/);

    raw.createdAt = '2026-10-01 12:00:00';
    expect(() => createArtifactManifest(raw)).toThrowError(/createdAt must be a valid ISO 8601 UTC timestamp/);

    // Non-UTC timezone offset
    raw.createdAt = '2026-10-01T12:00:00+05:30';
    expect(() => createArtifactManifest(raw)).toThrowError(/createdAt must be a valid ISO 8601 UTC timestamp/);
  });

  // 5. Absolute paths
  it('5. rejects absolute file paths (POSIX and Windows drive letters)', () => {
    const raw1 = createValidManifest();
    raw1.files[0].path = '/src/middleware/auth.ts';
    expect(() => createArtifactManifest(raw1)).toThrowError(/must be repository-relative, not absolute/);

    const raw2 = createValidManifest();
    raw2.files[0].path = 'C:/src/middleware/auth.ts';
    expect(() => createArtifactManifest(raw2)).toThrowError(/must be repository-relative, not absolute/);
  });

  // 6. Traversal paths
  it('6. rejects directory traversal and relative segment paths', () => {
    const raw1 = createValidManifest();
    raw1.files[0].path = '../middleware/auth.ts';
    expect(() => createArtifactManifest(raw1)).toThrowError(/Path traversal denied/);

    const raw2 = createValidManifest();
    raw2.files[0].path = 'src/../../middleware/auth.ts';
    expect(() => createArtifactManifest(raw2)).toThrowError(/Path traversal denied/);

    const raw3 = createValidManifest();
    raw3.files[0].path = 'src/./middleware/auth.ts';
    expect(() => createArtifactManifest(raw3)).toThrowError(/Relative segment "\." is not permitted/);
  });

  // 7. Null bytes
  it('7. rejects paths containing null bytes', () => {
    const raw = createValidManifest();
    raw.files[0].path = 'src/middleware/\0auth.ts';
    expect(() => createArtifactManifest(raw)).toThrowError(/cannot contain null bytes/);
  });

  // 8. Backslash normalization
  it('8. normalizes Windows backslashes into canonical POSIX forward slashes', () => {
    const raw = createValidManifest();
    raw.files[0].path = 'src\\middleware\\auth.ts';

    const canonical = canonicalizeManifest(raw);
    expect(canonical.files[0].path).toBe('src/middleware/auth.ts');

    const manifest = createArtifactManifest(raw);
    expect(manifest.files[0].path).toBe('src/middleware/auth.ts');
  });

  // 9. Duplicate files
  it('9. rejects manifests containing duplicate file paths', () => {
    const raw = createValidManifest();
    raw.files.push({
      path: 'src/middleware/auth.ts',
      status: 'MODIFIED',
      symbols: [],
    });

    expect(() => createArtifactManifest(raw)).toThrowError(/Duplicate file path "src\/middleware\/auth\.ts"/);
  });

  // 10. Duplicate symbols
  it('10. rejects duplicate symbol names within the same file', () => {
    const raw = createValidManifest();
    raw.files[0].symbols.push({
      name: 'authenticateToken',
      kind: 'function',
    });

    expect(() => createArtifactManifest(raw)).toThrowError(/Duplicate symbol name "authenticateToken"/);
  });

  // 11. Empty symbol names
  it('11. rejects symbols with empty or whitespace-only names', () => {
    const raw = createValidManifest();
    raw.files[0].symbols[0].name = '';
    expect(() => createArtifactManifest(raw)).toThrowError(/Symbol name must be a non-empty string/);

    raw.files[0].symbols[0].name = '   ';
    expect(() => createArtifactManifest(raw)).toThrowError(/Symbol name must be a non-empty string/);
  });

  // 12. Invalid symbol kind
  it('12. rejects invalid symbol kinds', () => {
    const raw = createValidManifest();
    // @ts-expect-error testing invalid kind
    raw.files[0].symbols[0].kind = 'macro';
    expect(() => createArtifactManifest(raw)).toThrowError(/Invalid symbol kind "macro"/);
  });

  // 13. Invalid file status
  it('13. rejects invalid file statuses', () => {
    const raw = createValidManifest();
    // @ts-expect-error testing invalid status
    raw.files[0].status = 'DELETED';
    expect(() => createArtifactManifest(raw)).toThrowError(/Invalid file status "DELETED"/);
  });

  // 14. Deterministic file sorting
  it('14. canonicalizes files in deterministic ASCII ascending order', () => {
    const raw: ArtifactManifest = {
      taskId: 'task-test',
      attemptNumber: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
      files: [
        { path: 'src/z.ts', status: 'ADDED', symbols: [] },
        { path: 'src/a.ts', status: 'ADDED', symbols: [] },
        { path: 'src/m.ts', status: 'ADDED', symbols: [] },
      ],
    };

    const manifest = createArtifactManifest(raw);
    expect(manifest.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  // 15. Deterministic symbol sorting
  it('15. canonicalizes symbols within each file in deterministic ASCII ascending order', () => {
    const raw: ArtifactManifest = {
      taskId: 'task-test',
      attemptNumber: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
      files: [
        {
          path: 'src/symbols.ts',
          status: 'ADDED',
          symbols: [
            { name: 'zeta', kind: 'variable' },
            { name: 'alpha', kind: 'function' },
            { name: 'beta', kind: 'type' },
          ],
        },
      ],
    };

    const manifest = createArtifactManifest(raw);
    expect(manifest.files[0].symbols.map((s) => s.name)).toEqual(['alpha', 'beta', 'zeta']);
  });

  // 16. Deep immutability
  it('16. enforces deep immutability on manifest, files, and symbols', () => {
    const raw = createValidManifest();
    const manifest = createArtifactManifest(raw);

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.files)).toBe(true);
    expect(Object.isFrozen(manifest.files[0])).toBe(true);
    expect(Object.isFrozen(manifest.files[0].symbols)).toBe(true);
    expect(Object.isFrozen(manifest.files[0].symbols[0])).toBe(true);

    expect(() => {
      // @ts-expect-error testing mutation
      manifest.taskId = 'hacked';
    }).toThrow(TypeError);

    expect(() => {
      // @ts-expect-error testing mutation
      manifest.files.push({ path: 'src/new.ts', status: 'ADDED', symbols: [] });
    }).toThrow(TypeError);

    expect(() => {
      // @ts-expect-error testing mutation
      manifest.files[0].path = 'src/mutated.ts';
    }).toThrow(TypeError);

    expect(() => {
      // @ts-expect-error testing mutation
      manifest.files[0].symbols[0].name = 'mutated';
    }).toThrow(TypeError);
  });

  // 17. Deterministic serialization and deserialization
  it('17. deterministically serializes and deserializes the manifest to/from JSON', () => {
    const raw1: ArtifactManifest = {
      taskId: 'task-test',
      attemptNumber: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
      files: [
        {
          path: 'src/b.ts',
          status: 'ADDED',
          symbols: [
            { name: 'z', kind: 'variable' },
            { name: 'a', kind: 'function' },
          ],
        },
        { path: 'src/a.ts', status: 'MODIFIED', symbols: [] },
      ],
    };

    const raw2: ArtifactManifest = {
      taskId: 'task-test',
      attemptNumber: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
      files: [
        { path: 'src/a.ts', status: 'MODIFIED', symbols: [] },
        {
          path: 'src/b.ts',
          status: 'ADDED',
          symbols: [
            { name: 'a', kind: 'function' },
            { name: 'z', kind: 'variable' },
          ],
        },
      ],
    };

    const json1 = serializeManifest(raw1);
    const json2 = serializeManifest(raw2);

    expect(json1).toBe(json2);

    const deserialized = deserializeManifest(json1);
    expect(deserialized.files[0].path).toBe('src/a.ts');
    expect(deserialized.files[1].path).toBe('src/b.ts');
    expect(deserialized.files[1].symbols[0].name).toBe('a');
    expect(deserialized.files[1].symbols[1].name).toBe('z');
    expect(Object.isFrozen(deserialized)).toBe(true);
  });

  // 18. Added-file example from docs/ARTIFACT_MANIFEST.md
  it('18. supports Example 1 (added authentication middleware file) from docs/ARTIFACT_MANIFEST.md', () => {
    const example1: ArtifactManifest = {
      taskId: 'task-auth-middleware',
      attemptNumber: 1,
      createdAt: '2026-10-01T14:00:00.000Z',
      files: [
        {
          path: 'src/middleware/auth.ts',
          status: 'ADDED',
          symbols: [
            {
              name: 'AuthRequest',
              kind: 'interface',
              signature: 'interface AuthRequest extends Request { user?: UserPayload; }',
            },
            {
              name: 'UserPayload',
              kind: 'type',
              signature: 'type UserPayload = { id: string; email: string; role: string; };',
            },
            {
              name: 'authenticateToken',
              kind: 'function',
              signature:
                'export function authenticateToken(req: AuthRequest, res: Response, next: NextFunction): void',
            },
          ],
        },
      ],
    };

    const manifest = createArtifactManifest(example1);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].status).toBe('ADDED');
    expect(manifest.files[0].symbols.map((s) => s.name)).toEqual([
      'AuthRequest',
      'UserPayload',
      'authenticateToken',
    ]);
  });

  // 19. Modified-file example from docs/ARTIFACT_MANIFEST.md
  it('19. supports Example 2 (modified existing repository files) from docs/ARTIFACT_MANIFEST.md', () => {
    const example2: ArtifactManifest = {
      taskId: 'task-data-model',
      attemptNumber: 1,
      createdAt: '2026-10-01T14:05:00.000Z',
      files: [
        {
          path: 'src/server.ts',
          status: 'MODIFIED',
          symbols: [
            {
              name: 'registerDataRoutes',
              kind: 'function',
              signature: 'export function registerDataRoutes(app: Express): void',
            },
          ],
        },
        {
          path: 'src/data/schema.ts',
          status: 'MODIFIED',
          symbols: [
            {
              name: 'ProjectEntity',
              kind: 'interface',
              signature:
                'export interface ProjectEntity { id: string; name: string; status: string; }',
            },
            {
              name: 'projectsTable',
              kind: 'variable',
              signature: 'export const projectsTable: TableDefinition',
            },
          ],
        },
      ],
    };

    const manifest = createArtifactManifest(example2);
    expect(manifest.files).toHaveLength(2);
    // ASCII sorted order: src/data/schema.ts before src/server.ts
    expect(manifest.files[0].path).toBe('src/data/schema.ts');
    expect(manifest.files[1].path).toBe('src/server.ts');
    expect(manifest.files[0].symbols.map((s) => s.name)).toEqual([
      'ProjectEntity',
      'projectsTable',
    ]);
  });
});
