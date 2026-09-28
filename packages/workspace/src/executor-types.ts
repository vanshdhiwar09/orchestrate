/**
 * Provider-agnostic command execution abstraction.
 *
 * V1 security model:
 *  - Executable allowlisting (node, npm, npx, tsc, git only)
 *  - shell: false — no shell injection surface
 *  - workspace-rooted cwd containment (lexical + physical realpath)
 *  - environment sanitization (credentials not forwarded)
 *  - timeout enforced by the runtime (30s default, 120s maximum)
 *  - bounded stdout/stderr (1 MiB per stream)
 *
 * This is NOT a full OS sandbox. It does not provide network firewalling,
 * Docker isolation, or kernel-level restrictions.
 */

export interface ExecuteCommandOptions {
  /**
   * Working directory for the subprocess, relative to the configured workspace root.
   * Defaults to the workspace root if omitted.
   * Must not escape the workspace via path traversal or symlinks.
   */
  cwd?: string;
  /**
   * Timeout in milliseconds. Must be between 1 and 120_000.
   * Defaults to 30_000 (30 seconds).
   */
  timeoutMs?: number;
}

export interface ExecuteCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandExecutor {
  execute(
    command: string,
    args: string[],
    options?: ExecuteCommandOptions
  ): Promise<ExecuteCommandResult>;
}
