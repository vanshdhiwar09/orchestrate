import { describe, it, expect, vi } from 'vitest';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import { NebiusModelClient } from '@orchestrate/model';
import {
  TokenBudgetGuard,
  BudgetExceededError,
} from '../../src/harness/budget-guard.js';
import { InstrumentedModelClient } from '../../src/harness/instrumented-model-client.js';
import { AgentExecutionAdapter } from '../../src/harness/agent-adapter.js';
import type { ArmExecutionInput, BenchmarkWorkspace } from '../../src/harness/types.js';

describe('Step 10.21: Final Adversarial Budget Safety Audit', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. Outbound Provider Limit Verification (Nebius & Adapters)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Outbound Provider Limit Verification', () => {
    it('verifies NebiusModelClient receives exactly the clamped max_tokens in its HTTP request payload', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const fakeFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'fake-nebius-resp',
            model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
            choices: [
              {
                message: { role: 'assistant', content: 'export function validateProfile() {}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 500, completion_tokens: 150, total_tokens: 650 },
          }),
        };
      });

      const nebiusClient = new NebiusModelClient({
        apiKey: 'fake-api-key-audit-10-21',
        fetchFn: fakeFetch as unknown as typeof fetch,
      });

      // Budget guard with 10000 total, 8200 already consumed -> 1800 remaining
      const guard = new TokenBudgetGuard({ maxTotalTokens: 10000 });
      guard.reserve(8200).commit(8200);
      expect(guard.remaining).toBe(1800);

      const instrumented = new InstrumentedModelClient({
        modelClient: nebiusClient,
        budgetGuard: guard,
      });

      // Request asks for 4096 tokens (exceeds remaining 1800)
      const response = await instrumented.complete({
        model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        messages: [{ role: 'user', content: 'Generate code' }],
        maxTokens: 4096,
      });

      expect(response.message.content).toBe('export function validateProfile() {}');

      // CRITICAL CHECK: The actual body sent to Nebius HTTP endpoint has max_tokens clamped to 1790 (accounting for estimated prompt tokens)!
      expect(capturedBody).not.toBeNull();
      expect(capturedBody?.max_tokens).toBe(1790);

      // Telemetry records both effective and original requested tokens
      const events = instrumented.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].request.maxTokens).toBe(1790);
      expect(events[0].request.requestedMaxTokens).toBe(4096);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Minimum Completion Floor Invariants
  // ───────────────────────────────────────────────────────────────────────────
  describe('Minimum Completion Floor Invariants', () => {
    it('floor does not override smaller remaining budget: remaining 100 < floor 256 fails fast', () => {
      const guard = new TokenBudgetGuard({
        maxTotalTokens: 5000,
        minUsefulTokens: 256,
      });
      guard.reserve(4900).commit(4900);
      expect(guard.remaining).toBe(100);

      // Remaining is 100. It must NOT grant 256 or 100; it must fail fast with BudgetExceededError.
      expect(() => guard.reserveAdaptive(4096)).toThrow(BudgetExceededError);
      expect(guard.reserved).toBe(0);
      expect(guard.consumed).toBe(4900);
    });

    it('remaining capacity of exactly 0 throws BudgetExceededError immediately', () => {
      const guard = new TokenBudgetGuard({ maxTotalTokens: 1000 });
      guard.reserve(1000).commit(1000);
      expect(guard.remaining).toBe(0);

      expect(() => guard.reserveAdaptive(100)).toThrow(BudgetExceededError);
      expect(guard.remaining).toBe(0);
    });

    it('remaining capacity exactly equal to floor 256 succeeds with effectiveTokens: 256', () => {
      const guard = new TokenBudgetGuard({
        maxTotalTokens: 1000,
        minUsefulTokens: 256,
      });
      guard.reserve(744).commit(744);
      expect(guard.remaining).toBe(256);

      const result = guard.reserveAdaptive(1024);
      expect(result.clamped).toBe(true);
      expect(result.effectiveTokens).toBe(256);
      expect(guard.reserved).toBe(256);
      expect(guard.remaining).toBe(0);

      result.reservation.commit(200);
      expect(guard.consumed).toBe(744 + 200);
      expect(guard.remaining).toBe(56);
    });

    it('remaining capacity 1 token below floor (255) throws BudgetExceededError', () => {
      const guard = new TokenBudgetGuard({
        maxTotalTokens: 1000,
        minUsefulTokens: 256,
      });
      guard.reserve(745).commit(745);
      expect(guard.remaining).toBe(255);

      expect(() => guard.reserveAdaptive(1024)).toThrow(BudgetExceededError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Accounting & Settling Correctness (Malformed Data, Concurrency, Late Resps)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Accounting & Reconciliation Robustness', () => {
    it('normalizes malformed or NaN provider usage to non-negative numbers without leaking budget', async () => {
      const malformedUsageClient: ModelClient = {
        complete: async () => ({
          id: 'malformed-resp',
          model: 'test-model',
          finishReason: 'stop',
          message: { role: 'assistant', content: 'done' },
          usage: {
            promptTokens: NaN,
            completionTokens: -50,
            totalTokens: -100,
          } as unknown as { promptTokens: number; completionTokens: number; totalTokens: number },
        }),
      };

      const guard = new TokenBudgetGuard({ maxTotalTokens: 5000 });
      const instrumented = new InstrumentedModelClient({
        modelClient: malformedUsageClient,
        budgetGuard: guard,
      });

      await instrumented.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 1000,
      });

      // Malformed negative/NaN usage safely committed as 0, active reservation cleared
      expect(guard.reserved).toBe(0);
      expect(guard.consumed).toBe(0);
      expect(guard.remaining).toBe(5000);
    });

    it('conservatively commits reservation when provider returns no usage object', async () => {
      const noUsageClient: ModelClient = {
        complete: async () => ({
          id: 'no-usage-resp',
          model: 'test-model',
          finishReason: 'stop',
          message: { role: 'assistant', content: 'done' },
        }),
      };

      const guard = new TokenBudgetGuard({ maxTotalTokens: 5000 });
      const instrumented = new InstrumentedModelClient({
        modelClient: noUsageClient,
        budgetGuard: guard,
      });

      await instrumented.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 1500,
      });

      // Reserved 1500; with usage missing, conservatively commits all 1500
      expect(guard.reserved).toBe(0);
      expect(guard.consumed).toBe(1500);
      expect(guard.remaining).toBe(3500);
    });

    it('prevents multiple calls to finalize() from double-committing in-flight reservations', async () => {
      let resolveInFlight!: (res: ModelResponse) => void;
      const slowClient: ModelClient = {
        complete: async () =>
          new Promise<ModelResponse>((resolve) => {
            resolveInFlight = resolve;
          }),
      };

      const guard = new TokenBudgetGuard({ maxTotalTokens: 5000 });
      const instrumented = new InstrumentedModelClient({
        modelClient: slowClient,
        budgetGuard: guard,
      });

      const callPromise = instrumented.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 2000,
      });

      expect(guard.reserved).toBe(2000);

      // Finalize called multiple times (e.g. timeout handler and adapter teardown)
      instrumented.finalize();
      instrumented.finalize();
      instrumented.finalize();

      expect(guard.reserved).toBe(0);
      expect(guard.consumed).toBe(2000); // Committed once, NOT 6000!

      // Late response arrives afterwards
      resolveInFlight({
        id: 'late',
        model: 'test-model',
        finishReason: 'stop',
        message: { role: 'assistant', content: 'late output' },
        usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      });

      await expect(callPromise).rejects.toThrow(/arrived after task finalization/);

      // Late response did NOT mutate the committed usage
      expect(guard.consumed).toBe(2000);
      expect(guard.reserved).toBe(0);
    });

    it('blocks any new complete() call initiated after client finalization', async () => {
      const guard = new TokenBudgetGuard({ maxTotalTokens: 5000 });
      const instrumented = new InstrumentedModelClient({
        modelClient: {
          complete: async () => ({
            id: 'resp',
            model: 'test',
            finishReason: 'stop',
            message: { role: 'assistant', content: 'hi' },
          }),
        },
        budgetGuard: guard,
      });

      instrumented.finalize();

      await expect(
        instrumented.complete({
          model: 'test',
          messages: [{ role: 'user', content: 'start' }],
          maxTokens: 500,
        })
      ).rejects.toThrow(/Model completion aborted or finalized/);

      // Never contacted budget guard
      expect(guard.reserved).toBe(0);
      expect(guard.consumed).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Controlled vs Adaptive Policy Compatibility & Isolation
  // ───────────────────────────────────────────────────────────────────────────
  describe('Controlled vs Adaptive Policy Compatibility', () => {
    it('strictly enforces per-arm isolation under CONTROLLED_PER_ARM_BUDGET: Arm B cannot borrow Arm A unused allocation', () => {
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 30000,
        policy: 'CONTROLLED_PER_ARM_BUDGET',
        label: 'Session',
      });

      const armA = sessionGuard.createChild({ maxTokens: 10000, label: 'Arm-A' });
      const armB = sessionGuard.createChild({ maxTokens: 10000, label: 'Arm-B' });

      // Arm A runs and uses only 2000 tokens (8000 tokens left unspent in Arm A)
      armA.reserve(2000).commit(2000);
      expect(armA.consumed).toBe(2000);
      expect(armA.remaining).toBe(8000);
      expect(sessionGuard.consumed).toBe(2000);
      expect(sessionGuard.remaining).toBe(28000);

      // Arm B consumes its full 10000 allocation across multiple turns
      armB.reserve(5000).commit(5000);
      armB.reserve(4000).commit(4000);
      expect(armB.consumed).toBe(9000);
      expect(armB.remaining).toBe(1000);

      // Arm B asks for 4096 tokens -> clamped to Arm B's own remaining (1000), NOT session remaining (21000)
      const res = armB.reserveAdaptive(4096);
      expect(res.clamped).toBe(true);
      expect(res.effectiveTokens).toBe(1000); // Strictly isolated!
      res.reservation.commit(1000);

      expect(armB.consumed).toBe(10000);
      expect(armB.remaining).toBe(0);

      // Arm B tries another call -> rejected, cannot borrow any of Arm A's 8000 unused tokens
      expect(() => armB.reserveAdaptive(500)).toThrow(BudgetExceededError);
    });

    it('preserves shared capacity pool under ADAPTIVE_SESSION_BUDGET: Arm B can use unspent pool capacity', () => {
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 30000,
        policy: 'ADAPTIVE_SESSION_BUDGET',
        label: 'Session',
      });

      const armA = sessionGuard.createChild({ label: 'Arm-A' });
      const armB = sessionGuard.createChild({ label: 'Arm-B' });

      // Arm A uses 2000 tokens
      armA.reserve(2000).commit(2000);

      // Arm B can consume 18000 tokens (> 10000 1/3 share) because policy is adaptive
      const res = armB.reserveAdaptive(18000);
      expect(res.clamped).toBe(false);
      expect(res.effectiveTokens).toBe(18000);
      res.reservation.commit(18000);

      expect(sessionGuard.consumed).toBe(20000);
      expect(sessionGuard.remaining).toBe(10000);
    });

    it('neither controlled nor adaptive policy can ever breach the aggregate session ceiling', () => {
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 15000,
        policy: 'ADAPTIVE_SESSION_BUDGET',
        label: 'Session',
      });

      const armA = sessionGuard.createChild({ label: 'Arm-A' });
      armA.reserve(14800).commit(14800);
      expect(sessionGuard.remaining).toBe(200);

      const armB = sessionGuard.createChild({ label: 'Arm-B' });
      // 200 tokens remaining is below 256 minimum floor -> throws BudgetExceededError
      expect(() => armB.reserveAdaptive(1000)).toThrow(BudgetExceededError);

      expect(sessionGuard.consumed).toBe(14800);
      expect(sessionGuard.consumed).toBeLessThanOrEqual(15000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Runner Status & Verification Independence On Stopped Tasks
  // ───────────────────────────────────────────────────────────────────────────
  describe('Runner Status & Verification Independence', () => {
    it('agent stopped due to budget exhaustion produces outcome: FAILED and cannot be marked VERIFIED without deliverable', async () => {
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 200, // below 256 floor -> immediate exhaustion
      });

      const mockModel: ModelClient = {
        complete: async () => ({
          id: 'fake',
          model: 'test',
          finishReason: 'stop',
          message: { role: 'assistant', content: 'Claiming success prematurely!' },
        }),
      };

      const mockWorkspace: BenchmarkWorkspace = {
        path: '/mock/path',
        workspace: {
          readFile: vi.fn(),
          writeFile: vi.fn(),
          deleteFile: vi.fn(),
          listDirectory: vi.fn(),
          exists: vi.fn().mockResolvedValue(false), // deliverable file DOES NOT exist
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
        trialId: 'trial-audit-failure',
        armId: 'ARM_A_BASELINE',
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        taskBPrompt: 'Create src/validate-profile.ts',
        systemPrompt: 'System',
        contextEnvelope: null,
        controlFingerprint: {
          snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
          taskBPromptHash: 'h',
          modelIdentity: 'test',
          inferenceConfigHash: 'h',
          systemInstructionsHash: 'h',
          toolDefinitionsHash: 'h',
        },
        samplingConfig: { maxTokens: 4096 },
      };

      const { evidence } = await adapter.execute(input);

      // Outcome MUST be FAILED
      expect(evidence.outcome).toBe('FAILED');
      expect(evidence.budgetExhausted).toBe(true);
      expect(evidence.error?.code).toBe('BUDGET_EXHAUSTED');
      expect(evidence.error?.message).toContain('below minimum useful threshold');

      // The provider was NEVER called
      expect(evidence.modelEvents).toHaveLength(0);
    });
  });
});
