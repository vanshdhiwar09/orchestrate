import { MemoryProjectBrain } from '@orchestrate/brain';
import type { VerificationPlan, VerificationResult } from '@orchestrate/verification';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Orchestrator,
  type OrchestrateTaskInput,
  type TaskAgentRunner,
  type TaskContextCompiler,
  type TaskVerificationEngine,
} from '../src/orchestrator.js';
import type { AgentRunInput, AgentRunResult } from '../src/runner.js';

describe('Orchestrator', () => {
  let brain: MemoryProjectBrain;

  beforeEach(async () => {
    brain = new MemoryProjectBrain();
    await brain.createProject({ id: 'proj-1', name: 'Test Project' });
    await brain.createTask({
      id: 'task-1',
      projectId: 'proj-1',
      title: 'First task',
      description: 'Implement feature A',
    });
  });

  const createPassingVerificationResult = (): VerificationResult => ({
    status: 'VERIFIED',
    checks: [
      {
        checkId: 'check-1',
        name: 'Typecheck',
        command: 'npm run typecheck',
        args: [],
        passed: true,
        exitCode: 0,
        signal: null,
        stdout: 'Success',
        stderr: '',
        timedOut: false,
        durationMs: 100,
        verifiedAt: new Date().toISOString(),
      },
    ],
    executedAt: new Date().toISOString(),
    totalDurationMs: 100,
  });

  const createFailingVerificationResult = (): VerificationResult => ({
    status: 'FAILED',
    checks: [
      {
        checkId: 'check-1',
        name: 'Unit Tests',
        command: 'npm test',
        args: [],
        passed: false,
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'Assertion failed in feature A',
        timedOut: false,
        durationMs: 150,
        verifiedAt: new Date().toISOString(),
      },
    ],
    executedAt: new Date().toISOString(),
    totalDurationMs: 150,
  });

  const createFakeRunner = (
    responseText = 'I finished the task implementation.',
    model = 'mock-model'
  ): TaskAgentRunner => ({
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      return {
        response: {
          id: 'resp-1',
          model,
          message: {
            role: 'assistant',
            content: responseText,
          },
          finishReason: 'stop',
          usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        },
        messages: [{ role: 'user', content: input.task }],
        iterations: 1,
      };
    },
  });

  const createFakeVerificationEngine = (
    result: VerificationResult
  ): TaskVerificationEngine => ({
    async run(_plan: VerificationPlan): Promise<VerificationResult> {
      return result;
    },
  });

  const defaultPlan: VerificationPlan = {
    checks: [
      {
        id: 'c1',
        name: 'Build check',
        command: 'npm',
        args: ['run', 'build'],
      },
    ],
  };

  it('1. executes a successful VERIFIED lifecycle end-to-end', async () => {
    const runner = createFakeRunner();
    const verificationEngine = createFakeVerificationEngine(createPassingVerificationResult());

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine,
    });

    const result = await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });

    expect(result.taskId).toBe('task-1');
    expect(result.attemptNumber).toBe(1);
    expect(result.status).toBe('VERIFIED');
    expect(result.handoffId).toBeDefined();
    expect(result.verificationRecordId).toBeDefined();

    // Verify Brain persistence
    const handoff = await brain.getHandoff('task-1', 1);
    expect(handoff).not.toBeNull();
    expect(handoff?.status).toBe('CLAIMED');
    expect(handoff?.summary).toBe('I finished the task implementation.');

    const verRecord = await brain.getVerificationRecord('task-1', 1);
    expect(verRecord).not.toBeNull();
    expect(verRecord?.result.status).toBe('VERIFIED');
    expect(verRecord?.handoffId).toBe(handoff?.id);

    // Derived trust state in Brain is VERIFIED
    const trustState = await brain.deriveTaskTrustState('task-1');
    expect(trustState).toBe('VERIFIED');
  });

  it('2. executes a FAILED verification lifecycle preserving independent verification status', async () => {
    const runner = createFakeRunner('The agent claims the code is 100% working!');
    const verificationEngine = createFakeVerificationEngine(createFailingVerificationResult());

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine,
    });

    const result = await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });

    expect(result.taskId).toBe('task-1');
    expect(result.attemptNumber).toBe(1);
    expect(result.status).toBe('FAILED');

    // Handoff must remain CLAIMED despite verification failure
    const handoff = await brain.getHandoff('task-1', 1);
    expect(handoff?.status).toBe('CLAIMED');
    expect(handoff?.summary).toBe('The agent claims the code is 100% working!');

    // Verification record persists FAILED result
    const verRecord = await brain.getVerificationRecord('task-1', 1);
    expect(verRecord?.result.status).toBe('FAILED');

    // Derived trust state in Brain is FAILED
    const trustState = await brain.deriveTaskTrustState('task-1');
    expect(trustState).toBe('FAILED');
  });

  it('3. ensures handoff is persisted before verification record execution', async () => {
    const events: string[] = [];

    const runner: TaskAgentRunner = {
      async run() {
        events.push('runner.run');
        return createFakeRunner().run({ task: 'foo' });
      },
    };

    const verificationEngine: TaskVerificationEngine = {
      async run() {
        events.push('verificationEngine.run');
        // At the moment verification runs, the handoff must already exist in Brain!
        const handoff = await brain.getHandoff('task-1', 1);
        expect(handoff).not.toBeNull();
        events.push('handoff_verified_present_during_check');
        return createPassingVerificationResult();
      },
    };

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine,
    });

    await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });

    expect(events).toEqual([
      'runner.run',
      'verificationEngine.run',
      'handoff_verified_present_during_check',
    ]);
  });

  it('4. determines attempt number sequentially following Brain semantics', async () => {
    const runner = createFakeRunner();
    const verificationEngine = createFakeVerificationEngine(createPassingVerificationResult());

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine,
    });

    const run1 = await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });
    expect(run1.attemptNumber).toBe(1);

    const run2 = await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });
    expect(run2.attemptNumber).toBe(2);

    const run3 = await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });
    expect(run3.attemptNumber).toBe(3);

    const history = await brain.getTaskHistory('task-1');
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.attemptNumber)).toEqual([1, 2, 3]);
  });

  it('5. fails clearly when target project or task is missing or mismatched', async () => {
    const runner = createFakeRunner();
    const verificationEngine = createFakeVerificationEngine(createPassingVerificationResult());
    const orchestrator = new Orchestrator({ brain, runner, verificationEngine });

    // Missing project
    await expect(
      orchestrator.executeTask({
        projectId: 'missing-proj',
        taskId: 'task-1',
        verificationPlan: defaultPlan,
      })
    ).rejects.toThrow(/Project "missing-proj" not found/);

    // Missing task
    await expect(
      orchestrator.executeTask({
        projectId: 'proj-1',
        taskId: 'missing-task',
        verificationPlan: defaultPlan,
      })
    ).rejects.toThrow(/Task "missing-task" not found/);

    // Task belonging to different project
    await brain.createProject({ id: 'proj-2', name: 'Other' });
    await expect(
      orchestrator.executeTask({
        projectId: 'proj-2',
        taskId: 'task-1', // belongs to proj-1
        verificationPlan: defaultPlan,
      })
    ).rejects.toThrow(/does not belong to project "proj-2"/);

    // Missing upstream task
    await expect(
      orchestrator.executeTask({
        projectId: 'proj-1',
        taskId: 'task-1',
        upstreamTaskId: 'missing-upstream',
        verificationPlan: defaultPlan,
      })
    ).rejects.toThrow(/Upstream task "missing-upstream" not found/);
  });

  it('6. does not fabricate handoff or verification evidence when agent execution fails', async () => {
    const failingRunner: TaskAgentRunner = {
      async run() {
        throw new Error('Model provider network timeout');
      },
    };
    const verificationEngine = createFakeVerificationEngine(createPassingVerificationResult());

    const orchestrator = new Orchestrator({
      brain,
      runner: failingRunner,
      verificationEngine,
    });

    await expect(
      orchestrator.executeTask({
        projectId: 'proj-1',
        taskId: 'task-1',
        verificationPlan: defaultPlan,
      })
    ).rejects.toThrow('Model provider network timeout');

    // Confirm nothing was stored in Brain
    const history = await brain.getTaskHistory('task-1');
    expect(history).toHaveLength(0);
    const handoff = await brain.getHandoff('task-1', 1);
    expect(handoff).toBeNull();
    const ver = await brain.getVerificationRecord('task-1', 1);
    expect(ver).toBeNull();
  });

  it('7. propagates unexpected verification errors without swallowing or fabricating results', async () => {
    const runner = createFakeRunner();
    const crashingEngine: TaskVerificationEngine = {
      async run() {
        throw new Error('Verification runner process crashed unexpectedly');
      },
    };

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine: crashingEngine,
    });

    await expect(
      orchestrator.executeTask({
        projectId: 'proj-1',
        taskId: 'task-1',
        verificationPlan: defaultPlan,
      })
    ).rejects.toThrow('Verification runner process crashed unexpectedly');

    // Handoff was recorded
    const handoff = await brain.getHandoff('task-1', 1);
    expect(handoff).not.toBeNull();

    // But NO verification record was fabricated
    const ver = await brain.getVerificationRecord('task-1', 1);
    expect(ver).toBeNull();
  });

  it('8. returns exact IDs and structured results matching persisted entities', async () => {
    const structuredAgentJson = JSON.stringify({
      summary: 'Added user authentication service',
      changes: 'Implemented auth controller and middleware',
      filesAffected: ['src/auth.ts', 'src/middleware.ts'],
      assumptions: ['Database is active'],
      limitations: ['No OAuth2 yet'],
    });

    const runner = createFakeRunner(structuredAgentJson, 'nemotron-model');
    const verificationResult = createPassingVerificationResult();
    const verificationEngine = createFakeVerificationEngine(verificationResult);

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine,
    });

    const result = await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });

    expect(result.taskId).toBe('task-1');
    expect(result.attemptNumber).toBe(1);
    expect(result.status).toBe('VERIFIED');
    expect(result.handoffId).toBe(result.handoff.id);
    expect(result.verificationRecordId).toBeDefined();

    // Verify structured fields parsed into handoff
    expect(result.handoff.summary).toBe('Added user authentication service');
    expect(result.handoff.changes).toBe('Implemented auth controller and middleware');
    expect(result.handoff.filesAffected).toEqual(['src/auth.ts', 'src/middleware.ts']);
    expect(result.handoff.limitations).toEqual(['No OAuth2 yet']);
    expect(result.handoff.status).toBe('CLAIMED');

    // Verify verification result matching
    expect(result.verificationResult).toBe(verificationResult);

    // Verify exact IDs in Brain
    const fromBrain = await brain.getVerificationRecordById(result.verificationRecordId);
    expect(fromBrain).not.toBeNull();
    expect(fromBrain?.id).toBe(result.verificationRecordId);
    expect(fromBrain?.handoffId).toBe(result.handoffId);
  });

  it('notifies telemetrySink on task start and completion and propagates usage and durationMs', async () => {
    const startedSpans: any[] = [];
    const completedSpans: any[] = [];

    const telemetrySink = {
      async onTaskStart(span: any) {
        startedSpans.push(span);
      },
      async onTaskComplete(span: any) {
        completedSpans.push(span);
      },
    };

    const runner: TaskAgentRunner = {
      async run(): Promise<AgentRunResult> {
        return {
          response: {
            id: 'resp-1',
            model: 'test-model',
            finishReason: 'stop',
            message: {
              role: 'assistant',
              content: 'Task completed successfully',
            },
          },
          messages: [],
          iterations: 1,
          durationMs: 150,
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            total_tokens: 165,
            estimated_cost_usd: 0,
            usage_available: true,
          },
        };
      },
    };

    const verificationResult = createPassingVerificationResult();
    const verificationEngine: TaskVerificationEngine = {
      async verify(): Promise<VerificationResult> {
        return verificationResult;
      },
    };

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine,
      telemetrySink,
    });

    const result = await orchestrator.executeTask({
      projectId: 'proj-1',
      taskId: 'task-1',
      verificationPlan: defaultPlan,
    });

    expect(result.status).toBe('VERIFIED');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({
      input_tokens: 120,
      output_tokens: 45,
      total_tokens: 165,
      estimated_cost_usd: 0,
      usage_available: true,
    });

    expect(startedSpans).toHaveLength(1);
    expect(startedSpans[0].taskId).toBe('task-1');
    expect(startedSpans[0].projectId).toBe('proj-1');

    expect(completedSpans).toHaveLength(1);
    expect(completedSpans[0].taskId).toBe('task-1');
    expect(completedSpans[0].status).toBe('VERIFIED');
    expect(completedSpans[0].usage?.total_tokens).toBe(165);
    expect(completedSpans[0].handoffId).toBe(result.handoffId);
  });

  it('preserves partial usage and invokes task-scoped telemetrySink on runner failure', async () => {
    const startedSpans: any[] = [];
    const completedSpans: any[] = [];

    const rootSink = {
      forTask(context: { projectId: string; taskId: string; attemptNumber: number }) {
        return {
          async onTaskStart(span: any) {
            startedSpans.push({ ...span, context });
          },
          async onTaskComplete(span: any) {
            completedSpans.push({ ...span, context });
          },
        };
      },
    };

    const failingRunner: TaskAgentRunner = {
      async run(): Promise<AgentRunResult> {
        const error: any = new Error('Model rate limited on turn 3');
        error.usage = {
          input_tokens: 300,
          output_tokens: 80,
          total_tokens: 380,
          estimated_cost_usd: 0,
          usage_available: true,
        };
        throw error;
      },
    };

    const verificationEngine: TaskVerificationEngine = {
      async verify(): Promise<VerificationResult> {
        return createPassingVerificationResult();
      },
    };

    const orchestrator = new Orchestrator({
      brain,
      runner: failingRunner,
      verificationEngine,
      telemetrySink: rootSink as any,
    });

    await expect(
      orchestrator.executeTask({
        projectId: 'proj-1',
        taskId: 'task-1',
        verificationPlan: defaultPlan,
      })
    ).rejects.toThrow('Model rate limited on turn 3');

    expect(startedSpans).toHaveLength(1);
    expect(startedSpans[0].context.taskId).toBe('task-1');

    expect(completedSpans).toHaveLength(1);
    expect(completedSpans[0].taskId).toBe('task-1');
    expect(completedSpans[0].status).toBe('FAILED');
    expect(completedSpans[0].error).toContain('Model rate limited on turn 3');
    expect(completedSpans[0].usage).toEqual({
      input_tokens: 300,
      output_tokens: 80,
      total_tokens: 380,
      estimated_cost_usd: 0,
      usage_available: true,
    });
  });
});
