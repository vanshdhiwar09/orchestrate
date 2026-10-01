import type { GitFileChange, GitStatus } from '@orchestrate/workspace';
import { describe, expect, it } from 'vitest';
import {
  extractArtifactManifest,
  ManifestExtractionError,
  serializeManifest,
} from '../src/index.js';

describe('Artifact Manifest Extractor', () => {
  const createFakeGit = (status: Partial<GitStatus> = {}, isRepo = true) => ({
    async isRepository(): Promise<boolean> {
      return isRepo;
    },
    async getStatus(): Promise<GitStatus> {
      return {
        clean: !status.staged?.length && !status.unstaged?.length && !status.untracked?.length,
        branch: 'main',
        detached: false,
        staged: status.staged ?? [],
        unstaged: status.unstaged ?? [],
        untracked: status.untracked ?? [],
      };
    },
  });

  const createFakeWorkspace = (files: Record<string, string> = {}) => ({
    async readFile(filePath: string): Promise<string> {
      if (filePath in files) {
        return files[filePath];
      }
      throw new Error(`File not found in fake workspace: ${filePath}`);
    },
  });

  const defaultCreatedAt = '2026-10-01T12:00:00.000Z';

  // 1. Untracked file -> ADDED
  it('1. classifies untracked file as ADDED', async () => {
    const git = createFakeGit({ untracked: ['src/auth.ts'] });
    const workspace = createFakeWorkspace({
      'src/auth.ts': 'export function verify(): boolean { return true; }',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-1',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('src/auth.ts');
    expect(manifest.files[0].status).toBe('ADDED');
    expect(manifest.files[0].symbols).toEqual([
      {
        name: 'verify',
        kind: 'function',
        signature: 'export function verify(): boolean',
      },
    ]);
  });

  // 2. Staged added -> ADDED
  it('2. classifies staged added file as ADDED', async () => {
    const git = createFakeGit({
      staged: [{ path: 'src/token.ts', statusCode: 'added', rawStatus: 'A ' }],
    });
    const workspace = createFakeWorkspace({
      'src/token.ts': 'export const generateToken = () => "xyz";',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-1',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files[0].status).toBe('ADDED');
    expect(manifest.files[0].symbols[0].name).toBe('generateToken');
    expect(manifest.files[0].symbols[0].kind).toBe('function');
  });

  // 3. Staged modified -> MODIFIED
  it('3. classifies staged modified file as MODIFIED', async () => {
    const git = createFakeGit({
      staged: [{ path: 'src/server.ts', statusCode: 'modified', rawStatus: 'M ' }],
    });
    const workspace = createFakeWorkspace({
      'src/server.ts': 'export const PORT = 3000;',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-1',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files[0].status).toBe('MODIFIED');
    expect(manifest.files[0].symbols[0]).toEqual({
      name: 'PORT',
      kind: 'variable',
      signature: 'export const PORT = 3000',
    });
  });

  // 4. Unstaged modified -> MODIFIED
  it('4. classifies unstaged modified file as MODIFIED', async () => {
    const git = createFakeGit({
      unstaged: [{ path: 'src/app.ts', statusCode: 'modified', rawStatus: ' M' }],
    });
    const workspace = createFakeWorkspace({
      'src/app.ts': 'export class App {}',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-1',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files[0].status).toBe('MODIFIED');
    expect(manifest.files[0].symbols[0].kind).toBe('class');
  });

  // 5. Renamed file -> destination ADDED
  it('5. classifies renamed destination as ADDED and ignores originalPath', async () => {
    const git = createFakeGit({
      staged: [
        {
          path: 'src/new-name.ts',
          originalPath: 'src/old-name.ts',
          statusCode: 'renamed',
          rawStatus: 'R ',
        },
      ],
    });
    const workspace = createFakeWorkspace({
      'src/new-name.ts': 'export type ID = string;',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-1',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('src/new-name.ts');
    expect(manifest.files[0].status).toBe('ADDED');
  });

  // 6. Copied file -> destination ADDED
  it('6. classifies copied destination as ADDED', async () => {
    const git = createFakeGit({
      staged: [
        {
          path: 'src/copy.ts',
          originalPath: 'src/orig.ts',
          statusCode: 'copied',
          rawStatus: 'C ',
        },
      ],
    });
    const workspace = createFakeWorkspace({
      'src/copy.ts': 'export interface Config { timeout: number; }',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-1',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files[0].path).toBe('src/copy.ts');
    expect(manifest.files[0].status).toBe('ADDED');
  });

  // 7. Deleted files -> excluded
  it('7. excludes deleted files from the manifest', async () => {
    const git = createFakeGit({
      staged: [{ path: 'src/deleted1.ts', statusCode: 'deleted', rawStatus: 'D ' }],
      unstaged: [{ path: 'src/deleted2.ts', statusCode: 'deleted', rawStatus: ' D' }],
      untracked: ['src/alive.ts'],
    });
    const workspace = createFakeWorkspace({
      'src/alive.ts': 'export function isAlive(): boolean { return true; }',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-1',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('src/alive.ts');
  });

  // 8. Deterministic extraction: same input produces byte-for-byte identical output
  it('8. produces byte-for-byte identical serializeManifest output on identical input', async () => {
    const git = createFakeGit({
      untracked: ['src/z.ts', 'src/a.ts'],
    });
    const workspace = createFakeWorkspace({
      'src/z.ts': 'export const zVar = 10;',
      'src/a.ts': 'export function aFunc() {}',
    });

    const run1 = await extractArtifactManifest({
      taskId: 'task-determinism',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    const run2 = await extractArtifactManifest({
      taskId: 'task-determinism',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    const json1 = serializeManifest(run1);
    const json2 = serializeManifest(run2);

    expect(json1).toBe(json2);
  });

  // 9. Lexical depth and nested declarations ignored
  it('9. extracts top-level declarations and ignores inner closures and nested variables', async () => {
    const git = createFakeGit({ untracked: ['src/service.ts'] });
    const code = `
      export function outerService(param: string): void {
        const innerSecret = "hidden";
        function innerHelper() {
          return 42;
        }
      }
      export const topLevelVar = 100;
    `;
    const workspace = createFakeWorkspace({ 'src/service.ts': code });

    const manifest = await extractArtifactManifest({
      taskId: 'task-depth',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    const names = manifest.files[0].symbols.map((s) => s.name);
    expect(names).toContain('outerService');
    expect(names).toContain('topLevelVar');
    expect(names).not.toContain('innerSecret');
    expect(names).not.toContain('innerHelper');
  });

  // 10. Symbol precedence (arrow functions vs variables, classes, interfaces, types)
  it('10. classifies symbols according to frozen precedence rules', async () => {
    const git = createFakeGit({ untracked: ['src/types.ts'] });
    const code = `
      export function funcOne() {}
      export class ClassOne {}
      export interface InterfaceOne {}
      export type TypeOne = string;
      export const arrowOne = (x: number) => x * 2;
      export const varOne = 123;
    `;
    const workspace = createFakeWorkspace({ 'src/types.ts': code });

    const manifest = await extractArtifactManifest({
      taskId: 'task-prec',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    const symbols = manifest.files[0].symbols;
    const find = (name: string) => symbols.find((s) => s.name === name);

    expect(find('funcOne')?.kind).toBe('function');
    expect(find('ClassOne')?.kind).toBe('class');
    expect(find('InterfaceOne')?.kind).toBe('interface');
    expect(find('TypeOne')?.kind).toBe('type');
    expect(find('arrowOne')?.kind).toBe('function'); // arrow function resolves to function
    expect(find('varOne')?.kind).toBe('variable');
  });

  // 11. Named export splitting and aliases
  it('11. splits export { foo, bar as baz } into individual export symbols', async () => {
    const git = createFakeGit({ untracked: ['src/exports.ts'] });
    const code = `
      export { alpha, beta as gamma };
    `;
    const workspace = createFakeWorkspace({ 'src/exports.ts': code });

    const manifest = await extractArtifactManifest({
      taskId: 'task-exp',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    const symbols = manifest.files[0].symbols;
    expect(symbols).toEqual([
      { name: 'alpha', kind: 'export' },
      { name: 'gamma', kind: 'export' },
    ]);
  });

  // 12. Wildcard export -> no symbols invented
  it('12. ignores wildcard export * from and does not invent symbols', async () => {
    const git = createFakeGit({ untracked: ['src/wildcard.ts'] });
    const code = `
      export * from './internal.js';
    `;
    const workspace = createFakeWorkspace({ 'src/wildcard.ts': code });

    const manifest = await extractArtifactManifest({
      taskId: 'task-wild',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files[0].symbols).toEqual([]);
  });

  // 13. Class and interface methods (including visibility filters and constructor exclusion)
  it('13. extracts public and protected methods, excludes private, #private, and constructor', async () => {
    const git = createFakeGit({ untracked: ['src/repo.ts'] });
    const code = `
      export class UserRepository {
        constructor(db: any) {}
        public findById(id: string): any {}
        protected validateId(id: string): boolean { return true; }
        defaultMethod() {}
        private internalCache() {}
        #hashSecret() {}
      }
    `;
    const workspace = createFakeWorkspace({ 'src/repo.ts': code });

    const manifest = await extractArtifactManifest({
      taskId: 'task-methods',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    const names = manifest.files[0].symbols.map((s) => s.name);
    expect(names).toContain('UserRepository'); // class
    expect(names).toContain('findById'); // public method
    expect(names).toContain('validateId'); // protected method
    expect(names).toContain('defaultMethod'); // default method
    expect(names).not.toContain('constructor');
    expect(names).not.toContain('internalCache');
    expect(names).not.toContain('#hashSecret');
  });

  // 14. Ignored and transient files excluded
  it('14. filters out node_modules, dist, .git, and log files', async () => {
    const git = createFakeGit({
      untracked: [
        'node_modules/pkg/index.ts',
        'dist/bundle.js',
        '.git/HEAD',
        'app.log',
        '.DS_Store',
        'src/real.ts',
      ],
    });
    const workspace = createFakeWorkspace({
      'src/real.ts': 'export function real() {}',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-ignored',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('src/real.ts');
  });

  // 15. Malformed/unbalanced source resilience
  it('15. safely falls back to symbols: [] when lexical structure has unbalanced braces', async () => {
    const git = createFakeGit({ untracked: ['src/broken.ts'] });
    const code = `
      export function broken() {
        // missing closing brace
    `;
    const workspace = createFakeWorkspace({ 'src/broken.ts': code });

    const manifest = await extractArtifactManifest({
      taskId: 'task-broken',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].symbols).toEqual([]);
  });

  // 16. Non-source text files recorded with symbols: []
  it('16. records non-source text files (like json or sql) with symbols: []', async () => {
    const git = createFakeGit({
      untracked: ['schema.sql', 'config.json'],
    });
    const workspace = createFakeWorkspace({
      'schema.sql': 'CREATE TABLE users (id TEXT PRIMARY KEY);',
      'config.json': '{"port": 8080}',
    });

    const manifest = await extractArtifactManifest({
      taskId: 'task-nonsrc',
      attemptNumber: 1,
      createdAt: defaultCreatedAt,
      git,
      workspace,
    });

    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0].symbols).toEqual([]);
    expect(manifest.files[1].symbols).toEqual([]);
  });

  // 17. Rejection of invalid inputs
  it('17. throws ManifestExtractionError on invalid inputs (missing createdAt, not a git repo)', async () => {
    const git = createFakeGit({}, false); // not a git repo
    const workspace = createFakeWorkspace();

    await expect(
      extractArtifactManifest({
        taskId: 'task-err',
        attemptNumber: 1,
        createdAt: defaultCreatedAt,
        git,
        workspace,
      })
    ).rejects.toThrow(ManifestExtractionError);

    const validGit = createFakeGit();
    // @ts-expect-error missing createdAt
    await expect(
      extractArtifactManifest({
        taskId: 'task-err',
        attemptNumber: 1,
        git: validGit,
        workspace,
      })
    ).rejects.toThrow(ManifestExtractionError);
  });
});
