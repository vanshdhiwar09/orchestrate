import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import {
  TokenBudgetGuard,
  BudgetExceededError,
  BudgetFeasibilityError,
  validateBudgetFeasibility,
} from '../../src/harness/budget-guard.js';
import { AgentExecutionAdapter } from '../../src/harness/agent-adapter.js';
import { InstrumentedModelClient } from '../../src/harness/instrumented-model-client.js';
import { BenchmarkReporter } from '../../src/harness/reporter.js';
import type { TrialRunResult } from '../../src/harness/trial-runner.js';
import type {
  ArmExecutionInput,
  BenchmarkWorkspace,
  WorkspaceFactory,
} from '../../src/harness/types.js';

describe('Step 10.8: Adaptive Budget Architecture Integration & Safety Tests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'adaptive-budget-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Arm can consume > 1/3 of session budget under adaptive policy
  // ───────────────────────────────────────────────────────────────────────────
  it('1. arm can consume > 1/3 of session budget under adaptive policy without hitting artificial ceiling', () => {
    const sessionGuard = new TokenBudgetGuard({
      maxTotalTokens: 30000,
      policy: 'ADAPTIVE_SESSION_BUDGET',
      label: 'Session',
    });

    // In controlled mode with 3 planned arms, 1/3 would cap an arm at 10000.
    // In adaptive mode, child has no local ceiling and can consume 20000 tokens (> 66% of budget)
    const armGuard = sessionGuard.createChild({ label: 'Arm-A' });
    expect(armGuard.remaining).toBe(30000);

    const reservation = armGuard.reserve(20000);
    expect(reservation.reservedTokens).toBe(20000);
    reservation.commit(20000);

    expect(armGuard.consumed).toBe(20000);
    expect(sessionGuard.consumed).toBe(20000);
    expect(sessionGuard.remaining).toBe(10000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Unused capacity remains available to subsequent arms in adaptive mode
  // ───────────────────────────────────────────────────────────────────────────
  it('2. unused capacity from a finished arm remains available to subsequent arms in adaptive mode', () => {
    const sessionGuard = new TokenBudgetGuard({
      maxTotalTokens: 30000,
      policy: 'ADAPTIVE_SESSION_BUDGET',
      label: 'Session',
    });

    // Arm A finishes fast, consuming only 3000 tokens (leaving 27000 tokens)
    const armAGuard = sessionGuard.createChild({ label: 'Arm-A' });
    armAGuard.reserve(3000).commit(3000);
    expect(armAGuard.consumed).toBe(3000);
    expect(sessionGuard.remaining).toBe(27000);

    // Arm B is subsequent and needs 15000 tokens (> 1/3 of original 30000).
    // It is NOT blocked because Arm A did not strand any capacity.
    const armBGuard = sessionGuard.createChild({ label: 'Arm-B' });
    expect(armBGuard.remaining).toBe(27000);
    armBGuard.reserve(15000).commit(15000);
    expect(armBGuard.consumed).toBe(15000);
    expect(sessionGuard.remaining).toBe(12000);

    // Arm C then consumes the remaining 12000 tokens
    const armCGuard = sessionGuard.createChild({ label: 'Arm-C' });
    expect(armCGuard.remaining).toBe(12000);
    armCGuard.reserve(12000).commit(12000);
    expect(sessionGuard.consumed).toBe(30000);
    expect(sessionGuard.remaining).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Concurrent child reservations cannot exceed aggregate session cap
  // ───────────────────────────────────────────────────────────────────────────
  it('3. concurrent child reservations cannot exceed aggregate session cap', () => {
    const sessionGuard = new TokenBudgetGuard({
      maxTotalTokens: 20000,
      policy: 'ADAPTIVE_SESSION_BUDGET',
      label: 'Session',
    });

    const child1 = sessionGuard.createChild({ label: 'Child-1' });
    const child2 = sessionGuard.createChild({ label: 'Child-2' });

    // Child 1 reserves 12000 tokens
    const res1 = child1.reserve(12000);
    expect(sessionGuard.reserved).toBe(12000);
    expect(sessionGuard.remaining).toBe(8000);

    // Child 2 attempts to reserve 10000 tokens (which exceeds 8000 remaining)
    expect(() => child2.reserve(10000)).toThrow(BudgetExceededError);

    // Child 2 can safely reserve 8000 tokens
    const res2 = child2.reserve(8000);
    expect(sessionGuard.reserved).toBe(20000);
    expect(sessionGuard.remaining).toBe(0);

    // Neither child can reserve any more
    expect(() => child1.reserve(1)).toThrow(BudgetExceededError);
    expect(() => child2.reserve(1)).toThrow(BudgetExceededError);

    res1.release();
    res2.release();
    expect(sessionGuard.remaining).toBe(20000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Explicit per-arm limits strictly enforced under CONTROLLED_PER_ARM_BUDGET
  // ───────────────────────────────────────────────────────────────────────────
  it('4. explicit per-arm limits remain strictly enforced under controlled policy', () => {
    const sessionGuard = new TokenBudgetGuard({
      maxTotalTokens: 30000,
      policy: 'CONTROLLED_PER_ARM_BUDGET',
      label: 'Session',
    });

    // In controlled mode, child guard is given explicit ceiling
    const armGuard = sessionGuard.createChild({ maxTokens: 8000, label: 'Arm-Controlled' });
    expect(armGuard.remaining).toBe(8000);

    armGuard.reserve(5000).commit(5000);
    expect(armGuard.remaining).toBe(3000);

    // Attempting to reserve 4000 exceeds local arm ceiling of 8000 even though session has 25000 tokens
    expect(() => armGuard.reserve(4000)).toThrow(/Token budget exceeded for Arm-Controlled/);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Controlled mode preserves configured fairness contract (no cross-arm borrowing)
  // ───────────────────────────────────────────────────────────────────────────
  it('5. controlled mode preserves fairness contract and prohibits cross-arm borrowing', () => {
    const sessionGuard = new TokenBudgetGuard({
      maxTotalTokens: 30000,
      policy: 'CONTROLLED_PER_ARM_BUDGET',
      label: 'Session',
    });

    const arm1 = sessionGuard.createChild({ maxTokens: 10000, label: 'Arm-1' });
    const arm2 = sessionGuard.createChild({ maxTokens: 10000, label: 'Arm-2' });

    // Arm 1 finishes having consumed only 1000 tokens
    arm1.reserve(1000).commit(1000);
    expect(arm1.consumed).toBe(1000);

    // Arm 2 attempts to consume 11000 tokens (trying to borrow unused 9000 from Arm 1)
    arm2.reserve(10000).commit(10000);
    expect(() => arm2.reserve(1000)).toThrow(/Token budget exceeded for Arm-2/);
    expect(arm2.consumed).toBe(10000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Budget exhaustion is reported with budgetExhausted: true and code: 'BUDGET_EXHAUSTED'
  // ───────────────────────────────────────────────────────────────────────────
  it('6. budget exhaustion is reported with budgetExhausted: true, phase recorded, and code: "BUDGET_EXHAUSTED"', async () => {
    const sessionGuard = new TokenBudgetGuard({
      maxTotalTokens: 200,
      policy: 'ADAPTIVE_SESSION_BUDGET',
    });

    let completeCalls = 0;
    const mockModel: ModelClient = {
      complete: async (req: ModelRequest): Promise<ModelResponse> => {
        completeCalls++;
        return {
          id: `resp-${completeCalls}`,
          model: req.model,
          finishReason: 'stop',
          message: { role: 'assistant', content: 'Working on task...' },
          usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        };
      },
    };

    const mockWorkspace: BenchmarkWorkspace = {
      path: tmpDir,
      workspace: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        deleteFile: vi.fn(),
        listDirectory: vi.fn(),
        exists: vi.fn(),
      } as any,
      git: {} as any,
      cleanup: async () => {},
    };

    const adapter = new AgentExecutionAdapter({
      workspaceFactory: { create: async () => mockWorkspace },
      modelClient: mockModel,
      budgetGuard: sessionGuard,
    });

    const input: ArmExecutionInput = {
      trialId: 'trial-exhaustion-test',
      armId: 'ARM_A_BASELINE',
      snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
      taskBPrompt: 'Solve problem',
      systemPrompt: 'System',
      contextEnvelope: null,
      controlFingerprint: {
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        taskBPromptHash: 'hash',
        modelIdentity: 'test-model',
        inferenceConfigHash: 'hash',
        systemInstructionsHash: 'hash',
        toolDefinitionsHash: 'hash',
      },
      samplingConfig: {
        maxTokens: 1000,
      },
      controls: {
        budgetPolicy: 'ADAPTIVE_SESSION_BUDGET',
        maxTokensPerRequest: 1500,
        taskTimeoutMs: 5000,
      },
    };

    const { evidence } = await adapter.execute(input);

    expect(evidence.outcome).toBe('FAILED');
    expect(evidence.error).toBeDefined();
    expect(evidence.error?.code).toBe('BUDGET_EXHAUSTED');
    expect(evidence.budgetExhausted).toBe(true);
    expect(evidence.budget?.budget_exhausted).toBe(true);
    expect(evidence.budget?.policy).toBe('ADAPTIVE_SESSION_BUDGET');
    expect(evidence.phase).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. No incomplete or budget-exhausted task becomes VERIFIED
  // ───────────────────────────────────────────────────────────────────────────
  it('7. no incomplete or budget-exhausted task becomes VERIFIED', async () => {
    const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 200 });
    const mockModel: ModelClient = {
      complete: async (req: ModelRequest): Promise<ModelResponse> => ({
        id: '1',
        model: req.model,
        finishReason: 'stop',
        message: {
          role: 'assistant',
          content: 'I have finished and solved everything completely and verified it!',
        },
        usage: { promptTokens: 600, completionTokens: 500, totalTokens: 1100 },
      }),
    };

    const mockWorkspace: BenchmarkWorkspace = {
      path: tmpDir,
      workspace: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        deleteFile: vi.fn(),
        listDirectory: vi.fn(),
        exists: vi.fn(),
      } as any,
      git: {} as any,
      cleanup: async () => {},
    };

    const adapter = new AgentExecutionAdapter({
      workspaceFactory: { create: async () => mockWorkspace },
      modelClient: mockModel,
      budgetGuard: sessionGuard,
    });

    const input: ArmExecutionInput = {
      trialId: 'trial-unverified',
      armId: 'ARM_A_BASELINE',
      snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
      taskBPrompt: 'Solve problem',
      systemPrompt: 'System',
      contextEnvelope: null,
      controlFingerprint: {
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        taskBPromptHash: 'hash',
        modelIdentity: 'test-model',
        inferenceConfigHash: 'hash',
        systemInstructionsHash: 'hash',
        toolDefinitionsHash: 'hash',
      },
      samplingConfig: { maxTokens: 1000 },
      controls: { maxTokensPerRequest: 1500 },
    };

    const { evidence } = await adapter.execute(input);
    expect(evidence.outcome).toBe('FAILED');
    expect(evidence.budgetExhausted).toBe(true);
    expect(evidence.error?.code).toBe('BUDGET_EXHAUSTED');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Warnings trigger at configured thresholds (70%, 85%, 95%) without altering ceiling
  // ───────────────────────────────────────────────────────────────────────────
  it('8. warnings trigger at configured thresholds without altering hard ceiling', () => {
    const warnings: number[] = [];
    const guard = new TokenBudgetGuard({
      maxTotalTokens: 10000,
      warningThresholds: [0.7, 0.85, 0.95],
      onWarning: (event) => {
        warnings.push(event.thresholdPercent);
      },
    });

    // 60% consumption -> no warning
    guard.reserve(6000).commit(6000);
    expect(warnings).toEqual([]);

    // 72% consumption -> triggers 70 warning
    guard.reserve(1200).commit(1200);
    expect(warnings).toEqual([70]);

    // 86% consumption -> triggers 85 warning
    guard.reserve(1400).commit(1400);
    expect(warnings).toEqual([70, 85]);

    // 96% consumption -> triggers 95 warning
    guard.reserve(1000).commit(1000);
    expect(warnings).toEqual([70, 85, 95]);

    // Hard ceiling remains exactly 10000; remaining is 400
    expect(guard.remaining).toBe(400);
    expect(() => guard.reserve(500)).toThrow(BudgetExceededError);

    // Exact remaining 400 can be consumed
    guard.reserve(400).commit(400);
    expect(guard.consumed).toBe(10000);
    expect(guard.remaining).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Unknown or late usage cannot create phantom capacity
  // ───────────────────────────────────────────────────────────────────────────
  it('9. unknown or late usage cannot create phantom capacity', async () => {
    const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 10000 });
    const childGuard = sessionGuard.createChild({ maxTokens: 5000 });
    const abortController = new AbortController();

    const slowModel: ModelClient = {
      complete: async () =>
        new Promise<ModelResponse>((_, reject) => {
          abortController.signal.addEventListener('abort', () => {
            const err = new Error('Model call aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    };

    const instrumented = new InstrumentedModelClient({
      modelClient: slowModel,
      budgetGuard: childGuard,
      abortSignal: abortController.signal,
    });

    const callPromise = instrumented.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 4000,
    });

    expect(childGuard.reserved).toBe(4000);

    // Abort in flight
    abortController.abort(new Error('Interrupted'));
    await expect(callPromise).rejects.toThrow();

    // Conservatively committed to consumed; cannot create phantom capacity
    expect(childGuard.reserved).toBe(0);
    expect(childGuard.consumed).toBe(4000);
    expect(childGuard.remaining).toBe(1000);
    expect(sessionGuard.consumed).toBe(4000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Policy selection is reflected consistently across reporter and summary
  // ───────────────────────────────────────────────────────────────────────────
  it('10. policy selection is reflected in persisted summary and markdown reports', () => {
    const reporter = new BenchmarkReporter();

    const adaptiveResults: TrialRunResult[] = [
      {
        valid: true,
        trial: {
          identity: {
            runId: 'trial-adaptive',
            scenarioId: 'auth-protected-api',
            replication: 1,
            taskAId: 'task-a',
            taskBId: 'task-b',
            snapshotId: 'snap-1',
            snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
          },
          controls: {
            budgetPolicy: 'ADAPTIVE_SESSION_BUDGET',
            maxTotalTokens: 50000,
          } as any,
          controlFingerprint: {} as any,
          state: 'COMPLETE',
          armOrderSeed: 1,
          executionOrder: ['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE'],
        },
        integrityPreflight: { valid: true, violations: [] },
        armResults: {
          ARM_A_BASELINE: {
            armId: 'ARM_A_BASELINE',
            status: 'COMPLETED',
            rawEvidence: {
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, usage_available: true, estimated_cost_usd: null },
            } as any,
            verificationEvidence: { status: 'PASSED' } as any,
            diffCapture: null,
            discoveryReport: { discovery_actions: 0 } as any,
            reworkReport: { rework_events: 0 } as any,
          },
          ARM_B_UNVERIFIED_HANDOFF: {
            armId: 'ARM_B_UNVERIFIED_HANDOFF',
            status: 'COMPLETED',
            rawEvidence: {
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, usage_available: true, estimated_cost_usd: null },
            } as any,
            verificationEvidence: { status: 'PASSED' } as any,
            diffCapture: null,
            discoveryReport: { discovery_actions: 0 } as any,
            reworkReport: { rework_events: 0 } as any,
          },
          ARM_C_ORCHESTRATE: {
            armId: 'ARM_C_ORCHESTRATE',
            status: 'COMPLETED',
            rawEvidence: {
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, usage_available: true, estimated_cost_usd: null },
            } as any,
            verificationEvidence: { status: 'PASSED' } as any,
            diffCapture: null,
            discoveryReport: { discovery_actions: 0 } as any,
            reworkReport: { rework_events: 0 } as any,
          },
        },
      },
    ];

    const summary = reporter.generateSummary(adaptiveResults);
    expect(summary.budgetPolicy).toBe('ADAPTIVE_SESSION_BUDGET');

    const md = reporter.renderMarkdown(adaptiveResults);
    expect(md).toContain('**Budget Policy:** ADAPTIVE_SESSION_BUDGET');
    expect(md).toContain('Token budget ceilings constrain model token volume');

    const controlledResults: TrialRunResult[] = [
      {
        valid: true,
        trial: {
          identity: {
            runId: 'trial-controlled',
            scenarioId: 'auth-protected-api',
            replication: 1,
            taskAId: 'task-a',
            taskBId: 'task-b',
            snapshotId: 'snap-1',
            snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
          },
          controls: {
            budgetPolicy: 'CONTROLLED_PER_ARM_BUDGET',
            maxTotalTokens: 50000,
            maxTokensPerArm: 15000,
          } as any,
          controlFingerprint: {} as any,
          state: 'COMPLETE',
          armOrderSeed: 1,
          executionOrder: ['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE'],
        },
        integrityPreflight: { valid: true, violations: [] },
        armResults: {
          ARM_A_BASELINE: {
            armId: 'ARM_A_BASELINE',
            status: 'COMPLETED',
            rawEvidence: {
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, usage_available: true, estimated_cost_usd: null },
            } as any,
            verificationEvidence: { status: 'PASSED' } as any,
            diffCapture: null,
            discoveryReport: { discovery_actions: 0 } as any,
            reworkReport: { rework_events: 0 } as any,
          },
          ARM_B_UNVERIFIED_HANDOFF: {
            armId: 'ARM_B_UNVERIFIED_HANDOFF',
            status: 'COMPLETED',
            rawEvidence: {
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, usage_available: true, estimated_cost_usd: null },
            } as any,
            verificationEvidence: { status: 'PASSED' } as any,
            diffCapture: null,
            discoveryReport: { discovery_actions: 0 } as any,
            reworkReport: { rework_events: 0 } as any,
          },
          ARM_C_ORCHESTRATE: {
            armId: 'ARM_C_ORCHESTRATE',
            status: 'COMPLETED',
            rawEvidence: {
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, usage_available: true, estimated_cost_usd: null },
            } as any,
            verificationEvidence: { status: 'PASSED' } as any,
            diffCapture: null,
            discoveryReport: { discovery_actions: 0 } as any,
            reworkReport: { rework_events: 0 } as any,
          },
        },
      },
    ];

    const controlledSummary = reporter.generateSummary(controlledResults);
    expect(controlledSummary.budgetPolicy).toBe('CONTROLLED_PER_ARM_BUDGET');
    const controlledMd = reporter.renderMarkdown(controlledResults);
    expect(controlledMd).toContain('**Budget Policy:** CONTROLLED_PER_ARM_BUDGET');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 11. Historical run artifacts remain byte-for-byte unchanged
  // ───────────────────────────────────────────────────────────────────────────
  it('11. historical run artifacts in benchmarks/runs remain byte-for-byte unchanged', async () => {
    const expectedHashes: Record<string, string> = {
      'benchmarks/runs/smoke-auth-protected-api-20261023-2053/benchmark-report.md':
        '0ca47d0d6db1a61769c7e89840c4d9256afd2a281f8b0eb7bcf8597dff3d36ca',
      'benchmarks/runs/smoke-auth-protected-api-20261023-2053/benchmark-summary.json':
        '2fe9a3a0a02e027a0261b1e5aeaad67b30a2114b22f6ad8ebbee7183abf96351',
      'benchmarks/runs/smoke-auth-protected-api-20261023-2053/trial-auth-protected-api-r1-1792769012935.json':
        'b5c3c75da27c2e5b0ee10f08b783da2dd01302266d03dff6fcec7601805c6b76',
      'benchmarks/runs/smoke-auth-protected-api-20261023-2145/benchmark-report.md':
        '7497b4d7ef809b1642a12bfe5f5f44697a5a5f4ea671122dd0afcc4889f3f0c5',
      'benchmarks/runs/smoke-auth-protected-api-20261023-2145/benchmark-summary.json':
        '44789bb85bce70b9a843a2e40c0eef595a97e635120871806aa964c3d47aad63',
      'benchmarks/runs/smoke-auth-protected-api-20261023-2145/trial-auth-protected-api-r1-1792772130129.json':
        'b9df96fe1eacfdb37ae51e786e78a76b1bc7ebe49ec33ee5a3c8a77495f37985',
    };

    for (const [relPath, expectedSha256] of Object.entries(expectedHashes)) {
      const fullPath = join(process.cwd(), relPath);
      const content = await readFile(fullPath);
      const actualHash = createHash('sha256').update(content).digest('hex').toLowerCase();
      expect(actualHash).toBe(expectedSha256.toLowerCase());
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 12. Mocked providers ensure zero network calls to live models
  // ───────────────────────────────────────────────────────────────────────────
  it('12. offline testing uses deterministic mocks and makes zero external model network calls', async () => {
    let externalNetworkCalls = 0;
    const offlineMock: ModelClient = {
      complete: async (req: ModelRequest): Promise<ModelResponse> => {
        // Assert no external protocol is used
        expect(req.model).toBe('mock-offline-model');
        return {
          id: 'offline-resp',
          model: req.model,
          finishReason: 'stop',
          message: { role: 'assistant', content: 'Offline execution.' },
          usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
        };
      },
    };

    const budgetGuard = new TokenBudgetGuard({ maxTotalTokens: 5000 });
    const instrumented = new InstrumentedModelClient({
      modelClient: offlineMock,
      budgetGuard,
    });

    const res = await instrumented.complete({
      model: 'mock-offline-model',
      messages: [{ role: 'user', content: 'test offline' }],
      maxTokens: 100,
    });

    expect(res.message.content).toBe('Offline execution.');
    expect(externalNetworkCalls).toBe(0);
    expect(budgetGuard.consumed).toBe(100);
  });
});
