import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertValidTransition,
  transitionTrial,
  TrialStateMachine,
  IllegalStateTransitionError,
} from '../../src/harness/trial-state-machine.js';
import { buildTrial } from '../../src/harness/trial-builder.js';
import type {
  HarnessExecutionControls,
  TrialIdentity,
  TrialRecord,
  TrialLifecycleState,
} from '../../src/harness/types.js';

describe('Trial State Machine (M7 Phase 4.2)', () => {
  const dummyControls: HarnessExecutionControls = {
    modelId: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
    baseSystemInstructions: 'You are a senior software engineer.',
    toolDefinitions: [],
    toolPermissions: [],
    taskTimeoutMs: 60000,
    maxSteps: 30,
    commandTimeoutMs: 10000,
    sanitizedEnv: {},
    harnessVersion: '1.0.0',
  };

  const validIdentity: TrialIdentity = {
    runId: 'run-sm-001',
    scenarioId: 'scenario-test',
    replication: 1,
    taskAId: 'task-a',
    taskBId: 'task-b',
    snapshotId: 'snap-001',
    snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
  };

  function createTestTrial(): TrialRecord {
    return buildTrial({
      identity: validIdentity,
      taskBPrompt: 'Implement task B feature.',
      controls: dummyControls,
      environmentDependencyFingerprint: 'node:22|env',
      armOrderSeed: 1234,
    });
  }

  // 1. CREATED -> SNAPSHOT_READY succeeds
  it('1. CREATED -> SNAPSHOT_READY succeeds', () => {
    const trial = createTestTrial();
    expect(trial.state).toBe('CREATED');
    expect(canTransition('CREATED', 'SNAPSHOT_READY')).toBe(true);

    const updated = transitionTrial(trial, 'SNAPSHOT_READY');
    expect(updated.state).toBe('SNAPSHOT_READY');
  });

  // 2. SNAPSHOT_READY -> ARMS_READY succeeds
  it('2. SNAPSHOT_READY -> ARMS_READY succeeds', () => {
    const trial = transitionTrial(createTestTrial(), 'SNAPSHOT_READY');
    expect(canTransition('SNAPSHOT_READY', 'ARMS_READY')).toBe(true);

    const updated = transitionTrial(trial, 'ARMS_READY');
    expect(updated.state).toBe('ARMS_READY');
  });

  // 3. ARMS_READY -> EXECUTING succeeds
  it('3. ARMS_READY -> EXECUTING succeeds', () => {
    let trial = transitionTrial(createTestTrial(), 'SNAPSHOT_READY');
    trial = transitionTrial(trial, 'ARMS_READY');
    expect(canTransition('ARMS_READY', 'EXECUTING')).toBe(true);

    const updated = transitionTrial(trial, 'EXECUTING');
    expect(updated.state).toBe('EXECUTING');
  });

  // 4. EXECUTING -> EVIDENCE_CAPTURED succeeds
  it('4. EXECUTING -> EVIDENCE_CAPTURED succeeds', () => {
    let trial = transitionTrial(createTestTrial(), 'SNAPSHOT_READY');
    trial = transitionTrial(trial, 'ARMS_READY');
    trial = transitionTrial(trial, 'EXECUTING');
    expect(canTransition('EXECUTING', 'EVIDENCE_CAPTURED')).toBe(true);

    const updated = transitionTrial(trial, 'EVIDENCE_CAPTURED');
    expect(updated.state).toBe('EVIDENCE_CAPTURED');
  });

  // 5. EVIDENCE_CAPTURED -> MEASURED succeeds
  it('5. EVIDENCE_CAPTURED -> MEASURED succeeds', () => {
    let trial = transitionTrial(createTestTrial(), 'SNAPSHOT_READY');
    trial = transitionTrial(trial, 'ARMS_READY');
    trial = transitionTrial(trial, 'EXECUTING');
    trial = transitionTrial(trial, 'EVIDENCE_CAPTURED');
    expect(canTransition('EVIDENCE_CAPTURED', 'MEASURED')).toBe(true);

    const updated = transitionTrial(trial, 'MEASURED');
    expect(updated.state).toBe('MEASURED');
  });

  // 6. MEASURED -> COMPLETE succeeds
  it('6. MEASURED -> COMPLETE succeeds', () => {
    let trial = transitionTrial(createTestTrial(), 'SNAPSHOT_READY');
    trial = transitionTrial(trial, 'ARMS_READY');
    trial = transitionTrial(trial, 'EXECUTING');
    trial = transitionTrial(trial, 'EVIDENCE_CAPTURED');
    trial = transitionTrial(trial, 'MEASURED');
    expect(canTransition('MEASURED', 'COMPLETE')).toBe(true);

    const updated = transitionTrial(trial, 'COMPLETE');
    expect(updated.state).toBe('COMPLETE');
  });

  // 7. any illegal transition fails
  it('7. any illegal transition fails', () => {
    const trial = createTestTrial(); // CREATED

    // Illegal skip: CREATED -> EXECUTING
    expect(canTransition('CREATED', 'EXECUTING')).toBe(false);
    expect(() => transitionTrial(trial, 'EXECUTING')).toThrow(IllegalStateTransitionError);

    // Illegal skip: CREATED -> COMPLETE
    expect(canTransition('CREATED', 'COMPLETE')).toBe(false);
    expect(() => transitionTrial(trial, 'COMPLETE')).toThrow(IllegalStateTransitionError);

    // Illegal backward: ARMS_READY -> CREATED
    let armsReadyTrial = transitionTrial(trial, 'SNAPSHOT_READY');
    armsReadyTrial = transitionTrial(armsReadyTrial, 'ARMS_READY');
    expect(canTransition('ARMS_READY', 'CREATED')).toBe(false);
    expect(() => transitionTrial(armsReadyTrial, 'CREATED')).toThrow(IllegalStateTransitionError);

    // Illegal backward: MEASURED -> EXECUTING
    let measuredTrial = transitionTrial(armsReadyTrial, 'EXECUTING');
    measuredTrial = transitionTrial(measuredTrial, 'EVIDENCE_CAPTURED');
    measuredTrial = transitionTrial(measuredTrial, 'MEASURED');
    expect(canTransition('MEASURED', 'EXECUTING')).toBe(false);
    expect(() => transitionTrial(measuredTrial, 'EXECUTING')).toThrow(IllegalStateTransitionError);
  });

  // 8. INVALID is terminal
  it('8. INVALID is terminal', () => {
    const trial = createTestTrial();

    // Any non-terminal state can transition to INVALID
    expect(canTransition('CREATED', 'INVALID')).toBe(true);
    expect(canTransition('SNAPSHOT_READY', 'INVALID')).toBe(true);
    expect(canTransition('ARMS_READY', 'INVALID')).toBe(true);
    expect(canTransition('EXECUTING', 'INVALID')).toBe(true);
    expect(canTransition('EVIDENCE_CAPTURED', 'INVALID')).toBe(true);
    expect(canTransition('MEASURED', 'INVALID')).toBe(true);

    const invalidTrial = transitionTrial(
      trial,
      'INVALID',
      'Integrity preflight failure'
    );
    expect(invalidTrial.state).toBe('INVALID');
    expect(invalidTrial.invalidationReason).toBe('Integrity preflight failure');

    // Attempting any transition from INVALID must fail
    const targetStates: TrialLifecycleState[] = [
      'CREATED',
      'SNAPSHOT_READY',
      'ARMS_READY',
      'EXECUTING',
      'EVIDENCE_CAPTURED',
      'MEASURED',
      'COMPLETE',
      'INVALID',
    ];

    for (const target of targetStates) {
      expect(canTransition('INVALID', target)).toBe(false);
      expect(() => transitionTrial(invalidTrial, target)).toThrow(IllegalStateTransitionError);
    }
  });

  // 9. identity fields cannot mutate
  it('9. identity fields cannot mutate', () => {
    const trial = createTestTrial();
    const originalIdentity = { ...trial.identity };

    let current = trial;
    const states: TrialLifecycleState[] = [
      'SNAPSHOT_READY',
      'ARMS_READY',
      'EXECUTING',
      'EVIDENCE_CAPTURED',
      'MEASURED',
      'COMPLETE',
    ];

    for (const nextState of states) {
      current = transitionTrial(current, nextState);
      expect(current.identity).toEqual(originalIdentity);
      expect(Object.isFrozen(current)).toBe(true);
    }

    // Verify original trial identity was never mutated
    expect(trial.identity).toEqual(originalIdentity);
  });

  // 10. state transitions are deterministic
  it('10. state transitions are deterministic', () => {
    const trial = createTestTrial();

    const t1 = transitionTrial(trial, 'SNAPSHOT_READY');
    const t2 = transitionTrial(trial, 'SNAPSHOT_READY');

    expect(t1.state).toBe(t2.state);
    expect(t1.identity).toEqual(t2.identity);
    expect(t1.controlFingerprint).toEqual(t2.controlFingerprint);

    // Class wrapper produces identical result
    const t3 = TrialStateMachine.transition(trial, 'SNAPSHOT_READY');
    expect(t3.state).toBe('SNAPSHOT_READY');
  });
});
