import type { BenchmarkBudgetPolicy } from './types.js';

export interface BudgetWarningEvent {
  thresholdPercent: number; // e.g. 70, 85, 95
  limit: number;
  totalCommitted: number;
  consumed: number;
  remaining: number;
  timestamp: string;
  label?: string;
  message: string;
}

export interface TokenBudgetGuardOptions {
  /**
   * Maximum total tokens permitted across all model calls shared by this guard.
   * Either maxTotalTokens or maxTokens may be specified.
   * If omitted on a child guard with a parent, defaults to adaptive shared capacity.
   */
  maxTotalTokens?: number;
  maxTokens?: number;

  /**
   * Default tokens to reserve when request.maxTokens is omitted or not specified.
   * Defaults to 1024.
   */
  defaultReservationTokens?: number;

  /**
   * Optional parent budget guard (for hierarchical session/arm budget isolation).
   */
  parent?: TokenBudgetGuard;

  /**
   * Optional label identifying this guard (e.g. 'Session', 'Arm-ARM_A_BASELINE').
   */
  label?: string;

  /**
   * Budget allocation policy.
   * Defaults to 'ADAPTIVE_SESSION_BUDGET'.
   */
  policy?: BenchmarkBudgetPolicy;

  /**
   * Configurable warning thresholds as fractions of the limit (e.g. [0.70, 0.85, 0.95]).
   */
  warningThresholds?: readonly number[];

  /**
   * Minimum useful tokens floor for completion generations (defaults to 256).
   * When remaining budget falls below this floor, adaptive reservations fail-fast with BudgetExceededError.
   */
  minUsefulTokens?: number;

  /**
   * Optional callback invoked whenever a warning threshold is crossed.
   */
  onWarning?: (warning: BudgetWarningEvent) => void;
}

export class BudgetExceededError extends Error {
  public readonly currentCommitted: number;
  public readonly requestedReservation: number;
  public readonly limit: number;

  constructor(
    message: string,
    currentCommitted: number,
    requestedReservation: number,
    limit: number
  ) {
    super(message);
    this.name = 'BudgetExceededError';
    this.currentCommitted = currentCommitted;
    this.requestedReservation = requestedReservation;
    this.limit = limit;
  }
}

export class BudgetFeasibilityError extends Error {
  public readonly params: BudgetFeasibilityParams;

  constructor(message: string, params: BudgetFeasibilityParams) {
    super(message);
    this.name = 'BudgetFeasibilityError';
    this.params = params;
  }
}

export interface BudgetFeasibilityParams {
  maxTotalTokens: number;
  maxTokensPerArm?: number;
  totalPlannedArms: number;
  singleRequestReservation: number;
  policy?: BenchmarkBudgetPolicy;
}

/**
 * Validates that the configured session and arm token budgets are mathematically
 * feasible before any execution or provider interaction begins.
 */
