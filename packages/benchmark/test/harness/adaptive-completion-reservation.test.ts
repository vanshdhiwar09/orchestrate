import { describe, it, expect } from 'vitest';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import {
  TokenBudgetGuard,
  BudgetExceededError,
} from '../../src/harness/budget-guard.js';
import { InstrumentedModelClient } from '../../src/harness/instrumented-model-client.js';

describe('Step 10.20: Adaptive Completion Reservations & Budget Guard Repair', () => {
  describe('TokenBudgetGuard.reserveAdaptive()', () => {
    it('preserves requested tokens when remaining budget is fully sufficient', () => {
      const guard = new TokenBudgetGuard({ maxTotalTokens: 10000 });
      const result = guard.reserveAdaptive(4096);

      expect(result.clamped).toBe(false);
      expect(result.effectiveTokens).toBe(4096);
      expect(result.requestedTokens).toBe(4096);
      expect(guard.reserved).toBe(4096);
      expect(guard.remaining).toBe(10000 - 4096);

      result.reservation.commit(1500);
      expect(guard.consumed).toBe(1500);
      expect(guard.reserved).toBe(0);
      expect(guard.remaining).toBe(8500);
    });

    it('adaptively clamps requested reservation when remaining headroom is less than requested but >= minUsefulTokens', () => {
      const guard = new TokenBudgetGuard({ maxTotalTokens: 10000 });

      // First call consumes 7425 tokens (matching Arm C in Run 1)
      const res1 = guard.reserve(7425);
      res1.commit(7425);
      expect(guard.remaining).toBe(2575);

      // Next call requests standard 4096 tokens (which exceeded 2575 under old static policy)
      const result = guard.reserveAdaptive(4096);

      expect(result.clamped).toBe(true);
      expect(result.requestedTokens).toBe(4096);
      expect(result.effectiveTokens).toBe(2575);
      expect(guard.reserved).toBe(2575);
      expect(guard.remaining).toBe(0);

      // Model call completes using 1800 actual tokens
      result.reservation.commit(1800);
      expect(guard.consumed).toBe(7425 + 1800);
      expect(guard.reserved).toBe(0);
      expect(guard.remaining).toBe(10000 - (7425 + 1800)); // 775 tokens left
    });

    it('hierarchically clamps reservation across child and parent guards', () => {
      const parent = new TokenBudgetGuard({
        maxTotalTokens: 30000,
        policy: 'CONTROLLED_PER_ARM_BUDGET',
        label: 'Session',
      });
      const arm = parent.createChild({
        maxTokens: 10000,
        label: 'Arm-A',
      });

      // Arm A consumes 6608 tokens (matching Arm A in Run 1)
      arm.reserve(6608).commit(6608);
      expect(arm.remaining).toBe(3392);
      expect(parent.consumed).toBe(6608);

      // Arm requests 4096 tokens
      const result = arm.reserveAdaptive(4096);
      expect(result.clamped).toBe(true);
      expect(result.effectiveTokens).toBe(3392);
      expect(arm.reserved).toBe(3392);
      expect(parent.reserved).toBe(3392);

      result.reservation.commit(2000);
      expect(arm.consumed).toBe(6608 + 2000);
      expect(parent.consumed).toBe(6608 + 2000);
      expect(arm.reserved).toBe(0);
      expect(parent.reserved).toBe(0);
    });

    it('fails fast with BudgetExceededError when remaining capacity is below minUsefulTokens floor', () => {
      const guard = new TokenBudgetGuard({
        maxTotalTokens: 10000,
        minUsefulTokens: 256,
      });

      // Consume 9800 tokens, leaving 200 tokens (below 256 floor)
      guard.reserve(9800).commit(9800);
      expect(guard.remaining).toBe(200);

      try {
        guard.reserveAdaptive(4096);
        expect.fail('Should have thrown BudgetExceededError');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        const bErr = err as BudgetExceededError;
        expect(bErr.limit).toBe(10000);
        expect(bErr.currentCommitted).toBe(9800);
        expect(bErr.requestedReservation).toBe(4096);
        expect(bErr.message).toContain('below minimum useful threshold');
      }
    });

    it('enforces custom minUsefulTokens floor when explicitly configured', () => {
      const guard = new TokenBudgetGuard({
        maxTotalTokens: 5000,
        minUsefulTokens: 500,
      });

      guard.reserve(4600).commit(4600);
      expect(guard.remaining).toBe(400); // 400 is below 500

      expect(() => guard.reserveAdaptive(1000)).toThrow(BudgetExceededError);
      expect(() => guard.reserveAdaptive(1000, 300)).not.toThrow(); // Explicit override allows 400
    });

    it('handles concurrent requests competing for remaining headroom atomically', () => {
      const guard = new TokenBudgetGuard({ maxTotalTokens: 3000 });

      // Request 1 asks for 2000 tokens -> granted 2000 (remaining 1000)
      const res1 = guard.reserveAdaptive(2000);
      expect(res1.effectiveTokens).toBe(2000);
      expect(guard.remaining).toBe(1000);

      // Request 2 concurrently asks for 2000 tokens -> clamped to remaining 1000
      const res2 = guard.reserveAdaptive(2000);
      expect(res2.effectiveTokens).toBe(1000);
      expect(res2.clamped).toBe(true);
      expect(guard.remaining).toBe(0);

      // Request 3 concurrently asks for 500 tokens -> remaining is 0 (< 256), rejected immediately
      expect(() => guard.reserveAdaptive(500)).toThrow(BudgetExceededError);

      // Finish requests
      res1.reservation.commit(1000);
      res2.reservation.commit(800);
      expect(guard.consumed).toBe(1800);
      expect(guard.remaining).toBe(1200);
    });
  });

  describe('InstrumentedModelClient Adaptive Clamping Integration', () => {
    it('forwards clamped maxTokens in outbound ModelRequest to inner client', async () => {
      let capturedRequest: ModelRequest | undefined;
      const mockClient: ModelClient = {
        complete: async (req) => {
          capturedRequest = req;
          return {
            id: 'resp-adaptive',
            model: req.model,
            finishReason: 'stop',
            message: { role: 'assistant', content: 'export function validateProfile() {}' },
            usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1000 },
          };
        },
      };

      const guard = new TokenBudgetGuard({ maxTotalTokens: 5000 });
      guard.reserve(3200).commit(3200);
      expect(guard.remaining).toBe(1800);

      const instrumented = new InstrumentedModelClient({
        modelClient: mockClient,
        budgetGuard: guard,
      });

      // Request asks for 4096 tokens, but guard only has 1800 tokens remaining
      const response = await instrumented.complete({
        model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        messages: [{ role: 'user', content: 'Generate validateProfile' }],
        maxTokens: 4096,
      });

      expect(response.message.content).toBe('export function validateProfile() {}');

      // The outbound request sent to the provider had maxTokens clamped to 1787 (accounting for estimated prompt tokens)!
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest?.maxTokens).toBe(1787);

      // Event log records effective maxTokens and requestedMaxTokens
      const events = instrumented.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].request.maxTokens).toBe(1787);
      expect(events[0].request.requestedMaxTokens).toBe(4096);

      // Budget consumed reflects actual usage (1000 tokens)
      expect(guard.consumed).toBe(3200 + 1000);
      expect(guard.remaining).toBe(800);
    });

    it('does not clamp maxTokens when remaining budget is sufficient', async () => {
      let capturedRequest: ModelRequest | undefined;
      const mockClient: ModelClient = {
        complete: async (req) => {
          capturedRequest = req;
          return {
            id: 'resp-unclamped',
            model: req.model,
            finishReason: 'stop',
            message: { role: 'assistant', content: 'ok' },
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        },
      };

      const guard = new TokenBudgetGuard({ maxTotalTokens: 20000 });
      const instrumented = new InstrumentedModelClient({
        modelClient: mockClient,
        budgetGuard: guard,
      });

      await instrumented.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 4096,
      });

      expect(capturedRequest?.maxTokens).toBe(4096);
      const events = instrumented.getEvents();
      expect(events[0].request.maxTokens).toBe(4096);
      expect(events[0].request.requestedMaxTokens).toBeUndefined();
    });

    it('releases clamped reservation safely on inner client error', async () => {
      const failingClient: ModelClient = {
        complete: async () => {
          throw new Error('Provider connection timeout');
        },
      };

      const guard = new TokenBudgetGuard({ maxTotalTokens: 2000 });
      guard.reserve(1000).commit(1000);
      expect(guard.remaining).toBe(1000);

      const instrumented = new InstrumentedModelClient({
        modelClient: failingClient,
        budgetGuard: guard,
      });

      await expect(
        instrumented.complete({
          model: 'test-model',
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: 4096, // clamped to 1000
        })
      ).rejects.toThrow('Provider connection timeout');

      // Clamped reservation of 1000 was safely released; consumed unchanged
      expect(guard.consumed).toBe(1000);
      expect(guard.reserved).toBe(0);
      expect(guard.remaining).toBe(1000);
    });
  });

  describe('Reproduction & Resolution: eval-profile-validation-20261028-run1 Arm Failure Conditions', () => {
    it('reproduces and resolves the exact Arm A, Arm B, and Arm C turn 5 reservation bottlenecks', async () => {
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 30000,
        policy: 'CONTROLLED_PER_ARM_BUDGET',
        label: 'Session',
      });

      // Replicate Arm C (highest risk in Run 1: 7425 tokens used after 4 turns, 2575 left)
      const armCGuard = sessionGuard.createChild({
        maxTokens: 10000,
        label: 'Arm-ARM_C_ORCHESTRATE',
      });

      // 4 turns of tool exploration in profile validation:
      armCGuard.reserve(4096).commit(1900);
      armCGuard.reserve(4096).commit(1850);
      armCGuard.reserve(4096).commit(1825);
      armCGuard.reserve(4096).commit(1850);

      expect(armCGuard.consumed).toBe(7425);
      expect(armCGuard.remaining).toBe(2575);

      // In Run 1, turn 5 attempted reserve(4096) and threw BudgetExceededError:
      // expect(() => armCGuard.reserve(4096)).toThrow(BudgetExceededError);
      expect(() => armCGuard.reserve(4096)).toThrow(BudgetExceededError);

      // But with reserveAdaptive(4096), it safely clamps to 2575 tokens!
      const adaptiveResult = armCGuard.reserveAdaptive(4096);
      expect(adaptiveResult.clamped).toBe(true);
      expect(adaptiveResult.effectiveTokens).toBe(2575);
      expect(armCGuard.reserved).toBe(2575);

      // Model generates the write_file tool call and commits 1200 total tokens
      adaptiveResult.reservation.commit(1200);
      expect(armCGuard.consumed).toBe(8625);
      expect(armCGuard.remaining).toBe(1375);
      expect(sessionGuard.consumed).toBe(8625);

      // Replicate Arm B (8144 tokens used after 4 turns, 1856 left)
      const armBGuard = sessionGuard.createChild({
        maxTokens: 10000,
        label: 'Arm-ARM_B_UNVERIFIED_HANDOFF',
      });
      armBGuard.reserve(8144).commit(8144);
      expect(armBGuard.remaining).toBe(1856);

      const adaptiveB = armBGuard.reserveAdaptive(4096);
      expect(adaptiveB.clamped).toBe(true);
      expect(adaptiveB.effectiveTokens).toBe(1856);
      adaptiveB.reservation.commit(1100);
      expect(armBGuard.consumed).toBe(9244);
      expect(armBGuard.remaining).toBe(756);

      // Total session consumption remains well below 30000 cap
      expect(sessionGuard.consumed).toBe(8625 + 9244);
      expect(sessionGuard.consumed).toBeLessThanOrEqual(30000);
    });
  });
});
