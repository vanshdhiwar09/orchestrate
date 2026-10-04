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

  describe('listModels discovery', () => {
    it('successfully lists available model IDs from Nebius GET /v1/models', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'nvidia/nemotron-4-340b-instruct', object: 'model' },
            { id: 'meta-llama/Llama-3.3-70B-Instruct', object: 'model' },
          ],
        }),
      });

      const client = new NebiusModelClient({
        apiKey: 'test-key',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const models = await client.listModels();
      expect(models).toEqual([
        'nvidia/nemotron-4-340b-instruct',
        'meta-llama/Llama-3.3-70B-Instruct',
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.tokenfactory.nebius.com/v1/models',
        {
          method: 'GET',
          headers: {
            Authorization: 'Bearer test-key',
          },
        }
      );
    });

    it('redacts API key when listModels fails with HTTP error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error with super-secret-key-999',
      });

      const client = new NebiusModelClient({
        apiKey: 'super-secret-key-999',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(client.listModels()).rejects.toThrowError(
        'Nebius API models listing failed with status 500: Internal server error with [REDACTED_API_KEY]'
      );
    });

    it('isModelAvailable accurately detects presence of model ID', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [{ id: 'nvidia/nemotron-4-340b-instruct' }],
        }),
      });

      const client = new NebiusModelClient({
        apiKey: 'test-key',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(await client.isModelAvailable('nvidia/nemotron-4-340b-instruct')).toBe(true);
      expect(await client.isModelAvailable('unknown-model')).toBe(false);
      expect(await client.isModelAvailable('')).toBe(false);
    });
  });

  describe('defaultModel and role configuration fallback', () => {
    it('uses configured defaultModel and defaultInferenceConfig when request omits model', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'cmpl-default-1',
          model: 'nvidia/nemotron-4-340b-instruct',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Response from default model' },
            },
          ],
        }),
      });

      const client = new NebiusModelClient({
        apiKey: 'test-key',
        defaultModel: 'nvidia/nemotron-4-340b-instruct',
        defaultInferenceConfig: {
          temperature: 0.3,
          maxTokens: 500,
        },
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const response = await client.complete({
        model: '', // empty model invokes fallback
        messages: [{ role: 'user', content: 'Hello default' }],
      });

      expect(response.provider).toBe('nebius');
      expect(response.model).toBe('nvidia/nemotron-4-340b-instruct');

      const [, options] = mockFetch.mock.calls[0];
      const parsedBody = JSON.parse(options.body);
      expect(parsedBody.model).toBe('nvidia/nemotron-4-340b-instruct');
      expect(parsedBody.temperature).toBe(0.3);
      expect(parsedBody.max_tokens).toBe(500);
    });

    it('overrides defaultModel with per-request model and inference parameters', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'cmpl-override-1',
          model: 'meta-llama/Llama-3.3-70B-Instruct',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Response from override' },
            },
          ],
        }),
      });

      const client = new NebiusModelClient({
        apiKey: 'test-key',
        defaultModel: 'nvidia/nemotron-4-340b-instruct',
        defaultInferenceConfig: { temperature: 0.2 },
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const response = await client.complete({
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0.8,
        messages: [{ role: 'user', content: 'Hello override' }],
      });

      expect(response.provider).toBe('nebius');
      expect(response.model).toBe('meta-llama/Llama-3.3-70B-Instruct');

      const [, options] = mockFetch.mock.calls[0];
      const parsedBody = JSON.parse(options.body);
      expect(parsedBody.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
      expect(parsedBody.temperature).toBe(0.8);
    });

    it('throws error when neither request model nor defaultModel is provided', async () => {
      const client = new NebiusModelClient({
        apiKey: 'test-key',
        fetchFn: vi.fn() as unknown as typeof fetch,
      });

      await expect(
        client.complete({
          model: '',
          messages: [{ role: 'user', content: 'No model' }],
        })
      ).rejects.toThrowError(
        'Model identifier is required. Specify model in ModelRequest or configure defaultModel in NebiusClientOptions.'
      );
    });
  });
});
