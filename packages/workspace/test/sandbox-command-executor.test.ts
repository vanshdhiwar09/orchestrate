import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DockerSandboxCommandExecutor,
  SandboxUnavailableError,
} from '../src/sandbox-command-executor.js';
import { createCommandExecutor } from '../src/executor-factory.js';
import { LocalCommandExecutor, DEFAULT_ENV_ALLOWLIST, BLOCKED_ENV_KEYS } from '../src/local-command-executor.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'orc-sandbox-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('DockerSandboxCommandExecutor & Factory', () => {
  describe('1. Security Boundaries & Workspace Root Validation', () => {
    it('rejects forbidden host roots (e.g. root or system directories)', () => {
      expect(() => new DockerSandboxCommandExecutor({ workspaceRoot: '/' })).toThrow(
        /Insecure workspace root/i
      );
      expect(() => new DockerSandboxCommandExecutor({ workspaceRoot: '/etc' })).toThrow(
        /Insecure workspace root/i
      );
      if (process.platform === 'win32') {
        expect(() => new DockerSandboxCommandExecutor({ workspaceRoot: 'C:\\' })).toThrow(
          /Insecure workspace root/i
        );
        expect(() => new DockerSandboxCommandExecutor({ workspaceRoot: 'C:\\Windows' })).toThrow(
          /Insecure workspace root/i
        );
      }
    });

    it('rejects empty workspace root', () => {
      expect(() => new DockerSandboxCommandExecutor({ workspaceRoot: '  ' })).toThrow(
        /non-empty workspaceRoot/i
      );
    });

    it('rejects cwd traversal attempting to escape workspace', () => {
      const executor = new DockerSandboxCommandExecutor({
        workspaceRoot: tmpDir,
      });

      expect(() => executor.resolveSafeCwd('../')).toThrow(/cwd traversal denied/i);
      expect(() => executor.resolveSafeCwd('../../etc')).toThrow(/cwd traversal denied/i);
      expect(() => executor.resolveSafeCwd('/absolute/path')).toThrow(/absolute path rejected/i);
    });

    it('resolves valid relative cwd', () => {
      const executor = new DockerSandboxCommandExecutor({
        workspaceRoot: tmpDir,
      });

      expect(executor.resolveSafeCwd('src/components')).toBe('src/components');
    });
  });

  describe('2. Command Validation', () => {
    it('rejects disallowed binaries in sandbox', async () => {
      const executor = new DockerSandboxCommandExecutor({
        workspaceRoot: tmpDir,
        runner: async () => ({
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
        }),
      });

      await expect(executor.execute('bash', [])).rejects.toThrow(/Command not allowed in sandbox: "bash"/i);
      await expect(executor.execute('curl', [])).rejects.toThrow(/Command not allowed in sandbox: "curl"/i);
      await expect(executor.execute('powershell', [])).rejects.toThrow(/Command not allowed in sandbox: "powershell"/i);
    });

    it('allows permitted executables (node, npm, npx, tsc, git)', async () => {
      let executedCommand = '';
      const executor = new DockerSandboxCommandExecutor({
        workspaceRoot: tmpDir,
        runner: async (cmd, args) => {
          executedCommand = args[args.length - 2]; // image, command, ...args
          return {
            exitCode: 0,
            signal: null,
            stdout: 'v24.0.0',
            stderr: '',
            timedOut: false,
          };
        },
      });

      const res = await executor.execute('node', ['--version']);
      expect(res.exitCode).toBe(0);
      expect(executedCommand).toBe('node');
    });
  });

  describe('3. Docker Container Argument Assembly', () => {
    it('assembles all critical security and isolation flags in docker run args', async () => {
      let capturedEngine = '';
      let capturedArgs: string[] = [];

      const executor = new DockerSandboxCommandExecutor({
        workspaceRoot: tmpDir,
        image: 'node:24-slim',
        network: 'none',
        memoryLimit: '512m',
        cpuLimit: '0.8',
        pidsLimit: 50,
        runner: async (engine, args) => {
          capturedEngine = engine;
          capturedArgs = args;
          return {
            exitCode: 0,
            signal: null,
            stdout: 'ok',
            stderr: '',
            timedOut: false,
          };
        },
      });

      await executor.execute('node', ['-e', 'console.log("secure")'], { cwd: 'subdir' });

      expect(capturedEngine).toBe('docker');
      expect(capturedArgs[0]).toBe('run');
      expect(capturedArgs).toContain('--rm');
      expect(capturedArgs).toContain('--network');
      expect(capturedArgs[capturedArgs.indexOf('--network') + 1]).toBe('none');
      expect(capturedArgs).toContain('--memory');
      expect(capturedArgs[capturedArgs.indexOf('--memory') + 1]).toBe('512m');
      expect(capturedArgs).toContain('--memory-swap');
      expect(capturedArgs[capturedArgs.indexOf('--memory-swap') + 1]).toBe('512m');
      expect(capturedArgs).toContain('--cpus');
      expect(capturedArgs[capturedArgs.indexOf('--cpus') + 1]).toBe('0.8');
      expect(capturedArgs).toContain('--pids-limit');
      expect(capturedArgs[capturedArgs.indexOf('--pids-limit') + 1]).toBe('50');
      expect(capturedArgs).toContain('--security-opt');
      expect(capturedArgs[capturedArgs.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
      expect(capturedArgs).toContain('--cap-drop');
      expect(capturedArgs[capturedArgs.indexOf('--cap-drop') + 1]).toBe('ALL');
      expect(capturedArgs).toContain('--read-only');

      // Volume mount must mount ONLY the workspace root
      const vIdx = capturedArgs.indexOf('-v');
      expect(vIdx).toBeGreaterThan(-1);
      expect(capturedArgs[vIdx + 1]).toBe(`${tmpDir}:/workspace:rw`);

      // Working directory inside container
      const wIdx = capturedArgs.indexOf('-w');
      expect(wIdx).toBeGreaterThan(-1);
      expect(capturedArgs[wIdx + 1]).toBe('/workspace/subdir');

      // Image name and command
      expect(capturedArgs).toContain('node:24-slim');
      expect(capturedArgs).toContain('node');
    });
  });

  describe('4. Fail-Closed Error Behavior', () => {
    it('throws SandboxUnavailableError when container engine is missing or unreachable', async () => {
      const executor = new DockerSandboxCommandExecutor({
        workspaceRoot: tmpDir,
        containerEngine: 'docker' as any,
      });

      // Override availability probe to simulate missing Docker daemon
      executor.isAvailable = async () => false;

      await expect(executor.execute('node', ['--version'])).rejects.toThrow(
        SandboxUnavailableError
      );
      await expect(executor.execute('node', ['--version'])).rejects.toThrow(
        /Sandbox runtime "docker" is not available/i
      );
    });
  });

  describe('5. Factory Mode Selection & Production Invariants', () => {
    it('returns DockerSandboxCommandExecutor when mode is "sandbox"', () => {
      const executor = createCommandExecutor({
        workspaceRoot: tmpDir,
        mode: 'sandbox',
      });

      expect(executor).toBeInstanceOf(DockerSandboxCommandExecutor);
    });

    it('returns LocalCommandExecutor in development when mode is "local"', () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const executor = createCommandExecutor({
          workspaceRoot: tmpDir,
          mode: 'local',
        });

        expect(executor).toBeInstanceOf(LocalCommandExecutor);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('strictly forbids LocalCommandExecutor when NODE_ENV is "production"', () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(() =>
          createCommandExecutor({
            workspaceRoot: tmpDir,
            mode: 'local',
          })
        ).toThrow(/Insecure execution denied: LocalCommandExecutor cannot be used when NODE_ENV=production/i);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('defaults to sandbox and fails closed in production when mode is "auto"', () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const executor = createCommandExecutor({
          workspaceRoot: tmpDir,
          mode: 'auto',
        });

        expect(executor).toBeInstanceOf(DockerSandboxCommandExecutor);
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });
  });

  describe('6. Environment Variable Allowlist Isolation', () => {
    it('drops sensitive credentials and unlisted variables from child process', async () => {
      const prevNebius = process.env.NEBIUS_API_KEY;
      const prevDbUrl = process.env.DATABASE_URL;
      const prevJwt = process.env.JWT_SECRET;
      const prevCustomSecret = process.env.MY_CUSTOM_SECRET;

      process.env.NEBIUS_API_KEY = 'super-secret-nebius-token';
      process.env.DATABASE_URL = 'postgres://admin:password@localhost:5432/db';
      process.env.JWT_SECRET = 'jwt-signing-secret';
      process.env.MY_CUSTOM_SECRET = 'secret-sauce';

      try {
        const executor = new LocalCommandExecutor({ workspaceRoot: tmpDir });
        const res = await executor.execute('node', [
          '-e',
          `console.log(JSON.stringify({
            nebius: process.env.NEBIUS_API_KEY || null,
            dbUrl: process.env.DATABASE_URL || null,
            jwt: process.env.JWT_SECRET || null,
            custom: process.env.MY_CUSTOM_SECRET || null,
            hasPath: Boolean(process.env.PATH)
          }))`,
        ]);

        expect(res.exitCode).toBe(0);
        const parsed = JSON.parse(res.stdout);
        expect(parsed.nebius).toBeNull();
        expect(parsed.dbUrl).toBeNull();
        expect(parsed.jwt).toBeNull();
        expect(parsed.custom).toBeNull();
        expect(parsed.hasPath).toBe(true);
      } finally {
        if (prevNebius !== undefined) process.env.NEBIUS_API_KEY = prevNebius;
        else delete process.env.NEBIUS_API_KEY;

        if (prevDbUrl !== undefined) process.env.DATABASE_URL = prevDbUrl;
        else delete process.env.DATABASE_URL;

        if (prevJwt !== undefined) process.env.JWT_SECRET = prevJwt;
        else delete process.env.JWT_SECRET;

        if (prevCustomSecret !== undefined) process.env.MY_CUSTOM_SECRET = prevCustomSecret;
        else delete process.env.MY_CUSTOM_SECRET;
      }
    });
  });
});
