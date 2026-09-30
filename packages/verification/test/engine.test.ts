import { describe, expect, it } from 'vitest';
import type {
  CommandExecutor,
  ExecuteCommandOptions,
  ExecuteCommandResult,
} from '@orchestrate/workspace';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  VerificationEngine,
  type VerificationPlan,
} from '../src/index.js';

// ── Test Double: FakeCommandExecutor ─────────────────────────────────────────

class FakeCommandExecutor implements CommandExecutor {
  readonly calls: {
    command: string;
    args: string[];
    options?: ExecuteCommandOptions;
    timestamp: number;
  }[] = [];

  private handlers = new Map<string, ExecuteCommandResult>();
  private queue: ExecuteCommandResult[] = [];
  defaultResult: ExecuteCommandResult = {
    exitCode: 0,
    signal: null,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
  };

  setResponseForCommand(command: string, result: ExecuteCommandResult): void {
    this.handlers.set(command, result);
  }

  setResponseForKey(key: string, result: ExecuteCommandResult): void {
    this.handlers.set(key, result);
  }

  enqueueResponse(result: ExecuteCommandResult): void {
    this.queue.push(result);
  }

  async execute(
    command: string,
    args: string[],
    options?: ExecuteCommandOptions
  ): Promise<ExecuteCommandResult> {
    this.calls.push({ command, args, options, timestamp: performance.now() });

    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }

    const key = `${command} ${args.join(' ')}`;
    if (this.handlers.has(key)) {
      return this.handlers.get(key)!;
    }
    if (this.handlers.has(command)) {
      return this.handlers.get(command)!;
    }

