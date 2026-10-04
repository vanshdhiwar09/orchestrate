import type {
  ChatMessage,
  ModelClient,
  ModelInferenceConfig,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from './types.js';

export interface NebiusClientOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultInferenceConfig?: ModelInferenceConfig;
  fetchFn?: typeof fetch;
}

export class NebiusModelClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;
  private readonly defaultInferenceConfig?: ModelInferenceConfig;
  private readonly fetchFn: typeof fetch;

  constructor(options: NebiusClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.NEBIUS_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Nebius API key is required. Set NEBIUS_API_KEY environment variable or pass apiKey in options.'
      );
    }
    this.apiKey = apiKey;
    const base = options.baseUrl ?? 'https://api.tokenfactory.nebius.com/v1';
    this.baseUrl = base.replace(/\/+$/, '');
    this.defaultModel = options.defaultModel;
    this.defaultInferenceConfig = options.defaultInferenceConfig;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Retrieves available model identifiers from Nebius Token Factory GET /v1/models.
   */
  async listModels(): Promise<string[]> {
    const endpoint = `${this.baseUrl}/models`;
    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = this.redactApiKey(rawMessage);
      throw new Error(`Nebius API network request failed: ${safeMessage}`);
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore body read error
      }
      const safeBody = this.redactApiKey(errorBody);
      throw new Error(
        `Nebius API models listing failed with status ${response.status}: ${safeBody}`
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error('Nebius API returned invalid JSON response for models list');
    }

    if (!Array.isArray(data?.data)) {
      throw new Error('Nebius API models response missing data array');
    }

    return data.data
      .map((item: any) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter((id: string) => id.length > 0);
  }

  /**
   * Checks whether a specific model identifier is available in Nebius Token Factory.
   */
  async isModelAvailable(modelId: string): Promise<boolean> {
    if (!modelId || typeof modelId !== 'string') return false;
    const models = await this.listModels();
    return models.includes(modelId.trim());
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const model = request.model || this.defaultModel;
    if (!model) {
      throw new Error(
        'Model identifier is required. Specify model in ModelRequest or configure defaultModel in NebiusClientOptions.'
      );
    }

    const endpoint = `${this.baseUrl}/chat/completions`;

    const openAiMessages = request.messages.map((msg) => {
      const formatted: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.name) {
        formatted.name = msg.name;
      }

      if (msg.role === 'tool' && msg.toolCallId) {
        formatted.tool_call_id = msg.toolCallId;
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        formatted.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }

      return formatted;
    });

    const body: Record<string, unknown> = {
      model,
      messages: openAiMessages,
    };

    const temperature = request.temperature ?? this.defaultInferenceConfig?.temperature;
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    const maxTokens = request.maxTokens ?? this.defaultInferenceConfig?.maxTokens;
    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    const stop = request.stop ?? this.defaultInferenceConfig?.stop;
    if (stop && stop.length > 0) {
      body.stop = stop;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const safeMessage = this.redactApiKey(rawMessage);
      throw new Error(`Nebius API network request failed: ${safeMessage}`);
    }

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore body read error
      }
      const safeBody = this.redactApiKey(errorBody);
      throw new Error(
        `Nebius API request failed with status ${response.status}: ${safeBody}`
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new Error('Nebius API returned invalid JSON response');
    }

    const choice = data?.choices?.[0];
    if (!choice || !choice.message) {
      throw new Error('Nebius API response missing choices[0].message');
    }

    const messageData = choice.message;
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(messageData.tool_calls)) {
      for (const tc of messageData.tool_calls) {
        let parsedArgs: Record<string, unknown> = {};
        if (typeof tc.function?.arguments === 'string') {
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            parsedArgs = { raw: tc.function.arguments };
          }
        } else if (typeof tc.function?.arguments === 'object') {
          parsedArgs = tc.function.arguments;
        }

        toolCalls.push({
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          arguments: parsedArgs,
        });
      }
    }

    const responseMessage: ChatMessage = {
      role: messageData.role ?? 'assistant',
      content: messageData.content ?? null,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      id: data.id ?? '',
      provider: 'nebius',
      model: data.model ?? model,
      message: responseMessage,
      finishReason: this.mapFinishReason(choice.finish_reason),
      ...(data.usage
        ? {
            usage: {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0,
              totalTokens: data.usage.total_tokens ?? 0,
            },
          }
        : {}),
    };
  }

  private mapFinishReason(reason: string | undefined): ModelResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  private redactApiKey(str: string): string {
    if (!this.apiKey || this.apiKey.length < 4) return str;
    return str.replaceAll(this.apiKey, '[REDACTED_API_KEY]');
  }
}
