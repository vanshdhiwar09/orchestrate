/**
 * Core type definitions for the Orchestrate telemetry and observability system.
 */

/**
 * Standard token usage shape reporting prompt, completion, and total tokens.
 */
export interface ExecutionUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  usage_available: boolean;
}

/**
 * Chronological event recorded for an individual model inference completion.
 */
export interface ModelCallEvent {
  sequence: number;
  type: 'MODEL_CALL';
  provider?: string;
  model: string;
  request: {
    messagesCount: number;
    toolsCount: number;
    temperature?: number;
    maxTokens?: number;
  };
  response?: {
    id: string;
    model: string;
    finishReason: string;
    toolCalls?: readonly {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }[];
    contentPreview?: string | null;
  };
  usage: ExecutionUsage;
  durationMs: number;
  error?: string;
  projectId?: string;
  taskId?: string;
  attemptNumber?: number;
  parentRunId?: string;
}

/**
 * Chronological event recorded for an individual tool invocation.
 */
export interface ToolCallEvent {
  sequence: number;
  type: 'TOOL_CALL';
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
  error?: string;
  projectId?: string;
  taskId?: string;
  attemptNumber?: number;
  parentRunId?: string;
}

/**
 * Metadata and lifecycle correlation state for an overarching task attempt execution.
 */
export interface TaskExecutionSpan {
  projectId: string;
  taskId: string;
  attemptNumber: number;
  upstreamTaskId?: string;
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  tags?: string[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status?: string;
  handoffId?: string;
  verificationRecordId?: string;
  usage?: ExecutionUsage;
  error?: string;
}

/**
 * Minimal sink/listener interface for receiving telemetry events.
 */
export interface TelemetrySink {
  onModelCall?(event: ModelCallEvent): void | Promise<void>;
  onToolCall?(event: ToolCallEvent): void | Promise<void>;
  onTaskStart?(span: TaskExecutionSpan): void | Promise<void>;
  onTaskComplete?(span: TaskExecutionSpan): void | Promise<void>;
  forTask?(context: { projectId: string; taskId: string; attemptNumber: number }): TelemetrySink;
}
