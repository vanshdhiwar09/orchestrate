import type { BrainStore, Handoff, VerificationRecord } from '@orchestrate/brain';
import {
  ContextCompiler,
  type CompilationRequest,
  type CompiledContext,
  ContextSerializer,
} from '@orchestrate/compiler';
import type { ModelClient } from '@orchestrate/model';
import {
  type ExecutionUsage,
  InstrumentedToolRegistry,
  type TelemetrySink,
} from '@orchestrate/telemetry';
import type {
  VerificationPlan,
  VerificationResult,
  VerificationStatus,
  SourceSnapshotIdentity,
} from '@orchestrate/verification';
import { computeSourceSnapshot } from '@orchestrate/verification';
import { AgentExecutionError, type AgentRunInput, type AgentRunResult } from './runner.js';
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
  telemetrySink?: TelemetrySink;
  workspaceRoot?: string;
  modelClient?: ModelClient;
}

export interface TaskPlanArtifact {
  summary: string;
  targetFiles?: string[];
  acceptanceCriteria?: string[];
  implementationSteps?: string[];
  risks?: string[];
}

export interface TaskReviewArtifact {
  verdict: 'APPROVED' | 'REQUEST_CHANGES';
  summary: string;
  findings?: string[];
  potentialRegressions?: string[];
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
  telemetrySink?: TelemetrySink;
  workspaceRoot?: string;
  onProgress?: (event: any) => void;
  enableMultiAgent?: boolean;
  plannerModel?: string;
  reviewerModel?: string;
  targetScope?: { type: string; paths: string[] };
}

export interface OrchestrationResult {
  taskId: string;
  attemptNumber: number;
  handoffId: string;
  verificationRecordId: string;
  status: VerificationStatus;
  handoff: Handoff;
  verificationResult: VerificationResult;
  usage?: ExecutionUsage;
  durationMs?: number;
  plan?: TaskPlanArtifact;
  review?: TaskReviewArtifact;
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
  private readonly telemetrySink?: TelemetrySink;
  private readonly workspaceRoot?: string;
  private readonly modelClient?: ModelClient;

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
    this.compiler =
      options.compiler ??
      new ContextCompiler({
        brain: options.brain,
        workspaceRoot: options.workspaceRoot,
      });
    this.toolRegistry = options.toolRegistry;
    this.telemetrySink = options.telemetrySink;
    this.workspaceRoot = options.workspaceRoot;
    this.modelClient = options.modelClient;
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

    const effectiveWorkspaceRoot =
      input.workspaceRoot ??
      (this.verificationEngine as any)?.workspaceRoot ??
      (this.verificationEngine as any)?.executor?.workspaceRoot ??
      this.workspaceRoot;

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

    // Check if task is explicitly blocked and requires human intervention
    const currentTrustState = await this.brain.deriveTaskTrustState(taskId);
    if (currentTrustState === 'BLOCKED_NEEDS_HUMAN') {
      throw new Error(
        `Orchestrator: Task "${taskId}" is in BLOCKED_NEEDS_HUMAN state. Human intervention is required before further execution.`
      );
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
      await this.brain.deriveTaskTrustState(
        upstreamTaskId,
        effectiveWorkspaceRoot ? { workspaceRoot: effectiveWorkspaceRoot } : undefined
      );
      await this.brain.getTaskHistory(upstreamTaskId);
    }

    // 2. Determine next attempt number
    const history = await this.brain.getTaskHistory(taskId);
    const highestAttempt =
      history.length > 0 ? Math.max(...history.map((a) => a.attemptNumber)) : 0;
    const attemptNumber = highestAttempt + 1;

    // Telemetry task span lifecycle start
    const rawTelemetrySink = input.telemetrySink ?? this.telemetrySink;
    const telemetrySink = (rawTelemetrySink && typeof rawTelemetrySink.forTask === 'function')
      ? rawTelemetrySink.forTask({ projectId, taskId, attemptNumber })
      : rawTelemetrySink;
    const taskStartedAt = new Date().toISOString();
    const taskStartTimeMs = performance.now();

    if (telemetrySink?.onTaskStart) {
      try {
        await telemetrySink.onTaskStart({
          projectId,
          taskId,
          attemptNumber,
          upstreamTaskId,
          model: input.model,
          temperature: input.temperature,
          maxTokens: input.maxTokens,
          tags: input.tags,
          startedAt: taskStartedAt,
        });
      } catch {
        // Telemetry error isolation: sink failures must never crash task execution
      }
    }