export function validateBudgetFeasibility(params: BudgetFeasibilityParams): void {
  if (
    typeof params.maxTotalTokens !== 'number' ||
    params.maxTotalTokens <= 0 ||
    !Number.isFinite(params.maxTotalTokens) ||
    !Number.isInteger(params.maxTotalTokens)
  ) {
    throw new BudgetFeasibilityError(
      `Infeasible budget configuration: maxTotalTokens must be a positive finite integer, received ${params.maxTotalTokens}.`,
      params
    );
  }

  if (
    typeof params.totalPlannedArms !== 'number' ||
    params.totalPlannedArms <= 0 ||
    !Number.isInteger(params.totalPlannedArms)
  ) {
    throw new BudgetFeasibilityError(
      `Infeasible budget configuration: totalPlannedArms must be a positive integer, received ${params.totalPlannedArms}.`,
      params
    );
  }

  const reservation =
    typeof params.singleRequestReservation === 'number' &&
    Number.isFinite(params.singleRequestReservation) &&
    params.singleRequestReservation > 0
      ? Math.round(params.singleRequestReservation)
      : 1024;

  if (params.maxTotalTokens < reservation) {
    throw new BudgetFeasibilityError(
      `Infeasible budget configuration: aggregate session cap (${params.maxTotalTokens}) is less than the required single-request reservation (${reservation} tokens).`,
      params
    );
  }

  const policy =
    params.policy ??
    (params.maxTokensPerArm !== undefined ? 'CONTROLLED_PER_ARM_BUDGET' : 'ADAPTIVE_SESSION_BUDGET');

  if (policy === 'CONTROLLED_PER_ARM_BUDGET') {
    if (
      typeof params.maxTokensPerArm !== 'number' ||
      params.maxTokensPerArm <= 0 ||
      !Number.isFinite(params.maxTokensPerArm) ||
      !Number.isInteger(params.maxTokensPerArm)
    ) {
      throw new BudgetFeasibilityError(
        `Infeasible budget configuration: maxTokensPerArm must be a positive finite integer, received ${params.maxTokensPerArm}.`,
        params
      );
    }

    if (params.maxTokensPerArm < reservation) {
      throw new BudgetFeasibilityError(
        `Infeasible budget configuration: maxTokensPerArm (${params.maxTokensPerArm}) is less than the required single-request reservation (${reservation} tokens). The agent cannot execute even one completion call.`,
        params
      );
    }

    const aggregateArmAllocation = params.maxTokensPerArm * params.totalPlannedArms;
    if (aggregateArmAllocation > params.maxTotalTokens) {
      throw new BudgetFeasibilityError(
        `Infeasible budget configuration: total planned arm allocations (${aggregateArmAllocation} tokens across ${params.totalPlannedArms} arms) exceed aggregate session cap (${params.maxTotalTokens} tokens). Increase maxTotalTokens or reduce maxTokensPerArm.`,
        params
      );
    }
  } else {
    // ADAPTIVE_SESSION_BUDGET
    if (params.maxTokensPerArm !== undefined) {
      if (
        typeof params.maxTokensPerArm !== 'number' ||
        params.maxTokensPerArm <= 0 ||
        !Number.isFinite(params.maxTokensPerArm) ||
        !Number.isInteger(params.maxTokensPerArm)
      ) {
        throw new BudgetFeasibilityError(
          `Infeasible budget configuration: maxTokensPerArm must be a positive finite integer, received ${params.maxTokensPerArm}.`,
          params
        );
      }

      if (params.maxTokensPerArm < reservation) {
        throw new BudgetFeasibilityError(
          `Infeasible budget configuration: maxTokensPerArm (${params.maxTokensPerArm}) is less than the required single-request reservation (${reservation} tokens).`,
          params
        );
      }

      if (params.maxTokensPerArm > params.maxTotalTokens) {
        throw new BudgetFeasibilityError(
          `Infeasible budget configuration: maxTokensPerArm (${params.maxTokensPerArm}) cannot exceed aggregate session cap (${params.maxTotalTokens}).`,
          params
        );
      }
    }
  }
}

export interface BudgetReservation {
  readonly reservedTokens: number;
  commit(actualTokens?: number | null): void;
  release(): void;
}

export interface AdaptiveReservationResult {
  readonly reservation: BudgetReservation;
  readonly effectiveTokens: number;
  readonly requestedTokens: number;
  readonly clamped: boolean;
  readonly estimatedPromptTokens?: number;
  readonly totalReservedTokens?: number;
}

/**
 * Shared usage guard for enforcing hard token budget caps across model calls
 * supporting both adaptive shared capacity and controlled per-arm isolation.
 *
 * Invariants:
 * - Checks budget BEFORE initiating a model call, not only post-hoc.
 * - Concurrent reservations are tracked so concurrent calls cannot exceed the cap.
 * - If provider usage metadata is unavailable, conservatively commits the reservation.
 * - Supports warning thresholds without altering the hard ceiling or fabricating capacity.
 * - Throws BudgetExceededError if a call would breach either the arm cap or aggregate ceiling.
 */
export class TokenBudgetGuard {
  private consumedTokens = 0;
  private activeReservations = 0;
  private readonly maxTokens?: number;
  private readonly defaultReservationTokens: number;
  private readonly _parent?: TokenBudgetGuard;
  private readonly _label?: string;
  private readonly _policy: BenchmarkBudgetPolicy;
  private readonly _warningThresholds: readonly number[];
  private readonly _minUsefulTokens: number;
  private readonly onWarning?: (warning: BudgetWarningEvent) => void;
  private readonly triggeredWarnings = new Set<number>();
  private readonly warningEvents: BudgetWarningEvent[] = [];

  constructor(options: TokenBudgetGuardOptions) {
    const effectiveLimit = options?.maxTokens ?? options?.maxTotalTokens;
    if (effectiveLimit !== undefined) {
      if (
        typeof effectiveLimit !== 'number' ||
        effectiveLimit <= 0 ||
        !Number.isFinite(effectiveLimit)
      ) {
        throw new Error('TokenBudgetGuard: maxTotalTokens must be a positive finite number.');
      }
      this.maxTokens = effectiveLimit;
    } else {
      if (!options?.parent) {
        throw new Error('TokenBudgetGuard: maxTotalTokens must be a positive finite number.');
      }
      this.maxTokens = undefined;
    }

    this.defaultReservationTokens = options.defaultReservationTokens ?? 1024;
    this._parent = options.parent;
    this._label = options.label;
    this._policy =
      options.policy ??
      (this._parent ? this._parent.policy : 'ADAPTIVE_SESSION_BUDGET');
    this._warningThresholds =
      options.warningThresholds ??
      (this._parent ? this._parent.warningThresholds : [0.70, 0.85, 0.95]);
    this._minUsefulTokens =
      options.minUsefulTokens ??
      (this._parent ? this._parent.minUsefulTokens : 256);
    this.onWarning =
      options.onWarning ?? (this._parent ? this._parent.onWarning : undefined);
  }

