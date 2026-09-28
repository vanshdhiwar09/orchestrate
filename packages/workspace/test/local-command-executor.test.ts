import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCommandExecutor } from '../src/local-command-executor.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(os.tmpdir(), 'orc-executor-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeExecutor(): LocalCommandExecutor {
  return new LocalCommandExecutor({ workspaceRoot: tmpDir });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalCommandExecutor', () => {
  it('1. allowed command succeeds with exit code 0', async () => {
    const executor = makeExecutor();
    const result = await executor.execute('node', ['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.stdout).toMatch(/^v\d+/);
  });

  it('2. non-zero exit code is returned as structured result, not exception', async () => {
    const executor = makeExecutor();
    // `node -e "process.exit(42)"` exits with code 42
    const result = await executor.execute('node', ['-e', 'process.exit(42)']);

    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
    // No exception should have been thrown
  });

  it('3. stdout is captured', async () => {
    const executor = makeExecutor();
    const result = await executor.execute('node', ['-e', 'process.stdout.write("hello stdout")']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello stdout');
  });

  it('4. stderr is captured', async () => {
    const executor = makeExecutor();
    const result = await executor.execute('node', ['-e', 'process.stderr.write("hello stderr")']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('hello stderr');
  });

  it('5. shell metacharacters are passed as literal args (shell: false)', async () => {
    const executor = makeExecutor();
    // If shell were true, `rm -rf /` would be dangerous; with shell: false the
    // semicolon is a literal argument to node and not a shell separator.
    const dangerous = '; echo INJECTED';
    const result = await executor.execute('node', ['-e', `process.stdout.write(${JSON.stringify(dangerous)})`]);

    expect(result.stdout).toBe(dangerous);
    // Output must NOT contain "INJECTED" appearing as a separate shell command result
    expect(result.stdout).not.toContain('INJECTED\n');
  });

  it('6. disallowed executable is rejected before spawning', async () => {
    const executor = makeExecutor();

    await expect(executor.execute('bash', [])).rejects.toThrow(
      'Command not allowed: "bash"'
    );
    await expect(executor.execute('powershell', [])).rejects.toThrow(
      'Command not allowed: "powershell"'
    );
    await expect(executor.execute('curl', [])).rejects.toThrow(
      'Command not allowed: "curl"'
    );
  });

  it('7. cwd traversal via ".." is rejected', async () => {
    const executor = makeExecutor();

    await expect(executor.execute('node', ['--version'], { cwd: '..' })).rejects.toThrow(
      'cwd traversal denied'
    );
    await expect(executor.execute('node', ['--version'], { cwd: '../../etc' })).rejects.toThrow(
      'cwd traversal denied'
    );
  });

  it('8. cwd symlink escape is rejected', async () => {
    // Create a symlink inside the workspace that points outside of it
    const outsideDir = await mkdtemp(join(os.tmpdir(), 'orc-outside-'));
    const symlinkPath = join(tmpDir, 'escape-link');

    try {
      await symlink(outsideDir, symlinkPath, 'junction');
    } catch {
      // On some platforms junction requires the target to exist;
      // fall back to dir symlink type
      await symlink(outsideDir, symlinkPath, 'dir');
    }

    const executor = makeExecutor();

    await expect(
      executor.execute('node', ['--version'], { cwd: 'escape-link' })
    ).rejects.toThrow(/symlink|traversal/i);
  });

  it('9. timeout is enforced', async () => {
    const executor = makeExecutor();

    // Runs a process that sleeps long enough to exceed timeout
    const result = await executor.execute(
      'node',
      ['-e', 'setTimeout(() => {}, 999999)'],
      { timeoutMs: 300 }
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    if (result.signal !== null) {
      expect(result.signal).toBe('SIGTERM');
    }
  }, 10_000);

  it('10. stdout and stderr output limits are enforced (1 MiB)', async () => {
    const executor = makeExecutor();

    // Generate > 1 MiB of output on stdout
    const result = await executor.execute('node', [
      '-e',
      // Write 2 MiB to stdout
      `const chunk = 'x'.repeat(65536); for(let i=0;i<32;i++) process.stdout.write(chunk);`,
    ]);

    const MAX = 1_048_576;
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(MAX);
  }, 15_000);

  it('11. child process environment does not contain NEBIUS_API_KEY', async () => {
    // Temporarily set the key in the parent process environment
    const original = process.env.NEBIUS_API_KEY;
    process.env.NEBIUS_API_KEY = 'sk-test-secret-key';

    try {
      const executor = makeExecutor();
      const result = await executor.execute('node', [
        '-e',
        'process.stdout.write(process.env.NEBIUS_API_KEY ?? "NOT_SET")',
      ]);

      expect(result.stdout).toBe('NOT_SET');
      expect(result.stdout).not.toContain('sk-test-secret-key');
    } finally {
      if (original === undefined) {
        delete process.env.NEBIUS_API_KEY;
      } else {
        process.env.NEBIUS_API_KEY = original;
      }
    }
  });

  it('12. execute_command tool input validation rejects bad inputs', async () => {
    const { createExecuteCommandTool } = await import(
      '../../core/src/tools.js'
    );
    const { LocalCommandExecutor: LCE } = await import('../src/local-command-executor.js');

    const executor = new LCE({ workspaceRoot: tmpDir });
    const tool = createExecuteCommandTool(executor);

    // empty command
    await expect(tool.execute({ command: '', args: [] })).rejects.toThrow(
      'execute_command requires a non-empty string "command" parameter.'
    );

    // args not an array
    await expect(tool.execute({ command: 'node', args: 'bad' as any })).rejects.toThrow(
      'execute_command requires an array "args" parameter.'
    );

    // arg not a string
    await expect(tool.execute({ command: 'node', args: [123 as any] })).rejects.toThrow(
      'execute_command: each element of "args" must be a string.'
    );

    // cwd wrong type
    await expect(tool.execute({ command: 'node', args: [], cwd: 42 as any })).rejects.toThrow(
      'execute_command: "cwd", if provided, must be a string.'
    );
  });

  it('executes successfully in a valid sub-directory cwd', async () => {
    const subdir = join(tmpDir, 'sub');
    await mkdir(subdir);

    const executor = makeExecutor();
    const result = await executor.execute('node', ['--version'], { cwd: 'sub' });

    expect(result.exitCode).toBe(0);
  });

  it('rejects absolute path as cwd', async () => {
    const executor = makeExecutor();

    await expect(
      executor.execute('node', ['--version'], { cwd: '/etc' })
    ).rejects.toThrow(/absolute path rejected/);
  });

  it('rejects non-existent cwd', async () => {
    const executor = makeExecutor();

    await expect(
      executor.execute('node', ['--version'], { cwd: 'nonexistent-dir' })
    ).rejects.toThrow(/does not exist/);
  });

  it('executes git --version successfully', async () => {
    const executor = makeExecutor();
    const result = await executor.execute('git', ['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');
  });

  it('1. npm resolves correctly', () => {
    const executor = makeExecutor();
    const res = executor.resolveExecution('npm', ['--version'], tmpDir);

    if (process.platform === 'win32') {
      expect(res.executable).toBe(process.execPath);
      expect(res.args[0]).toMatch(/npm-cli\.js$/i);
      expect(res.args[1]).toBe('--version');
    } else {
      expect(res.executable).toBe('npm');
      expect(res.args).toEqual(['--version']);
    }
  });

  it('2. npx resolves correctly', () => {
    const executor = makeExecutor();
    const res = executor.resolveExecution('npx', ['--version'], tmpDir);

    if (process.platform === 'win32') {
      expect(res.executable).toBe(process.execPath);
      expect(res.args[0]).toMatch(/npx-cli\.js$/i);
      expect(res.args[1]).toBe('--version');
    } else {
      expect(res.executable).toBe('npx');
      expect(res.args).toEqual(['--version']);
    }
  });

  it('3. the executor can successfully run npx --version', async () => {
    const executor = makeExecutor();
    const result = await executor.execute('npx', ['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('4. no PowerShell script is invoked', () => {
    const executor = makeExecutor();
    const allowlist = ['node', 'npm', 'npx', 'tsc', 'git'] as const;

    for (const cmd of allowlist) {
      const res = executor.resolveExecution(cmd, ['--version'], tmpDir);

      // Executable must never be PowerShell
      expect(res.executable.toLowerCase()).not.toContain('powershell');
      expect(res.executable.toLowerCase()).not.toContain('pwsh');

      // Arguments must never invoke a PowerShell script (.ps1)
      for (const arg of res.args) {
        expect(arg.toLowerCase()).not.toMatch(/\.ps1$/i);
      }
    }
  });

  it('executes npm --version successfully without shell', async () => {
    const executor = makeExecutor();
    const result = await executor.execute('npm', ['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('executes tsc --version successfully without shell', async () => {
    const executor = makeExecutor();
    const result = await executor.execute('tsc', ['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Version');
  });
});