    // 3. Compile relevant context
    const compilationRequest: CompilationRequest = {
      projectId,
      targetTaskId: taskId,
      upstreamTaskId,
      tags: input.tags,
      workspaceRoot: effectiveWorkspaceRoot,
    };
    const compiledContext = await this.compiler.compile(compilationRequest);

    // 4. Serialize compiled context
    const serializedContext = ContextSerializer.serialize(compiledContext);

    // Planning Phase (Role A: Planner, e.g. GLM-5.3-Flash)
    let planArtifact: TaskPlanArtifact | undefined;
    if (this.modelClient && input.enableMultiAgent) {
      const plannerModel = input.plannerModel || 'zai-org/GLM-5.3-Flash';
      if (input.onProgress) {
        input.onProgress({ type: 'planner_start', model: plannerModel });
      }
      try {
        const planPrompt = [
          'You are the Lead Planning Agent (Role: Planner).',
          `Task: ${task.title}\n${task.description || ''}`,
          input.targetScope ? `Selected Scope: ${JSON.stringify(input.targetScope)}` : '',
          'Examine the compiled context and output an actionable plan in JSON with fields: summary (string), targetFiles (string[]), acceptanceCriteria (string[]), implementationSteps (string[]), risks (string[]).',
          '',
          serializedContext,
        ].filter(Boolean).join('\n\n');

        const planResp = await this.modelClient.complete({
          model: plannerModel,
          messages: [{ role: 'user', content: planPrompt }],
          temperature: 0.2,
        });

        const planContent = planResp.message.content || '';
        try {
          planArtifact = JSON.parse(planContent);
        } catch {
          const m = planContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (m) {
            try { planArtifact = JSON.parse(m[1]); } catch {}
          }
        }
        if (!planArtifact) {
          planArtifact = {
            summary: planContent || 'Plan established for implementation',
            targetFiles: [],
            acceptanceCriteria: [],
            implementationSteps: [],
            risks: [],
          };
        }

        await this.brain.addProjectFact(projectId, {
          key: `task_${taskId}_plan`,
          value: JSON.stringify(planArtifact),
          provenance: 'SYSTEM',
          status: 'CLAIMED',
        });

        if (input.onProgress) {
          input.onProgress({ type: 'planner_complete', model: plannerModel, plan: planArtifact });
        }
      } catch (planErr) {
        if (input.onProgress) {
          input.onProgress({ type: 'planner_error', error: (planErr as Error).message });
        }
      }
    }

    const systemPromptWithInstructions = [
      'You are an autonomous AI software engineering agent working in an isolated workspace.',
      'Your objective is to accomplish the assigned task by inspecting existing code and making minimal, targeted changes.',
      'Operating Rules:',
      '1. Read relevant repository files before modifying them.',
      '2. Write necessary files using `write_file`.',
      '3. Run build/test commands if necessary using `execute_command`.',
      '4. COMPLETION RULE: Once you have created or edited the required files and fulfilled the task objective, STOP CALLING TOOLS IMMEDIATELY. Output your final response summarizing changes made, files affected, and verification details.',
      planArtifact?.summary ? `\nApproved Architectural Plan (from Lead Planner):\n${planArtifact.summary}\nTarget files: ${(planArtifact.targetFiles || []).join(', ')}` : '',
      '',
      serializedContext,
    ].filter(Boolean).join('\n\n');

    // 5. Run AgentRunner with tools (WITHOUT passing upstream raw message history)
    let promptTask = task.description ? `${task.title}\n\n${task.description}` : task.title;
    if (planArtifact?.acceptanceCriteria && planArtifact.acceptanceCriteria.length > 0) {
      promptTask += `\n\nAcceptance Criteria to satisfy:\n${planArtifact.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`;
    }
    let effectiveToolRegistry = input.toolRegistry ?? this.toolRegistry;
    if (telemetrySink && effectiveToolRegistry && !(effectiveToolRegistry instanceof InstrumentedToolRegistry)) {
      effectiveToolRegistry = new InstrumentedToolRegistry(effectiveToolRegistry, {
        telemetrySink,
        projectId,
        taskId,
        attemptNumber,
      }) as unknown as ToolRegistry;
    }

