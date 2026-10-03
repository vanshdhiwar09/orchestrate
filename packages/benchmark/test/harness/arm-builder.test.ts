import { describe, it, expect } from 'vitest';
import {
  buildArmTriad,
  attachArmTriad,
  assertAgentBlinded,
  formatArmBTreatmentBlock,
  formatArmCTreatmentBlock,
} from '../../src/harness/arm-builder.js';
import { buildTrial } from '../../src/harness/trial-builder.js';
import type { HarnessExecutionControls, TrialIdentity } from '../../src/harness/types.js';

describe('ArmBuilder', () => {
  const dummyControls: HarnessExecutionControls = {
    modelId: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
    temperature: 0.2,
    baseSystemInstructions: 'You are a senior software engineer.',
    toolDefinitions: [],
    toolPermissions: ['file_read'],
    taskTimeoutMs: 600000,
    maxSteps: 30,
    commandTimeoutMs: 30000,
    sanitizedEnv: { PATH: '/usr/bin' },
    harnessVersion: '1.0.0',
  };

  const validIdentity: TrialIdentity = {
    runId: 'trial-run-123',
    scenarioId: 'auth-protected-api',
    replication: 1,
    taskAId: 'task-a-impl',
    taskBId: 'task-b-impl',
    snapshotId: 'snap-456',
    snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
  };

  const validTaskBPrompt = 'Implement the protected authentication endpoint according to requirements.';
  const envFingerprint = 'node:22.0.0|npm:10.0.0|os:win32';

  const trial = buildTrial({
    identity: validIdentity,
    taskBPrompt: validTaskBPrompt,
    controls: dummyControls,
    environmentDependencyFingerprint: envFingerprint,
  });

  const validArmBNotes = 'Task A completed user registration service with POST /register.';
  const validArmCContext = 'Facts: Registration handler exports POST /register with schema validation.';

  describe('formatArmBTreatmentBlock & formatArmCTreatmentBlock', () => {
    it('wraps Arm B in <orchestrate_handoff>', () => {
      const block = formatArmBTreatmentBlock('some unverified notes');
      expect(block).toBe('<orchestrate_handoff>\nsome unverified notes\n</orchestrate_handoff>');
    });

    it('wraps Arm C in <orchestrate_context>', () => {
      const block = formatArmCTreatmentBlock('verified facts');
      expect(block).toBe('<orchestrate_context>\nverified facts\n</orchestrate_context>');
    });
  });

  describe('buildArmTriad', () => {
    it('constructs all three canonical arms with NOT_STARTED status', () => {
      const arms = buildArmTriad(trial, {
        taskBPrompt: validTaskBPrompt,
        armBUnverifiedHandoff: validArmBNotes,
        armCCompiledContext: validArmCContext,
      });

      expect(arms.ARM_A_BASELINE).toBeDefined();
      expect(arms.ARM_B_UNVERIFIED_HANDOFF).toBeDefined();
      expect(arms.ARM_C_ORCHESTRATE).toBeDefined();

      expect(arms.ARM_A_BASELINE.status).toBe('NOT_STARTED');
      expect(arms.ARM_B_UNVERIFIED_HANDOFF.status).toBe('NOT_STARTED');
      expect(arms.ARM_C_ORCHESTRATE.status).toBe('NOT_STARTED');
    });

    it('enforces ControlFingerprint(A) == ControlFingerprint(B) == ControlFingerprint(C)', () => {
      const arms = buildArmTriad(trial, {
        taskBPrompt: validTaskBPrompt,
        armBUnverifiedHandoff: validArmBNotes,
        armCCompiledContext: validArmCContext,
      });

      const cfA = arms.ARM_A_BASELINE.input.controlFingerprint;
      const cfB = arms.ARM_B_UNVERIFIED_HANDOFF.input.controlFingerprint;
      const cfC = arms.ARM_C_ORCHESTRATE.input.controlFingerprint;

      expect(cfA).toEqual(trial.controlFingerprint);
      expect(cfB).toEqual(trial.controlFingerprint);
      expect(cfC).toEqual(trial.controlFingerprint);
    });

    it('enforces TreatmentFingerprint(A) != TreatmentFingerprint(B) != TreatmentFingerprint(C)', () => {
      const arms = buildArmTriad(trial, {
        taskBPrompt: validTaskBPrompt,
        armBUnverifiedHandoff: validArmBNotes,
        armCCompiledContext: validArmCContext,
      });

      const tfA = arms.ARM_A_BASELINE.input.treatmentFingerprint;
      const tfB = arms.ARM_B_UNVERIFIED_HANDOFF.input.treatmentFingerprint;
      const tfC = arms.ARM_C_ORCHESTRATE.input.treatmentFingerprint;

      expect(tfA.armId).toBe('ARM_A_BASELINE');
      expect(tfB.armId).toBe('ARM_B_UNVERIFIED_HANDOFF');
      expect(tfC.armId).toBe('ARM_C_ORCHESTRATE');

      expect(tfA.treatmentPayloadHash).not.toBe(tfB.treatmentPayloadHash);
      expect(tfB.treatmentPayloadHash).not.toBe(tfC.treatmentPayloadHash);
      expect(tfA.treatmentPayloadHash).not.toBe(tfC.treatmentPayloadHash);
    });

    it('sets contextEnvelope to null for ARM_A_BASELINE', () => {
      const arms = buildArmTriad(trial, {
        taskBPrompt: validTaskBPrompt,
        armBUnverifiedHandoff: validArmBNotes,
        armCCompiledContext: validArmCContext,
      });

      expect(arms.ARM_A_BASELINE.input.contextEnvelope).toBeNull();
      expect(arms.ARM_A_BASELINE.input.systemPrompt).toBe(dummyControls.baseSystemInstructions);
    });

    it('sets formatted blocks in contextEnvelope for ARM_B and ARM_C', () => {
      const arms = buildArmTriad(trial, {
        taskBPrompt: validTaskBPrompt,
        armBUnverifiedHandoff: validArmBNotes,
        armCCompiledContext: validArmCContext,
      });

      expect(arms.ARM_B_UNVERIFIED_HANDOFF.input.contextEnvelope?.formattedBlock).toContain(
        '<orchestrate_handoff>'
      );
      expect(arms.ARM_C_ORCHESTRATE.input.contextEnvelope?.formattedBlock).toContain(
        '<orchestrate_context>'
      );
    });

    it('rejects taskBPrompt that does not match the trial control fingerprint', () => {
      expect(() =>
        buildArmTriad(trial, {
          taskBPrompt: 'Mismatched prompt that differs from trial registration.',
          armBUnverifiedHandoff: validArmBNotes,
          armCCompiledContext: validArmCContext,
        })
      ).toThrow('taskBPrompt does not match the trial controlFingerprint.taskBPromptHash');
    });

    it('rejects empty treatment payloads for ARM_B and ARM_C', () => {
      expect(() =>
        buildArmTriad(trial, {
          taskBPrompt: validTaskBPrompt,
          armBUnverifiedHandoff: '',
          armCCompiledContext: validArmCContext,
        })
      ).toThrow('armBUnverifiedHandoff must be a non-empty string');

      expect(() =>
        buildArmTriad(trial, {
          taskBPrompt: validTaskBPrompt,
          armBUnverifiedHandoff: validArmBNotes,
          armCCompiledContext: '  ',
        })
      ).toThrow('armCCompiledContext must be a non-empty string');
    });
  });

  describe('Agent Blinding Invariant', () => {
    it('assertAgentBlinded throws on arm ID leakage', () => {
      expect(() =>
        assertAgentBlinded('Please review ARM_A_BASELINE behavior', trial, 'taskBPrompt')
      ).toThrow('forbidden token "ARM_A_BASELINE"');

      expect(() =>
        assertAgentBlinded('Please review ARM_B_UNVERIFIED_HANDOFF', trial, 'taskBPrompt')
      ).toThrow('forbidden token "ARM_B_UNVERIFIED_HANDOFF"');

      expect(() =>
        assertAgentBlinded('Please review ARM_C_ORCHESTRATE', trial, 'taskBPrompt')
      ).toThrow('forbidden token "ARM_C_ORCHESTRATE"');
    });

    it('assertAgentBlinded throws on metric name leakage', () => {
      expect(() =>
        assertAgentBlinded('Reduce discovery_actions for better score', trial, 'systemPrompt')
      ).toThrow('forbidden token "discovery_actions"');

      expect(() =>
        assertAgentBlinded('Avoid rework_events in Task B', trial, 'systemPrompt')
      ).toThrow('forbidden token "rework_events"');
    });

    it('assertAgentBlinded throws on trial runId leakage', () => {
      expect(() =>
        assertAgentBlinded(`Running trial trial-run-123 now`, trial, 'taskBPrompt')
      ).toThrow('trial runId "trial-run-123" found in taskBPrompt');
    });

    it('buildArmTriad throws if input prompt contains forbidden token', () => {
      // Build a trial with a contaminated prompt to test builder-level enforcement
      const contaminatedPrompt = 'Implement endpoint without increasing discovery_actions.';
      const trialWithLeak = buildTrial({
        identity: validIdentity,
        taskBPrompt: contaminatedPrompt,
        controls: dummyControls,
        environmentDependencyFingerprint: envFingerprint,
      });

      expect(() =>
        buildArmTriad(trialWithLeak, {
          taskBPrompt: contaminatedPrompt,
          armBUnverifiedHandoff: validArmBNotes,
          armCCompiledContext: validArmCContext,
        })
      ).toThrow('Agent blinding violation: forbidden token "discovery_actions"');
    });
  });

  describe('attachArmTriad', () => {
    it('returns new frozen TrialRecord with state ARMS_READY and arms attached', () => {
      const trialWithArms = attachArmTriad(trial, {
        taskBPrompt: validTaskBPrompt,
        armBUnverifiedHandoff: validArmBNotes,
        armCCompiledContext: validArmCContext,
      });

      expect(trialWithArms.state).toBe('ARMS_READY');
      expect(trialWithArms.arms).toBeDefined();
      expect(trialWithArms.arms?.ARM_A_BASELINE).toBeDefined();
      expect(trialWithArms.arms?.ARM_B_UNVERIFIED_HANDOFF).toBeDefined();
      expect(trialWithArms.arms?.ARM_C_ORCHESTRATE).toBeDefined();
      expect(Object.isFrozen(trialWithArms)).toBe(true);
    });
  });
});
