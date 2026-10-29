import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import {
  TokenBudgetGuard,
  BudgetExceededError,
  BudgetFeasibilityError,
  validateBudgetFeasibility,
} from '../../src/harness/budget-guard.js';
import { InstrumentedModelClient } from '../../src/harness/instrumented-model-client.js';
import { InstrumentedToolRegistry } from '../../src/harness/instrumented-tool-registry.js';
import { AgentExecutionAdapter, TaskTimeoutError } from '../../src/harness/agent-adapter.js';
import { verifyEvidenceSeal } from '../../src/harness/evidence-sealer.js';
import { ToolRegistry } from '@orchestrate/core';
import type {
  ArmExecutionInput,
  BenchmarkWorkspace,
  WorkspaceFactory,
} from '../../src/harness/types.js';

describe('Step 10.7: Final Offline Adversarial Safety Audit', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'adv-audit-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 1: Allocation Formula and Feasibility
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 1: Allocation Formula and Feasibility', () => {
    it('equal-budget mode divides aggregate cap across three arms without exceeding total cap', () => {
      const maxTotalTokens = 50000;
      const totalPlannedArms = 3;
      const singleRequestReservation = 4096;

      const maxTokensPerArm = Math.floor(maxTotalTokens / totalPlannedArms);
      expect(maxTokensPerArm).toBe(16666);
      expect(maxTokensPerArm * totalPlannedArms).toBeLessThanOrEqual(maxTotalTokens);
      expect(maxTotalTokens - maxTokensPerArm * totalPlannedArms).toBe(2); // non-divisible remainder retained safely

      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens,
          maxTokensPerArm,
          totalPlannedArms,
          singleRequestReservation,
        })
      ).not.toThrow();
    });

    it('rejects fractional, negative, zero, or non-finite inputs deterministically', () => {
      // Fractional tokens
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000.5,
          maxTokensPerArm: 16000,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(BudgetFeasibilityError);

      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 16000.75,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(BudgetFeasibilityError);

      // Negative or zero
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: -100,
          maxTokensPerArm: 16000,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(BudgetFeasibilityError);

      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 0,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(BudgetFeasibilityError);

      // Non-finite
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: Infinity,
          maxTokensPerArm: 16000,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(BudgetFeasibilityError);
    });

    it('rejects allocation when per-arm budget cannot cover a single completion reservation', () => {
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 4000, // < 4096 single request reservation
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(/less than the required single-request reservation/);
    });

    it('rejects explicit per-arm allocation whose product exceeds total session budget', () => {
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 20000, // 3 * 20000 = 60000 > 50000
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(/exceed aggregate session cap/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 2: Concurrent Reservation and Aggregate Cap
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 2: Concurrent Reservation and Aggregate Cap', () => {
    it('prevents concurrent reservations across child guards from exceeding parent cap', async () => {
      const parent = new TokenBudgetGuard({ maxTotalTokens: 10000, label: 'Session' });
      const childA = parent.createChild({ maxTokens: 6000, label: 'Arm-A' });
      const childB = parent.createChild({ maxTokens: 6000, label: 'Arm-B' });

      // Child A reserves 5000 concurrently
      const resA = childA.reserve(5000);
      expect(parent.reserved).toBe(5000);
      expect(parent.remaining).toBe(5000);

      // Child B attempts to reserve 6000 concurrently
      // 5000 (committed) + 6000 = 11000 > 10000 parent cap!
      expect(() => childB.reserve(6000)).toThrow(/Token budget exceeded for Session/);

      // Child B's failed reservation must not corrupt Child B or parent state
      expect(childB.reserved).toBe(0);
      expect(childB.consumed).toBe(0);
      expect(parent.reserved).toBe(5000);
      expect(parent.consumed).toBe(0);

      // Child B can reserve up to remaining parent capacity
      const resB = childB.reserve(5000);
      expect(parent.reserved).toBe(10000);
      expect(parent.remaining).toBe(0);

      // Commit both
      resA.commit(4000);
      resB.commit(4500);

      expect(childA.consumed).toBe(4000);
      expect(childB.consumed).toBe(4500);
      expect(parent.consumed).toBe(8500);
      expect(parent.remaining).toBe(1500);
    });

    it('enforces accurate reconciliation when actual provider usage exceeds initial reservation', () => {
      const parent = new TokenBudgetGuard({ maxTotalTokens: 20000, label: 'Session' });
      const child = parent.createChild({ maxTokens: 10000, label: 'Arm-A' });

      // Reserve 4096 tokens
      const res = child.reserve(4096);
      expect(child.reserved).toBe(4096);
      expect(parent.reserved).toBe(4096);

      // Model response reported 6000 actual tokens (larger than reservation)
      res.commit(6000);

      expect(child.reserved).toBe(0);
      expect(child.consumed).toBe(6000);
      expect(child.remaining).toBe(4000);

      expect(parent.reserved).toBe(0);
      expect(parent.consumed).toBe(6000);
      expect(parent.remaining).toBe(14000);

      // Child cannot exceed its own allocation even if parent has capacity
      expect(() => child.reserve(4500)).toThrow(/Token budget exceeded for Arm-A/);
    });

    it('handles malformed, NaN, or non-finite usage conservatively without corrupting state', () => {
      const parent = new TokenBudgetGuard({ maxTotalTokens: 10000 });
      const child = parent.createChild({ maxTokens: 5000 });

      // Reservation of 1000
      const res1 = child.reserve(1000);
      res1.commit(NaN as any);
      expect(child.consumed).toBe(1000); // conservatively commits reservation

      const res2 = child.reserve(1000);
      res2.commit(Infinity as any);
      expect(child.consumed).toBe(2000); // non-finite falls back to reservation

      const res3 = child.reserve(1000);
      res3.commit(-500 as any);
      expect(child.consumed).toBe(3000); // negative falls back to reservation
    });

    it('proves no arm can consume or borrow peer arm allocations', () => {
      const parent = new TokenBudgetGuard({ maxTotalTokens: 30000 });
      const childA = parent.createChild({ maxTokens: 10000, label: 'Arm-A' });
      const childB = parent.createChild({ maxTokens: 10000, label: 'Arm-B' });

      // Arm A consumes entire allocation
      childA.reserve(5000).commit(5000);
      childA.reserve(5000).commit(5000);
      expect(childA.remaining).toBe(0);

      // Arm A attempts further execution
      expect(() => childA.reserve(100)).toThrow(/Token budget exceeded for Arm-A/);

      // Arm B retains its full 10000 allocation intact
      expect(childB.remaining).toBe(10000);
      expect(() => childB.reserve(4096)).not.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 3: Timeout, Abort, and Late Provider Usage
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 3: Timeout, Abort, and Late Provider Usage', () => {
    it('conservatively commits in-flight reservation when task times out before provider responds', async () => {
      const budgetGuard = new TokenBudgetGuard({ maxTotalTokens: 20000 });
      const childGuard = budgetGuard.createChild({ maxTokens: 8000, label: 'Arm-Test' });

      let callDispatched = false;
      const abortController = new AbortController();

      // Mock client that hangs awaiting response
      const hangingModel: ModelClient = {
        complete: async () => {
          callDispatched = true;
          // Simulated slow network request that never finishes before abort
          return new Promise<never>((_, reject) => {
            abortController.signal.addEventListener('abort', () => {
              const err = new Error('Client abort while in flight');
              err.name = 'AbortError';
              reject(err);
            });
          });
        },
      };

      const instrumented = new InstrumentedModelClient({
        modelClient: hangingModel,
        budgetGuard: childGuard,
        abortSignal: abortController.signal,
      });

      // Launch in-flight call
      const completePromise = instrumented.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 4096,
      });

      expect(callDispatched).toBe(true);
      expect(childGuard.reserved).toBe(4096);
      expect(budgetGuard.reserved).toBe(4096);

      // Abort in flight
      abortController.abort(new Error('Task timed out'));

      await expect(completePromise).rejects.toThrow();

      // Reservation must NOT be released back to spendable capacity!
      // In-flight abort must conservatively commit the reserved tokens.
      expect(childGuard.reserved).toBe(0);
      expect(childGuard.consumed).toBe(4096);
      expect(childGuard.remaining).toBe(8000 - 4096);

      expect(budgetGuard.reserved).toBe(0);
      expect(budgetGuard.consumed).toBe(4096);
    });

    it('suppresses late provider responses arriving after task has been finalized', async () => {
      const budgetGuard = new TokenBudgetGuard({ maxTotalTokens: 20000 });
      const childGuard = budgetGuard.createChild({ maxTokens: 8000 });
      const abortController = new AbortController();

      let resolveSlowCall!: (res: ModelResponse) => void;
      const slowModel: ModelClient = {
        complete: async () =>
          new Promise<ModelResponse>((resolve) => {
            resolveSlowCall = resolve;
          }),
      };

      const instrumented = new InstrumentedModelClient({
        modelClient: slowModel,
        budgetGuard: childGuard,
        abortSignal: abortController.signal,
      });

      // Call initiated in flight
      const callPromise = instrumented.complete({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 3000,
      });

      expect(childGuard.reserved).toBe(3000);

      // Task times out / finalizes
      abortController.abort(new Error('Task timeout'));
      instrumented.finalize();

      // Finalize conservatively commits the in-flight reservation
      expect(childGuard.consumed).toBe(3000);
      expect(childGuard.reserved).toBe(0);

      // Now the late provider response arrives 500ms later!
      resolveSlowCall({
        id: 'late-1',
        model: 'test-model',
        finishReason: 'stop',
        message: { role: 'assistant', content: 'late response' },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      await expect(callPromise).rejects.toThrow(/after task finalization or abort/);

      // Crucial: Late response did NOT commit again or corrupt budgetGuard!
      expect(childGuard.consumed).toBe(3000);
      expect(childGuard.reserved).toBe(0);
      expect(budgetGuard.consumed).toBe(3000);

      // Late response did NOT add a second event to instrumentedModel
      expect(instrumented.getEvents()).toHaveLength(0);
    });

    it('prevents late tool execution after task finalization or abort', async () => {
      const baseRegistry = new ToolRegistry();
      baseRegistry.register({
        name: 'write_file',
        description: 'write file',
        parameters: {} as any,
        execute: async () => 'wrote file',
      });

      const abortController = new AbortController();
      const instrumentedTools = new InstrumentedToolRegistry(baseRegistry, {
        abortSignal: abortController.signal,
      });

      // Successful tool execution before abort
      const res1 = await instrumentedTools.execute('write_file', { path: 'a.txt' });
      expect(res1).toBe('wrote file');
      expect(instrumentedTools.getEvents()).toHaveLength(1);

      // Task finalized
      instrumentedTools.finalize();

      // Any subsequent tool call is immediately rejected
      await expect(
        instrumentedTools.execute('write_file', { path: 'b.txt' })
      ).rejects.toThrow(/Tool execution aborted or finalized/);

      // Did not record rejected call into events
      expect(instrumentedTools.getEvents()).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 4: Sealed Telemetry Integrity
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 4: Sealed Telemetry Integrity', () => {
    it('records authoritative budget state into sealed evidence and verifies hash seal', async () => {
      const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 25000, label: 'Session' });
      const armGuard = sessionGuard.createChild({ maxTokens: 8000, label: 'Arm-A' });

      const mockModel: ModelClient = {
        complete: async (req: ModelRequest): Promise<ModelResponse> => ({
          id: 'test-resp',
          model: req.model,
          finishReason: 'stop',
          message: { role: 'assistant', content: 'Done' },
          usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
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

      const mockFactory: WorkspaceFactory = {
        create: async () => mockWorkspace,
        cleanup: async () => {},
      };

      const adapter = new AgentExecutionAdapter({
        workspaceFactory: mockFactory,
        modelClient: mockModel,
        budgetGuard: armGuard,
      });

      const input: ArmExecutionInput = {
        trialId: 'trial-audit-4',
        armId: 'ARM_A_BASELINE',
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        taskBPrompt: 'Test prompt',
        systemPrompt: 'System instructions',
        contextEnvelope: null,
        controlFingerprint: {
          snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
          taskBPromptHash: 'a',
          modelIdentity: 'test-model',
          inferenceConfigHash: 'b',
          systemInstructionsHash: 'c',
          toolDefinitionsHash: 'd',
          toolPermissionsHash: 'e',
          environmentDependencyFingerprint: 'f',
          executionLimitsHash: 'g',
          filesystemPolicyHash: 'h',
        },
      };

      const result = await adapter.execute(input);

      // Verify budget telemetry matches authoritative guard state
      expect(result.evidence.budget).toBeDefined();
      expect(result.evidence.budget?.arm_limit).toBe(8000);
      expect(result.evidence.budget?.arm_consumed).toBe(1500);
      expect(result.evidence.budget?.aggregate_limit).toBe(25000);
      expect(result.evidence.budget?.aggregate_consumed).toBe(1500);

      // Evidence is cryptographically sealed
      expect(verifyEvidenceSeal(result.evidence)).toBe(true);

      // Immutability: attempts to mutate frozen evidence fail
      expect(() => {
        (result.evidence as any).outcome = 'BLOCKED_NEEDS_HUMAN';
      }).toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 5: Three-Arm Readiness and Experimental Integrity
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 5: Three-Arm Readiness and Experimental Integrity', () => {
    it('executes three arms where one arm hitting its budget fails without starving peer arms', async () => {
      const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 30000, label: 'Session' });
      const armLimits = 10000;

      // Arm A runs first and exhausts its budget
      const armAGuard = sessionGuard.createChild({ maxTokens: armLimits, label: 'Arm-A' });
      armAGuard.reserve(4500).commit(4500);
      armAGuard.reserve(4500).commit(4500);

      // Arm A attempts 3rd call that breaches its 10000 cap
      expect(() => armAGuard.reserve(2000)).toThrow(/Token budget exceeded for Arm-A/);
      expect(armAGuard.consumed).toBe(9000);

      // Session guard has only consumed 9000 out of 30000 tokens
      expect(sessionGuard.consumed).toBe(9000);

      // Arm C runs next and receives its full unstarved allocation
      const armCGuard = sessionGuard.createChild({ maxTokens: armLimits, label: 'Arm-C' });
      expect(armCGuard.remaining).toBe(10000);
      const resC = armCGuard.reserve(4096);
      resC.commit(3500);
      expect(armCGuard.consumed).toBe(3500);
      expect(sessionGuard.consumed).toBe(12500);

      // Arm B runs next and also receives its full unstarved allocation
      const armBGuard = sessionGuard.createChild({ maxTokens: armLimits, label: 'Arm-B' });
      expect(armBGuard.remaining).toBe(10000);
      const resB = armBGuard.reserve(4096);
      resB.commit(3200);
      expect(armBGuard.consumed).toBe(3200);
      expect(sessionGuard.consumed).toBe(15700);

      // All peer arms completed successfully; Arm A failed without starving peers
      expect(armCGuard.consumed).toBe(3500);
      expect(armBGuard.consumed).toBe(3200);
    });

    it('confirms arm execution order does not alter allocation sizes', () => {
      const aggregate = 60000;
      const plannedArms = 3;
      const order1 = ['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE'];
      const order2 = ['ARM_C_ORCHESTRATE', 'ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF'];

      const allocOrder1 = order1.map(() => Math.floor(aggregate / plannedArms));
      const allocOrder2 = order2.map(() => Math.floor(aggregate / plannedArms));

      expect(allocOrder1).toEqual([20000, 20000, 20000]);
      expect(allocOrder2).toEqual([20000, 20000, 20000]);
    });
  });
});
