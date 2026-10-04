import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryProjectBrain, type Handoff } from '@orchestrate/brain';
import { ContextCompiler, ContextSerializer } from '@orchestrate/compiler';
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator, type OrchestrateTaskInput, type TaskVerificationEngine } from '../src/orchestrator.js';
import { AgentRunner, type AgentRunInput, type AgentRunResult } from '../src/runner.js';
import { createDefaultToolRegistry } from '../src/tools.js';
import { runDeterministicE2EScenario } from '../../../experiments/e2e-scenario.js';

interface ScriptedExchange {
  matcher?: (request: ModelRequest) => boolean;
  response: ModelResponse;
}

class DeterministicScriptedModelClient implements ModelClient {
  public requests: ModelRequest[] = [];
  private readonly queue: ScriptedExchange[] = [];

  enqueue(response: ModelResponse, matcher?: (request: ModelRequest) => boolean): void {
    this.queue.push({ response, matcher });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({
      ...request,
      messages: request.messages.map((m) => ({ ...m })),
    });

    const index = this.queue.findIndex(
      (item) => !item.matcher || item.matcher(request)
    );

    if (index === -1) {
      throw new Error(
        `DeterministicScriptedModelClient: No matching response for model="${request.model}" messages=${request.messages.length}`
      );
    }

    const [exchange] = this.queue.splice(index, 1);
    return exchange.response;
  }
}

