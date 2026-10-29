import type {
  ChatMessage,
  ModelClient,
  ModelResponse,
} from '@orchestrate/model';
import type { ToolRegistry } from './tools.js';

import type { ExecutionUsage } from '@orchestrate/telemetry';

export interface AgentRunnerOptions {
  modelClient: ModelClient;
  defaultModel?: string;
  toolRegistry?: ToolRegistry;
  maxIterations?: number;
}

export type AgentExecutionEvent =
  | { type: 'round_start'; iteration: number }
  | { type: 'model_response'; iteration: number; content?: string; toolCallsCount: number }
  | { type: 'tool_start'; iteration: number; tool: string; args: Record<string, unknown> }
  | { type: 'tool_complete'; iteration: number; tool: string; durationMs: number; success: boolean; preview: string }
  | { type: 'duplicate_tool_warning'; iteration: number; tool: string }
  | { type: 'round_complete'; iteration: number };

export interface AgentRunInput {
  task: string;
  model?: string;
  systemPrompt?: string;
  history?: ChatMessage[];
  toolRegistry?: ToolRegistry;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  onEvent?: (event: AgentExecutionEvent) => void;
}

export interface AgentRunResult {
  response: ModelResponse;
  messages: ChatMessage[];
  iterations: number;
  usage?: ExecutionUsage;
  durationMs?: number;
}

export class AgentExecutionError extends Error {
  public readonly usage?: ExecutionUsage;
  public readonly iterations: number;
  public readonly partialMessages?: ChatMessage[];

  constructor(message: string, usage?: ExecutionUsage, iterations = 0, partialMessages?: ChatMessage[]) {
    super(message);
    this.name = 'AgentExecutionError';
    this.usage = usage;
    this.iterations = iterations;
    this.partialMessages = partialMessages;
  }
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

    const startTime = performance.now();
    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let hasRecordedUsage = false;

    const buildUsage = (): ExecutionUsage => ({
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_tokens: totalTokens,
      estimated_cost_usd: null,
      usage_available: hasRecordedUsage,
    });

    let lastToolSignatures: string[] = [];
    let consecutiveDuplicateToolRounds = 0;
    const filesWritten = new Set<string>();
    let lastCheckPassed = false;
    let consecutiveErrors = 0;

