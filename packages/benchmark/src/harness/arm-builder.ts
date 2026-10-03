import {
  computeTreatmentFingerprint,
  sha256,
  canonicalJson,
} from './fingerprints.js';
import {
  type BenchmarkArmId,
  BENCHMARK_ARM_IDS,
  type TrialArmRecord,
  type TrialRecord,
  type TreatmentContextEnvelope,
  type ArmExecutionInput,
} from './types.js';

export const FORBIDDEN_BLINDING_TOKENS = [
  'ARM_A_BASELINE',
  'ARM_B_UNVERIFIED_HANDOFF',
  'ARM_C_ORCHESTRATE',
  'discovery_actions',
  'rework_events',
  'time_to_verified',
  'human_intervention',
] as const;

export interface ArmTriadContextInputs {
  taskBPrompt: string;
  armBUnverifiedHandoff: string;
  armCCompiledContext: string;
  baseSystemPrompt?: string;
}

/**
 * Asserts that agent-facing text contains no forbidden metadata or benchmark identifiers.
 * Strict agent blinding invariant (M6C §6.2).
 */
export function assertAgentBlinded(text: string, trial: TrialRecord, contextName: string): void {
  if (!text || typeof text !== 'string') {
    return;
  }

  // 1. Check fixed benchmark tokens
  for (const token of FORBIDDEN_BLINDING_TOKENS) {
    if (text.includes(token)) {
      throw new Error(
        `Agent blinding violation: forbidden token "${token}" found in ${contextName}.`
      );
    }
  }

  // 2. Check trial identity identifiers
  if (trial?.identity?.runId && trial.identity.runId.length > 3 && text.includes(trial.identity.runId)) {
    throw new Error(
      `Agent blinding violation: trial runId "${trial.identity.runId}" found in ${contextName}.`
    );
  }

  if (trial?.identity?.snapshotId && trial.identity.snapshotId.length > 3 && text.includes(trial.identity.snapshotId)) {
    throw new Error(
      `Agent blinding violation: snapshotId "${trial.identity.snapshotId}" found in ${contextName}.`
    );
  }
}

/**
 * Formats the structured unverified handoff block for ARM_B (M6C §5.2).
 */
export function formatArmBTreatmentBlock(payload: string): string {
  return `<orchestrate_handoff>\n${payload.trim()}\n</orchestrate_handoff>`;
}

/**
 * Formats the compiled verified context block for ARM_C (M6C §5.3).
 */
export function formatArmCTreatmentBlock(payload: string): string {
  return `<orchestrate_context>\n${payload.trim()}\n</orchestrate_context>`;
}

/**
 * Builds the exact triad of experimental arms for a trial (M6A / M6C).
 * Enforces:
 * 1. ControlFingerprint(A) == ControlFingerprint(B) == ControlFingerprint(C)
 * 2. TreatmentFingerprint(A) != TreatmentFingerprint(B) != TreatmentFingerprint(C)
 * 3. Byte-for-byte identical Task-B prompt across arms matching trial control fingerprint.
 * 4. Strict agent blinding against benchmark metadata leakage.
 */
