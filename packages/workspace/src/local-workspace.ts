import { lstat, mkdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Workspace } from './types.js';

export interface LocalWorkspaceOptions {
  rootPath: string;
}

export class LocalWorkspace implements Workspace {
  public readonly rootPath: string;
  private realRootCache?: string;

  constructor(options: LocalWorkspaceOptions) {
    if (!options?.rootPath?.trim()) {
      throw new Error('LocalWorkspace requires a non-empty rootPath option.');
    }
    this.rootPath = resolve(options.rootPath);
  }

  private async getRealRoot(): Promise<string> {
    if (!this.realRootCache) {
      try {
        this.realRootCache = await realpath(this.rootPath);
      } catch {
        this.realRootCache = this.rootPath;
      }
    }
    return this.realRootCache;
  }

  private resolveSafePath(requestedPath: string): string {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
      throw new Error('Workspace path cannot be empty.');
    }

    if (requestedPath.includes('\0')) {
      throw new Error('Workspace path cannot contain null bytes.');
    }

    const targetPath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.rootPath, requestedPath);

    const rel = relative(this.rootPath, targetPath);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `Path traversal denied: Requested path "${requestedPath}" escapes workspace root.`
      );
    }

    return targetPath;
  }

  private async findNearestExistingAncestor(startPath: string): Promise<string> {
    let current = startPath;
    while (true) {
      try {
        await lstat(current);
        return current;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'ENOENT') {
          const parent = dirname(current);
          if (parent === current) {
            return current;
          }
          current = parent;
        } else {
          throw err;
        }
      }
    }
  }

  async readFile(relativePath: string): Promise<string> {
    const safePath = this.resolveSafePath(relativePath);

    let realTarget: string;
    try {
      realTarget = await realpath(safePath);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'ENOENT') {
        throw new Error(`File not found in workspace: "${relativePath}"`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to resolve path "${relativePath}": ${message}`);
    }

    const realRoot = await this.getRealRoot();
    const realRel = relative(realRoot, realTarget);

    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(
        `Path traversal denied: Requested path "${relativePath}" resolves outside workspace root via symlink.`
      );
    }

    const stats = await stat(realTarget);
    if (stats.isDirectory()) {
      throw new Error(`Cannot read directory: "${relativePath}" is a directory.`);
    }

    return await readFile(realTarget, 'utf-8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    if (typeof content !== 'string') {
      throw new Error('File content must be a string.');
    }

    if (Buffer.byteLength(content, 'utf8') > 5_242_880) {
      throw new Error('File content exceeds maximum allowed size of 5 MiB.');
    }

    const safePath = this.resolveSafePath(relativePath);
    const realRoot = await this.getRealRoot();

    let targetLstat;
    try {
      targetLstat = await lstat(safePath);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== 'ENOENT') {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to access path "${relativePath}": ${message}`);
      }
    }

    if (targetLstat) {
      try {
        const stats = await stat(safePath);
        if (stats.isDirectory()) {
          throw new Error(`Cannot write to directory: "${relativePath}" is a directory.`);
        }
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== 'ENOENT') {
          throw err;
        }
      }

      let realTarget: string;
      try {
        realTarget = await realpath(safePath);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'ENOENT') {
          const linkTarget = await readlink(safePath);
          const resolvedLink = isAbsolute(linkTarget)
            ? resolve(linkTarget)
            : resolve(dirname(safePath), linkTarget);
          const ancestor = await this.findNearestExistingAncestor(resolvedLink);
          realTarget = await realpath(ancestor);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to resolve path "${relativePath}": ${message}`);
        }
      }

      const realRel = relative(realRoot, realTarget);
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new Error(
          `Path traversal denied: Requested path "${relativePath}" resolves outside workspace root via symlink.`
        );
      }
    } else {
      const ancestor = await this.findNearestExistingAncestor(dirname(safePath));
      let realAncestor: string;
      try {
        realAncestor = await realpath(ancestor);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to resolve path "${relativePath}": ${message}`);
      }

      const realRel = relative(realRoot, realAncestor);
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        throw new Error(
          `Path traversal denied: Requested path "${relativePath}" resolves outside workspace root via symlink.`
        );
      }

      await mkdir(dirname(safePath), { recursive: true });
    }

    await writeFile(safePath, content, 'utf-8');
  }
}

