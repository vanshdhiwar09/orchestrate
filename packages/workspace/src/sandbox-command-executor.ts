import { execFile } from 'node:child_process';
import { isAbsolute, normalize, parse, relative, resolve } from 'node:path';
import type {
  CommandExecutor,
  ExecuteCommandOptions,
  ExecuteCommandResult,
} from './executor-types.js';

export const ALLOWED_SANDBOX_EXECUTABLES = new Set(['node', 'npm', 'npx', 'tsc', 'git']);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB per stream

/**
 * Thrown when the required container sandbox runtime is unavailable or daemon is unreachable.
 * Production execution MUST fail closed with this error rather than falling back to host execution.
 */
export class SandboxUnavailableError extends Error {
  public readonly code = 'ERR_SANDBOX_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

export type SandboxNetworkPolicy = 'none' | 'host' | 'bridge';

export interface DockerSandboxOptions {
  /**
   * Absolute path to the isolated task workspace directory.
   * This is the ONLY host directory mounted into the container.
   */
  workspaceRoot: string;
  /**
   * Optional AbortSignal to cancel running container jobs.
   */
  signal?: AbortSignal;
  /**
   * Container image to run untrusted code in.
   * Defaults to 'node:24-slim'.
   */
  image?: string;
  /**
   * Container CLI binary name (e.g. 'docker' or 'podman').
   * Defaults to 'docker'.
   */
  containerEngine?: 'docker' | 'podman';
  /**
   * Network policy. Defaults to 'none' for complete network egress isolation.
   */
  network?: SandboxNetworkPolicy;
  /**
   * Maximum memory limit for the container (e.g. '1g', '512m').
   * Defaults to '1g'.
   */
  memoryLimit?: string;
  /**
   * Maximum CPU limit for the container (e.g. '1.0', '0.5').
   * Defaults to '1.0'.
   */
  cpuLimit?: string;
  /**
   * Process limit to prevent fork bombs.
   * Defaults to 100.
   */
  pidsLimit?: number;
  /**
   * Whether root filesystem should be read-only.
   * Defaults to true.
   */
  readOnlyRootfs?: boolean;
  /**
   * Optional custom runner function to intercept container CLI calls (for testing/mocking).
   */
  runner?: (
    command: string,
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<ExecuteCommandResult>;
}

/**
 * Known host system directories that must NEVER be mounted into a container sandbox.
 */
const FORBIDDEN_WORKSPACE_ROOTS = new Set([
  '',
  '/',
  '/etc',
  '/var',
  '/bin',
  '/sbin',
  '/usr',
  '/root',
  '/home',
  'c:',
  'c:\\',
  'c:/',
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\users',
]);

export class DockerSandboxCommandExecutor implements CommandExecutor {
  public readonly workspaceRoot: string;
  private readonly signal?: AbortSignal;
  private readonly image: string;
  private readonly containerEngine: 'docker' | 'podman';
  private readonly network: SandboxNetworkPolicy;
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly pidsLimit: number;
  private readonly readOnlyRootfs: boolean;
  private readonly runner?: (
    command: string,
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<ExecuteCommandResult>;
  private isAvailableCached: boolean | null = null;

  constructor(options: DockerSandboxOptions) {
    if (!options?.workspaceRoot?.trim()) {
      throw new Error('DockerSandboxCommandExecutor requires a non-empty workspaceRoot option.');
    }

    const rawNormalized = options.workspaceRoot.trim().replace(/[\\/]+$/, '').toLowerCase();
    const resolved = resolve(options.workspaceRoot);
    const parsed = parse(resolved);
    const normalizedLower = normalize(resolved).toLowerCase().replace(/[\\/]+$/, '');

    // Security check: Never mount root filesystem or system directories
    if (
      resolved === parsed.root ||
      FORBIDDEN_WORKSPACE_ROOTS.has(rawNormalized) ||
      FORBIDDEN_WORKSPACE_ROOTS.has(normalizedLower) ||
      normalizedLower === ''
    ) {
      throw new Error(
        `Insecure workspace root: Mounting host root or sensitive system directory "${resolved}" into container is strictly forbidden.`
      );
    }

    this.workspaceRoot = resolved;
    this.signal = options.signal;
    this.image = options.image || 'node:24-slim';
    this.containerEngine = options.containerEngine || 'docker';
    this.network = options.network || 'none';
    this.memoryLimit = options.memoryLimit || '1g';
    this.cpuLimit = options.cpuLimit || '1.0';
    this.pidsLimit = options.pidsLimit || 100;
    this.readOnlyRootfs = options.readOnlyRootfs ?? true;
    this.runner = options.runner;
  }

  /**
   * Checks whether the configured container CLI and daemon are reachable.
   */
  async isAvailable(): Promise<boolean> {
    if (this.runner) {
      return true;
    }
    if (this.isAvailableCached !== null) {
      return this.isAvailableCached;
    }

    try {
      const res = await new Promise<boolean>((res) => {
        execFile(
          this.containerEngine,
          ['--version'],
          { timeout: 3000 },
          (err, stdout) => {
            if (err) res(false);
            else res(stdout.trim().length > 0);
          }
        );
      });
      this.isAvailableCached = res;
      return res;
    } catch {
      this.isAvailableCached = false;
      return false;
    }
  }

  /**
   * Resolves `requestedCwd` lexically against workspace root and verifies no escape.
   */
  resolveSafeCwd(requestedCwd: string): string {
    if (typeof requestedCwd !== 'string' || !requestedCwd.trim()) {
      throw new Error('cwd must be a non-empty string.');
    }
    if (requestedCwd.includes('\0')) {
      throw new Error('cwd cannot contain null bytes.');
    }
    if (isAbsolute(requestedCwd)) {
      throw new Error(`cwd must be relative to the workspace; absolute path rejected: "${requestedCwd}"`);
    }

    const targetPath = resolve(this.workspaceRoot, requestedCwd);
    const rel = relative(this.workspaceRoot, targetPath);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`cwd traversal denied: "${requestedCwd}" escapes workspace root.`);
    }

