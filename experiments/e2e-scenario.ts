import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryProjectBrain, type BrainStore, type Handoff } from '@orchestrate/brain';
import {
  ContextCompiler,
  ContextSerializer,
  type CompiledContext,
} from '@orchestrate/compiler';
import type {
  ChatMessage,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from '@orchestrate/model';
import {
  VerificationEngine,
  type VerificationPlan,
  type VerificationResult,
} from '@orchestrate/verification';
import {
  LocalCommandExecutor,
  LocalWorkspace,
} from '@orchestrate/workspace';
import { Orchestrator, type OrchestrationResult } from '../packages/core/src/orchestrator.js';
import { AgentRunner } from '../packages/core/src/runner.js';
import { createDefaultToolRegistry } from '../packages/core/src/tools.js';

export interface E2EScenarioResult {
  projectId: string;
  taskAResult: OrchestrationResult;
  taskBResult: OrchestrationResult;
  taskBCompiledContext: CompiledContext;
  serializedContextB: string;
  workspaceDir: string;
  filesCreated: {
    greeting: string;
    consumer: string;
  };
}

class ScriptedModelClient implements ModelClient {
  private queue: ModelResponse[] = [];
  public requests: ModelRequest[] = [];

  enqueue(response: ModelResponse): void {
    this.queue.push(response);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({
      ...request,
      messages: request.messages.map((m) => ({ ...m })),
    });

    const response = this.queue.shift();
    if (!response) {
      throw new Error(
        `ScriptedModelClient: No response queued for request to model "${request.model}".`
      );
    }
    return response;
  }
}

/**
 * Runs the deterministic dependent workflow scenario:
 * Task A (Greeting module) -> Verification -> Brain -> Context Compiler -> Task B (Consumer) -> Verification
 */
export async function runDeterministicE2EScenario(
  existingWorkspaceDir?: string
): Promise<{ result: E2EScenarioResult; cleanup: () => Promise<void> }> {
  const isTemp = !existingWorkspaceDir;
  const workspaceDir =
    existingWorkspaceDir ?? (await mkdtemp(join(tmpdir(), 'orchestrate-scenario-')));

  const workspace = new LocalWorkspace({ rootPath: workspaceDir });
  const executor = new LocalCommandExecutor({ workspaceRoot: workspaceDir });
  const verificationEngine = new VerificationEngine({ executor });
  const taskVerificationEngine = {
    run: (plan: VerificationPlan) => verificationEngine.verify(plan),
  };
  const brain = new MemoryProjectBrain();
  const compiler = new ContextCompiler({ brain });

  const modelClient = new ScriptedModelClient();
  const toolRegistry = createDefaultToolRegistry({ workspace, executor });
  const runner = new AgentRunner({
    modelClient,
    defaultModel: 'nebius/token-factory-model',
    toolRegistry,
  });

  const orchestrator = new Orchestrator({
    brain,
    runner,
    verificationEngine: taskVerificationEngine,
    compiler,
  });

  const projectId = 'proj-e2e-greeting-scenario';
  const taskAId = 'task-a-greeting';
  const taskBId = 'task-b-consumer';

  await brain.createProject({
    id: projectId,
    name: 'E2E Greeting Scenario Project',
  });

  await brain.createTask({
    id: taskAId,
    projectId,
    title: 'Create reusable greeting module',
    description: 'Create src/greeting.ts exporting createGreeting(name: string): string.',
  });

  await brain.createTask({
    id: taskBId,
    projectId,
    title: 'Add greeting CLI / consumer function that uses the greeting module created by Task A',
    description: 'Create src/consumer.ts importing and using createGreeting.',
  });

  // Task A verification plan
  const taskAVerificationPlan: VerificationPlan = {
    checks: [
      {
        id: 'check-greeting-module',
        name: 'Verify greeting module exists and exports createGreeting',
        command: 'node',
        args: [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          'import { createGreeting } from "./src/greeting.ts"; if (createGreeting("World") !== "Hello, World!") process.exit(1);',
        ],
      },
    ],
  };

  // Task B verification plan
  const taskBVerificationPlan: VerificationPlan = {
    checks: [
      {
        id: 'check-consumer-module',
        name: 'Verify consumer imports and uses createGreeting',
        command: 'node',
        args: [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          'import { runGreeting } from "./src/consumer.ts"; if (runGreeting("World") !== "[CLI] Hello, World!") process.exit(1);',
        ],
      },
    ],
  };

  // Queue responses for Task A
  modelClient.enqueue({
    id: 'resp-scenario-a-1',
    model: 'nebius/token-factory-model',
    finishReason: 'tool_calls',
    message: {
      role: 'assistant',
      content: 'Creating src/greeting.ts with createGreeting function.',
      toolCalls: [
        {
          id: 'call_scen_1',
          name: 'write_file',
          arguments: {
            path: 'src/greeting.ts',
            content: 'export function createGreeting(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
          },
        },
      ],
    },
  });

  modelClient.enqueue({
    id: 'resp-scenario-a-2',
    model: 'nebius/token-factory-model',
    finishReason: 'stop',
    message: {
      role: 'assistant',
      content: JSON.stringify({
        summary: 'Created reusable greeting module in src/greeting.ts',
        changes: 'Exported createGreeting(name: string): string',
        filesAffected: ['src/greeting.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: ['Create consumer in Task B'],
      }),
    },
  });

  // Execute Task A
  const taskAResult = await orchestrator.executeTask({
    projectId,
    taskId: taskAId,
    verificationPlan: taskAVerificationPlan,
  });

  // Compile context for Task B
  const taskBCompiledContext = await compiler.compile({
    projectId,
    targetTaskId: taskBId,
    upstreamTaskId: taskAId,
  });
  const serializedContextB = ContextSerializer.serialize(taskBCompiledContext);

  // Queue responses for Task B
  modelClient.enqueue({
    id: 'resp-scenario-b-1',
    model: 'nebius/token-factory-model',
    finishReason: 'tool_calls',
    message: {
      role: 'assistant',
      content: 'Creating src/consumer.ts utilizing createGreeting from src/greeting.ts.',
      toolCalls: [
        {
          id: 'call_scen_2',
          name: 'write_file',
          arguments: {
            path: 'src/consumer.ts',
            content:
              'import { createGreeting } from "./greeting.ts";\n\nexport function runGreeting(name: string): string {\n  return `[CLI] ${createGreeting(name)}`;\n}\n',
          },
        },
      ],
    },
  });

  modelClient.enqueue({
    id: 'resp-scenario-b-2',
    model: 'nebius/token-factory-model',
    finishReason: 'stop',
    message: {
      role: 'assistant',
      content: JSON.stringify({
        summary: 'Created greeting consumer module in src/consumer.ts',
        changes: 'Imported createGreeting and exported runGreeting',
        filesAffected: ['src/consumer.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
      }),
    },
  });

  // Execute Task B
  const taskBResult = await orchestrator.executeTask({
    projectId,
    taskId: taskBId,
    upstreamTaskId: taskAId,
    verificationPlan: taskBVerificationPlan,
  });

  const greetingContent = await workspace.readFile('src/greeting.ts');
  const consumerContent = await workspace.readFile('src/consumer.ts');

  const cleanup = async () => {
    if (isTemp) {
      try {
        await rm(workspaceDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
  };

  return {
    result: {
      projectId,
      taskAResult,
      taskBResult,
      taskBCompiledContext,
      serializedContextB,
      workspaceDir,
      filesCreated: {
        greeting: greetingContent,
        consumer: consumerContent,
      },
    },
    cleanup,
  };
}
