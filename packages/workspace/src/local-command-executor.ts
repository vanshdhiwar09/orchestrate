import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandExecutor,
  ExecuteCommandOptions,
  ExecuteCommandResult,
} from './executor-types.js';

/**
 * V1 allowlist.
 *
 * Extend with explicit justification only.
 * Do NOT add: powershell, cmd, bash, sh, curl, wget, nc, python, ruby, etc.
 */
const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'npx', 'tsc', 'git']);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB per stream

/**
 * Credentials and sensitive host environment variables that must not be
 * forwarded to child processes.
 */
const BLOCKED_ENV_KEYS = [
  'NEBIUS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GCP_SERVICE_ACCOUNT_KEY',
];

export interface LocalCommandExecutorOptions {
  /**
   * Absolute path to the workspace root. Used as the default cwd and as the
   * containment boundary for any caller-supplied cwd.
   */
  workspaceRoot: string;
}

export class LocalCommandExecutor implements CommandExecutor {
  private readonly workspaceRoot: string;
  private realRootCache?: string;

  constructor(options: LocalCommandExecutorOptions) {
    if (!options?.workspaceRoot?.trim()) {
      throw new Error('LocalCommandExecutor requires a non-empty workspaceRoot option.');
    }
    this.workspaceRoot = resolve(options.workspaceRoot);
  }

  // ── Path-boundary helpers ───────────────────────────────────────────────────

  private async getRealRoot(): Promise<string> {
    if (!this.realRootCache) {
      try {
        this.realRootCache = await realpath(this.workspaceRoot);
      } catch {
        this.realRootCache = this.workspaceRoot;
      }
    }
    return this.realRootCache;
  }