  get limit(): number {
    if (this.maxTokens !== undefined) return this.maxTokens;
    if (this._parent) return this._parent.limit;
    return 0;
  }

  get localLimit(): number | undefined {
    return this.maxTokens;
  }

  get consumed(): number {
    return this.consumedTokens;
  }

  get reserved(): number {
    return this.activeReservations;
  }

  get totalCommitted(): number {
    return this.consumedTokens + this.activeReservations;
  }

  get remaining(): number {
    const parentRemaining = this._parent ? this._parent.remaining : Infinity;
    const localRemaining =
      this.maxTokens !== undefined
        ? Math.max(0, this.maxTokens - this.totalCommitted)
        : Infinity;
    return Math.min(localRemaining, parentRemaining);
  }

  get parent(): TokenBudgetGuard | undefined {
    return this._parent;
  }

  get label(): string | undefined {
    return this._label;
  }

  get policy(): BenchmarkBudgetPolicy {
    return this._policy;
  }

  get warningThresholds(): readonly number[] {
    return this._warningThresholds;
  }

  get warnings(): readonly BudgetWarningEvent[] {
    return [...this.warningEvents];
  }

  get triggeredWarningThresholds(): readonly number[] {
    return Array.from(this.triggeredWarnings).sort((a, b) => a - b);
  }

  get minUsefulTokens(): number {
    return this._minUsefulTokens;
  }

  /**
   * Spawns a child TokenBudgetGuard with its own label and optional ceiling.
   * Under ADAPTIVE_SESSION_BUDGET, maxTokens may be omitted to share the parent pool dynamically.
   */
  createChild(options?: {
    maxTokens?: number;
    label?: string;
    policy?: BenchmarkBudgetPolicy;
    minUsefulTokens?: number;
  }): TokenBudgetGuard {
    const childPolicy = options?.policy ?? this._policy;
    return new TokenBudgetGuard({
      maxTokens: options?.maxTokens,
      defaultReservationTokens: this.defaultReservationTokens,
      minUsefulTokens: options?.minUsefulTokens ?? this._minUsefulTokens,
      parent: this,
      label: options?.label,
      policy: childPolicy,
      warningThresholds: this._warningThresholds,
      onWarning: this.onWarning,
    });
  }

  private checkWarningThresholds(): void {
    if (!this._warningThresholds || this._warningThresholds.length === 0) return;
    const effectiveLimit = this.limit;
    if (effectiveLimit <= 0) return;

    const currentRatio = this.totalCommitted / effectiveLimit;
    for (const threshold of this._warningThresholds) {
      if (currentRatio >= threshold && !this.triggeredWarnings.has(threshold)) {
        this.triggeredWarnings.add(threshold);
        const percent = Math.round(threshold * 100);
        const event: BudgetWarningEvent = {
          thresholdPercent: percent,
          limit: effectiveLimit,
          totalCommitted: this.totalCommitted,
          consumed: this.consumed,
          remaining: this.remaining,
          timestamp: new Date().toISOString(),
          label: this._label,
          message: `[BUDGET WARNING] Token usage reached ${percent}% of authorized limit (${this.totalCommitted}/${effectiveLimit} tokens committed). Hard ceiling remains ${effectiveLimit}; no additional capacity is guaranteed.`,
        };
        this.warningEvents.push(event);
        this.onWarning?.(event);
        if (this._parent) {
          this._parent.recordChildWarning(event);
        }
      }
    }
  }

  /**
   * Records a warning event propagated from a child guard.
   */
  recordChildWarning(event: BudgetWarningEvent): void {
    this.warningEvents.push(event);
  }

  /**
   * Checks the budget and reserves completion tokens before initiating an LLM call.
   * If totalCommitted + reservation > limit, throws BudgetExceededError before making the call.
   * If a parent guard is configured, reserves against both the child and parent guards.
   */
  reserve(estimatedTokens?: number): BudgetReservation {
    const reservationAmount =
      typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) && estimatedTokens > 0
        ? Math.round(estimatedTokens)
        : this.defaultReservationTokens;

