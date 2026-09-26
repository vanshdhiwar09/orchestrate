export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  id: string;
  model: string;
  message: ChatMessage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage?: ModelUsage;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