function createHandoffRecord(
  overrides: Partial<Handoff> & { id: string; taskId: string }
): Handoff {
  return {
    attemptNumber: 1,
    status: 'CLAIMED',
    summary: 'Task completed by agent',
    changes: 'Modified files',
    filesAffected: [],
    decisionsCreated: [],
    assumptions: [],
    limitations: [],
    recommendedFollowUp: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('End-to-End Dependent Workflow Integration Tests', () => {
  let tempDir: string;
  let workspace: LocalWorkspace;
  let executor: LocalCommandExecutor;
  let verificationEngine: VerificationEngine;
  let taskVerificationEngine: TaskVerificationEngine;
  let brain: MemoryProjectBrain;
  let compiler: ContextCompiler;

  const projectId = 'proj-e2e-greeting';
  const taskAId = 'task-greeting-module';
  const taskBId = 'task-greeting-consumer';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orchestrate-e2e-'));
    workspace = new LocalWorkspace({ rootPath: tempDir });
    executor = new LocalCommandExecutor({ workspaceRoot: tempDir });
    verificationEngine = new VerificationEngine({ executor });
    taskVerificationEngine = {
      run: async (plan: VerificationPlan): Promise<VerificationResult> => {
        return verificationEngine.verify(plan);
      },
    };
    brain = new MemoryProjectBrain();
    compiler = new ContextCompiler({ brain });

    await brain.createProject({
      id: projectId,
      name: 'E2E Greeting Workflow Project',
    });

    await brain.addProjectFact(projectId, {
      key: 'architecture.module_format',
      value: 'ESM with TypeScript',
      provenance: 'CODE',
      status: 'VERIFIED',
    });

    await brain.addDecision({
      id: 'dec-1',
      projectId,
      statement: 'Use pure functions for greeting creation and consumption',
      rationale: 'Promotes testability and clean module boundaries',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
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
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error if temp dir already removed
    }
  });

  const taskAVerificationPlan: VerificationPlan = {
    checks: [
      {
        id: 'check-greeting-module-verified',
        name: 'Verify greeting module exists and exports createGreeting',
        command: 'node',
        args: [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          'import { createGreeting } from "./src/greeting.ts"; if (typeof createGreeting !== "function") process.exit(1); if (createGreeting("World") !== "Hello, World!") process.exit(1); console.log("createGreeting verified successfully");',
        ],
      },
    ],
  };

  const taskBVerificationPlan: VerificationPlan = {
    checks: [
      {
        id: 'check-consumer-verified',
        name: 'Verify consumer imports and uses createGreeting',
        command: 'node',
        args: [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          'import { runGreeting } from "./src/consumer.ts"; if (typeof runGreeting !== "function") process.exit(1); if (runGreeting("E2E") !== "[CLI] Hello, E2E!") process.exit(1); console.log("runGreeting verified successfully");',
        ],
      },
    ],
  };

  describe('1. Full Deterministic Dependent Scenario (Task A -> Task B)', () => {
    it('executes full pipeline with real workspace modifications, independent verification, and compiled upstream context', async () => {
      const modelClientA = new DeterministicScriptedModelClient();
      const toolRegistryA = createDefaultToolRegistry({ workspace, executor });
      const runnerA = new AgentRunner({
        modelClient: modelClientA,
        defaultModel: 'nebius/token-factory-model',
        toolRegistry: toolRegistryA,
      });

      // ── Step 1: Agent A execution ──────────────────────────────────────────
      // Turn 1: Agent A decides to call write_file to create src/greeting.ts
      modelClientA.enqueue({
        id: 'resp-a-1',
        model: 'nebius/token-factory-model',
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'I will create the reusable greeting module in src/greeting.ts.',
          toolCalls: [
            {
              id: 'call_write_greeting',
              name: 'write_file',
              arguments: {
                path: 'src/greeting.ts',
                content: [
                  'export function createGreeting(name: string): string {',
                  '  return `Hello, ${name}!`;',
                  '}',
                  '',
                ].join('\n'),
              },
            },
          ],
        },
      });

      // Turn 2: Agent A receives tool result and produces structured handoff JSON
      const agentAClaimedHandoff = {
        summary: 'Created reusable greeting module in src/greeting.ts exporting createGreeting(name: string): string.',
        changes: 'Exported createGreeting function with string interpolation.',
        filesAffected: ['src/greeting.ts'],
        decisionsCreated: [],
        assumptions: ['Node.js supports TypeScript type stripping.'],
        limitations: [],
        recommendedFollowUp: ['Create consumer function in Task B.'],
      };

      modelClientA.enqueue({
        id: 'resp-a-2',
        model: 'nebius/token-factory-model',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify(agentAClaimedHandoff),
        },
      });

      // Task A context before execution (initial task, no upstream)
      const compiledContextA = await compiler.compile({
        projectId,
        targetTaskId: taskAId,
      });
      const serializedContextA = ContextSerializer.serialize(compiledContextA);

      const agentARunResult: AgentRunResult = await runnerA.run({
        task: 'Create reusable greeting module src/greeting.ts exporting createGreeting(name: string): string.',
        systemPrompt: serializedContextA,
      });

      expect(agentARunResult.iterations).toBe(2);

      // Verify real code change occurred in workspace
      const greetingCodeOnDisk = await workspace.readFile('src/greeting.ts');
      expect(greetingCodeOnDisk).toContain('export function createGreeting(name: string): string');
      expect(greetingCodeOnDisk).toContain('return `Hello, ${name}!`;');

      // ── Step 2: Structured handoff creation (status = CLAIMED) ───────────
      const handoffA = await brain.addHandoff(
        createHandoffRecord({
          id: 'handoff-task-a-1',
          taskId: taskAId,
          attemptNumber: 1,
          model: 'nebius/token-factory-model',
          status: 'CLAIMED',
          summary: agentAClaimedHandoff.summary,
          changes: agentAClaimedHandoff.changes,
          filesAffected: agentAClaimedHandoff.filesAffected,
          assumptions: agentAClaimedHandoff.assumptions,
          limitations: agentAClaimedHandoff.limitations,
          recommendedFollowUp: agentAClaimedHandoff.recommendedFollowUp,
        })
      );

      expect(handoffA.status).toBe('CLAIMED');

      // Trust state before verification must be CLAIMED, NOT VERIFIED
      const preVerifStateA = await brain.deriveTaskTrustState(taskAId);
      expect(preVerifStateA).toBe('CLAIMED');

      // ── Step 3: Independent verification of Task A ────────────────────────
      const verifResultA = await verificationEngine.verify(taskAVerificationPlan);
      expect(verifResultA.status).toBe('VERIFIED');
      expect(verifResultA.checks[0].passed).toBe(true);
      expect(verifResultA.checks[0].exitCode).toBe(0);
      expect(verifResultA.checks[0].stdout).toContain('createGreeting verified successfully');

      // Record verification in BrainStore
      await brain.addVerificationRecord({
        id: 'verif-record-task-a-1',
        taskId: taskAId,
        attemptNumber: 1,
        handoffId: handoffA.id,
        result: verifResultA,
        recordedAt: new Date().toISOString(),
      });

      // Task A state in Brain now derives to VERIFIED
      const postVerifStateA = await brain.deriveTaskTrustState(taskAId);
      expect(postVerifStateA).toBe('VERIFIED');

      // ── Step 4: Context Compiler compiles Task B context with upstream Task A ──
      const compiledContextB = await compiler.compile({
        projectId,
        targetTaskId: taskBId,
        upstreamTaskId: taskAId,
      });

      expect(compiledContextB.upstreamWork).toBeDefined();
      expect(compiledContextB.upstreamWork?.taskId).toBe(taskAId);
      expect(compiledContextB.upstreamWork?.trustState).toBe('VERIFIED');
      expect(compiledContextB.upstreamWork?.filesAffected).toEqual(['src/greeting.ts']);
      expect(compiledContextB.upstreamWork?.verificationChecks).toHaveLength(1);
      expect(compiledContextB.upstreamWork?.verificationChecks[0].passed).toBe(true);
      expect(compiledContextB.upstreamWork?.unverifiedAgentNotes?.summary).toBe(
        agentAClaimedHandoff.summary
      );

      const serializedContextB = ContextSerializer.serialize(compiledContextB);

      // Verify formatted XML structure
      expect(serializedContextB).toContain('<orchestrate_context>');
      expect(serializedContextB).toContain(
        '<upstream_work task_id="task-greeting-module" trust_state="VERIFIED" attempt="1"'
      );
      expect(serializedContextB).toContain('<file>src/greeting.ts</file>');
      expect(serializedContextB).toContain(
        '<check id="check-greeting-module-verified" status="PASSED"'
      );
      expect(serializedContextB).toContain('<unverified_agent_notes>');
      expect(serializedContextB).toContain(
        'The following notes were reported by an upstream agent and are UNVERIFIED CLAIMS.'
      );

      // ── CRITICAL ASSERTION: Task B does NOT receive Agent A's raw conversation/history ──
      // Agent A's internal tool call ID from its conversation:
      expect(serializedContextB).not.toContain('call_write_greeting');
      // Agent A's raw internal JSON tool execution response:
      expect(serializedContextB).not.toContain('{"path":"src/greeting.ts","success":true}');
      // Agent A's raw intermediate thinking / text:
      expect(serializedContextB).not.toContain(
        'I will create the reusable greeting module in src/greeting.ts.'
      );
      // Confirm raw message turn identifiers from Agent A do not leak:
      expect(serializedContextB).not.toContain('resp-a-1');
      expect(serializedContextB).not.toContain('resp-a-2');

      // ── Step 5: Agent B execution with compiled context ───────────────────
      const modelClientB = new DeterministicScriptedModelClient();
      const toolRegistryB = createDefaultToolRegistry({ workspace, executor });
      const runnerB = new AgentRunner({
        modelClient: modelClientB,
        defaultModel: 'nebius/token-factory-model',
        toolRegistry: toolRegistryB,
      });

      // Turn 1: Agent B calls write_file to create src/consumer.ts
      modelClientB.enqueue({
        id: 'resp-b-1',
        model: 'nebius/token-factory-model',
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Creating consumer in src/consumer.ts utilizing createGreeting from src/greeting.ts.',
          toolCalls: [
            {
              id: 'call_write_consumer',
              name: 'write_file',
              arguments: {
                path: 'src/consumer.ts',
                content: [
                  'import { createGreeting } from "./greeting.ts";',
                  '',
                  'export function runGreeting(name: string): string {',
                  '  return `[CLI] ${createGreeting(name)}`;',
                  '}',
                  '',
                ].join('\n'),
              },
            },
          ],
        },
      });

      // Turn 2: Agent B produces structured handoff
      const agentBClaimedHandoff = {
        summary: 'Created consumer module src/consumer.ts that imports and calls createGreeting.',
        changes: 'Exported runGreeting function which decorates createGreeting output.',
        filesAffected: ['src/consumer.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
      };

      modelClientB.enqueue({
        id: 'resp-b-2',
        model: 'nebius/token-factory-model',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify(agentBClaimedHandoff),
        },
      });

      const agentBRunResult = await runnerB.run({
        task: 'Add greeting CLI / consumer function that uses the greeting module created by Task A',
        systemPrompt: serializedContextB,
      });

      expect(agentBRunResult.iterations).toBe(2);

      // Verify the messages Agent B was actually given:
      // Verify no history from Agent A was supplied to Agent B
      const initialUserMsg = modelClientB.requests[0].messages.find((m) => m.role === 'user');
      expect(initialUserMsg?.content).toBe(
        'Add greeting CLI / consumer function that uses the greeting module created by Task A'
      );
      const systemMsg = modelClientB.requests[0].messages.find((m) => m.role === 'system');
      expect(systemMsg?.content).toBe(serializedContextB);
      expect(systemMsg?.content).not.toContain('call_write_greeting');

      // Verify real code change on disk for Task B
      const consumerCodeOnDisk = await workspace.readFile('src/consumer.ts');
      expect(consumerCodeOnDisk).toContain('import { createGreeting } from "./greeting.ts";');
      expect(consumerCodeOnDisk).toContain('export function runGreeting(name: string): string');

      // ── Step 6: Independent verification of Task B ────────────────────────
      const verifResultB = await verificationEngine.verify(taskBVerificationPlan);
      expect(verifResultB.status).toBe('VERIFIED');
      expect(verifResultB.checks[0].passed).toBe(true);
      expect(verifResultB.checks[0].exitCode).toBe(0);
      expect(verifResultB.checks[0].stdout).toContain('runGreeting verified successfully');

      // Record Task B handoff and verification in BrainStore
      const handoffB = await brain.addHandoff(
        createHandoffRecord({
          id: 'handoff-task-b-1',
          taskId: taskBId,
          attemptNumber: 1,
          model: 'nebius/token-factory-model',
          status: 'CLAIMED',
          summary: agentBClaimedHandoff.summary,
          changes: agentBClaimedHandoff.changes,
          filesAffected: agentBClaimedHandoff.filesAffected,
        })
      );

      await brain.addVerificationRecord({
        id: 'verif-record-task-b-1',
        taskId: taskBId,
        attemptNumber: 1,
        handoffId: handoffB.id,
        result: verifResultB,
        recordedAt: new Date().toISOString(),
      });

      // ── Step 7: Final assertions on BrainStore records and trust state ─────
      const postVerifStateB = await brain.deriveTaskTrustState(taskBId);
      expect(postVerifStateB).toBe('VERIFIED');

      const historyA = await brain.getTaskHistory(taskAId);
      expect(historyA).toHaveLength(1);
      expect(historyA[0].handoff?.id).toBe('handoff-task-a-1');
      expect(historyA[0].verificationRecord?.result.status).toBe('VERIFIED');

      const historyB = await brain.getTaskHistory(taskBId);
      expect(historyB).toHaveLength(1);
      expect(historyB[0].handoff?.id).toBe('handoff-task-b-1');
      expect(historyB[0].verificationRecord?.result.status).toBe('VERIFIED');
    });

    it('executes full dependent flow through Orchestrator coordinator cleanly', async () => {
      const modelClient = new DeterministicScriptedModelClient();
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

      // Enqueue Agent A responses
      modelClient.enqueue({
        id: 'resp-orch-a-1',
        model: 'nebius/token-factory-model',
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Creating greeting file.',
          toolCalls: [
            {
              id: 'call-orch-1',
              name: 'write_file',
              arguments: {
                path: 'src/greeting.ts',
                content:
                  'export function createGreeting(name: string): string { return `Hello, ${name}!`; }\n',
              },
            },
          ],
        },
      });

      modelClient.enqueue({
        id: 'resp-orch-a-2',
        model: 'nebius/token-factory-model',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'Created greeting module in src/greeting.ts',
            changes: 'Exported createGreeting',
            filesAffected: ['src/greeting.ts'],
          }),
        },
      });

      const resultA = await orchestrator.executeTask({
        projectId,
        taskId: taskAId,
        verificationPlan: taskAVerificationPlan,
      });

      expect(resultA.status).toBe('VERIFIED');
      expect(resultA.handoff.filesAffected).toEqual(['src/greeting.ts']);
      expect(resultA.verificationResult.checks[0].passed).toBe(true);

      const trustA = await brain.deriveTaskTrustState(taskAId);
      expect(trustA).toBe('VERIFIED');

      // Enqueue Agent B responses
      modelClient.enqueue({
        id: 'resp-orch-b-1',
        model: 'nebius/token-factory-model',
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Creating consumer file.',
          toolCalls: [
            {
              id: 'call-orch-2',
              name: 'write_file',
              arguments: {
                path: 'src/consumer.ts',
                content:
                  'import { createGreeting } from "./greeting.ts"; export function runGreeting(name: string): string { return `[CLI] ${createGreeting(name)}`; }\n',
              },
            },
          ],
        },
      });

      modelClient.enqueue({
        id: 'resp-orch-b-2',
        model: 'nebius/token-factory-model',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'Created consumer module in src/consumer.ts',
            changes: 'Implemented runGreeting',
            filesAffected: ['src/consumer.ts'],
          }),
        },
      });

      const resultB = await orchestrator.executeTask({
        projectId,
        taskId: taskBId,
        upstreamTaskId: taskAId,
        verificationPlan: taskBVerificationPlan,
      });

      expect(resultB.status).toBe('VERIFIED');
      expect(resultB.handoff.filesAffected).toEqual(['src/consumer.ts']);
      expect(resultB.verificationResult.checks[0].passed).toBe(true);

      const trustB = await brain.deriveTaskTrustState(taskBId);
      expect(trustB).toBe('VERIFIED');
    });
  });

  describe('2. Negative Coverage & Independence of Verification', () => {
    it('Task A verification failure does NOT become VERIFIED in Brain when agent claims success but code fails check', async () => {
      const modelClient = new DeterministicScriptedModelClient();
      const toolRegistry = createDefaultToolRegistry({ workspace, executor });
      const runner = new AgentRunner({
        modelClient,
        defaultModel: 'nebius/token-factory-model',
        toolRegistry,
      });

      // Agent writes faulty code (wrong return value)
      modelClient.enqueue({
        id: 'resp-neg-1',
        model: 'nebius/token-factory-model',
        finishReason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Writing greeting implementation.',
          toolCalls: [
            {
              id: 'call-neg-write',
              name: 'write_file',
              arguments: {
                path: 'src/greeting.ts',
                content:
                  'export function createGreeting(name: string): string { return "INCORRECT GREETING"; }\n',
              },
            },
          ],
        },
      });

      // Agent aggressively claims complete success
      const agentClaim = {
        summary: 'COMPLETED AND PERFECT: 100% verified greeting module implemented!',
        changes: 'Exported createGreeting with flawless functionality.',
        filesAffected: ['src/greeting.ts'],
      };

      modelClient.enqueue({
        id: 'resp-neg-2',
        model: 'nebius/token-factory-model',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify(agentClaim),
        },
      });

      const orchestrator = new Orchestrator({
        brain,
        runner,
        verificationEngine: taskVerificationEngine,
        compiler,
      });

      const orchestrationResult = await orchestrator.executeTask({
        projectId,
        taskId: taskAId,
        verificationPlan: taskAVerificationPlan,
      });

      // INDEPENDENT VERIFICATION CHECK:
      // Even though agent claimed complete success, the verification check failed
      expect(orchestrationResult.status).toBe('FAILED');
      expect(orchestrationResult.verificationResult.status).toBe('FAILED');
      expect(orchestrationResult.verificationResult.checks[0].passed).toBe(false);
      expect(orchestrationResult.verificationResult.checks[0].exitCode).toBe(1);

      // Brain trust state MUST be FAILED, NEVER VERIFIED
      const derivedState = await brain.deriveTaskTrustState(taskAId);
      expect(derivedState).toBe('FAILED');
      expect(derivedState).not.toBe('VERIFIED');
    });

    it('Task A verification failure when agent did not write the required file', async () => {
      const modelClient = new DeterministicScriptedModelClient();
      const toolRegistry = createDefaultToolRegistry({ workspace, executor });
      const runner = new AgentRunner({
        modelClient,
        defaultModel: 'nebius/token-factory-model',
        toolRegistry,
      });

      // Agent makes no tool calls, simply hallucinates that work is done
      modelClient.enqueue({
        id: 'resp-no-op',
        model: 'nebius/token-factory-model',
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'I have successfully created src/greeting.ts without needing any tools.',
            changes: 'Created greeting module in mind.',
            filesAffected: ['src/greeting.ts'],
          }),
        },
      });

      const orchestrator = new Orchestrator({
        brain,
        runner,
        verificationEngine: taskVerificationEngine,
        compiler,
      });

      const orchestrationResult = await orchestrator.executeTask({
        projectId,
        taskId: taskAId,
        verificationPlan: taskAVerificationPlan,
      });

      expect(orchestrationResult.status).toBe('FAILED');
      expect(orchestrationResult.verificationResult.status).toBe('FAILED');

      const derivedState = await brain.deriveTaskTrustState(taskAId);
      expect(derivedState).toBe('FAILED');
    });

    it('Task B compilation when upstream failed: does not receive fabricated VERIFIED state; verification failure is truthfully reflected', async () => {
      // 1. Manually simulate a failed upstream Task A attempt in Brain
      const handoffA = await brain.addHandoff(
        createHandoffRecord({
          id: 'handoff-failed-a',
          taskId: taskAId,
          attemptNumber: 1,
          model: 'nebius/token-factory-model',
          status: 'CLAIMED',
          summary: 'Agent claimed greeting module was created.',
          changes: 'Added src/greeting.ts',
          filesAffected: ['src/greeting.ts'],
        })
      );

      await brain.addVerificationRecord({
        id: 'verif-failed-a',
        taskId: taskAId,
        attemptNumber: 1,
        handoffId: handoffA.id,
        result: {
          status: 'FAILED',
          checks: [
            {
              checkId: 'check-greeting-module-verified',
              name: 'Verify greeting module exists and exports createGreeting',
              command: 'node',
              args: ['--experimental-strip-types', '-e', 'import ...'],
              passed: false,
              exitCode: 1,
              signal: null,
              stdout: '',
              stderr: 'Error: Cannot find module "./src/greeting.ts"',
              timedOut: false,
              durationMs: 45,
              verifiedAt: new Date().toISOString(),
            },
          ],
          executedAt: new Date().toISOString(),
          totalDurationMs: 45,
        },
        recordedAt: new Date().toISOString(),
      });

      // Verify brain state of upstream task
      const upstreamTrust = await brain.deriveTaskTrustState(taskAId);
      expect(upstreamTrust).toBe('FAILED');

      // 2. Compile context for Task B with failed upstream Task A
      const compiledContextB = await compiler.compile({
        projectId,
        targetTaskId: taskBId,
        upstreamTaskId: taskAId,
      });

      // Truthful reflection in structured compiled context
      expect(compiledContextB.upstreamWork).toBeDefined();
      expect(compiledContextB.upstreamWork?.taskId).toBe(taskAId);
      expect(compiledContextB.upstreamWork?.trustState).toBe('FAILED');
      expect(compiledContextB.upstreamWork?.trustState).not.toBe('VERIFIED');
      expect(compiledContextB.upstreamWork?.verificationChecks[0].passed).toBe(false);
      expect(compiledContextB.upstreamWork?.verificationChecks[0].stderrSnippet).toContain(
        'Cannot find module "./src/greeting.ts"'
      );

      // Truthful reflection in serialized prompt context
      const serialized = ContextSerializer.serialize(compiledContextB);

      expect(serialized).toContain('trust_state="FAILED"');
      expect(serialized).not.toContain('trust_state="VERIFIED"');
      expect(serialized).toContain('<check id="check-greeting-module-verified" status="FAILED"');
      expect(serialized).toContain(
        '<stderr_snippet>Error: Cannot find module &quot;./src/greeting.ts&quot;</stderr_snippet>'
      );
    });

    it('Task trust state remains UNVERIFIED or CLAIMED before verification execution', async () => {
      // No attempts yet
      const initialState = await brain.deriveTaskTrustState(taskAId);
      expect(initialState).toBe('UNVERIFIED');

      // Add a handoff only (agent claims completion)
      await brain.addHandoff(
        createHandoffRecord({
          id: 'handoff-only-a',
          taskId: taskAId,
          attemptNumber: 1,
          model: 'nebius/token-factory-model',
          status: 'CLAIMED',
          summary: 'I have finished the task.',
          changes: 'All done.',
          filesAffected: ['src/greeting.ts'],
        })
      );

      // Trust state must be CLAIMED, never promoted to VERIFIED without verification evidence
      const claimedState = await brain.deriveTaskTrustState(taskAId);
      expect(claimedState).toBe('CLAIMED');
      expect(claimedState).not.toBe('VERIFIED');

      // Compiling context when upstream is only CLAIMED
      const compiled = await compiler.compile({
        projectId,
        targetTaskId: taskBId,
        upstreamTaskId: taskAId,
      });

      expect(compiled.upstreamWork?.trustState).toBe('CLAIMED');
      const serialized = ContextSerializer.serialize(compiled);
      expect(serialized).toContain('trust_state="CLAIMED"');
      expect(serialized).not.toContain('trust_state="VERIFIED"');
    });

    it('upholds the source-of-truth hierarchy: CODE > VERIFICATION EVIDENCE > PROJECT BRAIN > AGENT CLAIMS', async () => {
      // 1. Agent claims file exists and is perfect (AGENT CLAIM)
      const handoff = await brain.addHandoff(
        createHandoffRecord({
          id: 'h-hierarchy-1',
          taskId: taskAId,
          attemptNumber: 1,
          model: 'nebius/token-factory-model',
          status: 'CLAIMED',
          summary: 'File created and verified by agent',
          changes: 'None needed',
          filesAffected: ['src/greeting.ts'],
        })
      );

      // 2. But on disk (CODE), the file does not exist
      await expect(workspace.readFile('src/greeting.ts')).rejects.toThrow();

      // 3. VerificationEngine executes independent test against workspace (VERIFICATION EVIDENCE)
      const verifResult = await verificationEngine.verify(taskAVerificationPlan);

      expect(verifResult.status).toBe('FAILED');

      await brain.addVerificationRecord({
        id: 'v-hierarchy-1',
        taskId: taskAId,
        attemptNumber: 1,
        handoffId: handoff.id,
        result: verifResult,
        recordedAt: new Date().toISOString(),
      });

      // 4. Brain derives trust state from VERIFICATION EVIDENCE, completely overriding AGENT CLAIM
      const derived = await brain.deriveTaskTrustState(taskAId);
      expect(derived).toBe('FAILED');
    });
  });

  describe('3. Standalone E2E Experiment Scenario Runner', () => {
    it('executes runDeterministicE2EScenario successfully with complete verification and persistence', async () => {
      const { result, cleanup } = await runDeterministicE2EScenario();
      try {
        expect(result.taskAResult.status).toBe('VERIFIED');
        expect(result.taskBResult.status).toBe('VERIFIED');
        expect(result.filesCreated.greeting).toContain('export function createGreeting');
        expect(result.filesCreated.consumer).toContain('export function runGreeting');
        expect(result.serializedContextB).toContain('trust_state="VERIFIED"');
        expect(result.serializedContextB).not.toContain('call_scen_1');
      } finally {
        await cleanup();
      }
    });
  });
});
