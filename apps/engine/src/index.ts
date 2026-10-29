import {
  MemoryProjectBrain,
  SqliteProjectBrain,
  type SqliteProjectBrainOptions,
  type BrainStore,
  type CreateProjectInput,
  type CreateTaskInput,
  type Project,
  type Task,
  type Handoff,
  type VerificationRecord,
  type TaskTrustState,
  type TaskAttempt,
} from '@orchestrate/brain';
import {
  ContextCompiler,
  ContextCompilerCore,
  ContextLoader,
  ContextSerializer,
  type CompilationRequest,
  type CompiledContext,
} from '@orchestrate/compiler';
import {
  AgentRunner,
  createDefaultToolRegistry,
  createExecuteCommandTool,
  createReadFileTool,
  createWriteFileTool,
  getProjectInfoTool,
  Orchestrator,
  ToolRegistry,
  type AgentRunInput,
  type AgentRunResult,
  type OrchestrateTaskInput,
  type OrchestrationResult,
  type TaskAgentRunner,
  type TaskVerificationEngine,
  type Tool,
} from '@orchestrate/core';
import type {
  ChatMessage,
  ModelClient,
  ModelConfig,
  ModelRequest,
  ModelResponse,
  ProjectModelConfig,
  ToolDefinition,
} from '@orchestrate/model';
import {
  VerificationEngine,
  type VerificationCheck,
  type VerificationEvidence,
  type VerificationPlan,
  type VerificationResult,
  type VerificationStatus,
} from '@orchestrate/verification';
import {
  LocalCommandExecutor,
  DockerSandboxCommandExecutor,
  createCommandExecutor,
  SandboxUnavailableError,
  LocalGitRepository,
  LocalWorkspace,
  type ExecuteCommandResult,
  type CommandExecutor,
  type CommandExecutorMode,
  type Workspace,
} from '@orchestrate/workspace';

import {
  createEngineServer,
  type EngineServerOptions,
  type EngineServerInstance,
} from './server.js';
import {
  AuthError,
  createAuthToken,
  verifyAuthToken,
  extractBearerToken,
  resolveJwtSecret,
  INSECURE_DEV_JWT_SECRET,
  DEFAULT_JWT_ISSUER,
  DEFAULT_JWT_AUDIENCE,
  type AuthUser,
  type JwtHeader,
  type JwtPayload,
  type CreateTokenOptions,
  type VerifyTokenOptions,
} from './auth.js';

// Re-export all core components
export {
  // Server
  createEngineServer,
  // Core
  Orchestrator,
  AgentRunner,
  ToolRegistry,
  createDefaultToolRegistry,
  createReadFileTool,
  createWriteFileTool,
  createExecuteCommandTool,
  getProjectInfoTool,
  // Brain
  MemoryProjectBrain,
  SqliteProjectBrain,
  // Compiler
  ContextCompiler,
  ContextCompilerCore,
  ContextLoader,
  ContextSerializer,
  // Verification
  VerificationEngine,
  // Workspace
  LocalWorkspace,
  LocalCommandExecutor,
  DockerSandboxCommandExecutor,
  createCommandExecutor,
  SandboxUnavailableError,
  LocalGitRepository,
  // Auth
  AuthError,
  createAuthToken,
  verifyAuthToken,
  extractBearerToken,
  resolveJwtSecret,
  INSECURE_DEV_JWT_SECRET,
  DEFAULT_JWT_ISSUER,
  DEFAULT_JWT_AUDIENCE,
};

export type {
  // Auth types
  AuthUser,
  JwtHeader,
  JwtPayload,
  CreateTokenOptions,
  VerifyTokenOptions,
  CommandExecutorMode,
  // Server types
  EngineServerOptions,
  EngineServerInstance,
  // Core types
  OrchestrateTaskInput,
  OrchestrationResult,
  AgentRunInput,
  AgentRunResult,
  TaskAgentRunner,
  TaskVerificationEngine,
  Tool,
  // Brain types
  BrainStore,
  SqliteProjectBrainOptions,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  Task,
  Handoff,
  VerificationRecord,
  TaskTrustState,
  TaskAttempt,
  // Compiler types
  CompilationRequest,
  CompiledContext,
  // Verification types
  VerificationCheck,
  VerificationEvidence,
  VerificationPlan,
  VerificationResult,
  VerificationStatus,
  // Model types
  ChatMessage,
  ModelClient,
  ModelConfig,
  ModelRequest,
  ModelResponse,
  ProjectModelConfig,
  ToolDefinition,
  // Workspace types
  Workspace,
  CommandExecutor,
  ExecuteCommandResult,
};
