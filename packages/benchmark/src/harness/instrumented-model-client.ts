import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
} from '@orchestrate/model';
import { redactSecrets } from './redaction.js';
import type { ExecutionUsage, ModelCallEvent } from './types.js';
import type { TokenBudgetGuard, BudgetReservation } from './budget-guard.js';

export interface EstimatePromptTokensOptions {
  /**
   * Safety margin ratio added to prompt token estimate (e.g. 0.10 for +10%).
   * Defaults to 0.10 (+10% safety margin) to protect against tokenizer variance.
   */
  safetyMarginRatio?: number;
  /**
   * Fixed minimum safety headroom tokens added to prompt estimate.
   * Defaults to 16 tokens.
   */
  minimumSafetyHeadroom?: number;
}

export interface InstrumentedModelClientOptions {
  modelClient: ModelClient;
  sequenceProvider?: () => number;
  onCall?: (event: ModelCallEvent) => void;
  customSecrets?: string[];
  budgetGuard?: TokenBudgetGuard;
  abortSignal?: AbortSignal;
  minUsefulTokens?: number;
  safetyMarginRatio?: number;
  minimumSafetyHeadroom?: number;
}

/**
 * Conservative prompt token estimator for chat requests with tools.
 * Accounts for message roles, message contents, tool definitions, schemas,
 * and chat framing overhead (~3.2 chars/token for text/code, ~3.0 chars/token for JSON schemas,
 * plus per-message/tool overhead and configurable safety margin).
 */
export function estimatePromptTokens(
  request: ModelRequest,
  options?: EstimatePromptTokensOptions
): number {
  if (!request) return 0;
  let messageCharCount = 0;
  let messageCount = 0;
  let toolCharCount = 0;
  let toolCount = 0;

  const rawReq = request as unknown as Record<string, unknown>;
  if (typeof rawReq.systemPrompt === 'string') {
    messageCharCount += rawReq.systemPrompt.length;
  }

  if (Array.isArray(request.messages)) {
    messageCount = request.messages.length;
    for (const msg of request.messages) {
      if (typeof msg.role === 'string') {
        messageCharCount += msg.role.length;
      }
      if (typeof msg.content === 'string') {
        messageCharCount += msg.content.length;
      } else if (msg.content) {
        try {
          messageCharCount += JSON.stringify(msg.content).length;
        } catch {
          // ignore cyclic
        }
      }
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          messageCharCount += tc.name?.length ?? 0;
          if (tc.arguments) {
            try {
              messageCharCount +=
                typeof tc.arguments === 'string'
                  ? (tc.arguments as string).length
                  : JSON.stringify(tc.arguments).length;
            } catch {
              // ignore
            }
          }
        }
      }
    }
  }

  if (Array.isArray(request.tools)) {
    toolCount = request.tools.length;
    for (const tool of request.tools) {
      if (tool) {
        try {
          // Serialize tool definition structure matching OpenAI/Nebius function specifications
          const serializedTool = JSON.stringify({
            type: 'function',
            function: {
              name: tool.name ?? '',
              description: tool.description ?? '',
              parameters: tool.parameters ?? {},
            },
          });
          toolCharCount += serializedTool.length;
        } catch {
          toolCharCount += (tool.name?.length ?? 0) + (tool.description?.length ?? 0);
          if (tool.parameters) {
            try {
              toolCharCount += JSON.stringify(tool.parameters).length;
            } catch {
              // ignore cyclic
            }
          }
        }
      }
    }
  }

  if (messageCharCount === 0 && messageCount === 0 && toolCount === 0 && toolCharCount === 0) {
    return 0;
  }

  // Token conversion:
  // Messages: natural language and code ~ 3.2 chars/token + 4 framing tokens per message
  const messageTokens = Math.ceil(messageCharCount / 3.2) + messageCount * 4;
  // Tools: structured JSON schemas ~ 3.0 chars/token + 8 framing tokens per tool
  const toolTokens = toolCount > 0 ? Math.ceil(toolCharCount / 3.0) + toolCount * 8 : 0;
  let totalEstimated = messageTokens + toolTokens;

  if (
    typeof options?.safetyMarginRatio === 'number' &&
    Number.isFinite(options.safetyMarginRatio) &&
    options.safetyMarginRatio > 0
  ) {
    totalEstimated = Math.ceil(totalEstimated * (1 + options.safetyMarginRatio));
  }

  if (
    typeof options?.minimumSafetyHeadroom === 'number' &&
    Number.isFinite(options.minimumSafetyHeadroom) &&
    options.minimumSafetyHeadroom > 0
  ) {
    totalEstimated += Math.round(options.minimumSafetyHeadroom);
  }

  return totalEstimated;
}