    // 1. Check local limit if configured
    if (this.maxTokens !== undefined && this.totalCommitted + reservationAmount > this.maxTokens) {
      throw new BudgetExceededError(
        `Token budget exceeded${this._label ? ` for ${this._label}` : ''}: limit is ${this.maxTokens}, committed is ${this.totalCommitted}, requested reservation is ${reservationAmount}.`,
        this.totalCommitted,
        reservationAmount,
        this.maxTokens
      );
    }

    // 2. Reserve in parent if hierarchical
    let parentReservation: BudgetReservation | null = null;
    if (this._parent) {
      parentReservation = this._parent.reserve(reservationAmount);
    }

    this.activeReservations += reservationAmount;
    this.checkWarningThresholds();
    let finished = false;

    return {
      reservedTokens: reservationAmount,
      commit: (actualTokens?: number | null) => {
        if (finished) return;
        finished = true;
        this.activeReservations -= reservationAmount;
        const tokensToCommit =
          typeof actualTokens === 'number' && Number.isFinite(actualTokens) && actualTokens >= 0
            ? Math.round(actualTokens)
            : reservationAmount;
        this.consumedTokens += tokensToCommit;
        parentReservation?.commit(tokensToCommit);
        this.checkWarningThresholds();
      },
      release: () => {
        if (finished) return;
        finished = true;
        this.activeReservations -= reservationAmount;
        parentReservation?.release();
      },
    };
  }

  /**
   * Adaptively checks and reserves capacity for a model call:
   * 1. Evaluates available remaining capacity across both local ceiling and parent hierarchy.
   * 2. Evaluates estimated prompt tokens (if provided) and minimum useful completion floor.
   * 3. If available headroom cannot accommodate prompt + minUsefulTokens, throws BudgetExceededError (true exhaustion).
   * 4. Otherwise, clamps the allowed completion tokens to Math.min(requestedTokens, available - promptTokens).
   * 5. Atomically reserves promptTokens + effectiveCompletionTokens.
   * 6. Returns the reservation and effective completion token count for the outbound provider request.
   */
  reserveAdaptive(
    estimatedTokens?: number,
    minUsefulTokens?: number,
    estimatedPromptTokens?: number
  ): AdaptiveReservationResult {
    const requested =
      typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) && estimatedTokens > 0
        ? Math.round(estimatedTokens)
        : this.defaultReservationTokens;

    const minFloor =
      typeof minUsefulTokens === 'number' && Number.isFinite(minUsefulTokens) && minUsefulTokens > 0
        ? Math.round(minUsefulTokens)
        : this._minUsefulTokens;

    const promptTokens =
      typeof estimatedPromptTokens === 'number' &&
      Number.isFinite(estimatedPromptTokens) &&
      estimatedPromptTokens > 0
        ? Math.round(estimatedPromptTokens)
        : 0;

    const available = this.remaining;
    const requiredFloor = Math.min(requested, minFloor);
    const requiredTotal = promptTokens + requiredFloor;

    if (available < requiredTotal) {
      const limit = this.limit;
      const detail =
        promptTokens > 0
          ? `remaining capacity (${available}) is below minimum useful threshold (${requiredTotal}: ${promptTokens} prompt + ${requiredFloor} completion floor).`
          : `remaining capacity (${available}) is below minimum useful threshold (${minFloor}).`;
      throw new BudgetExceededError(
        `Token budget exceeded${this._label ? ` for ${this._label}` : ''}: limit is ${limit}, committed is ${this.totalCommitted}, ${detail}`,
        this.totalCommitted,
        requested + promptTokens,
        limit
      );
    }

    const maxCompletionAllowed = Math.max(0, available - promptTokens);
    const effectiveTokens = Math.min(requested, maxCompletionAllowed);

    if (effectiveTokens < requiredFloor) {
      const limit = this.limit;
      throw new BudgetExceededError(
        `Token budget exceeded${this._label ? ` for ${this._label}` : ''}: limit is ${limit}, committed is ${this.totalCommitted}, remaining capacity (${available}) is below minimum useful threshold (${minFloor}).`,
        this.totalCommitted,
        requested + promptTokens,
        limit
      );
    }

    const reservation = this.reserve(effectiveTokens);

    return {
      reservation,
      effectiveTokens,
      requestedTokens: requested,
      clamped: effectiveTokens < requested,
      estimatedPromptTokens: promptTokens,
      totalReservedTokens: effectiveTokens,
    };
  }

  /**
   * Resets usage counters.
   */
  reset(): void {
    this.consumedTokens = 0;
    this.activeReservations = 0;
    this.triggeredWarnings.clear();
    this.warningEvents.length = 0;
  }
}
