import type { BrainStore, Handoff, VerificationRecord } from '@orchestrate/brain';
import {
  ContextCompiler,
  type CompilationRequest,
  type CompiledContext,
  ContextSerializer,
} from '@orchestrate/compiler';
import type {
  VerificationPlan,
  VerificationResult,
  VerificationStatus,
} from '@orchestrate/verification';
import type { AgentRunInput, AgentRunResult } from './runner.js';
import type { ToolRegistry } from './tools.js';

export interface TaskAgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface TaskContextCompiler {
  compile(request: CompilationRequest): Promise<CompiledContext>;
}

export interface TaskVerificationEngine {
  verify?(plan: VerificationPlan): Promise<VerificationResult>;
  run?(plan: VerificationPlan): Promise<VerificationResult>;
}

export interface OrchestratorOptions {
  brain: BrainStore;
  runner: TaskAgentRunner;
  verificationEngine: TaskVerificationEngine;
  compiler?: TaskContextCompiler;
  toolRegistry?: ToolRegistry;
}

export interface OrchestrateTaskInput {
  projectId: string;
  taskId: string;
  upstreamTaskId?: string;
  tags?: string[];
  verificationPlan: VerificationPlan;
  model?: string;
  toolRegistry?: ToolRegistry;
  temperature?: number;
  maxTokens?: number;
}

export interface OrchestrationResult {
  taskId: string;
  attemptNumber: number;
  handoffId: string;
  verificationRecordId: string;
  status: VerificationStatus;
  handoff: Handoff;
  verificationResult: VerificationResult;
}

/**
 * Orchestrator coordinates a single task lifecycle across Project Brain,
 * Context Compiler, AgentRunner, and VerificationEngine.
 */
export class Orchestrator {
  private readonly brain: BrainStore;
  private readonly runner: TaskAgentRunner;
  private readonly verificationEngine: TaskVerificationEngine;
  private readonly compiler: TaskContextCompiler;
  private readonly toolRegistry?: ToolRegistry;

  constructor(options: OrchestratorOptions) {
    if (!options?.brain) {
      throw new Error('Orchestrator requires a valid BrainStore instance.');
    }
    if (!options?.runner) {
      throw new Error('Orchestrator requires a valid TaskAgentRunner instance.');
    }
    if (!options?.verificationEngine) {
      throw new Error('Orchestrator requires a valid TaskVerificationEngine instance.');
    }

    this.brain = options.brain;
    this.runner = options.runner;
    this.verificationEngine = options.verificationEngine;
    this.compiler = options.compiler ?? new ContextCompiler({ brain: options.brain });
    this.toolRegistry = options.toolRegistry;
  }