/**
 * InstrumentedModelClient wraps a ModelClient to record every interaction
 * in an ordered, sanitized execution event log while tracking token usage
 * and enforcing shared token budget constraints before calls are made.
 */
export class InstrumentedModelClient implements ModelClient {
  private readonly inner: ModelClient;
  private readonly sequenceProvider?: () => number;
  private readonly onCall?: (event: ModelCallEvent) => void;
  private readonly customSecrets?: string[];
  private readonly budgetGuard?: TokenBudgetGuard;
  private readonly abortSignal?: AbortSignal;
  private readonly minUsefulTokens: number;
  private readonly safetyMarginRatio?: number;
  private readonly minimumSafetyHeadroom?: number;
  private readonly events: ModelCallEvent[] = [];
  private fallbackSeq = 1;

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalTokens = 0;
  private hasRecordedUsage = false;
  private isFinalized = false;
  private activePendingReservation: BudgetReservation | null = null;

  constructor(options: InstrumentedModelClientOptions) {
    if (!options?.modelClient) {
      throw new Error('InstrumentedModelClient requires a valid ModelClient.');
    }
    this.inner = options.modelClient;
    this.sequenceProvider = options.sequenceProvider;
    this.onCall = options.onCall;
    this.customSecrets = options.customSecrets;
    this.budgetGuard = options.budgetGuard;
    this.abortSignal = options.abortSignal;
    this.minUsefulTokens =
      options.minUsefulTokens ??
      (this.budgetGuard ? this.budgetGuard.minUsefulTokens : 256);
    this.safetyMarginRatio = options.safetyMarginRatio;
    this.minimumSafetyHeadroom = options.minimumSafetyHeadroom;
  }

  private nextSequence(): number {
    return this.sequenceProvider ? this.sequenceProvider() : this.fallbackSeq++;
  }

