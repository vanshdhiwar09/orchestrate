import type {
  ChatMessage,
  ModelClient,
  ModelResponse,
} from '@orchestrate/model';
import type { ToolRegistry } from './tools.js';

export interface AgentRunnerOptions {
  modelClient: ModelClient;
  defaultModel?: string;
  toolRegistry?: ToolRegistry;
  maxIterations?: number;
}

export interface AgentRunInput {
  task: string;
  model?: string;
  systemPrompt?: string;
  history?: ChatMessage[];
  toolRegistry?: ToolRegistry;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentRunResult {
  response: ModelResponse;
  messages: ChatMessage[];
  iterations: number;
}

export class AgentRunner {
  private readonly modelClient: ModelClient;
  private readonly defaultModel?: string;
  private readonly toolRegistry?: ToolRegistry;
  private readonly maxIterations: number;

  constructor(options: AgentRunnerOptions) {
    if (!options?.modelClient) throw new Error('AgentRunner requires a valid ModelClient instance.');
    this.modelClient = options.modelClient;
    this.defaultModel = options.defaultModel;
    this.toolRegistry = options.toolRegistry;
    this.maxIterations = options.maxIterations ?? 10;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (!input.task || input.task.trim() === '') {
      throw new Error('AgentRunner.run requires a non-empty task string.');
    }

    const model = input.model ?? this.defaultModel;
    if (!model) {
      throw new Error(
        'Model identifier is required. Specify model in AgentRunInput or set defaultModel in AgentRunnerOptions.'
      );
    }

    const toolRegistry = input.toolRegistry ?? this.toolRegistry;
    const maxIterations = input.maxIterations ?? this.maxIterations;

    const messages: ChatMessage[] = [];

    if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });

    if (input.history) {
      messages.push(...input.history);
    }

    messages.push({
      role: 'user',
      content: input.task,
    });

    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      const toolDefs = toolRegistry?.toToolDefinitions();
      const tools = toolDefs?.length ? toolDefs : undefined;

      const response = await this.modelClient.complete({
        model,
        messages: [...messages],
        tools,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });

      messages.push(response.message);

      const toolCalls = response.message.toolCalls;

      if (!toolCalls?.length || response.finishReason !== 'tool_calls') {
        return {
          response,
          messages,
          iterations,
        };
      }

      for (const toolCall of toolCalls) {
        let resultText: string;
        try {
          if (!toolRegistry) {
            throw new Error(`Model requested tool "${toolCall.name}", but no ToolRegistry is configured.`);
          }
          const output = await toolRegistry.execute(toolCall.name, toolCall.arguments);
          resultText = typeof output === 'string' ? output : JSON.stringify(output);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          resultText = JSON.stringify({ error: errorMsg });
        }

        messages.push({
          role: 'tool',
          name: toolCall.name,
          toolCallId: toolCall.id,
          content: resultText,
        });
      }
    }

    throw new Error(
      `AgentRunner reached maximum loop iterations (${maxIterations}) without reaching a final response.`
    );
  }
}