export function buildArmTriad(
  trial: TrialRecord,
  inputs: ArmTriadContextInputs
): Record<BenchmarkArmId, TrialArmRecord> {
  if (!trial || typeof trial !== 'object') {
    throw new Error('buildArmTriad: trial must be a non-null TrialRecord.');
  }
  if (!inputs || typeof inputs !== 'object') {
    throw new Error('buildArmTriad: inputs must be a non-null object.');
  }

  const { taskBPrompt, armBUnverifiedHandoff, armCCompiledContext } = inputs;

  if (!taskBPrompt || typeof taskBPrompt !== 'string' || taskBPrompt.trim() === '') {
    throw new Error('buildArmTriad: taskBPrompt must be a non-empty string.');
  }

  // Invariant: taskBPrompt must match the trial's controlFingerprint.taskBPromptHash
  const computedPromptHash = sha256(canonicalJson(taskBPrompt.trim()));
  if (computedPromptHash !== trial.controlFingerprint.taskBPromptHash) {
    throw new Error(
      'buildArmTriad: taskBPrompt does not match the trial controlFingerprint.taskBPromptHash. Prompt text must be byte-for-byte identical to the registered control.'
    );
  }

  if (typeof armBUnverifiedHandoff !== 'string' || armBUnverifiedHandoff.trim() === '') {
    throw new Error(
      'buildArmTriad: armBUnverifiedHandoff must be a non-empty string for ARM_B_UNVERIFIED_HANDOFF.'
    );
  }

  if (typeof armCCompiledContext !== 'string' || armCCompiledContext.trim() === '') {
    throw new Error(
      'buildArmTriad: armCCompiledContext must be a non-empty string for ARM_C_ORCHESTRATE.'
    );
  }

  const baseSystemPrompt = inputs.baseSystemPrompt ?? trial.controls.baseSystemInstructions;

  // Strict agent blinding checks
  assertAgentBlinded(taskBPrompt, trial, 'taskBPrompt');
  assertAgentBlinded(baseSystemPrompt, trial, 'baseSystemPrompt');
  assertAgentBlinded(armBUnverifiedHandoff, trial, 'armBUnverifiedHandoff');
  assertAgentBlinded(armCCompiledContext, trial, 'armCCompiledContext');

  // Sampling configuration from execution controls
  const samplingConfig = Object.freeze({
    temperature: trial.controls.temperature,
    maxTokens: trial.controls.maxTokens,
  });

  // ARM_A_BASELINE
  const armATreatmentFingerprint = computeTreatmentFingerprint('ARM_A_BASELINE', null);
  const armAInput: ArmExecutionInput = Object.freeze({
    trialId: trial.identity.runId,
    armId: 'ARM_A_BASELINE',
    snapshotCommitSha: trial.identity.snapshotCommitSha,
    taskBPrompt: taskBPrompt.trim(),
    systemPrompt: baseSystemPrompt.trim(),
    contextEnvelope: null,
    controlFingerprint: trial.controlFingerprint,
    treatmentFingerprint: armATreatmentFingerprint,
    samplingConfig,
  });

  const armARecord: TrialArmRecord = Object.freeze({
    armId: 'ARM_A_BASELINE',
    status: 'NOT_STARTED',
    input: armAInput,
  });

  // ARM_B_UNVERIFIED_HANDOFF
  const armBTreatmentFingerprint = computeTreatmentFingerprint(
    'ARM_B_UNVERIFIED_HANDOFF',
    armBUnverifiedHandoff
  );
  const armBFormattedBlock = formatArmBTreatmentBlock(armBUnverifiedHandoff);
  const armBEnvelope: TreatmentContextEnvelope = Object.freeze({
    armId: 'ARM_B_UNVERIFIED_HANDOFF',
    rawPayload: armBUnverifiedHandoff.trim(),
    formattedBlock: armBFormattedBlock,
    treatmentPayloadHash: armBTreatmentFingerprint.treatmentPayloadHash,
  });
  const armBSystemPrompt = `${baseSystemPrompt.trim()}\n\n${armBFormattedBlock}`;
  const armBInput: ArmExecutionInput = Object.freeze({
    trialId: trial.identity.runId,
    armId: 'ARM_B_UNVERIFIED_HANDOFF',
    snapshotCommitSha: trial.identity.snapshotCommitSha,
    taskBPrompt: taskBPrompt.trim(),
    systemPrompt: armBSystemPrompt,
    contextEnvelope: armBEnvelope,
    controlFingerprint: trial.controlFingerprint,
    treatmentFingerprint: armBTreatmentFingerprint,
    samplingConfig,
  });

  const armBRecord: TrialArmRecord = Object.freeze({
    armId: 'ARM_B_UNVERIFIED_HANDOFF',
    status: 'NOT_STARTED',
    input: armBInput,
  });

  // ARM_C_ORCHESTRATE
  const armCTreatmentFingerprint = computeTreatmentFingerprint(
    'ARM_C_ORCHESTRATE',
    armCCompiledContext
  );
  const armCFormattedBlock = formatArmCTreatmentBlock(armCCompiledContext);
  const armCEnvelope: TreatmentContextEnvelope = Object.freeze({
    armId: 'ARM_C_ORCHESTRATE',
    rawPayload: armCCompiledContext.trim(),
    formattedBlock: armCFormattedBlock,
    treatmentPayloadHash: armCTreatmentFingerprint.treatmentPayloadHash,
  });
  const armCSystemPrompt = `${baseSystemPrompt.trim()}\n\n${armCFormattedBlock}`;
  const armCInput: ArmExecutionInput = Object.freeze({
    trialId: trial.identity.runId,
    armId: 'ARM_C_ORCHESTRATE',
    snapshotCommitSha: trial.identity.snapshotCommitSha,
    taskBPrompt: taskBPrompt.trim(),
    systemPrompt: armCSystemPrompt,
    contextEnvelope: armCEnvelope,
    controlFingerprint: trial.controlFingerprint,
    treatmentFingerprint: armCTreatmentFingerprint,
    samplingConfig,
  });

  const armCRecord: TrialArmRecord = Object.freeze({
    armId: 'ARM_C_ORCHESTRATE',
    status: 'NOT_STARTED',
    input: armCInput,
  });

  return Object.freeze({
    ARM_A_BASELINE: armARecord,
    ARM_B_UNVERIFIED_HANDOFF: armBRecord,
    ARM_C_ORCHESTRATE: armCRecord,
  });
}

/**
 * Attaches the arm triad to a TrialRecord and transitions state to ARMS_READY.
 */
export function attachArmTriad(
  trial: TrialRecord,
  inputs: ArmTriadContextInputs
): TrialRecord {
  const arms = buildArmTriad(trial, inputs);

  return Object.freeze({
    ...trial,
    state: 'ARMS_READY',
    arms,
  });
}