  /**
   * Executes a single end-to-end task lifecycle.
   */
  async executeTask(input: OrchestrateTaskInput): Promise<OrchestrationResult> {
    if (!input?.projectId || typeof input.projectId !== 'string' || input.projectId.trim() === '') {
      throw new Error('Orchestrator: projectId must be a non-empty string.');
    }
    if (!input?.taskId || typeof input.taskId !== 'string' || input.taskId.trim() === '') {
      throw new Error('Orchestrator: taskId must be a non-empty string.');
    }
    if (!input?.verificationPlan || !Array.isArray(input.verificationPlan.checks)) {
      throw new Error('Orchestrator: verificationPlan must be a valid VerificationPlan object.');
    }

    const projectId = input.projectId.trim();
    const taskId = input.taskId.trim();

    // 1. Load target Project and Task from Brain
    const project = await this.brain.getProject(projectId);
    if (!project) {
      throw new Error(`Orchestrator: Project "${projectId}" not found.`);
    }

    const task = await this.brain.getTask(taskId);
    if (!task) {
      throw new Error(`Orchestrator: Task "${taskId}" not found.`);
    }
    if (task.projectId !== projectId) {
      throw new Error(`Orchestrator: Task "${taskId}" does not belong to project "${projectId}".`);
    }

    // Verify upstream task if provided and load verified state from Brain
    let upstreamTaskId: string | undefined;
    if (input.upstreamTaskId) {
      upstreamTaskId = input.upstreamTaskId.trim();
      const upstream = await this.brain.getTask(upstreamTaskId);
      if (!upstream) {
        throw new Error(`Orchestrator: Upstream task "${upstreamTaskId}" not found.`);
      }
      if (upstream.projectId !== projectId) {
        throw new Error(
          `Orchestrator: Upstream task "${upstreamTaskId}" does not belong to project "${projectId}".`
        );
      }
      // Load upstream task verified history and trust state from Brain
      await this.brain.deriveTaskTrustState(upstreamTaskId);
      await this.brain.getTaskHistory(upstreamTaskId);
    }

    // 2. Determine next attempt number
    const history = await this.brain.getTaskHistory(taskId);
    const highestAttempt =
      history.length > 0 ? Math.max(...history.map((a) => a.attemptNumber)) : 0;
    const attemptNumber = highestAttempt + 1;

    // 3. Compile relevant context
    const compilationRequest: CompilationRequest = {
      projectId,
      targetTaskId: taskId,
      upstreamTaskId,
      tags: input.tags,
    };
    const compiledContext = await this.compiler.compile(compilationRequest);

    // 4. Serialize compiled context
    const serializedContext = ContextSerializer.serialize(compiledContext);

    // 5. Run AgentRunner with tools (WITHOUT passing upstream raw message history)
    const promptTask = task.description ? `${task.title}\n\n${task.description}` : task.title;
    const effectiveToolRegistry = input.toolRegistry ?? this.toolRegistry;
    const agentResult = await this.runner.run({
      task: promptTask,
      systemPrompt: serializedContext,
      model: input.model,
      toolRegistry: effectiveToolRegistry,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    });

    // 6. Convert agent result into a Handoff with status CLAIMED
    const content = agentResult?.response?.message?.content || '';
    let summary = content;
    let changes = '';
    let filesAffected: string[] = [];
    let decisionsCreated: string[] = [];
    let assumptions: string[] = [];
    let limitations: string[] = [];
    let recommendedFollowUp: string[] = [];

    let parsed: any = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      const jsonBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonBlockMatch) {
        try {
          parsed = JSON.parse(jsonBlockMatch[1]);
        } catch {
          // Plain text
        }
      }
    }

    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.summary === 'string') summary = parsed.summary;
      if (typeof parsed.changes === 'string') changes = parsed.changes;
      if (Array.isArray(parsed.filesAffected)) filesAffected = parsed.filesAffected.map(String);
      if (Array.isArray(parsed.decisionsCreated)) {
        decisionsCreated = parsed.decisionsCreated.map(String);
      }
      if (Array.isArray(parsed.assumptions)) assumptions = parsed.assumptions.map(String);
      if (Array.isArray(parsed.limitations)) limitations = parsed.limitations.map(String);
      if (Array.isArray(parsed.recommendedFollowUp)) {
        recommendedFollowUp = parsed.recommendedFollowUp.map(String);
      }
    }

    // If filesAffected was not specified, infer affected files from write_file tool calls
    if (filesAffected.length === 0 && Array.isArray(agentResult?.messages)) {
      const affectedSet = new Set<string>();
      for (const msg of agentResult.messages) {
        if (msg.role === 'assistant' && Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            if (tc.name === 'write_file' && tc.arguments && typeof tc.arguments.path === 'string') {
              affectedSet.add(tc.arguments.path);
            }
          }
        }
      }
      if (affectedSet.size > 0) {
        filesAffected = Array.from(affectedSet).sort((a, b) => a.localeCompare(b));
      }
    }

    if (!summary.trim()) {
      summary = `Task ${task.id} attempt ${attemptNumber} completed by agent`;
    }

    const handoffId = `handoff-${task.id}-a${attemptNumber}-${Date.now()}`;
    const handoff: Handoff = {
      id: handoffId,
      taskId: task.id,
      attemptNumber,
      model: agentResult?.response?.model,
      status: 'CLAIMED',
      summary,
      changes,
      filesAffected,
      decisionsCreated,
      assumptions,
      limitations,
      recommendedFollowUp,
      createdAt: new Date().toISOString(),
    };

    // 7. Persist Handoff in Brain
    const persistedHandoff = await this.brain.addHandoff(handoff);

    // 8. Run VerificationEngine using supplied VerificationPlan
    const runVerification =
      typeof this.verificationEngine.verify === 'function'
        ? this.verificationEngine.verify.bind(this.verificationEngine)
        : typeof this.verificationEngine.run === 'function'
          ? this.verificationEngine.run.bind(this.verificationEngine)
          : null;

    if (!runVerification) {
      throw new Error(
        'Orchestrator: verificationEngine must provide either a verify() or run() method.'
      );
    }

    const verificationResult = await runVerification(input.verificationPlan);

    // 9. Persist VerificationRecord in Brain
    const recordId = `verif-${task.id}-a${attemptNumber}-${Date.now()}`;
    const record: VerificationRecord = {
      id: recordId,
      taskId: task.id,
      attemptNumber,
      handoffId: persistedHandoff.id,
      result: verificationResult,
      recordedAt: new Date().toISOString(),
    };
    const persistedRecord = await this.brain.addVerificationRecord(record);

    // 10. Return structured OrchestrationResult
    return {
      taskId: task.id,
      attemptNumber,
      handoffId: persistedHandoff.id,
      verificationRecordId: persistedRecord.id,
      status: verificationResult.status,
      handoff: persistedHandoff,
      verificationResult,
    };
  }
}
