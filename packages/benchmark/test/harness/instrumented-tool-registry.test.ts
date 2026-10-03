import { describe, it, expect } from 'vitest';
import { ToolRegistry, type Tool } from '@orchestrate/core';
import { InstrumentedToolRegistry } from '../../src/harness/instrumented-tool-registry.js';

describe('InstrumentedToolRegistry', () => {
  const dummyTool: Tool<{ path: string; token?: string }, { success: boolean; data?: string }> = {
    name: 'read_secret_file',
    description: 'Reads a file with optional token',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async execute(input) {
      if (input.path === 'error.txt') {
        throw new Error('File not found with token bearer secret12345');
      }
      return { success: true, data: `Content of ${input.path}` };
    },
  };

  it('forwards definitions unchanged', () => {
    const inner = new ToolRegistry();
    inner.register(dummyTool);

    const instrumented = new InstrumentedToolRegistry(inner);
    const defs = instrumented.toToolDefinitions();

    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('read_secret_file');
    expect(defs[0].description).toBe('Reads a file with optional token');
    expect(defs[0].parameters).toEqual(dummyTool.inputSchema);
  });

  it('forwards execution, records chronological call events and results', async () => {
    const inner = new ToolRegistry();
    inner.register(dummyTool);

    const instrumented = new InstrumentedToolRegistry(inner);

    const res = await instrumented.execute('read_secret_file', { path: 'valid.txt' });
    expect(res).toEqual({ success: true, data: 'Content of valid.txt' });

    const events = instrumented.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe('TOOL_CALL');
    expect(events[0].toolName).toBe('read_secret_file');
    expect(events[0].arguments).toEqual({ path: 'valid.txt' });
    expect(events[0].result).toEqual({ success: true, data: 'Content of valid.txt' });
    expect(events[0].success).toBe(true);
    expect(typeof events[0].durationMs).toBe('number');
  });

  it('records failures and propagates errors exactly', async () => {
    const inner = new ToolRegistry();
    inner.register(dummyTool);

    const instrumented = new InstrumentedToolRegistry(inner);

    await expect(
      instrumented.execute('read_secret_file', { path: 'error.txt' })
    ).rejects.toThrow('File not found');

    const events = instrumented.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].error).toBeDefined();
    expect(events[0].error).toContain('[REDACTED]');
    expect(events[0].error).not.toContain('secret12345');
  });

  it('redacts sensitive arguments and results', async () => {
    const inner = new ToolRegistry();
    inner.register(dummyTool);

    const instrumented = new InstrumentedToolRegistry(inner);

    await instrumented.execute('read_secret_file', {
      path: 'src/main.ts',
      token: 'super-secret-token-value',
    });

    const events = instrumented.getEvents();
    expect(events[0].arguments.path).toBe('src/main.ts');
    expect(events[0].arguments.token).toBe('[REDACTED]');
  });
});
