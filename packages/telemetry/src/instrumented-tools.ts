import type { ToolDefinition } from '@orchestrate/model';
import { redactSecrets } from './redaction.js';
import type { TelemetrySink, ToolCallEvent } from './types.js';

export interface ToolRegistryLike {
  execute(name: string, input: unknown): Promise<unknown>;
  toToolDefinitions?(): ToolDefinition[];
  get?(name: string): unknown;
  list?(): unknown[];
  register?(tool: unknown): void;
}

export interface InstrumentedToolRegistryOptions {
  sequenceProvider?: () => number;
  onCall?: (event: ToolCallEvent) => void;
  telemetrySink?: TelemetrySink;
  customSecrets?: string[];
  projectId?: string;
  taskId?: string;
  attemptNumber?: number;
}

/**
 * InstrumentedToolRegistry wraps any ToolRegistry to record tool invocations,
 * durations, arguments, and outcomes in an ordered, sanitized execution event log.
 */
export class InstrumentedToolRegistry<T extends ToolRegistryLike = ToolRegistryLike> {
  private readonly inner: T;
  private readonly sequenceProvider?: () => number;
  private readonly onCall?: (event: ToolCallEvent) => void;
  private readonly telemetrySink?: TelemetrySink;
  private readonly customSecrets?: string[];
  private readonly projectId?: string;
  private readonly taskId?: string;
  private readonly attemptNumber?: number;
  private readonly events: ToolCallEvent[] = [];
  private fallbackSeq = 1;

  constructor(inner: T, options?: InstrumentedToolRegistryOptions) {
    if (!inner || typeof inner.execute !== 'function') {
      throw new Error('InstrumentedToolRegistry requires a valid ToolRegistry instance with an execute() method.');
    }
    this.inner = inner;
    this.sequenceProvider = options?.sequenceProvider;
    this.onCall = options?.onCall;
    this.telemetrySink = options?.telemetrySink;
    this.customSecrets = options?.customSecrets;
    this.projectId = options?.projectId;
    this.taskId = options?.taskId;
    this.attemptNumber = options?.attemptNumber;
  }

  private nextSequence(): number {
    return this.sequenceProvider ? this.sequenceProvider() : this.fallbackSeq++;
  }

  register(tool: unknown): void {
    if (typeof this.inner.register === 'function') {
      this.inner.register(tool);
    }
  }

  get(name: string): unknown {
    return typeof this.inner.get === 'function' ? this.inner.get(name) : undefined;
  }

  list(): unknown[] {
    return typeof this.inner.list === 'function' ? this.inner.list() : [];
  }

  toToolDefinitions(): ToolDefinition[] {
    return typeof this.inner.toToolDefinitions === 'function'
      ? this.inner.toToolDefinitions()
      : [];
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const startTime = performance.now();
    const seq = this.nextSequence();

    try {
      const result = await this.inner.execute(name, input);
      const durationMs = Math.round(performance.now() - startTime);

      const sanitizedArgs = (input && typeof input === 'object')
        ? redactSecrets(input as Record<string, unknown>, this.customSecrets)
        : { input: redactSecrets(input, this.customSecrets) };

      const sanitizedResult = redactSecrets(result, this.customSecrets);

      const event: ToolCallEvent = {
        sequence: seq,
        type: 'TOOL_CALL',
        toolName: name,
        arguments: sanitizedArgs,
        result: sanitizedResult,
        success: true,
        durationMs,
        projectId: this.projectId,
        taskId: this.taskId,
        attemptNumber: this.attemptNumber,
      };

      this.events.push(Object.freeze(event));
      this.onCall?.(event);
      if (this.telemetrySink?.onToolCall) {
        try {
          await this.telemetrySink.onToolCall(event);
        } catch {
          // Sink failure isolation
        }
      }

      return result;
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorMsg = err instanceof Error ? err.message : String(err);

      const sanitizedArgs = (input && typeof input === 'object')
        ? redactSecrets(input as Record<string, unknown>, this.customSecrets)
        : { input: redactSecrets(input, this.customSecrets) };

      const event: ToolCallEvent = {
        sequence: seq,
        type: 'TOOL_CALL',
        toolName: name,
        arguments: sanitizedArgs,
        result: { error: redactSecrets(errorMsg, this.customSecrets) },
        success: false,
        durationMs,
        error: redactSecrets(errorMsg, this.customSecrets),
        projectId: this.projectId,
        taskId: this.taskId,
        attemptNumber: this.attemptNumber,
      };

      this.events.push(Object.freeze(event));
      this.onCall?.(event);
      if (this.telemetrySink?.onToolCall) {
        try {
          await this.telemetrySink.onToolCall(event);
        } catch {
          // Sink failure isolation
        }
      }

      throw err;
    }
  }

  getEvents(): readonly ToolCallEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events.length = 0;
  }
}