    return rel.replace(/\\/g, '/');
  }

  /**
   * Assembles the secure `docker run` or `podman run` arguments.
   */
  buildDockerRunArgs(
    command: string,
    args: string[],
    relCwd: string,
    containerName: string
  ): string[] {
    const dockerArgs: string[] = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      this.network,
      '--memory',
      this.memoryLimit,
      '--memory-swap',
      this.memoryLimit, // prevent swap escape
      '--cpus',
      this.cpuLimit,
      '--pids-limit',
      String(this.pidsLimit),
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
    ];

    if (this.readOnlyRootfs) {
      dockerArgs.push(
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m'
      );
    }

    // Mount workspace directory strictly
    // Docker volume format: hostDir:containerDir:rw
    dockerArgs.push('-v', `${this.workspaceRoot}:/workspace:rw`);

    // Target working directory inside container
    const containerCwd = relCwd ? `/workspace/${relCwd}` : '/workspace';
    dockerArgs.push('-w', containerCwd);

    // Minimal explicit environment allowlist passed into container
    dockerArgs.push(
      '-e',
      'NODE_ENV=production',
      '-e',
      'HOME=/tmp',
      '-e',
      'TMPDIR=/tmp',
      '-e',
      'PATH=/usr/local/bin:/usr/bin:/bin'
    );

    // Image and command
    dockerArgs.push(this.image, command, ...args);

    return dockerArgs;
  }

  async execute(
    command: string,
    args: string[],
    options?: ExecuteCommandOptions
  ): Promise<ExecuteCommandResult> {
    // 1. Validate command
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('command must be a non-empty string.');
    }
    const normalized = command.trim();
    if (!ALLOWED_SANDBOX_EXECUTABLES.has(normalized)) {
      throw new Error(
        `Command not allowed in sandbox: "${normalized}". Allowed executables: ${[...ALLOWED_SANDBOX_EXECUTABLES].join(', ')}.`
      );
    }

    // 2. Validate args
    if (!Array.isArray(args)) {
      throw new Error('args must be an array.');
    }
    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error('Each element of args must be a string.');
      }
    }

    // 3. Resolve relative cwd
    let relCwd = '';
    if (options?.cwd !== undefined) {
      relCwd = this.resolveSafeCwd(options.cwd);
    }

    // 4. Check runtime availability
    const available = await this.isAvailable();
    if (!available) {
      throw new SandboxUnavailableError(
        `Sandbox runtime "${this.containerEngine}" is not available or daemon is not reachable. ` +
        `Production execution cannot execute untrusted agent commands on the host.`
      );
    }

    // 5. Timeout configuration
    let timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
      timeoutMs = DEFAULT_TIMEOUT_MS;
    }
    if (timeoutMs > MAX_TIMEOUT_MS) {
      timeoutMs = MAX_TIMEOUT_MS;
    }

    const containerName = `orc-sbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const dockerArgs = this.buildDockerRunArgs(normalized, args, relCwd, containerName);

    // 6. Custom runner path (for testing and mock execution)
    if (this.runner) {
      return this.runner(this.containerEngine, dockerArgs, {
        timeoutMs,
        signal: options?.signal ?? this.signal,
      });
    }

    // 7. Live container execution
    return new Promise<ExecuteCommandResult>((resolveResult) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;

      const effectiveSignal = options?.signal ?? this.signal;

      const child = execFile(this.containerEngine, dockerArgs, {
        shell: false,
        signal: effectiveSignal,
      });

      const killContainer = () => {
        try {
          execFile(this.containerEngine, ['kill', containerName], { timeout: 5000 }, () => {});
        } catch {
          // ignore cleanup errors
        }
      };

      timer = setTimeout(() => {
        timedOut = true;
        killContainer();
        child.kill('SIGKILL');
      }, timeoutMs);

      if (effectiveSignal) {
        effectiveSignal.addEventListener('abort', () => {
          killContainer();
        });
      }

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

      child.on('close', (exitCode, sig) => {
        if (timer !== undefined) clearTimeout(timer);
        resolveResult({
          exitCode: exitCode ?? null,
          signal: (sig as NodeJS.Signals | null) ?? null,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          timedOut,
        });
      });

      child.on('error', (err) => {
        if (timer !== undefined) clearTimeout(timer);
        if (!stderrBuf && err && typeof (err as Error).message === 'string') {
          stderrBuf = (err as Error).message;
        }
      });
    });
  }
}