  /**
   * Resolves `requestedCwd` lexically against the workspace root and verifies:
   * 1. Lexical containment (no `..` escape, no cross-drive absolute paths).
   * 2. Physical containment via realpath (no symlink escape).
   *
   * Returns the resolved absolute path if safe.
   */
  private async resolveSafeCwd(requestedCwd: string): Promise<string> {
    if (typeof requestedCwd !== 'string' || !requestedCwd.trim()) {
      throw new Error('cwd must be a non-empty string.');
    }

    if (requestedCwd.includes('\0')) {
      throw new Error('cwd cannot contain null bytes.');
    }

    // Step 1: Lexical containment — resolve against root, no absolute paths allowed
    if (isAbsolute(requestedCwd)) {
      throw new Error(
        `cwd must be a relative path within the workspace; absolute path rejected: "${requestedCwd}"`
      );
    }

    const targetPath = resolve(this.workspaceRoot, requestedCwd);
    const rel = relative(this.workspaceRoot, targetPath);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `cwd traversal denied: "${requestedCwd}" escapes workspace root.`
      );
    }

    // Step 2: Physical containment — resolve symlinks and re-check
    let realTarget: string;
    try {
      // lstat first to ensure directory exists; symlinks to non-existent targets throw ENOENT
      const st = await lstat(targetPath);
      if (!st.isDirectory() && !st.isSymbolicLink()) {
        throw new Error(`cwd "${requestedCwd}" is not a directory.`);
      }
      realTarget = await realpath(targetPath);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        throw new Error(`cwd "${requestedCwd}" does not exist.`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to resolve cwd "${requestedCwd}": ${message}`);
    }

    const realRoot = await this.getRealRoot();
    const realRel = relative(realRoot, realTarget);

    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(
        `cwd traversal denied: "${requestedCwd}" resolves outside workspace root via symlink.`
      );
    }

    return realTarget;
  }

  // ── Environment sanitization ────────────────────────────────────────────────

  private buildSafeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      const upperKey = key.toUpperCase();
      const blocked = BLOCKED_ENV_KEYS.some((b) => upperKey === b.toUpperCase());
      if (!blocked) {
        env[key] = value;
      }
    }
    return env;
  }

  // ── Windows command resolution ──────────────────────────────────────────────

  private findNpmCli(cliName: string): string | null {
    // 1. Next to the current node.exe (standard Windows Node installation)
    const nodeDir = dirname(process.execPath);
    const adjacent = join(nodeDir, 'node_modules', 'npm', 'bin', cliName);
    if (existsSync(adjacent)) {
      return adjacent;
    }

    // 2. In APPDATA global npm prefix
    if (process.env.APPDATA) {
      const appdataCandidate = join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', cliName);
      if (existsSync(appdataCandidate)) {
        return appdataCandidate;
      }
    }

    // 3. Search directories in PATH
    if (process.env.PATH) {
      for (const dir of process.env.PATH.split(';')) {
        const trimmed = dir.trim();
        if (!trimmed) continue;
        const candidate = join(trimmed, 'node_modules', 'npm', 'bin', cliName);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  private findTscBin(resolvedCwd: string): string | null {
    // 1. Direct check in resolvedCwd node_modules
    const localCwdCandidate = join(resolvedCwd, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(localCwdCandidate)) {
      return localCwdCandidate;
    }

    // 2. Direct check in workspaceRoot node_modules
    const localRootCandidate = join(this.workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(localRootCandidate)) {
      return localRootCandidate;
    }

    // 3. Node module resolution from resolvedCwd, workspaceRoot, or current package
    const currentDir = dirname(fileURLToPath(import.meta.url));
    for (const basePath of [resolvedCwd, this.workspaceRoot, currentDir]) {
      try {
        const req = createRequire(join(basePath, 'package.json'));
        const tsEntry = req.resolve('typescript');
        const candidate = join(dirname(tsEntry), '..', 'bin', 'tsc');
        if (existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // continue search
      }
    }

    // 4. In APPDATA global npm prefix (e.g. npm install -g typescript)
    if (process.env.APPDATA) {
      const appdataCandidate = join(process.env.APPDATA, 'npm', 'node_modules', 'typescript', 'bin', 'tsc');
      if (existsSync(appdataCandidate)) {
        return appdataCandidate;
      }
    }

    // 5. Alongside node.exe
    const nodeDir = dirname(process.execPath);
    const adjacent = join(nodeDir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(adjacent)) {
      return adjacent;
    }

    // 6. Search directories in PATH
    if (process.env.PATH) {
      for (const dir of process.env.PATH.split(';')) {
        const trimmed = dir.trim();
        if (!trimmed) continue;
        const candidate1 = join(trimmed, 'node_modules', 'typescript', 'bin', 'tsc');
        if (existsSync(candidate1)) return candidate1;
        const candidate2 = join(trimmed, '..', 'typescript', 'bin', 'tsc');
        if (existsSync(candidate2)) return candidate2;
      }
    }

    return null;
  }

  /**
   * Resolves allowlisted command and args for the current OS platform.
   * On Linux/macOS, commands run directly with shell: false.
   * On Windows, node scripts (npm, npx, tsc) that lack PE binaries are explicitly
   * launched with process.execPath (Node) without invoking a shell.
   */
  resolveExecution(
    command: string,
    args: string[],
    resolvedCwd: string
  ): { executable: string; args: string[] } {
    if (process.platform !== 'win32') {
      return { executable: command, args };
    }

    if (command === 'node') {
      return { executable: process.execPath, args };
    }

    if (command === 'git') {
      return { executable: 'git', args };
    }

    if (command === 'npm' || command === 'npx') {
      const cliName = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
      const cliPath = this.findNpmCli(cliName);
      if (cliPath) {
        return { executable: process.execPath, args: [cliPath, ...args] };
      }
      return { executable: command, args };
    }

    if (command === 'tsc') {
      const tscBin = this.findTscBin(resolvedCwd);
      if (tscBin) {
        return { executable: process.execPath, args: [tscBin, ...args] };
      }
      return { executable: command, args };
    }

    return { executable: command, args };
  }

  // ── Public execute ──────────────────────────────────────────────────────────

  async execute(
    command: string,
    args: string[],
    options?: ExecuteCommandOptions
  ): Promise<ExecuteCommandResult> {
    // Validate command
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('command must be a non-empty string.');
    }
    const normalizedCommand = command.trim();
    if (!ALLOWED_EXECUTABLES.has(normalizedCommand)) {
      throw new Error(
        `Command not allowed: "${normalizedCommand}". Allowed executables: ${[...ALLOWED_EXECUTABLES].join(', ')}.`
      );
    }

    // Validate args
    if (!Array.isArray(args)) {
      throw new Error('args must be an array.');
    }
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error('Each element of args must be a string.');
      }
    }

    // Resolve cwd
    let resolvedCwd: string;
    if (options?.cwd !== undefined) {
      resolvedCwd = await this.resolveSafeCwd(options.cwd);
    } else {
      resolvedCwd = await this.getRealRoot();
    }

    // Validate and clamp timeout
    let timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
      timeoutMs = DEFAULT_TIMEOUT_MS;
    }
    if (timeoutMs > MAX_TIMEOUT_MS) {
      timeoutMs = MAX_TIMEOUT_MS;
    }

    const env = this.buildSafeEnv();

    const { executable, args: executionArgs } = this.resolveExecution(
      normalizedCommand,
      args,
      resolvedCwd
    );

    return new Promise<ExecuteCommandResult>((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;

      const child = execFile(executable, executionArgs, {
        shell: false,
        cwd: resolvedCwd,
        env,
        // stdin is not piped; child inherits /dev/null effectively via execFile
      });

      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      // Enforce 1 MiB per stream
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (stdoutTruncated) return;
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (Buffer.byteLength(stdoutBuf + str, 'utf8') > MAX_OUTPUT_BYTES) {
          stdoutBuf = (stdoutBuf + str).slice(0, MAX_OUTPUT_BYTES);
          stdoutTruncated = true;
          child.stdout?.destroy();
        } else {
          stdoutBuf += str;
        }
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderrTruncated) return;
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (Buffer.byteLength(stderrBuf + str, 'utf8') > MAX_OUTPUT_BYTES) {
          stderrBuf = (stderrBuf + str).slice(0, MAX_OUTPUT_BYTES);
          stderrTruncated = true;
          child.stderr?.destroy();
        } else {
          stderrBuf += str;
        }
      });

      child.on('close', (exitCode, signal) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        const result: ExecuteCommandResult = {
          exitCode: exitCode ?? null,
          signal: (signal as NodeJS.Signals | null) ?? null,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          timedOut,
        };
        resolve(result);
      });

      child.on('error', (err) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (!stderrBuf && err && typeof (err as Error).message === 'string') {
          stderrBuf = (err as Error).message;
        }
      });
    });
  }
}
