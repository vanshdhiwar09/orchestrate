import type { CommandExecutor, ExecuteCommandResult } from './executor-types.js';
import { LocalCommandExecutor, type LocalCommandExecutorOptions } from './local-command-executor.js';
import {
  DockerSandboxCommandExecutor,
  type DockerSandboxOptions,
  type SandboxNetworkPolicy,
} from './sandbox-command-executor.js';

export type CommandExecutorMode = 'sandbox' | 'local' | 'auto';

export interface CreateCommandExecutorOptions {
  /**
   * Absolute path to the isolated task workspace directory.
   */
  workspaceRoot: string;
  /**
   * Optional AbortSignal to cancel running commands.
   */
  signal?: AbortSignal;
  /**
   * Execution mode:
   * - 'sandbox': strictly containerized execution (fails closed if container daemon unavailable).
   * - 'local': host-level execution (allowed ONLY in development, forbidden in production).
   * - 'auto': defaults to 'sandbox' in production, 'local' in development.
   */
  mode?: CommandExecutorMode;
  /**
   * Docker image (for sandbox mode). Defaults to 'node:24-slim'.
   */
  image?: string;
  /**
   * Network policy (for sandbox mode). Defaults to 'none'.
   */
  network?: SandboxNetworkPolicy;
  /**
   * Memory limit (for sandbox mode). Defaults to '1g'.
   */
  memoryLimit?: string;
  /**
   * CPU limit (for sandbox mode). Defaults to '1.0'.
   */
  cpuLimit?: string;
  /**
   * Process limit (for sandbox mode). Defaults to 100.
   */
  pidsLimit?: number;
  /**
   * Optional mock runner for sandbox unit testing.
   */
  runner?: (
    command: string,
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal }
  ) => Promise<ExecuteCommandResult>;
  /**
   * Optional extra environment variables (for local mode).
   */
  extraEnv?: Record<string, string>;
}

/**
 * Creates a CommandExecutor configured according to the current environment and security policy.
 *
 * Security Invariant (Production):
 * When NODE_ENV=production, local host execution is strictly forbidden.
 * The executor will always instantiate a container sandbox and fail closed if the runtime is missing.
 */
export function createCommandExecutor(options: CreateCommandExecutorOptions): CommandExecutor {
  if (!options?.workspaceRoot?.trim()) {
    throw new Error('createCommandExecutor requires a non-empty workspaceRoot option.');
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const envMode = process.env.ORCHESTRATE_EXECUTOR as CommandExecutorMode | undefined;
  const requestedMode = options.mode || envMode || 'auto';

  if (requestedMode === 'local') {
    if (isProduction) {
      throw new Error(
        'Insecure execution denied: LocalCommandExecutor cannot be used when NODE_ENV=production. ' +
        'Production deployments require container isolation (Docker/Podman).'
      );
    }
    return new LocalCommandExecutor({
      workspaceRoot: options.workspaceRoot,
      signal: options.signal,
      extraEnv: options.extraEnv,
    });
  }

  if (requestedMode === 'sandbox') {
    return new DockerSandboxCommandExecutor({
      workspaceRoot: options.workspaceRoot,
      signal: options.signal,
      image: options.image,
      network: options.network,
      memoryLimit: options.memoryLimit,
      cpuLimit: options.cpuLimit,
      pidsLimit: options.pidsLimit,
      runner: options.runner,
    });
  }

  // requestedMode === 'auto'
  if (isProduction) {
    // In production, 'auto' ALWAYS requires sandbox isolation and fails closed
    return new DockerSandboxCommandExecutor({
      workspaceRoot: options.workspaceRoot,
      signal: options.signal,
      image: options.image,
      network: options.network,
      memoryLimit: options.memoryLimit,
      cpuLimit: options.cpuLimit,
      pidsLimit: options.pidsLimit,
      runner: options.runner,
    });
  }

  // In development, if a custom runner is provided (e.g. testing the sandbox), use it
  if (options.runner) {
    return new DockerSandboxCommandExecutor({
      workspaceRoot: options.workspaceRoot,
      signal: options.signal,
      image: options.image,
      network: options.network,
      memoryLimit: options.memoryLimit,
      cpuLimit: options.cpuLimit,
      pidsLimit: options.pidsLimit,
      runner: options.runner,
    });
  }

  // Otherwise, default to LocalCommandExecutor for developer convenience in local dev
  return new LocalCommandExecutor({
    workspaceRoot: options.workspaceRoot,
    signal: options.signal,
    extraEnv: options.extraEnv,
  });
}
