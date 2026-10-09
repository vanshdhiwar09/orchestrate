import { describe, expect, it, vi } from 'vitest';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import {
  REDACTED_PLACEHOLDER,
  isSecretKey,
  sanitizeSecretText,
  redactSecrets,
  InstrumentedModelClient,
  InstrumentedToolRegistry,
  LangSmithTracer,
  createLangSmithTracer,
  type TaskExecutionSpan,
  type TelemetrySink,
} from '../src/index.js';

describe('packages/telemetry - Minimal Telemetry Foundation', () => {
  describe('Secret Redaction Utilities', () => {
    it('isSecretKey identifies sensitive credential fields and exempts harmless keys', () => {
      expect(isSecretKey('api_key')).toBe(true);
      expect(isSecretKey('apiKey')).toBe(true);
      expect(isSecretKey('secret')).toBe(true);
      expect(isSecretKey('token')).toBe(true);
      expect(isSecretKey('authToken')).toBe(true);
      expect(isSecretKey('authorization')).toBe(true);
      expect(isSecretKey('password')).toBe(true);
      expect(isSecretKey('passwd')).toBe(true);
      expect(isSecretKey('private_key')).toBe(true);

      // Exempt keys
      expect(isSecretKey('name')).toBe(false);
      expect(isSecretKey('toolName')).toBe(false);
      expect(isSecretKey('type')).toBe(false);
      expect(isSecretKey('role')).toBe(false);
      expect(isSecretKey('format')).toBe(false);
      expect(isSecretKey('description')).toBe(false);
    });

    it('sanitizeSecretText redacts standalone bearer tokens, auth headers, and provider keys', () => {
      const input = 'Header Authorization: Bearer secret-token-123456789 and Bearer abcdef123456789';
      const sanitized = sanitizeSecretText(input);
      expect(sanitized).toContain(`Authorization: ${REDACTED_PLACEHOLDER}`);
      expect(sanitized).toContain(`Bearer ${REDACTED_PLACEHOLDER}`);
      expect(sanitized).not.toContain('secret-token-123456789');

      // Provider tokens
      expect(sanitizeSecretText('sk-abcdefghijklmnopqrstuvwxyz123456')).toBe(REDACTED_PLACEHOLDER);
      expect(sanitizeSecretText('nvapi-abcdefghijklmnopqrstuvwxyz123456')).toBe(REDACTED_PLACEHOLDER);
      expect(sanitizeSecretText('ghp_abcdefghijklmnopqrstuvwxyz1234567890')).toBe(REDACTED_PLACEHOLDER);
      expect(sanitizeSecretText('xoxb-1234567890123456')).toBe(REDACTED_PLACEHOLDER);
    });

    it('sanitizeSecretText preserves innocent terms like SQL keys and plain English', () => {
      expect(sanitizeSecretText('CREATE TABLE users (id INT, PRIMARY KEY (id))')).toBe(
        'CREATE TABLE users (id INT, PRIMARY KEY (id))'
      );
      expect(sanitizeSecretText('This is the key difference between A and B.')).toBe(
        'This is the key difference between A and B.'
      );
    });

    it('sanitizeSecretText redacts custom secrets supplied to it', () => {
      const custom = ['super-confidential-string-123'];
      const text = 'Here is super-confidential-string-123 in the log.';
      expect(sanitizeSecretText(text, custom)).toBe(`Here is ${REDACTED_PLACEHOLDER} in the log.`);
    });

    it('redactSecrets recursively cleans objects, arrays, and command line args', () => {
      const complex = {
        name: 'test-agent',
        apiKey: 'super-secret-key-999',
        nested: {
          password: 'my-password-123',
          normalField: 'hello world',
          list: ['safe', 'Authorization: Bearer my-token-999999999'],
        },
        args: ['node', 'cli.js', '--api-key', 'secret-val-123', '--password=pass123', '--safe', 'value'],
      };

      const cleaned = redactSecrets(complex);
      expect(cleaned.name).toBe('test-agent');
      expect(cleaned.apiKey).toBe(REDACTED_PLACEHOLDER);
      expect(cleaned.nested.password).toBe(REDACTED_PLACEHOLDER);
      expect(cleaned.nested.normalField).toBe('hello world');
      expect(cleaned.nested.list[0]).toBe('safe');
      expect(cleaned.nested.list[1]).toContain(REDACTED_PLACEHOLDER);
      expect(cleaned.args).toEqual([
        'node',
        'cli.js',
        '--api-key',
        REDACTED_PLACEHOLDER,
        `--password=${REDACTED_PLACEHOLDER}`,
        '--safe',
        'value',
      ]);
    });
  });

  describe('InstrumentedModelClient', () => {
    it('records call events, measures durations, and tracks cumulative token usage across multiple turns', async () => {
      let turn = 0;
      const fakeModelClient: ModelClient = {
        async complete(request: ModelRequest): Promise<ModelResponse> {
          turn++;
          return {
            id: `resp-${turn}`,
            provider: 'nebius',
            model: request.model,
            message: {
              role: 'assistant',
              content: `Turn ${turn} response`,
            },
            usage: {
              promptTokens: 100 * turn,
              completionTokens: 50 * turn,
              totalTokens: 150 * turn,
            },
          };
        },
      };

      const emittedEvents: unknown[] = [];
      const client = new InstrumentedModelClient({
        modelClient: fakeModelClient,
        onCall: (ev) => emittedEvents.push(ev),
      });

      const res1 = await client.complete({
        model: 'nvidia/nemotron-mini-4b-instruct',
        messages: [{ role: 'user', content: 'Turn 1' }],
      });
      expect(res1.id).toBe('resp-1');

      const res2 = await client.complete({
        model: 'nvidia/nemotron-mini-4b-instruct',
        messages: [{ role: 'user', content: 'Turn 2' }],
      });
      expect(res2.id).toBe('resp-2');

      const events = client.getEvents();
      expect(events).toHaveLength(2);
      expect(emittedEvents).toHaveLength(2);
      expect(events[0].sequence).toBe(1);
      expect(events[1].sequence).toBe(2);
      expect(events[0].usage.input_tokens).toBe(100);
      expect(events[1].usage.input_tokens).toBe(200);

      // Cumulative usage
      const aggregate = client.getAggregateUsage();
      expect(aggregate.usage_available).toBe(true);
      expect(aggregate.input_tokens).toBe(300); // 100 + 200
      expect(aggregate.output_tokens).toBe(150); // 50 + 100
      expect(aggregate.total_tokens).toBe(450); // 150 + 300
    });

    it('isolates telemetry sink errors so inference never fails on sink error', async () => {
      const fakeModelClient: ModelClient = {
        async complete(): Promise<ModelResponse> {
          return {
            id: 'resp-ok',
            provider: 'nebius',
            model: 'test-model',
            message: { role: 'assistant', content: 'ok' },
          };
        },
      };

      const faultySink: TelemetrySink = {
        async onModelCall() {
          throw new Error('Sink network timeout');
        },
      };

      const client = new InstrumentedModelClient({
        modelClient: fakeModelClient,
        telemetrySink: faultySink,
      });

      const res = await client.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.id).toBe('resp-ok');
      expect(client.getEvents()).toHaveLength(1);
    });

    it('records error event and propagates exception when underlying model client fails', async () => {
      const failingClient: ModelClient = {
        async complete(): Promise<ModelResponse> {
          throw new Error('Rate limit exceeded: sk-secret-123456789');
        },
      };

      const client = new InstrumentedModelClient({
        modelClient: failingClient,
      });

      await expect(
        client.complete({
          model: 'test-model',
          messages: [{ role: 'user', content: 'hello' }],
        })
      ).rejects.toThrow('Rate limit exceeded');

      const events = client.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].error).toContain(REDACTED_PLACEHOLDER);
      expect(events[0].error).not.toContain('sk-secret-123456789');
    });
  });

  describe('InstrumentedToolRegistry', () => {
    it('records tool calls, arguments, results, durations, and sanitizes secrets', async () => {
      const innerRegistry = {
        async execute(name: string, input: unknown) {
          if (name === 'write_token') {
            return { saved: true, apiKey: 'raw-secret-value-1234' };
          }
          return { result: `Executed ${name}` };
        },
      };

      const registry = new InstrumentedToolRegistry(innerRegistry);
      const res = await registry.execute('write_token', {
        path: '/tmp/token',
        secretToken: 'sensitive-token-12345678',
      });
      expect(res).toEqual({ saved: true, apiKey: 'raw-secret-value-1234' });

      const events = registry.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('write_token');
      expect(events[0].success).toBe(true);
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
      expect((events[0].arguments as any).secretToken).toBe(REDACTED_PLACEHOLDER);
      expect((events[0].result as any).apiKey).toBe(REDACTED_PLACEHOLDER);
    });

    it('records tool failure and isolates telemetry sink errors', async () => {
      const failingRegistry = {
        async execute() {
          throw new Error('Disk full on write');
        },
      };

      const faultySink: TelemetrySink = {
        async onToolCall() {
          throw new Error('Sink crash');
        },
      };

      const registry = new InstrumentedToolRegistry(failingRegistry, {
        telemetrySink: faultySink,
      });

      await expect(registry.execute('bad_tool', {})).rejects.toThrow('Disk full on write');

      const events = registry.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].success).toBe(false);
      expect(events[0].error).toBe('Disk full on write');
    });
  });

  describe('LangSmithTracer', () => {
    it('is a complete no-op when disabled or when API key is missing', async () => {
      const fetchFn = vi.fn();
      const tracer = createLangSmithTracer({
        enabled: false,
        fetchFn,
      });

      expect(tracer.enabled).toBe(false);

      const span: TaskExecutionSpan = {
        projectId: 'p1',
        taskId: 't1',
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
      };

      await tracer.onTaskStart(span);
      await tracer.onModelCall({
        sequence: 1,
        type: 'MODEL_CALL',
        provider: 'nebius',
        model: 'test-model',
        request: { messagesCount: 1, toolsCount: 0 },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated_cost_usd: 0, usage_available: true },
        durationMs: 100,
      });
      await tracer.onToolCall({
        sequence: 2,
        type: 'TOOL_CALL',
        toolName: 'read_file',
        arguments: { path: 'a.txt' },
        result: { content: 'hello' },
        success: true,
        durationMs: 50,
      });
      await tracer.onTaskComplete({
        ...span,
        status: 'VERIFIED',
        completedAt: new Date().toISOString(),
      });

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('creates root task run, child runs with parent_run_id, and completes task span via REST API', async () => {
      const calls: Array<{ url: string; method: string; body: any; headers: any }> = [];
      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: JSON.parse(init?.body as string),
          headers: init?.headers,
        });
        return {
          ok: true,
          status: 200,
          text: async () => '{"ok": true}',
        } as unknown as Response;
      });

      const tracer = createLangSmithTracer({
        apiKey: 'ls-mock-key-12345678',
        projectName: 'orchestrate-test',
        fetchFn,
      });

      expect(tracer.enabled).toBe(true);

      const span: TaskExecutionSpan = {
        projectId: 'proj-1',
        taskId: 'task-1',
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        model: 'nvidia/nemotron-mini-4b-instruct',
        provider: 'nebius',
      };

      // 1. Task Start
      await tracer.onTaskStart(span);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.smith.langchain.com/runs');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers['x-api-key']).toBe('ls-mock-key-12345678');
      expect(calls[0].body.run_type).toBe('chain');
      expect(calls[0].body.name).toBe('Task: task-1');
      expect(calls[0].body.project_name).toBe('orchestrate-test');
      const rootRunId = calls[0].body.id;
      expect(rootRunId).toBeDefined();

      // 2. Child Model Call
      await tracer.onModelCall({
        sequence: 1,
        type: 'MODEL_CALL',
        provider: 'nebius',
        model: 'nvidia/nemotron-mini-4b-instruct',
        request: { messagesCount: 2, toolsCount: 1 },
        response: {
          id: 'resp-1',
          model: 'nvidia/nemotron-mini-4b-instruct',
          finishReason: 'tool_calls',
          contentPreview: 'Calling tool',
        },
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70, estimated_cost_usd: 0, usage_available: true },
        durationMs: 120,
      });

      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe('https://api.smith.langchain.com/runs');
      expect(calls[1].body.run_type).toBe('llm');
      expect(calls[1].body.parent_run_id).toBe(rootRunId);

      // 3. Child Tool Call
      await tracer.onToolCall({
        sequence: 2,
        type: 'TOOL_CALL',
        toolName: 'read_file',
        arguments: { path: 'greeting.ts', apiKey: 'secret-key-in-arg' },
        result: { content: 'export const greeting = "hi";' },
        success: true,
        durationMs: 15,
      });

      expect(calls).toHaveLength(3);
      expect(calls[2].url).toBe('https://api.smith.langchain.com/runs');
      expect(calls[2].body.run_type).toBe('tool');
      expect(calls[2].body.parent_run_id).toBe(rootRunId);
      expect(calls[2].body.inputs.apiKey).toBe(REDACTED_PLACEHOLDER);

      // 4. Task Complete
      await tracer.onTaskComplete({
        ...span,
        status: 'VERIFIED',
        handoffId: 'handoff-1',
        verificationRecordId: 'verif-1',
        durationMs: 250,
        usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70, estimated_cost_usd: 0, usage_available: true },
        completedAt: new Date().toISOString(),
      });

      expect(calls).toHaveLength(4);
      expect(calls[3].url).toBe(`https://api.smith.langchain.com/runs/${rootRunId}`);
      expect(calls[3].method).toBe('PATCH');
      expect(calls[3].body.outputs.status).toBe('VERIFIED');
      expect(calls[3].body.outputs.handoffId).toBe('handoff-1');
    });

    it('isSecretKey identifies plural credential forms', () => {
      expect(isSecretKey('credentials')).toBe(true);
      expect(isSecretKey('secrets')).toBe(true);
      expect(isSecretKey('tokens')).toBe(true);
      expect(isSecretKey('passwords')).toBe(true);
      expect(isSecretKey('api_keys')).toBe(true);
      expect(isSecretKey('apiKeys')).toBe(true);
      expect(isSecretKey('private_keys')).toBe(true);
      expect(isSecretKey('privateKeys')).toBe(true);
    });

    it('sanitizeSecretText handles Base64-style assignment patterns with +, /, =', () => {
      const input = 'api_key: "abc+def/ghi==" and password=xyz+123/456==';
      const sanitized = sanitizeSecretText(input);
      expect(sanitized).toBe(`api_key: "${REDACTED_PLACEHOLDER} and password=${REDACTED_PLACEHOLDER}`);
      expect(sanitized).not.toContain('abc+def');
      expect(sanitized).not.toContain('xyz+123');
    });

    it('redactSecrets cleans plural CLI flags', () => {
      const args = ['--credentials=secret-val-1234', '--tokens', 'token-val-5678', '--safe-flag', 'value'];
      const cleaned = redactSecrets({ args });
      expect(cleaned.args).toEqual([
        `--credentials=${REDACTED_PLACEHOLDER}`,
        '--tokens',
        REDACTED_PLACEHOLDER,
        '--safe-flag',
        'value',
      ]);
    });

    it('isolates network rejections and HTTP errors without throwing', async () => {
      const errorLog: Error[] = [];
      const fetchFn = vi.fn(async () => {
        throw new Error('Connection refused to api.smith.langchain.com');
      });

      const tracer = createLangSmithTracer({
        apiKey: 'ls-mock-key',
        fetchFn,
        onError: (err) => errorLog.push(err),
      });

      const span: TaskExecutionSpan = {
        projectId: 'p1',
        taskId: 't1',
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
      };

      // Calling tracer should not throw despite fetch failure
      await expect(tracer.onTaskStart(span)).resolves.not.toThrow();
      expect(errorLog).toHaveLength(1);
      expect(errorLog[0].message).toContain('Connection refused');
    });

    it('enforces configurable timeout and isolates aborted requests', async () => {
      const errorLog: Error[] = [];
      const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('Request timed out (aborted)'));
          });
        });
      });

      const tracer = createLangSmithTracer({
        apiKey: 'ls-mock-key',
        timeoutMs: 50, // Fast 50ms timeout for test
        fetchFn,
        onError: (err) => errorLog.push(err),
      });

      const span: TaskExecutionSpan = {
        projectId: 'p1',
        taskId: 't1',
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
      };

      await expect(tracer.onTaskStart(span)).resolves.not.toThrow();
      expect(errorLog).toHaveLength(1);
      expect(errorLog[0].message).toContain('timed out');
    });

    it('guarantees zero cross-task contamination across overlapping concurrent task executions', async () => {
      const posts: Array<{ url: string; body: any }> = [];
      const patches: Array<{ url: string; body: any }> = [];

      const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        if (init?.method === 'PATCH') {
          patches.push({ url, body });
        } else {
          posts.push({ url, body });
        }
        return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
      });

      const tracer = createLangSmithTracer({
        apiKey: 'ls-test-key',
        fetchFn,
      });

      const taskASpan: TaskExecutionSpan = {
        projectId: 'proj-1',
        taskId: 'task-A',
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
      };

      const taskBSpan: TaskExecutionSpan = {
        projectId: 'proj-1',
        taskId: 'task-B',
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
      };

      // Create task-scoped sinks
      const sinkA = tracer.forTask({ projectId: 'proj-1', taskId: 'task-A', attemptNumber: 1 });
      const sinkB = tracer.forTask({ projectId: 'proj-1', taskId: 'task-B', attemptNumber: 1 });

      // Overlapping execution:
      // 1. Task A starts
      await sinkA.onTaskStart!(taskASpan);
      // 2. Task B starts before Task A completes
      await sinkB.onTaskStart!(taskBSpan);

      const runIdA = posts.find((p) => p.body.name === 'Task: task-A')?.body.id;
      const runIdB = posts.find((p) => p.body.name === 'Task: task-B')?.body.id;
      expect(runIdA).toBeDefined();
      expect(runIdB).toBeDefined();
      expect(runIdA).not.toBe(runIdB);

      // 3. Task A emits model and tool calls
      await sinkA.onModelCall!({
        sequence: 1,
        type: 'MODEL_CALL',
        provider: 'nebius',
        model: 'model-a',
        request: { messagesCount: 1, toolsCount: 1 },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated_cost_usd: 0, usage_available: true },
        durationMs: 50,
      });

      await sinkA.onToolCall!({
        sequence: 2,
        type: 'TOOL_CALL',
        toolName: 'tool_a',
        arguments: { arg: 'valA' },
        result: { ok: true },
        success: true,
        durationMs: 20,
      });

      // 4. Task B emits model and tool calls
      await sinkB.onModelCall!({
        sequence: 1,
        type: 'MODEL_CALL',
        provider: 'nebius',
        model: 'model-b',
        request: { messagesCount: 1, toolsCount: 1 },
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, estimated_cost_usd: 0, usage_available: true },
        durationMs: 60,
      });

      await sinkB.onToolCall!({
        sequence: 2,
        type: 'TOOL_CALL',
        toolName: 'tool_b',
        arguments: { arg: 'valB' },
        result: { ok: true },
        success: true,
        durationMs: 25,
      });

      // 5. Complete both tasks
      await sinkA.onTaskComplete!({ ...taskASpan, status: 'VERIFIED' });
      await sinkB.onTaskComplete!({ ...taskBSpan, status: 'VERIFIED' });

      // Verify that Task A events have parent_run_id = runIdA
      const modelACall = posts.find((p) => p.body.name === 'Model: model-a');
      const toolACall = posts.find((p) => p.body.name === 'Tool: tool_a');
      expect(modelACall?.body.parent_run_id).toBe(runIdA);
      expect(toolACall?.body.parent_run_id).toBe(runIdA);

      // Verify that Task B events have parent_run_id = runIdB
      const modelBCall = posts.find((p) => p.body.name === 'Model: model-b');
      const toolBCall = posts.find((p) => p.body.name === 'Tool: tool_b');
      expect(modelBCall?.body.parent_run_id).toBe(runIdB);
      expect(toolBCall?.body.parent_run_id).toBe(runIdB);

      // Verify each task patched its own run
      expect(patches.find((p) => p.url.endsWith(`/runs/${runIdA}`))).toBeDefined();
      expect(patches.find((p) => p.url.endsWith(`/runs/${runIdB}`))).toBeDefined();
    });

    it('redacts sensitive credentials before transmitting payloads to LangSmith', async () => {
      let transmittedBody: any;
      const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
        transmittedBody = JSON.parse(init?.body as string);
        return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
      });

      const tracer = createLangSmithTracer({
        apiKey: 'ls-api-key-test-1234',
        fetchFn,
      });

      await tracer.onToolCall({
        sequence: 1,
        type: 'TOOL_CALL',
        toolName: 'execute_command',
        arguments: {
          command: 'curl -H "Authorization: Bearer my-secret-token-abcdef123" https://example.com',
          password: 'super-password-123',
        },
        result: {
          output: 'Authenticated as user, token=secret-token-12345678',
        },
        success: true,
        durationMs: 40,
      });

      expect(transmittedBody.inputs.password).toBe(REDACTED_PLACEHOLDER);
      expect(transmittedBody.inputs.command).toContain(REDACTED_PLACEHOLDER);
      expect(transmittedBody.inputs.command).not.toContain('my-secret-token-abcdef123');
      expect(transmittedBody.outputs.output).toContain(REDACTED_PLACEHOLDER);
    });
  });
});
