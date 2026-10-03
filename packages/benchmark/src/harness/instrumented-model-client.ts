import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
} from '@orchestrate/model';
import { redactSecrets } from './redaction.js';
import type { ExecutionUsage, ModelCallEvent } from './types.js';

export interface InstrumentedModelClientOptions {
  modelClient: ModelClient;
  sequenceProvider?: () => number;
  onCall?: (event: ModelCallEvent) => void;
  customSecrets?: string[];
}

/**
 * InstrumentedModelClient wraps a ModelClient to record every interaction
 * in an ordered, sanitized execution event log while tracking token usage.
 */
export class InstrumentedModelClient implements ModelClient {
  private readonly inner: ModelClient;
  private readonly sequenceProvider?: () => number;
  private readonly onCall?: (event: ModelCallEvent) => void;
  private readonly customSecrets?: string[];
  private readonly events: ModelCallEvent[] = [];
  private fallbackSeq = 1;

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalTokens = 0;
  private hasRecordedUsage = false;

  constructor(options: InstrumentedModelClientOptions) {
    if (!options?.modelClient) {
      throw new Error('InstrumentedModelClient requires a valid ModelClient.');
    }
    this.inner = options.modelClient;
    this.sequenceProvider = options.sequenceProvider;
    this.onCall = options.onCall;
    this.customSecrets = options.customSecrets;
  }

  private nextSequence(): number {
    return this.sequenceProvider ? this.sequenceProvider() : this.fallbackSeq++;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const startTime = performance.now();
    const seq = this.nextSequence();

    try {
      const response = await this.inner.complete(request);
      const durationMs = Math.round(performance.now() - startTime);

      let callUsage: ExecutionUsage;
      if (response.usage) {
        const inputTokens = response.usage.promptTokens ?? 0;
        const outputTokens = response.usage.completionTokens ?? 0;
        const totalTokens = response.usage.totalTokens ?? (inputTokens + outputTokens);

        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        this.totalTokens += totalTokens;
        this.hasRecordedUsage = true;

        callUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          estimated_cost_usd: 0,
          usage_available: true,
        };
      } else {
        callUsage = {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          estimated_cost_usd: 0,
          usage_available: false,
        };
      }

      const event: ModelCallEvent = {
        sequence: seq,
        type: 'MODEL_CALL',
        model: request.model,
        request: {
          messagesCount: request.messages?.length ?? 0,
          toolsCount: request.tools?.length ?? 0,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        },
        response: {
          id: response.id,
          model: response.model,
          finishReason: response.finishReason,
          toolCalls: response.message.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: redactSecrets(tc.arguments, this.customSecrets),
          })),
          contentPreview: response.message.content
            ? redactSecrets(response.message.content.slice(0, 200), this.customSecrets)
            : null,
        },
        usage: callUsage,
        durationMs,
      };

      this.events.push(Object.freeze(event));
      this.onCall?.(event);

      return response;
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorMsg = err instanceof Error ? err.message : String(err);

      const event: ModelCallEvent = {
        sequence: seq,
        type: 'MODEL_CALL',
        model: request.model,
        request: {
          messagesCount: request.messages?.length ?? 0,
          toolsCount: request.tools?.length ?? 0,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          estimated_cost_usd: 0,
          usage_available: false,
        },
        durationMs,
        error: redactSecrets(errorMsg, this.customSecrets),
      };

      this.events.push(Object.freeze(event));
      this.onCall?.(event);

      throw err;
    }
  }

  /**
   * Returns all recorded model call events in chronological order.
   */
  getEvents(): readonly ModelCallEvent[] {
    return [...this.events];
  }

  /**
   * Returns cumulative token usage across all completed calls.
   */
  getAggregateUsage(): ExecutionUsage {
    return Object.freeze({
      input_tokens: this.totalInputTokens,
      output_tokens: this.totalOutputTokens,
      total_tokens: this.totalTokens,
      estimated_cost_usd: 0,
      usage_available: this.hasRecordedUsage,
    });
  }
}