    let agentResult: AgentRunResult | undefined;
    try {
      agentResult = await this.runner.run({
        task: promptTask,
        systemPrompt: systemPromptWithInstructions,
        model: input.model,
        toolRegistry: effectiveToolRegistry,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        onEvent: (event) => {
          if (input.onProgress) {
            try {
              input.onProgress(event);
            } catch {
              // Ignore callback error
            }
          }
        },
      });
    } catch (err: unknown) {
      if (err instanceof AgentExecutionError) {
        const msgs = err.partialMessages || [];
        const wroteFiles = msgs.some(
          (m: any) =>
            m.role === 'tool' &&
            m.name === 'write_file' &&
            typeof m.content === 'string' &&
            !m.content.includes('"error":')
        );
        if (wroteFiles) {
          // Agent performed workspace modifications before loop termination.
          // Build claimed handoff and proceed to verification.
          const lastMsg = [...msgs]
            .reverse()
            .find(
              (m: any) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()
            );
          agentResult = {
            response: {
              id: 'interrupted-run',
              model: input.model ?? 'default-model',
              finishReason: 'stop',
              message: {
                role: 'assistant',
                content:
                  (lastMsg?.content as string) ||
                  `Workspace modified by agent. Loop concluded early (${err.message}) and forwarded to verification.`,
              },
            },
            messages: msgs,
            iterations: err.iterations,
            usage: err.usage,
            durationMs: Math.round(performance.now() - taskStartTimeMs),
          };
        }
      }

      if (!agentResult) {
        const partialUsage = (err && typeof err === 'object' && 'usage' in err)
          ? (err as { usage?: ExecutionUsage }).usage
          : undefined;

        if (telemetrySink?.onTaskComplete) {
          try {
            await telemetrySink.onTaskComplete({
              projectId,
              taskId,
              attemptNumber,
              upstreamTaskId,
              model: input.model,
              startedAt: taskStartedAt,
              completedAt: new Date().toISOString(),
              durationMs: Math.round(performance.now() - taskStartTimeMs),
              status: 'FAILED',
              error: err instanceof Error ? err.message : String(err),
              usage: partialUsage,
            });
          } catch {
            // Telemetry error isolation
          }
        }
        throw err;
      }
    }

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

    // Review Phase (Role C: Reviewer, e.g. Nemotron-3.5-Super-VL)
    let reviewArtifact: TaskReviewArtifact | undefined;
    if (this.modelClient && input.enableMultiAgent) {
      const reviewerModel = input.reviewerModel || 'nvidia/Nemotron-3.5-Super-VL';
      if (input.onProgress) {
        input.onProgress({ type: 'reviewer_start', model: reviewerModel });
      }
      try {
        const reviewPrompt = [
          'You are the Independent Code Reviewer Agent (Role: Reviewer).',
          `Task: ${task.title}\n${task.description || ''}`,
          planArtifact ? `Original Plan:\n${JSON.stringify(planArtifact, null, 2)}` : '',
          `Implementation Summary:\n${summary}`,
          `Files Affected:\n${filesAffected.join(', ')}`,
          `Changes:\n${changes}`,
          'Review the implementation against the task objectives and plan.',
          'Output a valid JSON object with: verdict ("APPROVED" | "REQUEST_CHANGES"), summary (string), findings (string[]), potentialRegressions (string[]).',
        ].filter(Boolean).join('\n\n');

        const reviewResp = await this.modelClient.complete({
          model: reviewerModel,
          messages: [{ role: 'user', content: reviewPrompt }],
          temperature: 0.1,
        });

        const reviewContent = reviewResp.message.content || '';
        try {
          reviewArtifact = JSON.parse(reviewContent);
        } catch {
          const m = reviewContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (m) {
            try { reviewArtifact = JSON.parse(m[1]); } catch {}
          }
        }

        if (!reviewArtifact) {
          reviewArtifact = {
            verdict: 'APPROVED',
            summary: reviewContent || 'Independent review completed.',
            findings: [],
            potentialRegressions: [],
          };
        }

        await this.brain.addProjectFact(projectId, {
          key: `task_${taskId}_review`,
          value: JSON.stringify(reviewArtifact),
          provenance: 'AGENT',
          status: 'CLAIMED',
        });

        if (input.onProgress) {
          input.onProgress({ type: 'reviewer_complete', model: reviewerModel, review: reviewArtifact });
        }
      } catch (revErr) {
        if (input.onProgress) {
          input.onProgress({ type: 'reviewer_error', error: (revErr as Error).message });
        }
      }
    }

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

    // Capture source snapshot immediately before running verification
    let preSnapshot: SourceSnapshotIdentity | undefined;
    if (effectiveWorkspaceRoot) {
      preSnapshot = await computeSourceSnapshot(effectiveWorkspaceRoot);
    }

    let verificationResult = await runVerification(input.verificationPlan);