    return this.defaultResult;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('VerificationEngine', () => {
  it('constructor rejects invalid executor', () => {
    expect(() => new VerificationEngine({} as any)).toThrow(
      /valid CommandExecutor instance/i
    );
    expect(() => new VerificationEngine({ executor: null as any })).toThrow(
      /valid CommandExecutor instance/i
    );
  });

  it('1. single passing check → VERIFIED', async () => {
    const executor = new FakeCommandExecutor();
    executor.defaultResult = {
      exitCode: 0,
      signal: null,
      stdout: 'all tests passed',
      stderr: '',
      timedOut: false,
    };
    const engine = new VerificationEngine({ executor });

    const plan: VerificationPlan = {
      checks: [
        {
          id: 'test-1',
          name: 'Unit Tests',
          command: 'npm',
          args: ['test'],
        },
      ],
    };

    const result = await engine.verify(plan);

    expect(result.status).toBe('VERIFIED');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].checkId).toBe('test-1');
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);
    expect(result.checks[0].stdout).toBe('all tests passed');
  });

  it('2. single failing check → FAILED', async () => {
    const executor = new FakeCommandExecutor();
    executor.defaultResult = {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'AssertionError: expected true to be false',
      timedOut: false,
    };
    const engine = new VerificationEngine({ executor });

    const plan: VerificationPlan = {
      checks: [
        {
          id: 'test-1',
          name: 'Unit Tests',
          command: 'npm',
          args: ['test'],
        },
      ],
    };

    const result = await engine.verify(plan);

    expect(result.status).toBe('FAILED');
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].exitCode).toBe(1);
    expect(result.checks[0].stderr).toContain('AssertionError');
  });

  it('3. multiple passing checks → VERIFIED', async () => {
    const executor = new FakeCommandExecutor();
    const engine = new VerificationEngine({ executor });

    const plan: VerificationPlan = {
      checks: [
        { id: 'lint', name: 'Lint', command: 'npm', args: ['run', 'lint'] },
        { id: 'typecheck', name: 'Typecheck', command: 'tsc', args: ['--noEmit'] },
        { id: 'test', name: 'Tests', command: 'npm', args: ['test'] },
      ],
    };

    const result = await engine.verify(plan);

    expect(result.status).toBe('VERIFIED');
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(executor.calls).toHaveLength(3);
  });

  it('4. one failure among multiple checks → FAILED', async () => {
    const executor = new FakeCommandExecutor();
    // lint passes (default 0), typecheck fails (exitCode 2), test passes (exitCode 0)
    executor.setResponseForCommand('tsc', {
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: 'error TS2322: Type number is not assignable to type string',
      timedOut: false,
    });
    const engine = new VerificationEngine({ executor });

    const plan: VerificationPlan = {
      checks: [
        { id: 'lint', name: 'Lint', command: 'npm', args: ['run', 'lint'] },
        { id: 'typecheck', name: 'Typecheck', command: 'tsc', args: ['--noEmit'] },
        { id: 'test', name: 'Tests', command: 'node', args: ['test.js'] },
      ],
    };

    const result = await engine.verify(plan);

    expect(result.status).toBe('FAILED');
    expect(result.checks).toHaveLength(3);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[1].passed).toBe(false);
    expect(result.checks[2].passed).toBe(true);
  });

  it('5. all checks execute even when an earlier check fails (no fail-fast)', async () => {
    const executor = new FakeCommandExecutor();
    executor.setResponseForKey('npm run lint', {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'lint error',
      timedOut: false,
    });
    const engine = new VerificationEngine({ executor });

    const plan: VerificationPlan = {
      checks: [
        { id: 'check-1', name: 'Lint', command: 'npm', args: ['run', 'lint'] },
        { id: 'check-2', name: 'Typecheck', command: 'tsc', args: ['-b'] },
        { id: 'check-3', name: 'Test', command: 'node', args: ['test.js'] },
      ],
    };

    const result = await engine.verify(plan);

    expect(executor.calls).toHaveLength(3);
    expect(executor.calls.map((c) => c.command)).toEqual(['npm', 'tsc', 'node']);
    expect(result.status).toBe('FAILED');
  });

  it('6. checks execute sequentially in plan order', async () => {
    const executor = new FakeCommandExecutor();
    const engine = new VerificationEngine({ executor });

    const plan: VerificationPlan = {
      checks: [
        { id: 'c1', name: 'First', command: 'git', args: ['status'] },
        { id: 'c2', name: 'Second', command: 'node', args: ['-v'] },
        { id: 'c3', name: 'Third', command: 'npx', args: ['--version'] },
      ],
    };

    await engine.verify(plan);

    expect(executor.calls).toHaveLength(3);
    expect(executor.calls[0].command).toBe('git');
    expect(executor.calls[1].command).toBe('node');
    expect(executor.calls[2].command).toBe('npx');
    // Ensure execution timestamps are non-decreasing
    expect(executor.calls[1].timestamp).toBeGreaterThanOrEqual(executor.calls[0].timestamp);
    expect(executor.calls[2].timestamp).toBeGreaterThanOrEqual(executor.calls[1].timestamp);
  });

  describe('check success criteria', () => {
    it('exitCode !== 0 causes passed=false', async () => {
      const executor = new FakeCommandExecutor();
      executor.defaultResult = {
        exitCode: 127,
        signal: null,
        stdout: '',
        stderr: 'command failed',
        timedOut: false,
      };
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });

      expect(result.checks[0].passed).toBe(false);
      expect(result.status).toBe('FAILED');
    });

    it('timedOut=true causes passed=false even if exitCode is 0', async () => {
      const executor = new FakeCommandExecutor();
      executor.defaultResult = {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: 'timed out',
        timedOut: true,
      };
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });

      expect(result.checks[0].passed).toBe(false);
      expect(result.checks[0].timedOut).toBe(true);
      expect(result.status).toBe('FAILED');
    });

    it('signal !== null causes passed=false even if exitCode is null', async () => {
      const executor = new FakeCommandExecutor();
      executor.defaultResult = {
        exitCode: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: 'killed',
        timedOut: false,
      };
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });

      expect(result.checks[0].passed).toBe(false);
      expect(result.checks[0].signal).toBe('SIGTERM');
      expect(result.status).toBe('FAILED');
    });

    it('exitCode=0 + timedOut=false + signal=null → passed=true', async () => {
      const executor = new FakeCommandExecutor();
      executor.defaultResult = {
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
      };
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });

      expect(result.checks[0].passed).toBe(true);
      expect(result.status).toBe('VERIFIED');
    });
  });

  describe('evidence preservation and metadata', () => {
    it('stdout/stderr are preserved exactly as returned', async () => {
      const executor = new FakeCommandExecutor();
      executor.defaultResult = {
        exitCode: 0,
        signal: null,
        stdout: 'exact stdout output\nwith newlines\n',
        stderr: 'exact stderr diagnostic\n',
        timedOut: false,
      };
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: ['script.js'] }],
      });

      expect(result.checks[0].stdout).toBe('exact stdout output\nwith newlines\n');
      expect(result.checks[0].stderr).toBe('exact stderr diagnostic\n');
    });

    it('evidence contains command, args, and cwd', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [
          {
            id: 'c-sub',
            name: 'Sub-dir test',
            command: 'npm',
            args: ['run', 'build'],
            cwd: 'packages/sub',
          },
        ],
      });

      const ev = result.checks[0];
      expect(ev.command).toBe('npm');
      expect(ev.args).toEqual(['run', 'build']);
      expect(ev.cwd).toBe('packages/sub');
    });

    it('durationMs is recorded as non-negative integer', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });

      expect(typeof result.checks[0].durationMs).toBe('number');
      expect(result.checks[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('verifiedAt is recorded as valid ISO timestamp', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const before = new Date().toISOString();
      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });
      const after = new Date().toISOString();

      const iso = result.checks[0].verifiedAt;
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(iso >= before).toBe(true);
      expect(iso <= after).toBe(true);
    });

    it('executedAt and totalDurationMs are recorded on result', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const result = await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });

      expect(result.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(typeof result.totalDurationMs).toBe('number');
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('timeout policy', () => {
    it('omitted timeout uses DEFAULT_TIMEOUT_MS (5 min)', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [] }],
      });

      expect(executor.calls[0].options?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
    });

    it('explicit timeout is passed through to CommandExecutor', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await engine.verify({
        checks: [{ id: 'c', name: 'C', command: 'node', args: [], timeoutMs: 15_000 }],
      });

      expect(executor.calls[0].options?.timeoutMs).toBe(15_000);
    });

    it('invalid timeout (negative, 0, NaN) is rejected before execution', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(
        engine.verify({
          checks: [{ id: 'c', name: 'C', command: 'node', args: [], timeoutMs: -1 }],
        })
      ).rejects.toThrow(/finite positive number/);

      await expect(
        engine.verify({
          checks: [{ id: 'c', name: 'C', command: 'node', args: [], timeoutMs: 0 }],
        })
      ).rejects.toThrow(/finite positive number/);

      await expect(
        engine.verify({
          checks: [{ id: 'c', name: 'C', command: 'node', args: [], timeoutMs: NaN }],
        })
      ).rejects.toThrow(/finite positive number/);

      expect(executor.calls).toHaveLength(0);
    });

    it('timeout above MAX_TIMEOUT_MS is rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(
        engine.verify({
          checks: [
            {
              id: 'c',
              name: 'C',
              command: 'node',
              args: [],
              timeoutMs: MAX_TIMEOUT_MS + 1,
            },
          ],
        })
      ).rejects.toThrow(/exceeds maximum allowed timeout/);

      expect(executor.calls).toHaveLength(0);
    });
  });

  describe('plan validation before execution', () => {
    it('empty plan is rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(engine.verify({ checks: [] })).rejects.toThrow(
        /must contain at least one check/
      );
      expect(executor.calls).toHaveLength(0);
    });

    it('null or non-object plan is rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(engine.verify(null as any)).rejects.toThrow(/non-null object/);
      await expect(engine.verify(undefined as any)).rejects.toThrow(/non-null object/);
      await expect(engine.verify({ checks: 'bad' as any })).rejects.toThrow(
        /must be an array/
      );
      expect(executor.calls).toHaveLength(0);
    });

    it('duplicate IDs are rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const plan: VerificationPlan = {
        checks: [
          { id: 'duplicate-id', name: 'First', command: 'node', args: [] },
          { id: 'duplicate-id', name: 'Second', command: 'tsc', args: [] },
        ],
      };

      await expect(engine.verify(plan)).rejects.toThrow(
        'Duplicate verification check ID: "duplicate-id"'
      );
      expect(executor.calls).toHaveLength(0);
    });

    it('empty ID is rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(
        engine.verify({
          checks: [{ id: '', name: 'Test', command: 'node', args: [] }],
        })
      ).rejects.toThrow(/non-empty string "id"/);

      await expect(
        engine.verify({
          checks: [{ id: '   ', name: 'Test', command: 'node', args: [] }],
        })
      ).rejects.toThrow(/non-empty string "id"/);
      expect(executor.calls).toHaveLength(0);
    });

    it('empty name is rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(
        engine.verify({
          checks: [{ id: 'test', name: '', command: 'node', args: [] }],
        })
      ).rejects.toThrow(/non-empty string "name"/);
      expect(executor.calls).toHaveLength(0);
    });

    it('empty command is rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(
        engine.verify({
          checks: [{ id: 'test', name: 'Test', command: '', args: [] }],
        })
      ).rejects.toThrow(/non-empty string "command"/);
      expect(executor.calls).toHaveLength(0);
    });

    it('invalid args are rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(
        engine.verify({
          checks: [{ id: 'test', name: 'Test', command: 'node', args: 'bad' as any }],
        })
      ).rejects.toThrow(/must have an array "args"/);

      await expect(
        engine.verify({
          checks: [{ id: 'test', name: 'Test', command: 'node', args: [123 as any] }],
        })
      ).rejects.toThrow(/args\[0\] must be a string/);
      expect(executor.calls).toHaveLength(0);
    });

    it('invalid cwd is rejected', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      await expect(
        engine.verify({
          checks: [{ id: 'test', name: 'Test', command: 'node', args: [], cwd: '' }],
        })
      ).rejects.toThrow(/must be a non-empty string/);

      await expect(
        engine.verify({
          checks: [{ id: 'test', name: 'Test', command: 'node', args: [], cwd: 123 as any }],
        })
      ).rejects.toThrow(/must be a non-empty string/);
      expect(executor.calls).toHaveLength(0);
    });

    it('disallowed command is rejected before execution', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const dangerousCommands = [
        'powershell',
        'pwsh',
        'cmd',
        'bash',
        'sh',
        'curl',
        'wget',
        'python',
      ];

      for (const cmd of dangerousCommands) {
        await expect(
          engine.verify({
            checks: [{ id: `test-${cmd}`, name: 'Test', command: cmd, args: [] }],
          })
        ).rejects.toThrow(/Command not allowed in verification check/);
      }

      expect(executor.calls).toHaveLength(0);
    });

    it('if plan validation fails, FakeCommandExecutor records ZERO executions', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const plan: VerificationPlan = {
        checks: [
          { id: 'valid-1', name: 'Valid', command: 'node', args: [] },
          { id: 'bad-2', name: 'Bad', command: 'bash', args: [] }, // disallowed
        ],
      };

      await expect(engine.verify(plan)).rejects.toThrow(/Command not allowed/);
      // Valid-1 must NOT have run
      expect(executor.calls).toHaveLength(0);
    });

    it('original plan is not mutated during verification', async () => {
      const executor = new FakeCommandExecutor();
      const engine = new VerificationEngine({ executor });

      const plan: VerificationPlan = {
        checks: [
          { id: 'test', name: 'Test', command: 'node', args: ['-v'], cwd: 'sub' },
        ],
      };

      const originalPlanCopy = JSON.parse(JSON.stringify(plan));
      await engine.verify(plan);

      expect(plan).toEqual(originalPlanCopy);
    });
  });
});
