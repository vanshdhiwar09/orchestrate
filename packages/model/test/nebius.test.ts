import { describe, expect, it, vi } from 'vitest';
import { NebiusModelClient } from '../src/nebius.js';
import type { ModelRequest } from '../src/types.js';

describe('NebiusModelClient', () => {
  it('throws error when API key is missing', () => {
    const origKey = process.env.NEBIUS_API_KEY;
    delete process.env.NEBIUS_API_KEY;
    try {
      expect(() => new NebiusModelClient()).toThrowError(
        'Nebius API key is required'
      );
    } finally {
      if (origKey) process.env.NEBIUS_API_KEY = origKey;
    }
  });

  it('completes text chat request using mocked fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-123',
        model: 'deepseek-ai/DeepSeek-R1-0528',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Hello, I am Nebius AI assistant.',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18,
        },
      }),
    });

    const client = new NebiusModelClient({
      apiKey: 'test-secret-key-12345',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const request: ModelRequest = {
      model: 'deepseek-ai/DeepSeek-R1-0528',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      maxTokens: 100,
    };

    const response = await client.complete(request);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];

    expect(url).toBe('https://api.tokenfactory.nebius.com/v1/chat/completions');
    expect(options.headers.Authorization).toBe('Bearer test-secret-key-12345');

    const parsedBody = JSON.parse(options.body);
    expect(parsedBody.model).toBe('deepseek-ai/DeepSeek-R1-0528');
    expect(parsedBody.temperature).toBe(0.7);
    expect(parsedBody.max_tokens).toBe(100);

    expect(response.id).toBe('cmpl-123');
    expect(response.message.role).toBe('assistant');
    expect(response.message.content).toBe('Hello, I am Nebius AI assistant.');
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toEqual({
      promptTokens: 10,
      completionTokens: 8,
      totalTokens: 18,
    });
  });

  it('handles tool calls correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'cmpl-tool-1',
        model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-fast',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"/workspace/test.txt"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    const client = new NebiusModelClient({
      apiKey: 'test-key',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const request: ModelRequest = {
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-fast',
      messages: [{ role: 'user', content: 'Read /workspace/test.txt' }],
      tools: [
        {
          name: 'read_file',
          description: 'Read file contents',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    };

    const response = await client.complete(request);

    expect(response.finishReason).toBe('tool_calls');
    expect(response.message.toolCalls).toBeDefined();
    expect(response.message.toolCalls?.length).toBe(1);
    expect(response.message.toolCalls?.[0]).toEqual({
      id: 'call_abc123',
      name: 'read_file',
      arguments: { path: '/workspace/test.txt' },
    });
  });

  it('redacts API key in HTTP error messages', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized with secret-key-xyz987',
    });

    const client = new NebiusModelClient({
      apiKey: 'secret-key-xyz987',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const request: ModelRequest = {
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-fast',
      messages: [{ role: 'user', content: 'Hi' }],
    };

    await expect(client.complete(request)).rejects.toThrowError(
      'Nebius API request failed with status 401: Unauthorized with [REDACTED_API_KEY]'
    );
  });
});
