import { describe, it, expect } from 'vitest';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import { InstrumentedModelClient } from '../../src/harness/instrumented-model-client.js';

describe('InstrumentedModelClient', () => {
  const dummyRequest: ModelRequest = {
    model: 'mock-model-v1',
    messages: [{ role: 'user', content: 'Hello world' }],
  };

  const dummyResponse: ModelResponse = {
    id: 'resp-001',
    model: 'mock-model-v1',
    message: { role: 'assistant', content: 'Hello there!' },
    finishReason: 'stop',
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    },
  };

  it('forwards request unchanged and returns response', async () => {
    let capturedRequest: ModelRequest | undefined;
    const innerClient: ModelClient = {
      complete: async (req) => {
        capturedRequest = req;
        return dummyResponse;
      },
    };

    const instrumented = new InstrumentedModelClient({ modelClient: innerClient });
    const response = await instrumented.complete(dummyRequest);

    expect(response).toEqual(dummyResponse);
    expect(capturedRequest).toEqual(dummyRequest);
  });

  it('records chronological calls with usage metrics', async () => {
    const innerClient: ModelClient = {
      complete: async () => dummyResponse,
    };

    const instrumented = new InstrumentedModelClient({ modelClient: innerClient });
    await instrumented.complete(dummyRequest);
    await instrumented.complete(dummyRequest);

    const events = instrumented.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
    expect(events[0].type).toBe('MODEL_CALL');
    expect(events[0].usage.input_tokens).toBe(10);
    expect(events[0].usage.output_tokens).toBe(20);
    expect(events[0].usage.total_tokens).toBe(30);
    expect(events[0].usage.usage_available).toBe(true);

    const aggregateUsage = instrumented.getAggregateUsage();
    expect(aggregateUsage.input_tokens).toBe(20);
    expect(aggregateUsage.output_tokens).toBe(40);
    expect(aggregateUsage.total_tokens).toBe(60);
    expect(aggregateUsage.usage_available).toBe(true);
    expect(aggregateUsage.estimated_cost_usd).toBe(0);
  });

  it('handles unavailable usage cleanly without fabricating tokens', async () => {
    const responseWithoutUsage: ModelResponse = {
      id: 'resp-002',
      model: 'mock-model-v1',
      message: { role: 'assistant', content: 'Answer' },
      finishReason: 'stop',
    };

    const innerClient: ModelClient = {
      complete: async () => responseWithoutUsage,
    };

    const instrumented = new InstrumentedModelClient({ modelClient: innerClient });
    await instrumented.complete(dummyRequest);

    const events = instrumented.getEvents();
    expect(events[0].usage.usage_available).toBe(false);
    expect(events[0].usage.input_tokens).toBe(0);
    expect(events[0].usage.output_tokens).toBe(0);
    expect(events[0].usage.total_tokens).toBe(0);

    const aggregateUsage = instrumented.getAggregateUsage();
    expect(aggregateUsage.usage_available).toBe(false);
    expect(aggregateUsage.total_tokens).toBe(0);
  });

  it('records errors and rethrows exactly', async () => {
    const innerClient: ModelClient = {
      complete: async () => {
        throw new Error('API Rate limit exceeded with key sk-secret12345678901234');
      },
    };

    const instrumented = new InstrumentedModelClient({ modelClient: innerClient });

    await expect(instrumented.complete(dummyRequest)).rejects.toThrow(
      'API Rate limit exceeded'
    );

    const events = instrumented.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].error).toBeDefined();
    expect(events[0].error).not.toContain('sk-secret12345678901234');
    expect(events[0].error).toContain('[REDACTED]');
  });

  it('redacts sensitive metadata in tool calls and response preview', async () => {
    const responseWithSecrets: ModelResponse = {
      id: 'resp-003',
      model: 'mock-model-v1',
      message: {
        role: 'assistant',
        content: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        toolCalls: [
          {
            id: 'call-1',
            name: 'execute_command',
            arguments: {
              api_key: 'supersecretkey123',
              command: 'node',
            },
          },
        ],
      },
      finishReason: 'tool_calls',
    };

    const innerClient: ModelClient = {
      complete: async () => responseWithSecrets,
    };

    const instrumented = new InstrumentedModelClient({ modelClient: innerClient });
    await instrumented.complete(dummyRequest);

    const events = instrumented.getEvents();
    expect(events[0].response?.contentPreview).toContain('[REDACTED]');
    expect(events[0].response?.toolCalls?.[0].arguments.api_key).toBe('[REDACTED]');
    expect(events[0].response?.toolCalls?.[0].arguments.command).toBe('node');
  });
});
