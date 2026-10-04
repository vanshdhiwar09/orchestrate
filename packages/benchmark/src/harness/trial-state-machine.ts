import type { TrialLifecycleState, TrialRecord } from './types.js';

/**
 * Dedicated error thrown when an illegal trial lifecycle state transition is attempted.
 */
export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly fromState: TrialLifecycleState,
    public readonly toState: TrialLifecycleState,
    message?: string
  ) {
    super(
      message ??
        `Illegal trial lifecycle state transition from "${fromState}" to "${toState}".`
    );
    this.name = 'IllegalStateTransitionError';
  }
}

/**
 * Explicit map of legal forward transitions across the trial lifecycle.
 * In accordance with M6B §15 and M7:
 * CREATED -> SNAPSHOT_READY -> ARMS_READY -> EXECUTING -> EVIDENCE_CAPTURED -> MEASURED -> COMPLETE.
 * Any non-terminal state may transition to INVALID.
 * COMPLETE and INVALID are strictly terminal.
 */
export const LEGAL_TRIAL_TRANSITIONS: ReadonlyMap<
  TrialLifecycleState,
  ReadonlySet<TrialLifecycleState>
> = new Map<TrialLifecycleState, ReadonlySet<TrialLifecycleState>>([
  ['CREATED', new Set(['SNAPSHOT_READY', 'INVALID'])],
  ['SNAPSHOT_READY', new Set(['ARMS_READY', 'INVALID'])],
  ['ARMS_READY', new Set(['EXECUTING', 'INVALID'])],
  ['EXECUTING', new Set(['EVIDENCE_CAPTURED', 'INVALID'])],
  ['EVIDENCE_CAPTURED', new Set(['MEASURED', 'INVALID'])],
  ['MEASURED', new Set(['COMPLETE', 'INVALID'])],
  ['COMPLETE', new Set()],
  ['INVALID', new Set()],
]);

/**
 * Checks whether a lifecycle transition from `fromState` to `toState` is legally permitted.
 */
export function canTransition(
  fromState: TrialLifecycleState,
  toState: TrialLifecycleState
): boolean {
  const allowed = LEGAL_TRIAL_TRANSITIONS.get(fromState);
  if (!allowed) {
    return false;
  }
  return allowed.has(toState);
}

/**
 * Asserts that a lifecycle transition from `fromState` to `toState` is legally permitted.
 * Throws IllegalStateTransitionError if the transition is disallowed.
 */
export function assertValidTransition(
  fromState: TrialLifecycleState,
  toState: TrialLifecycleState
): void {
  if (!canTransition(fromState, toState)) {
    throw new IllegalStateTransitionError(fromState, toState);
  }
}

/**
 * Transitions a TrialRecord to `toState`, returning a new immutable TrialRecord.
 * Throws IllegalStateTransitionError if the transition is illegal.
 * Does NOT mutate the input trial or its immutable identity.
 */
export function transitionTrial(
  trial: TrialRecord,
  toState: TrialLifecycleState,
  invalidationReason?: string
): TrialRecord {
  if (!trial || typeof trial !== 'object') {
    throw new Error('transitionTrial: trial must be a valid non-null TrialRecord.');
  }

  assertValidTransition(trial.state, toState);

  const updated: TrialRecord = {
    ...trial,
    state: toState,
    ...(invalidationReason !== undefined ? { invalidationReason } : {}),
  };

  return Object.freeze(updated);
}

/**
 * State machine managing trial lifecycle transitions.
 */
export class TrialStateMachine {
  /**
   * Evaluates if a transition is legal.
   */
  static canTransition(
    fromState: TrialLifecycleState,
    toState: TrialLifecycleState
  ): boolean {
    return canTransition(fromState, toState);
  }

  /**
   * Asserts validity of a transition.
   */
  static assertValid(
    fromState: TrialLifecycleState,
    toState: TrialLifecycleState
  ): void {
    assertValidTransition(fromState, toState);
  }

  /**
   * Transitions a trial record to the target state.
   */
  static transition(
    trial: TrialRecord,
    toState: TrialLifecycleState,
    invalidationReason?: string
  ): TrialRecord {
    return transitionTrial(trial, toState, invalidationReason);
  }
}
