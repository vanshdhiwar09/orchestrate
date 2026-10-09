import { redactSecrets, sanitizeSecretText } from './redaction.js';
import type {
  ModelCallEvent,
  TaskExecutionSpan,
  TelemetrySink,
  ToolCallEvent,
} from './types.js';

export interface LangSmithConfig {
  /**
   * LangSmith API Key. Defaults to process.env.LANGSMITH_API_KEY.
   */
  apiKey?: string;

  /**
   * LangSmith endpoint URL. Defaults to process.env.LANGSMITH_ENDPOINT or 'https://api.smith.langchain.com'.
   */
  apiUrl?: string;

  /**
   * LangSmith project name. Defaults to process.env.LANGSMITH_PROJECT or 'orchestrate'.
   */
  projectName?: string;

  /**
   * Explicit enablement flag. Defaults to true if apiKey is present, false otherwise.
   */
  enabled?: boolean;

  /**
   * Custom fetch function for dependency injection or testing. Defaults to globalThis.fetch.
   */
  fetchFn?: typeof fetch;

  /**
   * Custom secrets list to redact before transmitting trace payloads.
   */
  customSecrets?: string[];

  /**
   * Whether to capture prompt and tool payloads (redacted).
   * If false, sends only structural metadata (durations, token counts, error status).
   * Defaults to true.
   */
  capturePayloads?: boolean;

  /**
   * Request timeout in milliseconds. Defaults to 5000.
   */
  timeoutMs?: number;

  /**
   * Optional logger or error hook for telemetry-internal diagnostics.
   */
  onError?: (err: Error) => void;
}

/**
 * Lightweight, dependency-free LangSmith tracer implementing the TelemetrySink interface.
 * Transmits hierarchical execution traces (Task Chain -> LLM runs & Tool runs) directly
 * to the LangSmith REST API with strict field-aware secret redaction and failure isolation.
 */
export class LangSmithTracer implements TelemetrySink {
  public readonly enabled: boolean;
  private readonly apiKey?: string;
  private readonly apiUrl: string;
  private readonly projectName: string;
  private readonly fetchFn: typeof fetch;
  private readonly customSecrets?: string[];
  private readonly capturePayloads: boolean;
  private readonly timeoutMs: number;
  private readonly onError?: (err: Error) => void;

  // Correlates (projectId:taskId:attemptNumber) -> LangSmith run UUID
  private readonly taskRuns = new Map<string, string>();

  constructor(options: LangSmithConfig = {}) {
    const rawApiKey = options.apiKey ?? (typeof process !== 'undefined' ? process.env?.LANGSMITH_API_KEY : undefined);
    this.apiKey = rawApiKey?.trim();
    this.enabled = options.enabled ?? Boolean(this.apiKey);

    const base = options.apiUrl ?? (typeof process !== 'undefined' ? process.env?.LANGSMITH_ENDPOINT : undefined) ?? 'https://api.smith.langchain.com';
    this.apiUrl = base.replace(/\/+$/, '');

    this.projectName =
      options.projectName ??
      (typeof process !== 'undefined' ? process.env?.LANGSMITH_PROJECT : undefined) ??
      'orchestrate';

    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.customSecrets = [
      ...(options.customSecrets ?? []),
      ...(this.apiKey ? [this.apiKey] : []),
    ];
    this.capturePayloads = options.capturePayloads ?? true;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.onError = options.onError;
  }

  private getSpanKey(span: TaskExecutionSpan): string {
    return `${span.projectId}:${span.taskId}:${span.attemptNumber}`;
  }

