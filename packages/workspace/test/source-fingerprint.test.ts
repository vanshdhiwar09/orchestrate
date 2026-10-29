import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSourceSnapshot,
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_EXCLUDED_FILE_PATTERNS,
} from '../src/source-fingerprint.js';

describe('Source Fingerprint & Snapshot Identity', () => {
  async function createTestDir(name: string): Promise<string> {
    const dir = join(tmpdir(), `test-snapshot-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it('computes deterministic fingerprint with stable path sorting', async () => {
    const dir = await createTestDir('deterministic');
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
      await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
      await writeFile(join(dir, 'package.json'), '{"name":"test"}\n', 'utf8');

      const snap1 = await computeSourceSnapshot(dir);
      const snap2 = await computeSourceSnapshot(dir);

      expect(snap1.fileCount).toBe(3);
      expect(snap1.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(snap1.fingerprint).toBe(snap2.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects changes to existing source files', async () => {
    const dir = await createTestDir('file-change');
    try {
      await writeFile(join(dir, 'index.ts'), 'console.log("hello");\n', 'utf8');
      const snap1 = await computeSourceSnapshot(dir);

      await writeFile(join(dir, 'index.ts'), 'console.log("world");\n', 'utf8');
      const snap2 = await computeSourceSnapshot(dir);

      expect(snap1.fingerprint).not.toBe(snap2.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects additions of new untracked source files', async () => {
    const dir = await createTestDir('file-added');
    try {
      await writeFile(join(dir, 'index.ts'), 'console.log("hello");\n', 'utf8');
      const snap1 = await computeSourceSnapshot(dir);

      await writeFile(join(dir, 'new-file.ts'), 'export const x = 42;\n', 'utf8');
      const snap2 = await computeSourceSnapshot(dir);

      expect(snap2.fileCount).toBe(snap1.fileCount + 1);
      expect(snap2.fingerprint).not.toBe(snap1.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects deletion and renaming of files', async () => {
    const dir = await createTestDir('file-delete');
    try {
      await writeFile(join(dir, 'file1.ts'), 'content1\n', 'utf8');
      await writeFile(join(dir, 'file2.ts'), 'content2\n', 'utf8');
      const snapInitial = await computeSourceSnapshot(dir);

      await rm(join(dir, 'file2.ts'));
      const snapDeleted = await computeSourceSnapshot(dir);
      expect(snapDeleted.fingerprint).not.toBe(snapInitial.fingerprint);

      // Renaming: recreate file2 as file3 with same content
      await writeFile(join(dir, 'file3.ts'), 'content2\n', 'utf8');
      const snapRenamed = await computeSourceSnapshot(dir);
      expect(snapRenamed.fingerprint).not.toBe(snapInitial.fingerprint);
      expect(snapRenamed.fingerprint).not.toBe(snapDeleted.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects changes to configuration files like tsconfig.json', async () => {
    const dir = await createTestDir('config-change');
    try {
      await writeFile(join(dir, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
      const snap1 = await computeSourceSnapshot(dir);

      await writeFile(join(dir, 'tsconfig.json'), '{"compilerOptions":{"moduleResolution":"NodeNext"}}\n', 'utf8');
      const snap2 = await computeSourceSnapshot(dir);

      expect(snap1.fingerprint).not.toBe(snap2.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns identical fingerprint when content is modified and reverted back', async () => {
    const dir = await createTestDir('content-revert');
    try {
      const original = 'export const greeting = "hi";\n';
      await writeFile(join(dir, 'greet.ts'), original, 'utf8');
      const snapOriginal = await computeSourceSnapshot(dir);

      await writeFile(join(dir, 'greet.ts'), 'export const greeting = "changed";\n', 'utf8');
      const snapModified = await computeSourceSnapshot(dir);
      expect(snapModified.fingerprint).not.toBe(snapOriginal.fingerprint);

      await writeFile(join(dir, 'greet.ts'), original, 'utf8');
      const snapReverted = await computeSourceSnapshot(dir);
      expect(snapReverted.fingerprint).toBe(snapOriginal.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('excludes transient directories and files by default', async () => {
    const dir = await createTestDir('transient-exclusions');
    try {
      await writeFile(join(dir, 'app.ts'), 'export const app = true;\n', 'utf8');
      const snapBefore = await computeSourceSnapshot(dir);

      // Create transient files in excluded dirs and with excluded extensions
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

      await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
      await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports={}\n', 'utf8');

      await mkdir(join(dir, 'dist'), { recursive: true });
      await writeFile(join(dir, 'dist', 'app.js'), 'export var app = true;\n', 'utf8');

      await writeFile(join(dir, 'build.log'), 'compile log output\n', 'utf8');
      await writeFile(join(dir, 'temp.tmp'), 'temporary data\n', 'utf8');
      await writeFile(join(dir, '.DS_Store'), 'darwin metadata\n', 'utf8');

      const snapAfter = await computeSourceSnapshot(dir);

      expect(snapAfter.fileCount).toBe(snapBefore.fileCount);
      expect(snapAfter.fingerprint).toBe(snapBefore.fingerprint);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when symlink resolves outside workspace root', async () => {
    const dir = await createTestDir('symlink-escape');
    const outsideDir = await createTestDir('symlink-outside');
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'secret credentials\n', 'utf8');

      try {
        await symlink(join(outsideDir, 'secret.txt'), join(dir, 'escape-link.ts'), 'file');
      } catch {
        // If symlink creation not permitted on this platform/privilege, skip test gracefully
        return;
      }

      await expect(computeSourceSnapshot(dir)).rejects.toThrow(/escapes workspace root/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('fails closed on non-existent or unreadable workspace directory', async () => {
    await expect(computeSourceSnapshot('C:/non-existent-directory-path-12345')).rejects.toThrow(
      /workspace root does not exist or cannot be accessed/i
    );
  });
});