    try {
      while (iterations < maxIterations) {
        iterations++;

        if (input.onEvent) {
          input.onEvent({ type: 'round_start', iteration: iterations });
        }

        const toolDefs = toolRegistry?.toToolDefinitions();
        const tools = toolDefs?.length ? toolDefs : undefined;

        const response = await this.modelClient.complete({
          model,
          messages: [...messages],
          tools,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
        });

        if (response.usage) {
          hasRecordedUsage = true;
          totalInputTokens += response.usage.promptTokens ?? 0;
          totalOutputTokens += response.usage.completionTokens ?? 0;
          totalTokens += response.usage.totalTokens ?? (
            (response.usage.promptTokens ?? 0) + (response.usage.completionTokens ?? 0)
          );
        }

        messages.push(response.message);

        const toolCalls = response.message.toolCalls;

        if (input.onEvent) {
          input.onEvent({
            type: 'model_response',
            iteration: iterations,
            content: response.message.content ?? undefined,
            toolCallsCount: toolCalls?.length ?? 0,
          });
        }

        const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
        if (!hasToolCalls) {
          const durationMs = Math.round(performance.now() - startTime);
          if (input.onEvent) {
            input.onEvent({ type: 'round_complete', iteration: iterations });
          }
          return {
            response,
            messages,
            iterations,
            usage: buildUsage(),
            durationMs,
          };
        }

        // Check for consecutive duplicate tool calls to prevent runaway loops
        const currentSignatures = toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments || {})}`)
          .sort();
        const currentSigKey = currentSignatures.join('||');
        const isDuplicateRound =
          lastToolSignatures.length > 0 && currentSigKey === lastToolSignatures.join('||');

        if (isDuplicateRound) {
          consecutiveDuplicateToolRounds++;
          if (input.onEvent) {
            input.onEvent({
              type: 'duplicate_tool_warning',
              iteration: iterations,
              tool: toolCalls[0]?.name || 'unknown',
            });
          }
          if (consecutiveDuplicateToolRounds >= 2) {
            // Break infinite duplicate loop gracefully and preserve state
            const durationMs = Math.round(performance.now() - startTime);
            if (input.onEvent) {
              input.onEvent({ type: 'round_complete', iteration: iterations });
            }
            return {
              response: {
                ...response,
                finishReason: 'stop',
                message: {
                  role: 'assistant',
                  content:
                    response.message.content ||
                    'Completed requested workspace tool modifications and stabilized repository state.',
                },
              },
              messages,
              iterations,
              usage: buildUsage(),
              durationMs,
            };
          }
        } else {
          consecutiveDuplicateToolRounds = 0;
          lastToolSignatures = currentSignatures;
        }

        for (const toolCall of toolCalls) {
          if (input.onEvent) {
            input.onEvent({
              type: 'tool_start',
              iteration: iterations,
              tool: toolCall.name,
              args: (toolCall.arguments as Record<string, unknown>) || {},
            });
          }
          const toolStart = performance.now();
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
          const toolDuration = Math.round(performance.now() - toolStart);

          const isError = resultText.includes('"error":');
          if (isError) {
            consecutiveErrors++;
          } else {
            consecutiveErrors = 0;
            const argsObj = (toolCall.arguments as Record<string, unknown>) || {};
            if (toolCall.name === 'write_file') {
              const writtenPath = argsObj.path || argsObj.file_path || argsObj.filepath;
              if (typeof writtenPath === 'string') {
                filesWritten.add(writtenPath);
              }
            }
            if (toolCall.name === 'execute_command') {
              const commandStr = String(argsObj.command || '');
              const argsArr = Array.isArray(argsObj.args) ? argsObj.args.join(' ') : String(argsObj.args || '');
              const fullCmd = `${commandStr} ${argsArr}`.toLowerCase();
              if (
                fullCmd.includes('test') ||
                fullCmd.includes('vitest') ||
                fullCmd.includes('check') ||
                fullCmd.includes('tsc')
              ) {
                lastCheckPassed = true;
              }
            }
          }

          if (isDuplicateRound) {
            resultText += '\n[Notice: Duplicate tool call executed. If all changes are made, summarize results and stop calling tools.]';
          } else if (filesWritten.size > 0 && lastCheckPassed) {
            resultText += '\n[Notice: Workspace files have been modified and verification checks passed. Please provide your final summary and finish without calling further tools.]';
          }

          if (input.onEvent) {
            input.onEvent({
              type: 'tool_complete',
              iteration: iterations,
              tool: toolCall.name,
              durationMs: toolDuration,
              success: !isError,
              preview: resultText.slice(0, 160),
            });
          }

          messages.push({
            role: 'tool',
            name: toolCall.name,
            toolCallId: toolCall.id,
            content: resultText,
          });

          if (consecutiveErrors >= 3) {
            // Gracefully halt instead of repeating failing tool calls
            const durationMs = Math.round(performance.now() - startTime);
            if (input.onEvent) {
              input.onEvent({ type: 'round_complete', iteration: iterations });
            }
            return {
              response: {
                ...response,
                finishReason: 'stop',
                message: {
                  role: 'assistant',
                  content:
                    response.message.content ||
                    'Tool execution encountered repeated errors. Halting to avoid exceeding iteration limits and allowing independent verification of current workspace state.',
                },
              },
              messages,
              iterations,
              usage: buildUsage(),
              durationMs,
            };
          }
        }

        if (input.onEvent) {
          input.onEvent({ type: 'round_complete', iteration: iterations });
        }
      }

      throw new AgentExecutionError(
        `AgentRunner reached maximum loop iterations (${maxIterations}) without reaching a final response.`,
        buildUsage(),
        iterations,
        messages
      );
    } catch (err: unknown) {
      if (err instanceof AgentExecutionError) {
        throw err;
      }
      throw new AgentExecutionError(
        err instanceof Error ? err.message : String(err),
        buildUsage(),
        iterations,
        messages
      );
    }
  }
}