  private generateRunId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback UUIDv4 generator
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private async postJson(endpoint: string, body: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST'): Promise<void> {
    if (!this.enabled || !this.apiKey) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.apiUrl}${endpoint}`;
      const response = await this.fetchFn(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errText = '';
        try {
          errText = await response.text();
        } catch {
          // ignore stream read error
        }
        const safeError = sanitizeSecretText(errText, this.customSecrets);
        this.onError?.(
          new Error(`LangSmith API returned status ${response.status}: ${safeError}`)
        );
      }
    } catch (err: unknown) {
      // Failure isolation: telemetry failure must NEVER crash or fail agent execution
      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = sanitizeSecretText(rawMsg, this.customSecrets);
      this.onError?.(new Error(`LangSmith network request failed: ${safeMsg}`));
    } finally {
      clearTimeout(timer);
    }
  }

  async onTaskStart(span: TaskExecutionSpan): Promise<void> {
    if (!this.enabled) return;

    const spanKey = this.getSpanKey(span);
    const runId = this.generateRunId();
    this.taskRuns.set(spanKey, runId);

    const inputs = this.capturePayloads
      ? redactSecrets(
          {
            projectId: span.projectId,
            taskId: span.taskId,
            attemptNumber: span.attemptNumber,
            upstreamTaskId: span.upstreamTaskId,
          },
          this.customSecrets
        )
      : {};

    const metadata = redactSecrets(
      {
        projectId: span.projectId,
        taskId: span.taskId,
        attemptNumber: span.attemptNumber,
        upstreamTaskId: span.upstreamTaskId,
        model: span.model,
        provider: span.provider,
        temperature: span.temperature,
        maxTokens: span.maxTokens,
        tags: span.tags,
      },
      this.customSecrets
    );

    const payload: Record<string, unknown> = {
      id: runId,
      name: `Task: ${span.taskId}`,
      run_type: 'chain',
      session_name: this.projectName,
      project_name: this.projectName,
      start_time: span.startedAt || new Date().toISOString(),
      inputs,
      extra: {
        metadata,
      },
    };

    await this.postJson('/runs', payload, 'POST');
  }

  async onModelCall(event: ModelCallEvent): Promise<void> {
    if (!this.enabled) return;

    const callRunId = this.generateRunId();
    let parentRunId = event.parentRunId;
    if (!parentRunId && event.projectId && event.taskId && event.attemptNumber !== undefined) {
      parentRunId = this.taskRuns.get(`${event.projectId}:${event.taskId}:${event.attemptNumber}`);
    } else if (!parentRunId && this.taskRuns.size === 1) {
      parentRunId = Array.from(this.taskRuns.values())[0];
    }

    const inputs = this.capturePayloads
      ? {
          messagesCount: event.request.messagesCount,
          toolsCount: event.request.toolsCount,
        }
      : {};

    const outputs =
      this.capturePayloads && event.response
        ? redactSecrets(
            {
              finishReason: event.response.finishReason,
              contentPreview: event.response.contentPreview,
              toolCalls: event.response.toolCalls,
            },
            this.customSecrets
          )
        : undefined;

    const metadata = redactSecrets(
      {
        provider: event.provider,
        model: event.model,
        durationMs: event.durationMs,
        usage: event.usage,
      },
      this.customSecrets
    );

    const startTime = new Date(Date.now() - event.durationMs).toISOString();
    const endTime = new Date().toISOString();

    const payload: Record<string, unknown> = {
      id: callRunId,
      name: `Model: ${event.model}`,
      run_type: 'llm',
      parent_run_id: parentRunId,
      session_name: this.projectName,
      project_name: this.projectName,
      start_time: startTime,
      end_time: endTime,
      inputs,
      outputs,
      extra: {
        metadata,
      },
    };

    if (event.error) {
      payload.error = sanitizeSecretText(event.error, this.customSecrets);
    }

    await this.postJson('/runs', payload, 'POST');
  }

  async onToolCall(event: ToolCallEvent): Promise<void> {
    if (!this.enabled) return;

    const toolRunId = this.generateRunId();
    let parentRunId = event.parentRunId;
    if (!parentRunId && event.projectId && event.taskId && event.attemptNumber !== undefined) {
      parentRunId = this.taskRuns.get(`${event.projectId}:${event.taskId}:${event.attemptNumber}`);
    } else if (!parentRunId && this.taskRuns.size === 1) {
      parentRunId = Array.from(this.taskRuns.values())[0];
    }

    const inputs = this.capturePayloads
      ? redactSecrets(event.arguments, this.customSecrets)
      : { toolName: event.toolName };

    const outputs = this.capturePayloads
      ? redactSecrets(event.result, this.customSecrets)
      : { success: event.success };

    const metadata = redactSecrets(
      {
        toolName: event.toolName,
        success: event.success,
        durationMs: event.durationMs,
      },
      this.customSecrets
    );

    const startTime = new Date(Date.now() - event.durationMs).toISOString();
    const endTime = new Date().toISOString();

    const payload: Record<string, unknown> = {
      id: toolRunId,
      name: `Tool: ${event.toolName}`,
      run_type: 'tool',
      parent_run_id: parentRunId,
      session_name: this.projectName,
      project_name: this.projectName,
      start_time: startTime,
      end_time: endTime,
      inputs,
      outputs,
      extra: {
        metadata,
      },
    };

    if (event.error) {
      payload.error = sanitizeSecretText(event.error, this.customSecrets);
    }

    await this.postJson('/runs', payload, 'POST');
  }

  async onTaskComplete(span: TaskExecutionSpan): Promise<void> {
    if (!this.enabled) return;

    const spanKey = this.getSpanKey(span);
    const runId = this.taskRuns.get(spanKey);
    if (!runId) {
      return;
    }

    const outputs = redactSecrets(
      {
        status: span.status,
        handoffId: span.handoffId,
        verificationRecordId: span.verificationRecordId,
        durationMs: span.durationMs,
        usage: span.usage,
      },
      this.customSecrets
    );

    const payload: Record<string, unknown> = {
      end_time: span.completedAt || new Date().toISOString(),
      outputs,
    };

    if (span.error) {
      payload.error = sanitizeSecretText(span.error, this.customSecrets);
    }

    await this.postJson(`/runs/${runId}`, payload, 'PATCH');
    this.taskRuns.delete(spanKey);
  }

  /**
   * Creates a task-scoped TelemetrySink adapter that automatically binds child model
   * and tool calls to this specific task execution span, preventing cross-task contamination.
   */
  forTask(context: { projectId: string; taskId: string; attemptNumber: number }): TelemetrySink {
    return {
      onTaskStart: (span) => this.onTaskStart(span),
      onModelCall: (event) =>
        this.onModelCall({
          ...event,
          projectId: context.projectId,
          taskId: context.taskId,
          attemptNumber: context.attemptNumber,
        }),
      onToolCall: (event) =>
        this.onToolCall({
          ...event,
          projectId: context.projectId,
          taskId: context.taskId,
          attemptNumber: context.attemptNumber,
        }),
      onTaskComplete: (span) => this.onTaskComplete(span),
      forTask: () => this.forTask(context),
    };
  }

  getRegisteredRunId(span: TaskExecutionSpan): string | undefined {
    return this.taskRuns.get(this.getSpanKey(span));
  }
}

/**
 * Factory creating a LangSmithTracer instance from options or environment variables.
 */
export function createLangSmithTracer(options?: LangSmithConfig): LangSmithTracer {
  return new LangSmithTracer(options);
}
