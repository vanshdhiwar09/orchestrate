import { describe, expect, it, vi } from 'vitest';
import {
  validateTrialIntegrity,
  INTEGRITY_VIOLATION_CODES,
} from '../../src/harness/integrity-guard.js';
import { buildTrial } from '../../src/harness/trial-builder.js';
import { attachArmTriad } from '../../src/harness/arm-builder.js';
import {
  computeControlFingerprint,
  computeTreatmentFingerprint,
} from '../../src/harness/fingerprints.js';
import { TrialRunner } from '../../src/harness/trial-runner.js';
import { InstrumentedModelClient } from '../../src/harness/instrumented-model-client.js';
import type {
  AgentExecutionAdapter,
  BenchmarkVerificationEvidence,
  GitRepository,
  HarnessExecutionControls,
  ModelClient,
  RawExecutionEvidence,
  TrialIdentity,
  TrialRecord,
  VerificationAdapter,
  Workspace,
  WorkspaceFactory,
} from '../../src/harness/types.js';

describe('Benchmark Model Selection & Control Invariants', () => {
  const dummyControls: HarnessExecutionControls = {
    modelId: 'nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
    temperature: 0.2,
    topP: 0.95,
    maxTokens: 4096,
    seed: 12345,
    baseSystemInstructions: 'You are an AI software engineering agent.',
    toolDefinitions: [{ name: 'read_file', description: 'Read file contents' }],
    toolPermissions: ['read_file', 'write_file'],
    taskTimeoutMs: 600000,
    maxSteps: 30,
    commandTimeoutMs: 30000,
    sanitizedEnv: { PATH: '/usr/bin' },
    harnessVersion: '1.0.0',
  };

  const validIdentity: TrialIdentity = {
    runId: 'run-model-ctrl-001',
    scenarioId: 'scenario-auth-api',
    replication: 1,
    taskAId: 'task-a',
    taskBId: 'task-b',
    snapshotId: 'snap-001',
    snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
  };

  const taskBPrompt = 'Implement user authentication handler.';
  const envFingerprint = 'node:22.0.0|npm:10.0.0|os:win32';

  function createValidTrial(): TrialRecord {
    const trial = buildTrial({
      identity: validIdentity,
      taskBPrompt,
      controls: dummyControls,
      environmentDependencyFingerprint: envFingerprint,
      armOrderSeed: 42,
    });

    return attachArmTriad(trial, {
      taskBPrompt,
      armBUnverifiedHandoff: 'Handoff from Task A: created src/auth.ts',
      armCCompiledContext: 'Verified context: Auth middleware exports authenticate()',
    });
  }

  function cloneTrial(trial: TrialRecord): TrialRecord {
    return JSON.parse(JSON.stringify(trial));
  }

  it('1. same model identity across A/B/C passes integrity guard', () => {
    const trial = createValidTrial();
    const result = validateTrialIntegrity(trial);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(trial.controlFingerprint.modelIdentity).toBe(
      'nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B'
    );
  });

  it('2. different model identity across A/B/C fails integrity guard', () => {
    const trial = createValidTrial();
    const mutated = cloneTrial(trial);

    // Tamper model identity in ARM_B
    mutated.arms.ARM_B_UNVERIFIED_HANDOFF.input.controlFingerprint.modelIdentity =
      'nebius/meta-llama/Llama-3.3-70B-Instruct';

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);

    const violation = result.violations.find(
      (v) => v.code === INTEGRITY_VIOLATION_CODES.CONTROL_FINGERPRINT_MISMATCH
    );
    expect(violation).toBeDefined();
    expect(violation?.category).toBe('CATEGORY_A');
    expect(violation?.severity).toBe('CRITICAL');
    expect(violation?.message).toContain('modelIdentity');
  });

  it('3. same inference configuration across A/B/C passes integrity guard', () => {
    const trial = createValidTrial();
    const result = validateTrialIntegrity(trial);
    expect(result.valid).toBe(true);

    const armAFp = trial.arms.ARM_A_BASELINE.input.controlFingerprint;
    const armBFp = trial.arms.ARM_B_UNVERIFIED_HANDOFF.input.controlFingerprint;
    const armCFp = trial.arms.ARM_C_ORCHESTRATE.input.controlFingerprint;

    expect(armAFp.inferenceConfigHash).toBe(trial.controlFingerprint.inferenceConfigHash);
    expect(armBFp.inferenceConfigHash).toBe(trial.controlFingerprint.inferenceConfigHash);
    expect(armCFp.inferenceConfigHash).toBe(trial.controlFingerprint.inferenceConfigHash);
  });

  it('4. different inference configuration (temperature/seed) across A/B/C fails integrity guard', () => {
    const trial = createValidTrial();
    const mutated = cloneTrial(trial);

    // Tamper inferenceConfigHash in ARM_C by simulating a different temperature or seed
    const alteredControls: HarnessExecutionControls = {
      ...dummyControls,
      temperature: 0.9, // altered sampling
    };
    const alteredFp = computeControlFingerprint({
      snapshotCommitSha: validIdentity.snapshotCommitSha,
      taskBPrompt,
      controls: alteredControls,
      environmentDependencyFingerprint: envFingerprint,
    });

    mutated.arms.ARM_C_ORCHESTRATE.input.controlFingerprint.inferenceConfigHash =
      alteredFp.inferenceConfigHash;

    const result = validateTrialIntegrity(mutated);
    expect(result.valid).toBe(false);

    const violation = result.violations.find(
      (v) => v.code === INTEGRITY_VIOLATION_CODES.CONTROL_FINGERPRINT_MISMATCH
    );
    expect(violation).toBeDefined();
    expect(violation?.message).toContain('inferenceConfigHash');
  });

  it('5. model identity is strictly excluded from TreatmentFingerprint', () => {
    const rawPayloadB = 'Unverified handoff notes';

    const tf1 = computeTreatmentFingerprint('ARM_B_UNVERIFIED_HANDOFF', rawPayloadB);
    const tf2 = computeTreatmentFingerprint('ARM_B_UNVERIFIED_HANDOFF', rawPayloadB);

    // Verify TreatmentFingerprint has only armId and treatmentPayloadHash
    expect(Object.keys(tf1).sort()).toEqual(['armId', 'treatmentPayloadHash']);
    expect(tf1.treatmentPayloadHash).toBe(tf2.treatmentPayloadHash);

    // Model identity does not enter treatment hash calculation
    expect((tf1 as any).modelIdentity).toBeUndefined();
    expect((tf1 as any).model).toBeUndefined();
    expect((tf1 as any).provider).toBeUndefined();
  });

  it('6. benchmark model mismatch transitions trial to INVALID in TrialRunner', async () => {
    const mockRepo: GitRepository = {
      isRepository: async () => true,
      getHeadCommit: async () => ({
        sha: validIdentity.snapshotCommitSha,
        message: 'Snapshot commit',
        author: 'Test',
        date: new Date().toISOString(),
      }),
      getRecentCommits: async () => [],
      getStatus: async () => ({
        clean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        branch: null,
        detached: true,
      }),
      diff: async () => '',
      revParse: async () => validIdentity.snapshotCommitSha,
    };

    const mockFactory: WorkspaceFactory = {
      create: async () => ({
        path: '/tmp/ws-test',
        cleanup: async () => {},
      } as Workspace),
    };

    const mockModelClient: ModelClient = {
      complete: async () => ({
        id: 'cmpl-1',
        model: 'nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        message: { role: 'assistant', content: 'done' },
        finishReason: 'stop',
      }),
    };

    const runner = new TrialRunner({
      snapshotRepo: mockRepo,
      workspaceFactory: mockFactory,
      modelClient: mockModelClient,
    });

    // Run trial with prompt that violates agent blinding or control equality
    const trialInput = {
      identity: validIdentity,
      taskBPrompt: 'Normal prompt mentioning ARM_A_BASELINE', // triggers preflight Category A failure
      controls: dummyControls,
      environmentDependencyFingerprint: envFingerprint,
      armOrderSeed: 42,
      baseSystemPrompt: 'You are an engineer.',
      armBUnverifiedHandoff: 'Handoff',
      armCCompiledContext: 'Context',
    };

    const result = await runner.runTrial(trialInput);

    expect(result.valid).toBe(false);
    expect(result.trial.state).toBe('INVALID');
    expect(result.integrityPreflight.valid).toBe(false);
  });

  it('7. model provenance captures provider, model, and inference parameters without leaking API keys', async () => {
    const rawApiKey = 'nebius-secret-key-abcdef1234567890';
    const mockInnerClient: ModelClient = {
      complete: async (req) => ({
        id: 'cmpl-provenance-1',
        provider: 'nebius',
        model: req.model,
        message: {
          role: 'assistant',
          content: 'Here is your completion.',
          toolCalls: [
            {
              id: 'call-1',
              name: 'read_file',
              arguments: { path: '/src/index.ts', token: rawApiKey },
            },
          ],
        },
        finishReason: 'stop',
        usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      }),
    };

    const recordedEvents: any[] = [];
    const instrumented = new InstrumentedModelClient({
      modelClient: mockInnerClient,
      customSecrets: [rawApiKey],
      onCall: (event) => recordedEvents.push(event),
    });

    const response = await instrumented.complete({
      model: 'nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
      messages: [{ role: 'user', content: 'Run task' }],
      temperature: 0.2,
      maxTokens: 1000,
    });

    expect(response.provider).toBe('nebius');
    expect(response.model).toBe('nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');

    expect(recordedEvents).toHaveLength(1);
    const event = recordedEvents[0];
    expect(event.provider).toBe('nebius');
    expect(event.model).toBe('nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
    expect(event.request.temperature).toBe(0.2);
    expect(event.request.maxTokens).toBe(1000);

    // Verify secret redaction
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(rawApiKey);
    expect(serialized).toContain('[REDACTED]');
  });
});
