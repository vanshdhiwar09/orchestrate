import type {
  ChatMessage,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from './types.js';

export interface NebiusClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class NebiusModelClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
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
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
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
      model: request.model,
      messages: openAiMessages,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    if (request.stop && request.stop.length > 0) {
      body.stop = request.stop;
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
      model: data.model ?? request.model,
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
