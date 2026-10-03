import {
  AgentRunner,
  createDefaultToolRegistry,
  type Tool,
  ToolRegistry,
} from '@orchestrate/core';
import type { ModelClient } from '@orchestrate/model';
import {
  type CommandExecutor,
  createGitTools,
  type GitRepository,
  LocalCommandExecutor,
  type Workspace,
} from '@orchestrate/workspace';
import { sealEvidence } from './evidence-sealer.js';
import { InstrumentedModelClient } from './instrumented-model-client.js';
import { InstrumentedToolRegistry } from './instrumented-tool-registry.js';
import type {
  ArmExecutionInput,
  ArmExecutionResult,
  BenchmarkWorkspace,
  ExecutionOutcome,
  RawExecutionEvidence,
  WorkspaceFactory,
} from './types.js';

export interface AgentExecutionAdapterOptions {
  /**
   * Factory providing isolated, disposable workspaces.
   */
  workspaceFactory: WorkspaceFactory;

  /**
   * Underlying model client for agent reasoning.
   */
  modelClient: ModelClient;

  /**
   * Optional custom tool factory for creating workspace-bound tools.
   */
  toolRegistryFactory?: (
    workspace: Workspace,
    executor: CommandExecutor,
    git: GitRepository
  ) => ToolRegistry;

  /**
   * If true, cleans up the workspace immediately upon execution completion.
   * Defaults to false (preserving workspace for verification and diff capture).
   */
  cleanupWorkspace?: boolean;

  /**
   * Maximum loop iterations before terminating agent. Defaults to 30.
   */
  maxIterations?: number;

  /**
   * Optional custom secrets for field-aware redaction.
   */
  customSecrets?: string[];
}

function defaultToolFactory(
  workspace: Workspace,
  executor: CommandExecutor,
  git: GitRepository
): ToolRegistry {
  const registry = createDefaultToolRegistry({
    workspace,
    executor,
  });

  const gitTools = createGitTools(git);
  for (const gitTool of gitTools) {
    registry.register(gitTool as Tool);
  }

  return registry;
}

/**
 * AgentExecutionAdapter executes a single benchmark arm in an isolated workspace,
 * recording an ordered execution trace with model calls, tool calls, token usage,
 * and producing sealed raw execution evidence.
 */
export class AgentExecutionAdapter {
  private readonly workspaceFactory: WorkspaceFactory;
  private readonly modelClient: ModelClient;
  private readonly toolRegistryFactory: (
    workspace: Workspace,
    executor: CommandExecutor,
    git: GitRepository
  ) => ToolRegistry;
  private readonly cleanupWorkspace: boolean;
  private readonly maxIterations: number;
  private readonly customSecrets?: string[];

  constructor(options: AgentExecutionAdapterOptions) {
    if (!options?.workspaceFactory) {
      throw new Error('AgentExecutionAdapter requires a WorkspaceFactory.');
    }
    if (!options?.modelClient) {
      throw new Error('AgentExecutionAdapter requires a ModelClient.');
    }

    this.workspaceFactory = options.workspaceFactory;
    this.modelClient = options.modelClient;
    this.toolRegistryFactory = options.toolRegistryFactory ?? defaultToolFactory;
    this.cleanupWorkspace = options.cleanupWorkspace ?? false;
    this.maxIterations = options.maxIterations ?? 30;
    this.customSecrets = options.customSecrets;
  }

  /**
   * Executes a single experimental arm and returns sealed raw execution evidence
   * along with the live workspace handle for downstream verification and teardown.
   */
  async execute(input: ArmExecutionInput): Promise<ArmExecutionResult> {
    if (!input || typeof input !== 'object') {
      throw new Error('AgentExecutionAdapter.execute: input must be a valid ArmExecutionInput.');
    }

    if (!input.taskBPrompt || typeof input.taskBPrompt !== 'string' || input.taskBPrompt.trim() === '') {
      throw new Error('AgentExecutionAdapter.execute: taskBPrompt must be a non-empty string.');
    }

    // 1. Provision isolated workspace
    const benchWorkspace = await this.workspaceFactory.create(input.snapshotCommitSha);

    // 2. Monotonic sequence generator for unified event ordering
    let sequenceCounter = 1;
    const sequenceProvider = () => sequenceCounter++;

    // 3. Instrument Model Client
    const instrumentedModel = new InstrumentedModelClient({
      modelClient: this.modelClient,
      sequenceProvider,
      customSecrets: this.customSecrets,
    });

    // 4. Instrument Tool Registry
    const executor = new LocalCommandExecutor({ workspaceRoot: benchWorkspace.path });
    const baseTools = this.toolRegistryFactory(
      benchWorkspace.workspace,
      executor,
      benchWorkspace.git
    );
    const instrumentedTools = new InstrumentedToolRegistry(baseTools, {
      sequenceProvider,
      customSecrets: this.customSecrets,
    });

    // 5. Construct AgentRunner
    const runner = new AgentRunner({
      modelClient: instrumentedModel,
      defaultModel: input.controlFingerprint.modelIdentity,
      toolRegistry: instrumentedTools,
      maxIterations: this.maxIterations,
    });

    // 6. Execute Agent Loop
    const startedAt = new Date().toISOString();
    const startTimeMs = performance.now();

    let outcome: ExecutionOutcome = 'COMPLETED';
    let finalResponse: { content: string | null; finishReason?: string } | null = null;
    let executionError: { message: string; stack?: string } | undefined = undefined;

    try {
      const runResult = await runner.run({
        task: input.taskBPrompt,
        systemPrompt: input.systemPrompt,
        model: input.controlFingerprint.modelIdentity,
        temperature: input.samplingConfig?.temperature,
        maxTokens: input.samplingConfig?.maxTokens,
      });

      finalResponse = {
        content: runResult.response.message.content,
        finishReason: runResult.response.finishReason,
      };
    } catch (err: unknown) {
      outcome = 'FAILED';
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      executionError = { message, stack };
    } finally {
      if (this.cleanupWorkspace) {
        try {
          await benchWorkspace.cleanup();
        } catch {
          // ignore cleanup errors during teardown
        }
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Math.round(performance.now() - startTimeMs);

    // 7. Collect Evidence
    const modelEvents = instrumentedModel.getEvents();
    const toolEvents = instrumentedTools.getEvents();
    const usage = instrumentedModel.getAggregateUsage();

    const unsealedEvidence: Omit<RawExecutionEvidence, 'evidenceContentHash'> = {
      trialId: input.trialId,
      armId: input.armId,
      snapshotCommitSha: input.snapshotCommitSha,
      workspacePath: `workspace://${input.armId}`,
      modelIdentity: input.controlFingerprint.modelIdentity,
      startedAt,
      completedAt,
      durationMs,
      outcome,
      modelEvents,
      toolEvents,
      finalResponse,
      usage,
      ...(executionError ? { error: executionError } : {}),
    };

    // 8. Redact and seal evidence
    const evidence = sealEvidence(unsealedEvidence, this.customSecrets);
    return {
      evidence,
      workspace: benchWorkspace,
    };
  }
}
