// Core Telemetry Types
export type {
  ExecutionUsage,
  ModelCallEvent,
  ToolCallEvent,
  TaskExecutionSpan,
  TelemetrySink,
} from './types.js';

// Secret Redaction
export {
  REDACTED_PLACEHOLDER,
  sanitizeSecretText,
  isSecretKey,
  redactSecrets,
} from './redaction.js';

// Instrumented Model Client Wrapper
export {
  InstrumentedModelClient,
  type InstrumentedModelClientOptions,
} from './instrumented-client.js';

// Instrumented Tool Registry Wrapper
export {
  InstrumentedToolRegistry,
  type ToolRegistryLike,
  type InstrumentedToolRegistryOptions,
} from './instrumented-tools.js';

// LangSmith Telemetry Integration
export {
  LangSmithTracer,
  createLangSmithTracer,
  type LangSmithConfig,
} from './langsmith.js';
