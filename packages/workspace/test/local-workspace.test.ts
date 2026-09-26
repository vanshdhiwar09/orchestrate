import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalWorkspace } from '../src/local-workspace.js';

describe('LocalWorkspace', () => {
  let outerDir: string;
  let workspaceDir: string;
  let workspace: LocalWorkspace;

  beforeEach(async () => {
    outerDir = await mkdtemp(join(tmpdir(), 'orchestrate-outer-test-'));
    workspaceDir = join(outerDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    workspace = new LocalWorkspace({ rootPath: workspaceDir });
  });

  afterEach(async () => {
    await rm(outerDir, { recursive: true, force: true });
  });

  it('throws error when instantiated with empty rootPath', () => {
    expect(() => new LocalWorkspace({ rootPath: '' })).toThrowError(
      'LocalWorkspace requires a non-empty rootPath option.'
    );
  });

  it('1. reads a valid normal file successfully', async () => {
    const filePath = join(workspaceDir, 'hello.txt');
    await writeFile(filePath, 'Hello, Orchestrate Workspace!', 'utf-8');

    const content = await workspace.readFile('hello.txt');
    expect(content).toBe('Hello, Orchestrate Workspace!');
  });

  it('2. reads a nested file successfully', async () => {
    const nestedDir = join(workspaceDir, 'src', 'sub');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, 'data.json'), '{"ok":true}', 'utf-8');

    const content = await workspace.readFile('src/sub/data.json');
    expect(content).toBe('{"ok":true}');
  });

  it('3. blocks relative ../ path traversal attempts', async () => {
    await expect(workspace.readFile('../secret.txt')).rejects.toThrowError(
      'Path traversal denied'
    );
    await expect(workspace.readFile('../../etc/passwd')).rejects.toThrowError(
      'Path traversal denied'
    );
  });

  it('4. blocks absolute path escaping workspace root', async () => {
    const outsideFile = join(outerDir, 'outside.txt');
    await writeFile(outsideFile, 'Outside secret data', 'utf-8');

    await expect(workspace.readFile(outsideFile)).rejects.toThrowError(
      'Path traversal denied'
    );
  });

  it('5. blocks cross-drive/Windows escaping paths where applicable', async () => {
    const crossDrivePath = process.platform === 'win32' ? 'D:\\secret.txt' : '/var/log/syslog';
    await expect(workspace.readFile(crossDrivePath)).rejects.toThrowError(
      'Path traversal denied'
    );
  });

  it('6. rejects a symlink inside workspace pointing to a file outside workspace', async () => {
    const outsideFile = join(outerDir, 'secret-outside.txt');
    await writeFile(outsideFile, 'Top secret outside data', 'utf-8');

    const symlinkPath = join(workspaceDir, 'symlink-to-outside.txt');

    try {
      await symlink(outsideFile, symlinkPath);
    } catch (err: unknown) {
      // If Windows user lacks symlink creation privilege (EPERM), skip test gracefully
      if ((err as { code?: string })?.code === 'EPERM') {
        return;
      }
      throw err;
    }

    await expect(workspace.readFile('symlink-to-outside.txt')).rejects.toThrowError(
      'Path traversal denied'
    );
  });

  it('7. allows a symlink inside workspace pointing to a file inside workspace', async () => {
    const internalFile = join(workspaceDir, 'target-inside.txt');
    await writeFile(internalFile, 'Internal target data', 'utf-8');

    const symlinkPath = join(workspaceDir, 'symlink-to-inside.txt');

    try {
      await symlink(internalFile, symlinkPath);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'EPERM') {
        return;
      }
      throw err;
    }

    const content = await workspace.readFile('symlink-to-inside.txt');
    expect(content).toBe('Internal target data');
  });

  it('8. rejects attempting to read a directory with a clear error', async () => {
    const subDir = join(workspaceDir, 'my-folder');
    await mkdir(subDir, { recursive: true });

    await expect(workspace.readFile('my-folder')).rejects.toThrowError(
      'Cannot read directory: "my-folder" is a directory.'
    );
  });

  describe('writeFile', () => {
    it('1. creates a new file successfully', async () => {
      await workspace.writeFile('new-file.txt', 'Hello, New File!');
      const content = await workspace.readFile('new-file.txt');
      expect(content).toBe('Hello, New File!');
    });

    it('2. overwrites an existing file successfully', async () => {
      await workspace.writeFile('existing.txt', 'Initial Content');
      await workspace.writeFile('existing.txt', 'Updated Content');
      const content = await workspace.readFile('existing.txt');
      expect(content).toBe('Updated Content');
    });

    it('3. creates missing nested parent directories automatically', async () => {
      await workspace.writeFile('deeply/nested/path/file.txt', 'Nested Content');
      const content = await workspace.readFile('deeply/nested/path/file.txt');
      expect(content).toBe('Nested Content');
    });

    it('4. blocks relative ../ path traversal attempts on write', async () => {
      await expect(workspace.writeFile('../traversal.txt', 'bad')).rejects.toThrowError(
        'Path traversal denied'
      );
      await expect(workspace.writeFile('../../etc/passwd', 'bad')).rejects.toThrowError(
        'Path traversal denied'
      );
    });

    it('5. blocks writing to absolute paths outside workspace root', async () => {
      const outsideFile = join(outerDir, 'outside-write.txt');
      await expect(workspace.writeFile(outsideFile, 'bad')).rejects.toThrowError(
        'Path traversal denied'
      );
    });

    it('6. blocks cross-drive/Windows escaping paths on write where applicable', async () => {
      const crossDrivePath = process.platform === 'win32' ? 'D:\\secret.txt' : '/var/log/syslog';
      await expect(workspace.writeFile(crossDrivePath, 'bad')).rejects.toThrowError(
        'Path traversal denied'
      );
    });

    it('7. rejects a symlinked file pointing outside the workspace', async () => {
      const outsideFile = join(outerDir, 'outside-target.txt');
      await writeFile(outsideFile, 'Outside file', 'utf-8');

      const symlinkPath = join(workspaceDir, 'symlink-outside-file.txt');

      try {
        await symlink(outsideFile, symlinkPath);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'EPERM') {
          return;
        }
        throw err;
      }

      await expect(
        workspace.writeFile('symlink-outside-file.txt', 'Overwrite attempt')
      ).rejects.toThrowError('Path traversal denied');
    });

    it('8. rejects a symlinked parent directory pointing outside the workspace', async () => {
      const outsideDir = join(outerDir, 'outside-folder');
      await mkdir(outsideDir, { recursive: true });

      const symlinkDir = join(workspaceDir, 'symlinked-folder');

      try {
        await symlink(outsideDir, symlinkDir, 'dir');
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'EPERM') {
          return;
        }
        throw err;
      }

      await expect(
        workspace.writeFile('symlinked-folder/escaped.txt', 'Escaped write content')
      ).rejects.toThrowError('Path traversal denied');
    });

    it('9. allows writing to a file through an internal symlink pointing inside workspace', async () => {
      const internalTarget = join(workspaceDir, 'internal-target.txt');
      await writeFile(internalTarget, 'Original internal content', 'utf-8');

      const symlinkPath = join(workspaceDir, 'internal-symlink.txt');

      try {
        await symlink(internalTarget, symlinkPath);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'EPERM') {
          return;
        }
        throw err;
      }

      await workspace.writeFile('internal-symlink.txt', 'Updated internal content');
      const content = await workspace.readFile('internal-target.txt');
      expect(content).toBe('Updated internal content');
    });

    it('10. rejects content larger than 5 MiB', async () => {
      const largeContent = 'a'.repeat(5_242_881);
      await expect(workspace.writeFile('large.txt', largeContent)).rejects.toThrowError(
        'File content exceeds maximum allowed size of 5 MiB.'
      );
    });

    it('11. rejects writing to an existing directory target', async () => {
      const subDir = join(workspaceDir, 'target-folder');
      await mkdir(subDir, { recursive: true });

      await expect(workspace.writeFile('target-folder', 'data')).rejects.toThrowError(
        'Cannot write to directory: "target-folder" is a directory.'
      );
    });

    it('12. rejects a null-byte path', async () => {
      await expect(workspace.writeFile('foo\0bar.txt', 'data')).rejects.toThrowError(
        'Workspace path cannot contain null bytes.'
      );
    });
  });
});

