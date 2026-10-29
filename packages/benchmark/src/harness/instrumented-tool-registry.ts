import { ToolRegistry, type Tool } from '@orchestrate/core';
import type { ToolDefinition } from '@orchestrate/model';
import { redactSecrets } from './redaction.js';
import type { ToolCallEvent } from './types.js';

export interface InstrumentedToolRegistryOptions {
  sequenceProvider?: () => number;
  onCall?: (event: ToolCallEvent) => void;
  customSecrets?: string[];
  abortSignal?: AbortSignal;
}

/**
 * InstrumentedToolRegistry wraps a ToolRegistry to record tool invocations,
 * durations, arguments, and outcomes in an ordered, sanitized execution event log.
 */
export class InstrumentedToolRegistry extends ToolRegistry {
  private readonly inner: ToolRegistry;
  private readonly sequenceProvider?: () => number;
  private readonly onCall?: (event: ToolCallEvent) => void;
  private readonly customSecrets?: string[];
  private readonly abortSignal?: AbortSignal;
  private readonly events: ToolCallEvent[] = [];
  private fallbackSeq = 1;
  private isFinalized = false;

  constructor(inner: ToolRegistry, options?: InstrumentedToolRegistryOptions) {
    super();
    if (!inner) {
      throw new Error('InstrumentedToolRegistry requires a valid ToolRegistry instance.');
    }
    this.inner = inner;
    this.sequenceProvider = options?.sequenceProvider;
    this.onCall = options?.onCall;
    this.customSecrets = options?.customSecrets;
    this.abortSignal = options?.abortSignal;
  }

  finalize(): void {
    this.isFinalized = true;
  }

  private nextSequence(): number {
    return this.sequenceProvider ? this.sequenceProvider() : this.fallbackSeq++;
  }

  override register(tool: Tool): void {
    this.inner.register(tool);
  }

  override get(name: string): Tool | undefined {
    return this.inner.get(name);
  }

  override list(): Tool[] {
    return this.inner.list();
  }

  override toToolDefinitions(): ToolDefinition[] {
    return this.inner.toToolDefinitions();
  }

  override async execute(name: string, input: unknown): Promise<unknown> {
    if (this.isFinalized || this.abortSignal?.aborted) {
      const reason = this.abortSignal?.reason;
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Tool execution aborted or finalized';
      throw new Error(msg);
    }

    const startTime = performance.now();
    const seq = this.nextSequence();

    try {
      const result = await this.inner.execute(name, input);

      if (this.isFinalized || this.abortSignal?.aborted) {
        throw new Error('Tool execution completed after task finalization or abort.');
      }

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
      };

      this.events.push(Object.freeze(event));
      this.onCall?.(event);

      console.log(`    [TOOL CALL #${seq}] Tool: ${name} (${durationMs}ms)`);

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
      };

      this.events.push(Object.freeze(event));
      this.onCall?.(event);

      throw err;
    }
  }

  /**
   * Returns all recorded tool call events in chronological order.
   */
  getEvents(): readonly ToolCallEvent[] {
    return [...this.events];
  }
}
