import {
  MemoryProjectBrain,
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
  LocalGitRepository,
  LocalWorkspace,
  type ExecuteCommandResult,
  type CommandExecutor,
  type Workspace,
} from '@orchestrate/workspace';

// Re-export all core components
export {
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
  LocalGitRepository,
};

export type {
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