  /**
   * Finalizes the client upon task completion or timeout.
   * Settles any unresolved in-flight reservations conservatively and blocks
   * late responses from mutating evidence, budget, or triggering downstream tools.
   */
  finalize(): void {
    if (this.isFinalized) return;
    this.isFinalized = true;
    if (this.activePendingReservation) {
      // In-flight request pending at finalization/timeout;
      // conservatively commit the reserved amount so capacity is not phantom-freed.
      this.activePendingReservation.commit(null);
      this.activePendingReservation = null;
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (this.isFinalized || this.abortSignal?.aborted) {
      const reason = this.abortSignal?.reason;
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Model completion aborted or finalized';
      throw new Error(msg);
    }

    // Check budget guard adaptively before initiating any model call,
    // explicitly accounting for prompt/input tokens to prevent overshooting limits.
    let reservation: BudgetReservation | null = null;
    let effectiveMaxTokens = request.maxTokens;
    let clamped = false;

    if (this.budgetGuard) {
      const estimatedPrompt = estimatePromptTokens(request, {
        safetyMarginRatio: this.safetyMarginRatio,
        minimumSafetyHeadroom: this.minimumSafetyHeadroom,
      });
      const adaptiveResult = this.budgetGuard.reserveAdaptive(
        request.maxTokens,
        this.minUsefulTokens,
        estimatedPrompt
      );
      reservation = adaptiveResult.reservation;
      effectiveMaxTokens = adaptiveResult.effectiveTokens;
      clamped = adaptiveResult.clamped;
    }
    this.activePendingReservation = reservation;

    const outboundRequest: ModelRequest =
      effectiveMaxTokens !== undefined && effectiveMaxTokens !== request.maxTokens
        ? { ...request, maxTokens: effectiveMaxTokens }
        : request;

    const startTime = performance.now();
    const seq = this.nextSequence();

    try {
      const response = await this.inner.complete(outboundRequest);
      this.activePendingReservation = null;

      // Check if task aborted or was finalized while the model call was in flight
      if (this.isFinalized || this.abortSignal?.aborted) {
        // Late response arrived after finalization/abort!
        // Drop the response so it cannot mutate events, usage, or trigger downstream tools.
        throw new Error('Model completion arrived after task finalization or abort.');
      }

      const durationMs = Math.round(performance.now() - startTime);

      let callUsage: ExecutionUsage;
      if (response.usage) {
        const inputTokens =
          typeof response.usage.promptTokens === 'number' &&
          Number.isFinite(response.usage.promptTokens) &&
          response.usage.promptTokens >= 0
            ? Math.round(response.usage.promptTokens)
            : 0;
        const outputTokens =
          typeof response.usage.completionTokens === 'number' &&
          Number.isFinite(response.usage.completionTokens) &&
          response.usage.completionTokens >= 0
            ? Math.round(response.usage.completionTokens)
            : 0;
        const totalTokens =
          typeof response.usage.totalTokens === 'number' &&
          Number.isFinite(response.usage.totalTokens) &&
          response.usage.totalTokens >= 0
            ? Math.round(response.usage.totalTokens)
            : (inputTokens + outputTokens);

        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;
        this.totalTokens += totalTokens;
        this.hasRecordedUsage = true;

        reservation?.commit(totalTokens);

        callUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          estimated_cost_usd: null,
          usage_available: true,
        };
      } else {
        reservation?.commit(null);

        callUsage = {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: reservation?.reservedTokens ?? 0,
          estimated_cost_usd: null,
          usage_available: false,
        };
      }

      const event: ModelCallEvent = {
        sequence: seq,
        type: 'MODEL_CALL',
        provider: response.provider ?? 'nebius',
        model: request.model,
        request: {
          messagesCount: request.messages?.length ?? 0,
          toolsCount: request.tools?.length ?? 0,
          temperature: request.temperature,
          maxTokens: effectiveMaxTokens,
          ...(clamped ? { requestedMaxTokens: request.maxTokens } : {}),
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

      const clampedLog = clamped
        ? ` | Clamped maxTokens: ${effectiveMaxTokens} (requested: ${request.maxTokens})`
        : '';
      console.log(`    [MODEL CALL #${seq}] Model: ${request.model}${clampedLog} | Duration: ${durationMs}ms | Tokens: in=${callUsage.input_tokens}, out=${callUsage.output_tokens}, total=${callUsage.total_tokens} | Finish: ${response.finishReason}`);

      return response;
    } catch (err: unknown) {
      this.activePendingReservation = null;

      const durationMs = Math.round(performance.now() - startTime);
      const isAbortedOrTimedOut =
        this.isFinalized ||
        this.abortSignal?.aborted ||
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'TaskTimeoutError');

      if (isAbortedOrTimedOut) {
        // Request was in-flight when client aborted or timed out.
        // Provider may bill for processed tokens; conservatively commit reservation.
        reservation?.commit(null);
      } else {
        // Provider or local validation error before/during processing where usage is not billable
        reservation?.release();
      }

      const errorMsg = err instanceof Error ? err.message : String(err);

      // Only record the event if evidence has not already been sealed/finalized
      if (!this.isFinalized) {
        const event: ModelCallEvent = {
          sequence: seq,
          type: 'MODEL_CALL',
          provider: 'nebius',
          model: request.model,
          request: {
            messagesCount: request.messages?.length ?? 0,
            toolsCount: request.tools?.length ?? 0,
            temperature: request.temperature,
            maxTokens: effectiveMaxTokens,
            ...(clamped ? { requestedMaxTokens: request.maxTokens } : {}),
          },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: isAbortedOrTimedOut ? (reservation?.reservedTokens ?? 0) : 0,
            estimated_cost_usd: null,
            usage_available: false,
          },
          durationMs,
          error: redactSecrets(errorMsg, this.customSecrets),
        };

        this.events.push(Object.freeze(event));
        this.onCall?.(event);
      }

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
      estimated_cost_usd: null,
      usage_available: this.hasRecordedUsage,
    });
  }
}
