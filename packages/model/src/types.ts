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

export type ModelProvider = 'nebius';

export const SUPPORTED_MODEL_PROVIDERS: readonly ModelProvider[] = ['nebius'] as const;

export type ModelRole =
  | 'planner'
  | 'builder'
  | 'reviewer'
  | 'repairer'
  | 'summarizer';

export const MODEL_ROLES: readonly ModelRole[] = [
  'planner',
  'builder',
  'reviewer',
  'repairer',
  'summarizer',
] as const;

export interface ModelInferenceConfig {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  stop?: string[];
}

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  inferenceConfig?: ModelInferenceConfig;
}

export interface ProjectModelConfig {
  defaultModel: ModelConfig;
  roles?: Partial<Record<ModelRole, ModelConfig>>;
}

/**
 * Resolves the effective ModelConfig for a specific role within a ProjectModelConfig.
 * Falls back to defaultModel if no role-specific configuration is specified.
 */
export function resolveModelForRole(
  config: ProjectModelConfig,
  role?: ModelRole
): ModelConfig {
  if (role && config.roles?.[role]) {
    return config.roles[role]!;
  }
  return config.defaultModel;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  id: string;
  provider?: ModelProvider;
  model: string;
  message: ChatMessage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  usage?: ModelUsage;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  listModels?(): Promise<string[]>;
}