    // If verification claims VERIFIED and workspaceRoot is present, immediately recheck source freshness
    let postSnapshot: SourceSnapshotIdentity | undefined;
    if (effectiveWorkspaceRoot && verificationResult.status === 'VERIFIED') {
      try {
        postSnapshot = await computeSourceSnapshot(effectiveWorkspaceRoot);
        if (preSnapshot && postSnapshot.fingerprint !== preSnapshot.fingerprint) {
          // Source modified during verification or before persistence -> fail closed!
          verificationResult = {
            ...verificationResult,
            status: 'FAILED',
            checks: [
              ...verificationResult.checks,
              {
                checkId: 'source-freshness-guard',
                name: 'Source Freshness Guard',
                command: 'internal:source-freshness',
                args: [],
                passed: false,
                exitCode: 1,
                timedOut: false,
                signal: null,
                stdout: '',
                stderr: `Source freshness violation: workspace source modified during verification execution (pre: ${preSnapshot.fingerprint}, post: ${postSnapshot.fingerprint}).`,
                durationMs: 0,
                verifiedAt: new Date().toISOString(),
              },
            ],
          };
        }
      } catch (err: unknown) {
        // Failed to establish post-verification snapshot -> fail closed!
        verificationResult = {
          ...verificationResult,
          status: 'FAILED',
          checks: [
            ...verificationResult.checks,
            {
              checkId: 'source-freshness-guard',
              name: 'Source Freshness Guard',
              command: 'internal:source-freshness',
              args: [],
              passed: false,
              exitCode: 1,
              timedOut: false,
              signal: null,
              stdout: '',
              stderr: `Source freshness error: failed to recompute workspace snapshot: ${err instanceof Error ? err.message : String(err)}`,
              durationMs: 0,
              verifiedAt: new Date().toISOString(),
            },
          ],
        };
      }
    }

    // 9. Persist VerificationRecord in Brain
    const recordId = `verif-${task.id}-a${attemptNumber}-${Date.now()}`;
    const record: VerificationRecord = {
      id: recordId,
      taskId: task.id,
      attemptNumber,
      handoffId: persistedHandoff.id,
      result: verificationResult,
      recordedAt: new Date().toISOString(),
      sourceSnapshot:
        verificationResult.status === 'VERIFIED' ? postSnapshot ?? preSnapshot : undefined,
    };
    const persistedRecord = await this.brain.addVerificationRecord(record);

    // Telemetry task span lifecycle complete
    const taskCompletedAt = new Date().toISOString();
    const totalDurationMs = Math.round(performance.now() - taskStartTimeMs);

    if (telemetrySink?.onTaskComplete) {
      try {
        await telemetrySink.onTaskComplete({
          projectId,
          taskId,
          attemptNumber,
          upstreamTaskId,
          model: input.model,
          startedAt: taskStartedAt,
          completedAt: taskCompletedAt,
          durationMs: totalDurationMs,
          status: verificationResult.status,
          handoffId: persistedHandoff.id,
          verificationRecordId: persistedRecord.id,
          usage: agentResult?.usage,
        });
      } catch {
        // Telemetry error isolation
      }
    }

    // 10. Return structured OrchestrationResult
    return {
      taskId: task.id,
      attemptNumber,
      handoffId: persistedHandoff.id,
      verificationRecordId: persistedRecord.id,
      status: verificationResult.status,
      handoff: persistedHandoff,
      verificationResult,
      usage: agentResult?.usage,
      durationMs: totalDurationMs,
      plan: planArtifact,
      review: reviewArtifact,
    };
  }

  /**
   * Executes a task with bounded automated repair.
   * In accordance with Rule 9:
   * - Maximum of 2 automated repair attempts for a failed task.
   * - If verification fails across all repair attempts, transitions task to BLOCKED_NEEDS_HUMAN.
   */
  async executeTaskWithRepair(
    input: OrchestrateTaskInput,
    options?: { maxRepairAttempts?: number }
  ): Promise<OrchestrationResult> {
    const maxRepairs = options?.maxRepairAttempts ?? 2;
    const taskId = input.taskId.trim();

    let result = await this.executeTask(input);
    if (result.status === 'VERIFIED') {
      return result;
    }

    let repairAttempt = 0;
    while (result.status === 'FAILED' && repairAttempt < maxRepairs) {
      repairAttempt++;
      result = await this.executeTask(input);
      if (result.status === 'VERIFIED') {
        return result;
      }
    }

    if (result.status === 'FAILED' && repairAttempt >= maxRepairs) {
      await this.brain.markTaskBlocked(
        taskId,
        `Automated repair loop exhausted (${maxRepairs} repair attempts failed). Transitioned to BLOCKED_NEEDS_HUMAN.`
      );
    }

    return result;
  }
}
