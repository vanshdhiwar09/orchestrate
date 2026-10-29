import { describe, it, expect } from 'vitest';
import {
  TokenBudgetGuard,
  BudgetExceededError,
  BudgetFeasibilityError,
  validateBudgetFeasibility,
} from '../../src/harness/budget-guard.js';

describe('TokenBudgetGuard', () => {
  it('rejects invalid or non-positive maxTotalTokens options', () => {
    expect(() => new TokenBudgetGuard({ maxTotalTokens: 0 })).toThrow(
      /maxTotalTokens must be a positive finite number/
    );
    expect(() => new TokenBudgetGuard({ maxTotalTokens: -50 })).toThrow(
      /maxTotalTokens must be a positive finite number/
    );
    expect(() => new TokenBudgetGuard({ maxTotalTokens: NaN })).toThrow(
      /maxTotalTokens must be a positive finite number/
    );
  });

  it('enforces exact-boundary reservation and commit', () => {
    const guard = new TokenBudgetGuard({ maxTotalTokens: 1000 });
    expect(guard.remaining).toBe(1000);
    expect(guard.consumed).toBe(0);
    expect(guard.reserved).toBe(0);

    // Reserve exact amount
    const res = guard.reserve(1000);
    expect(guard.reserved).toBe(1000);
    expect(guard.remaining).toBe(0);

    // Any further reservation must fail before any call is made
    expect(() => guard.reserve(1)).toThrow(BudgetExceededError);

    // Commit actual usage less than reservation
    res.commit(600);
    expect(guard.reserved).toBe(0);
    expect(guard.consumed).toBe(600);
    expect(guard.remaining).toBe(400);

    // Can now reserve remaining
    const res2 = guard.reserve(400);
    res2.commit(400);
    expect(guard.consumed).toBe(1000);
    expect(guard.remaining).toBe(0);

    // At exact boundary, any next request throws
    expect(() => guard.reserve(1)).toThrow(BudgetExceededError);
  });

  it('rejects calls exceeding the cap immediately', () => {
    const guard = new TokenBudgetGuard({ maxTotalTokens: 500 });
    try {
      guard.reserve(501);
      expect.fail('Should have thrown BudgetExceededError');
    } catch (err: any) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(err.limit).toBe(500);
      expect(err.currentCommitted).toBe(0);
      expect(err.requestedReservation).toBe(501);
    }
  });

  it('conservatively commits reserved tokens when provider usage is unavailable', () => {
    const guard = new TokenBudgetGuard({ maxTotalTokens: 2000 });
    const res = guard.reserve(800);
    // Provider returned no usage metadata
    res.commit(null);

    expect(guard.consumed).toBe(800);
    expect(guard.remaining).toBe(1200);
  });

  it('releases reservation safely on error/abort without leaking budget', () => {
    const guard = new TokenBudgetGuard({ maxTotalTokens: 1000 });
    const res = guard.reserve(500);
    expect(guard.reserved).toBe(500);

    res.release();
    expect(guard.reserved).toBe(0);
    expect(guard.consumed).toBe(0);
    expect(guard.remaining).toBe(1000);
  });

  it('prevents concurrent calls from collectively exceeding the limit', async () => {
    const guard = new TokenBudgetGuard({ maxTotalTokens: 1000 });

    // Call 1 reserves 600
    const res1 = guard.reserve(600);

    // Call 2 attempts to reserve 600 concurrently before Call 1 commits
    expect(() => guard.reserve(600)).toThrow(BudgetExceededError);

    res1.commit(400);
    expect(guard.consumed).toBe(400);

    // Now Call 2 can reserve up to 600
    const res2 = guard.reserve(600);
    res2.commit(500);
    expect(guard.consumed).toBe(900);
  });

  it('resets usage cleanly', () => {
    const guard = new TokenBudgetGuard({ maxTotalTokens: 1000 });
    guard.reserve(500).commit(500);
    expect(guard.consumed).toBe(500);

    guard.reset();
    expect(guard.consumed).toBe(0);
    expect(guard.reserved).toBe(0);
    expect(guard.remaining).toBe(1000);
  });

  describe('Hierarchical Budget Isolation (Child Guards)', () => {
    it('isolates per-arm budgets so one arm cannot starve peer arms', () => {
      // Session aggregate cap of 30,000 across 3 arms, 10,000 each
      const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 30000, label: 'Session' });
      const armAGuard = sessionGuard.createChild({ maxTokens: 10000, label: 'Arm-A' });
      const armBGuard = sessionGuard.createChild({ maxTokens: 10000, label: 'Arm-B' });
      const armCGuard = sessionGuard.createChild({ maxTokens: 10000, label: 'Arm-C' });

      // Arm A consumes up to its limit (e.g. 2 calls of 4500 = 9000 committed)
      const resA1 = armAGuard.reserve(4500);
      resA1.commit(4500);
      const resA2 = armAGuard.reserve(4500);
      resA2.commit(4500);

      expect(armAGuard.consumed).toBe(9000);
      expect(armAGuard.remaining).toBe(1000);
      expect(sessionGuard.consumed).toBe(9000);

      // Arm A attempts a 3rd call reserving 2000 tokens (9000 + 2000 = 11000 > 10000 limit)
      // Arm A must fail due to ARM cap, NOT aggregate session cap
      expect(() => armAGuard.reserve(2000)).toThrow(/Token budget exceeded for Arm-A: limit is 10000/);

      // Arm A is halted, but Session has only consumed 9000 tokens!
      expect(sessionGuard.consumed).toBe(9000);
      expect(sessionGuard.remaining).toBe(21000);

      // Arm B runs next — it has its FULL 10,000 allocation intact and unstarved!
      expect(armBGuard.remaining).toBe(10000);
      const resB1 = armBGuard.reserve(4096);
      resB1.commit(3500);
      expect(armBGuard.consumed).toBe(3500);
      expect(sessionGuard.consumed).toBe(12500);

      // Arm C runs next — it also has its FULL 10,000 allocation intact and unstarved!
      expect(armCGuard.remaining).toBe(10000);
      const resC1 = armCGuard.reserve(4096);
      resC1.commit(4000);
      expect(armCGuard.consumed).toBe(4000);
      expect(sessionGuard.consumed).toBe(16500);
    });

    it('enforces aggregate session cap across child guards', () => {
      // Session cap of 15,000 with 3 child guards allocated 6,000 each (aggregate 18,000 > 15,000)
      const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 15000, label: 'Session' });
      const armAGuard = sessionGuard.createChild({ maxTokens: 6000, label: 'Arm-A' });
      const armBGuard = sessionGuard.createChild({ maxTokens: 6000, label: 'Arm-B' });
      const armCGuard = sessionGuard.createChild({ maxTokens: 6000, label: 'Arm-C' });

      // Arm A uses 6000
      const resA = armAGuard.reserve(6000);
      resA.commit(6000);

      // Arm B uses 6000 (total in session: 12,000)
      const resB = armBGuard.reserve(6000);
      resB.commit(6000);
      expect(sessionGuard.consumed).toBe(12000);

      // Arm C tries to reserve 4000 (Arm C local has 6000 remaining, but session only has 3000 remaining)
      // Parent guard must reject the reservation before any call is made!
      expect(() => armCGuard.reserve(4000)).toThrow(/Token budget exceeded for Session/);
    });

    it('releases child reservation cleanly on error/abort without corrupting parent', () => {
      const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 20000 });
      const childGuard = sessionGuard.createChild({ maxTokens: 8000 });

      const res = childGuard.reserve(4000);
      expect(childGuard.reserved).toBe(4000);
      expect(sessionGuard.reserved).toBe(4000);

      res.release();
      expect(childGuard.reserved).toBe(0);
      expect(childGuard.consumed).toBe(0);
      expect(sessionGuard.reserved).toBe(0);
      expect(sessionGuard.consumed).toBe(0);
    });

    it('conservatively commits reserved tokens through child to parent when usage is missing', () => {
      const sessionGuard = new TokenBudgetGuard({ maxTotalTokens: 20000 });
      const childGuard = sessionGuard.createChild({ maxTokens: 8000 });

      const res = childGuard.reserve(4000);
      res.commit(null);

      expect(childGuard.consumed).toBe(4000);
      expect(sessionGuard.consumed).toBe(4000);
    });
  });

  describe('Budget Feasibility Validation', () => {
    it('accepts valid, mathematically feasible session configurations', () => {
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 16000,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).not.toThrow();
    });

    it('rejects underfunded per-arm budget less than single request reservation', () => {
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 2000, // less than 4096 single request reservation!
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(BudgetFeasibilityError);

      try {
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 2000,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(BudgetFeasibilityError);
        expect(err.message).toMatch(/less than the required single-request reservation/);
      }
    });

    it('rejects aggregate arm allocation exceeding the total session cap', () => {
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 20000, // 3 * 20000 = 60000 > 50000!
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(BudgetFeasibilityError);

      try {
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 20000,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(BudgetFeasibilityError);
        expect(err.message).toMatch(/exceed aggregate session cap/);
      }
    });

    it('rejects non-positive or non-finite inputs', () => {
      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: -100,
          maxTokensPerArm: 10000,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(/maxTotalTokens must be a positive finite integer/);

      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 0,
          totalPlannedArms: 3,
          singleRequestReservation: 4096,
        })
      ).toThrow(/maxTokensPerArm must be a positive finite integer/);

      expect(() =>
        validateBudgetFeasibility({
          maxTotalTokens: 50000,
          maxTokensPerArm: 10000,
          totalPlannedArms: 0,
          singleRequestReservation: 4096,
        })
      ).toThrow(/totalPlannedArms must be a positive integer/);
    });
  });
});
