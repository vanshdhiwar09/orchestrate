import { describe, it, expect } from 'vitest';
import {
  validateTrialIntegrity,
  IntegrityGuard,
  INTEGRITY_VIOLATION_CODES,
  type IntegrityCheckOptions,
} from '../../src/harness/integrity-guard.js';
import { buildTrial } from '../../src/harness/trial-builder.js';
import { attachArmTriad } from '../../src/harness/arm-builder.js';
import type {
  HarnessExecutionControls,
  RawExecutionEvidence,
  TrialIdentity,
  TrialRecord,
  BenchmarkVerificationEvidence,
} from '../../src/harness/types.js';

describe('Integrity Guard (M7 Phase 4)', () => {
  const dummyControls: HarnessExecutionControls = {
    modelId: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
    temperature: 0.2,
    topP: 0.95,
    maxTokens: 4096,
    seed: 42,
    baseSystemInstructions: 'You are a senior software engineer.',
    toolDefinitions: [{ name: 'file_read', description: 'Read file contents' }],
    toolPermissions: ['file_read', 'file_write'],
    taskTimeoutMs: 600000,
    maxSteps: 30,
    commandTimeoutMs: 30000,
    sanitizedEnv: { PATH: '/usr/bin' },
    harnessVersion: '1.0.0',
  };

  const validIdentity: TrialIdentity = {
    runId: 'run-auth-trial-001',
    scenarioId: 'scenario-auth-api',
    replication: 1,
    taskAId: 'task-a-jwt',
    taskBId: 'task-b-login',
    snapshotId: 'snap-auth-001',
    snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
  };

  const validTaskBPrompt = 'Implement the protected authentication endpoint according to requirements.';
  const envFingerprint = 'node:22.0.0|npm:10.0.0|os:win32';
  const armBNotes = 'Task A completed JWT middleware and created src/jwt.ts.';
  const armCContext = 'Verified knowledge: JWT middleware exports verifyToken(req).';

  function createValidTrialWithArms(): TrialRecord {
    const trial = buildTrial({
      identity: validIdentity,
      taskBPrompt: validTaskBPrompt,
      controls: dummyControls,
      environmentDependencyFingerprint: envFingerprint,
      armOrderSeed: 42,
    });

    return attachArmTriad(trial, {
      taskBPrompt: validTaskBPrompt,
      armBUnverifiedHandoff: armBNotes,
      armCCompiledContext: armCContext,
    });
  }

  function cloneTrial(trial: TrialRecord): TrialRecord {
    return JSON.parse(JSON.stringify(trial));
  }

  // 1. valid A/B/C triad passes
  it('1. valid A/B/C triad passes', () => {
    const trial = createValidTrialWithArms();
    const result = validateTrialIntegrity(trial);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    // IntegrityGuard class wrapper produces identical result
    const classResult = IntegrityGuard.validate(trial);
    expect(classResult.valid).toBe(true);
    expect(classResult.violations).toHaveLength(0);
  });

  // 2. control fingerprint mismatch fails
  it('2. control fingerprint mismatch fails', () => {
    const trial = createValidTrialWithArms();
    const mutated = cloneTrial(trial);

    // Tamper model identity in ARM_B control fingerprint
    mutated.arms.ARM_B_UNVERIFIED_HANDOFF.input.controlFingerprint.modelIdentity = 'openai/gpt-4o';

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);

    const violation = result.violations.find(
      (v) => v.code === INTEGRITY_VIOLATION_CODES.CONTROL_FINGERPRINT_MISMATCH
    );
    expect(violation).toBeDefined();
    expect(violation?.category).toBe('CATEGORY_A');
    expect(violation?.severity).toBe('CRITICAL');
    expect(violation?.armId).toBe('ARM_B_UNVERIFIED_HANDOFF');
  });

  // 3. snapshot SHA mismatch fails
  it('3. snapshot SHA mismatch fails', () => {
    const trial = createValidTrialWithArms();

    // 3a. Arm starting commit mismatch
    const mutatedArm = cloneTrial(trial);
    mutatedArm.arms.ARM_C_ORCHESTRATE.input.snapshotCommitSha =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const resultArm = validateTrialIntegrity(mutatedArm);
    expect(resultArm.valid).toBe(false);
    expect(
      resultArm.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH &&
          v.armId === 'ARM_C_ORCHESTRATE'
      )
    ).toBe(true);

    // 3b. Trial identity snapshot SHA format invalid
    const mutatedTrial = cloneTrial(trial);
    (mutatedTrial.identity as Record<string, unknown>).snapshotCommitSha = 'invalid-short-sha';

    const resultTrial = validateTrialIntegrity(mutatedTrial);
    expect(resultTrial.valid).toBe(false);
    expect(
      resultTrial.violations.some(
        (v) => v.code === INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH
      )
    ).toBe(true);
  });

  // 4. missing arm fails
  it('4. missing arm fails', () => {
    const trial = createValidTrialWithArms();
    const mutated = cloneTrial(trial);

    // Delete ARM_C
    delete (mutated.arms as Record<string, unknown>).ARM_C_ORCHESTRATE;

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);
    const violation = result.violations.find(
      (v) => v.code === INTEGRITY_VIOLATION_CODES.MISSING_ARM_RECORD && v.armId === 'ARM_C_ORCHESTRATE'
    );
    expect(violation).toBeDefined();
    expect(violation?.message).toContain('ARM_C_ORCHESTRATE');
  });

  // 5. duplicate arm fails
  it('5. duplicate arm fails', () => {
    const trial = createValidTrialWithArms();

    // 5a. Duplicate arm in custom arms array
    const armA = trial.arms.ARM_A_BASELINE;
    const armB = trial.arms.ARM_B_UNVERIFIED_HANDOFF;
    const duplicateArmsResult = validateTrialIntegrity(trial, {
      arms: [armA, armB, armB],
    });
    expect(duplicateArmsResult.valid).toBe(false);
    expect(
      duplicateArmsResult.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.DUPLICATE_ARM_RECORD &&
          v.armId === 'ARM_B_UNVERIFIED_HANDOFF'
      )
    ).toBe(true);

    // 5b. Duplicate arm in executionOrder
    const mutatedOrder = cloneTrial(trial);
    mutatedOrder.executionOrder = [
      'ARM_A_BASELINE',
      'ARM_B_UNVERIFIED_HANDOFF',
      'ARM_B_UNVERIFIED_HANDOFF',
    ];
    const orderResult = validateTrialIntegrity(mutatedOrder);
    expect(orderResult.valid).toBe(false);
    expect(
      orderResult.violations.some((v) => v.code === INTEGRITY_VIOLATION_CODES.DUPLICATE_ARM_RECORD)
    ).toBe(true);
  });

  // 6. incorrect treatment payload fails
  it('6. incorrect treatment payload fails', () => {
    const trial = createValidTrialWithArms();

    // 6a. Tampered payload not matching treatment hash
    const mutated = cloneTrial(trial);
    mutated.arms.ARM_B_UNVERIFIED_HANDOFF.input.contextEnvelope!.rawPayload =
      'tampered payload content';

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH &&
          v.armId === 'ARM_B_UNVERIFIED_HANDOFF'
      )
    ).toBe(true);

    // 6b. Empty payload on ARM_C
    const mutatedEmpty = cloneTrial(trial);
    mutatedEmpty.arms.ARM_C_ORCHESTRATE.input.contextEnvelope!.rawPayload = '   ';
    const resultEmpty = validateTrialIntegrity(mutatedEmpty);
    expect(resultEmpty.valid).toBe(false);
    expect(
      resultEmpty.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH &&
          v.armId === 'ARM_C_ORCHESTRATE'
      )
    ).toBe(true);
  });

  // 7. A receiving B context fails
  it('7. A receiving B context fails', () => {
    const trial = createValidTrialWithArms();

    // 7a. ARM_A contextEnvelope contains payload
    const mutatedEnv = cloneTrial(trial);
    (mutatedEnv.arms.ARM_A_BASELINE.input as Record<string, unknown>).contextEnvelope =
      trial.arms.ARM_B_UNVERIFIED_HANDOFF.input.contextEnvelope;

    const resultEnv = validateTrialIntegrity(mutatedEnv);
    expect(resultEnv.valid).toBe(false);
    expect(
      resultEnv.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION &&
          v.armId === 'ARM_A_BASELINE'
      )
    ).toBe(true);

    // 7b. ARM_A systemPrompt contains <orchestrate_handoff>
    const mutatedPrompt = cloneTrial(trial);
    mutatedPrompt.arms.ARM_A_BASELINE.input.systemPrompt +=
      '\n<orchestrate_handoff>leaked</orchestrate_handoff>';

    const resultPrompt = validateTrialIntegrity(mutatedPrompt);
    expect(resultPrompt.valid).toBe(false);
    expect(
      resultPrompt.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION &&
          v.armId === 'ARM_A_BASELINE'
      )
    ).toBe(true);
  });

  // 8. B receiving C context fails
  it('8. B receiving C context fails', () => {
    const trial = createValidTrialWithArms();
    const mutated = cloneTrial(trial);

    mutated.arms.ARM_B_UNVERIFIED_HANDOFF.input.systemPrompt +=
      '\n<orchestrate_context>C context leaked into B</orchestrate_context>';

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION &&
          v.armId === 'ARM_B_UNVERIFIED_HANDOFF'
      )
    ).toBe(true);
  });

  // 9. C receiving B context fails
  it('9. C receiving B context fails', () => {
    const trial = createValidTrialWithArms();
    const mutated = cloneTrial(trial);

    mutated.arms.ARM_C_ORCHESTRATE.input.systemPrompt +=
      '\n<orchestrate_handoff>B handoff leaked into C</orchestrate_handoff>';

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION &&
          v.armId === 'ARM_C_ORCHESTRATE'
      )
    ).toBe(true);
  });

  // 10. agent-blinding violation fails
  it('10. agent-blinding violation fails', () => {
    const trial = createValidTrialWithArms();

    // 10a. Arm ID leaked into prompt
    const mutatedArmId = cloneTrial(trial);
    mutatedArmId.arms.ARM_B_UNVERIFIED_HANDOFF.input.taskBPrompt +=
      ' Note: you are running in ARM_A_BASELINE.';

    const resultArmId = validateTrialIntegrity(mutatedArmId);
    expect(resultArmId.valid).toBe(false);
    expect(
      resultArmId.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.AGENT_BLINDING_VIOLATION &&
          v.armId === 'ARM_B_UNVERIFIED_HANDOFF'
      )
    ).toBe(true);

    // 10b. Metric token leaked into system prompt
    const mutatedMetric = cloneTrial(trial);
    mutatedMetric.arms.ARM_C_ORCHESTRATE.input.systemPrompt +=
      ' Be sure to optimize discovery_actions!';

    const resultMetric = validateTrialIntegrity(mutatedMetric);
    expect(resultMetric.valid).toBe(false);
    expect(
      resultMetric.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.AGENT_BLINDING_VIOLATION &&
          v.armId === 'ARM_C_ORCHESTRATE'
      )
    ).toBe(true);

    // 10c. Trial runId leaked into prompt
    const mutatedRunId = cloneTrial(trial);
    mutatedRunId.arms.ARM_A_BASELINE.input.taskBPrompt += ` Benchmark trial id: ${validIdentity.runId}`;

    const resultRunId = validateTrialIntegrity(mutatedRunId);
    expect(resultRunId.valid).toBe(false);
    expect(
      resultRunId.violations.some(
        (v) =>
          v.code === INTEGRITY_VIOLATION_CODES.AGENT_BLINDING_VIOLATION &&
          v.armId === 'ARM_A_BASELINE'
      )
    ).toBe(true);
  });

  // 11. duplicate workspace identity fails
  it('11. duplicate workspace identity fails', () => {
    const trial = createValidTrialWithArms();

    const options: IntegrityCheckOptions = {
      armWorkspaces: {
        ARM_A_BASELINE: 'C:/temp/workspaces/ws-shared',
        ARM_B_UNVERIFIED_HANDOFF: 'c:\\temp\\workspaces\\ws-shared\\',
        ARM_C_ORCHESTRATE: 'C:/temp/workspaces/ws-c',
      },
    };

    const result = validateTrialIntegrity(trial, options);
    expect(result.valid).toBe(false);

    const violation = result.violations.find(
      (v) => v.code === INTEGRITY_VIOLATION_CODES.DUPLICATE_WORKSPACE_IDENTITY
    );
    expect(violation).toBeDefined();
    expect(violation?.category).toBe('CATEGORY_A');
    expect(violation?.severity).toBe('CRITICAL');
    expect(violation?.message).toContain('isolated workspace');
  });

  // 12. multiple violations are reported deterministically
  it('12. multiple violations are reported deterministically', () => {
    const trial = createValidTrialWithArms();
    const mutated = cloneTrial(trial);

    // Violation 1: starting commit mismatch on ARM_A
    mutated.arms.ARM_A_BASELINE.input.snapshotCommitSha =
      'ffffffffffffffffffffffffffffffffffffffff';

    // Violation 2: agent blinding violation on ARM_B
    mutated.arms.ARM_B_UNVERIFIED_HANDOFF.input.taskBPrompt += ' Leak: ARM_C_ORCHESTRATE';

    // Violation 3: unintended context injection on ARM_C
    mutated.arms.ARM_C_ORCHESTRATE.input.systemPrompt += '\n<orchestrate_handoff>leak</orchestrate_handoff>';

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);

    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain(INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH);
    expect(codes).toContain(INTEGRITY_VIOLATION_CODES.AGENT_BLINDING_VIOLATION);
    expect(codes).toContain(INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  // 13. input objects are not mutated
  it('13. input objects are not mutated', () => {
    const trial = createValidTrialWithArms();
    const originalJson = JSON.stringify(trial);

    const options: IntegrityCheckOptions = {
      armWorkspaces: {
        ARM_A_BASELINE: '/tmp/ws-a',
        ARM_B_UNVERIFIED_HANDOFF: '/tmp/ws-b',
        ARM_C_ORCHESTRATE: '/tmp/ws-c',
      },
    };
    const optionsJson = JSON.stringify(options);

    const result = validateTrialIntegrity(trial, options);

    // Verify trial and options remain completely unchanged
    expect(JSON.stringify(trial)).toBe(originalJson);
    expect(JSON.stringify(options)).toBe(optionsJson);

    // Verify returned result is deep-frozen
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.violations)).toBe(true);
  });

  // 14. pre-execution absence of verification evidence is NOT incorrectly classified as an integrity violation
  it('14. pre-execution absence of verification evidence is NOT incorrectly classified as an integrity violation', () => {
    const trial = createValidTrialWithArms();

    // Pre-execution states: CREATED, SNAPSHOT_READY, ARMS_READY
    // attachArmTriad sets state to 'ARMS_READY'
    expect(trial.state).toBe('ARMS_READY');
    const preResult = validateTrialIntegrity(trial);

    expect(preResult.valid).toBe(true);
    expect(
      preResult.violations.some((v) => v.code === INTEGRITY_VIOLATION_CODES.MISSING_REQUIRED_EVIDENCE)
    ).toBe(false);

    // Post-execution state: MEASURED requires verification evidence
    const measuredTrial = { ...trial, state: 'MEASURED' as const };
    const postResult = validateTrialIntegrity(measuredTrial);

    expect(postResult.valid).toBe(false);
    expect(
      postResult.violations.some(
        (v) => v.code === INTEGRITY_VIOLATION_CODES.MISSING_REQUIRED_EVIDENCE
      )
    ).toBe(true);
  });

  // 15. deterministic result ordering
  it('15. deterministic result ordering', () => {
    const trial = createValidTrialWithArms();
    const mutated = cloneTrial(trial);

    // Multiple violations across arms
    mutated.arms.ARM_A_BASELINE.input.snapshotCommitSha =
      '1111111111111111111111111111111111111111';
    mutated.arms.ARM_B_UNVERIFIED_HANDOFF.input.taskBPrompt += ' Leak: ARM_C_ORCHESTRATE';
    mutated.arms.ARM_C_ORCHESTRATE.input.systemPrompt += '\n<orchestrate_handoff>leak</orchestrate_handoff>';

    const results = Array.from({ length: 10 }, () => validateTrialIntegrity(mutated));

    const baselineJson = JSON.stringify(results[0].violations);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i].violations)).toBe(baselineJson);
    }
  });

  // Additional edge cases: null/malformed trial and post-execution evidence binding
  describe('Edge cases and evidence validation', () => {
    it('handles null or non-object trial gracefully without crashing', () => {
      const result = validateTrialIntegrity(null as unknown as TrialRecord);
      expect(result.valid).toBe(false);
      expect(result.violations[0].code).toBe(INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY);
    });

    it('validates post-execution raw evidence snapshot consistency when present', () => {
      const baseTrial = createValidTrialWithArms();
      const trial = { ...baseTrial, state: 'EVIDENCE_CAPTURED' as const };

      const mockEvidence = (armId: any, commitSha: string): RawExecutionEvidence => ({
        trialId: validIdentity.runId,
        armId,
        snapshotCommitSha: commitSha,
        workspacePath: `/tmp/${armId}`,
        modelIdentity: dummyControls.modelId,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1000,
        outcome: 'COMPLETED',
        modelEvents: [],
        toolEvents: [],
        finalResponse: null,
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          total_tokens: 20,
          estimated_cost_usd: 0.001,
          usage_available: true,
        },
        evidenceContentHash: 'abc',
      });

      // Valid evidence matches snapshot SHA
      const validEvResult = validateTrialIntegrity(trial, {
        rawEvidence: {
          ARM_A_BASELINE: mockEvidence('ARM_A_BASELINE', validIdentity.snapshotCommitSha),
          ARM_B_UNVERIFIED_HANDOFF: mockEvidence(
            'ARM_B_UNVERIFIED_HANDOFF',
            validIdentity.snapshotCommitSha
          ),
          ARM_C_ORCHESTRATE: mockEvidence('ARM_C_ORCHESTRATE', validIdentity.snapshotCommitSha),
        },
      });
      expect(validEvResult.valid).toBe(true);

      // Mismatched snapshot SHA in raw evidence
      const mismatchEvResult = validateTrialIntegrity(trial, {
        rawEvidence: {
          ARM_A_BASELINE: mockEvidence('ARM_A_BASELINE', '9999999999999999999999999999999999999999'),
          ARM_B_UNVERIFIED_HANDOFF: mockEvidence(
            'ARM_B_UNVERIFIED_HANDOFF',
            validIdentity.snapshotCommitSha
          ),
          ARM_C_ORCHESTRATE: mockEvidence('ARM_C_ORCHESTRATE', validIdentity.snapshotCommitSha),
        },
      });
      expect(mismatchEvResult.valid).toBe(false);
      expect(
        mismatchEvResult.violations.some(
          (v) =>
            v.code === INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH &&
            v.armId === 'ARM_A_BASELINE'
        )
      ).toBe(true);
    });
  });
});
