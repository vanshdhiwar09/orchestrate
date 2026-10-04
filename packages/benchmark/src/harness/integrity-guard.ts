import {
  type BenchmarkArmId,
  BENCHMARK_ARM_IDS,
  type ControlFingerprint,
  type RawExecutionEvidence,
  type BenchmarkVerificationEvidence,
  type TrialArmRecord,
  type TrialRecord,
} from './types.js';
import {
  canonicalJson,
  computeControlFingerprint,
  computeTreatmentFingerprint,
  sha256,
} from './fingerprints.js';
import { isValidCommitSha } from './snapshot-loader.js';
import { FORBIDDEN_BLINDING_TOKENS } from './arm-builder.js';
import { deepFreeze } from '../manifest/freeze.js';

export const INTEGRITY_VIOLATION_CODES = {
  INVALID_TRIAL_IDENTITY: 'INVALID_TRIAL_IDENTITY',
  STARTING_COMMIT_MISMATCH: 'STARTING_COMMIT_MISMATCH',
  CONTROL_FINGERPRINT_MISMATCH: 'CONTROL_FINGERPRINT_MISMATCH',
  TREATMENT_FINGERPRINT_MISMATCH: 'TREATMENT_FINGERPRINT_MISMATCH',
  UNINTENDED_CONTEXT_INJECTION: 'UNINTENDED_CONTEXT_INJECTION',
  AGENT_BLINDING_VIOLATION: 'AGENT_BLINDING_VIOLATION',
  DUPLICATE_WORKSPACE_IDENTITY: 'DUPLICATE_WORKSPACE_IDENTITY',
  CROSS_ARM_WORKSPACE_ACCESS: 'CROSS_ARM_WORKSPACE_ACCESS',
  MISSING_ARM_RECORD: 'MISSING_ARM_RECORD',
  DUPLICATE_ARM_RECORD: 'DUPLICATE_ARM_RECORD',
  MISSING_REQUIRED_EVIDENCE: 'MISSING_REQUIRED_EVIDENCE',
  INFORMATION_LEAKAGE: 'INFORMATION_LEAKAGE',
} as const;

export type IntegrityViolationCode =
  (typeof INTEGRITY_VIOLATION_CODES)[keyof typeof INTEGRITY_VIOLATION_CODES];

export interface IntegrityViolation {
  code: IntegrityViolationCode | string;
  message: string;
  category: 'CATEGORY_A';
  severity: 'CRITICAL';
  armId?: BenchmarkArmId;
}

export interface IntegrityCheckResult {
  valid: boolean;
  violations: readonly IntegrityViolation[];
}

export interface IntegrityCheckOptions {
  /**
   * Optional map of workspace paths or identifiers per arm.
   * If provided, verifies physical/logical isolation metadata (no duplicate paths).
   */
  armWorkspaces?: Partial<Record<BenchmarkArmId, string>> | Map<BenchmarkArmId, string>;

  /**
   * Optional map of raw execution evidence per arm.
   */
  rawEvidence?: Partial<Record<BenchmarkArmId, RawExecutionEvidence>>;

  /**
   * Optional map of verification evidence per arm.
   */
  verificationEvidence?: Partial<Record<BenchmarkArmId, BenchmarkVerificationEvidence>>;

  /**
   * Optional custom raw arm records (array or record) to test arm set invariants.
   */
  arms?: readonly TrialArmRecord[] | Record<string, TrialArmRecord>;
}

/**
 * Normalizes a workspace path or URI for deterministic case-insensitive comparison.
 */
function normalizeWorkspacePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Validates agent blinding invariant on an agent-facing text field.
 */
function checkAgentBlinding(
  text: unknown,
  trial: TrialRecord,
  armId: BenchmarkArmId,
  fieldName: string,
  violations: IntegrityViolation[]
): void {
  if (typeof text !== 'string' || text.trim() === '') {
    return;
  }

  // 1. Check fixed benchmark tokens
  for (const token of FORBIDDEN_BLINDING_TOKENS) {
    if (text.includes(token)) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.AGENT_BLINDING_VIOLATION,
        message: `Agent blinding violation in arm ${armId}: forbidden token "${token}" found in ${fieldName}.`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId,
      });
    }
  }

  // 2. Check trial identity identifiers
  if (
    trial?.identity?.runId &&
    trial.identity.runId.length > 3 &&
    text.includes(trial.identity.runId)
  ) {
    violations.push({
      code: INTEGRITY_VIOLATION_CODES.AGENT_BLINDING_VIOLATION,
      message: `Agent blinding violation in arm ${armId}: trial runId "${trial.identity.runId}" found in ${fieldName}.`,
      category: 'CATEGORY_A',
      severity: 'CRITICAL',
      armId,
    });
  }

  if (
    trial?.identity?.snapshotId &&
    trial.identity.snapshotId.length > 3 &&
    text.includes(trial.identity.snapshotId)
  ) {
    violations.push({
      code: INTEGRITY_VIOLATION_CODES.AGENT_BLINDING_VIOLATION,
      message: `Agent blinding violation in arm ${armId}: snapshotId "${trial.identity.snapshotId}" found in ${fieldName}.`,
      category: 'CATEGORY_A',
      severity: 'CRITICAL',
      armId,
    });
  }
}

/**
 * Pure validator for Orchestrate Benchmark Trial integrity (M7 Phase 4).
 * Validates trial identity, snapshot consistency, control equality, treatment correctness,
 * agent blinding, workspace isolation metadata, and evidence completeness without mutation.
 */
export function validateTrialIntegrity(
  trial: TrialRecord,
  options?: IntegrityCheckOptions
): IntegrityCheckResult {
  const violations: IntegrityViolation[] = [];

  // 1. Structural check on trial object
  if (!trial || typeof trial !== 'object') {
    violations.push({
      code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
      message: 'TrialRecord must be a valid non-null object.',
      category: 'CATEGORY_A',
      severity: 'CRITICAL',
    });
    return deepFreeze({ valid: false, violations });
  }

  // 2. Validate trial identity
  const identity = trial.identity;
  if (!identity || typeof identity !== 'object') {
    violations.push({
      code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
      message: 'TrialRecord.identity must be a non-null object.',
      category: 'CATEGORY_A',
      severity: 'CRITICAL',
    });
  } else {
    if (typeof identity.runId !== 'string' || identity.runId.trim() === '') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
        message: 'Trial identity runId must be a non-empty string.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
    if (typeof identity.scenarioId !== 'string' || identity.scenarioId.trim() === '') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
        message: 'Trial identity scenarioId must be a non-empty string.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
    if (
      typeof identity.replication !== 'number' ||
      !Number.isInteger(identity.replication) ||
      identity.replication < 1
    ) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
        message: `Trial identity replication must be an integer >= 1, got ${identity.replication}.`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
    if (typeof identity.taskAId !== 'string' || identity.taskAId.trim() === '') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
        message: 'Trial identity taskAId must be a non-empty string.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
    if (typeof identity.taskBId !== 'string' || identity.taskBId.trim() === '') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
        message: 'Trial identity taskBId must be a non-empty string.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
    if (identity.taskAId && identity.taskBId && identity.taskAId === identity.taskBId) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
        message: `Trial identity taskAId and taskBId must be distinct, got "${identity.taskAId}".`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
    if (typeof identity.snapshotId !== 'string' || identity.snapshotId.trim() === '') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.INVALID_TRIAL_IDENTITY,
        message: 'Trial identity snapshotId must be a non-empty string.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
    if (!isValidCommitSha(identity.snapshotCommitSha)) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH,
        message: `Trial snapshotCommitSha must be a 40-character hexadecimal SHA, got "${identity.snapshotCommitSha}".`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
      });
    }
  }

  // 3. Validate execution order
  if (Array.isArray(trial.executionOrder)) {
    const seenOrderArms = new Set<string>();
    for (const armId of trial.executionOrder) {
      if (!BENCHMARK_ARM_IDS.includes(armId)) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.MISSING_ARM_RECORD,
          message: `Unknown arm "${armId}" in trial executionOrder.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
        });
      } else if (seenOrderArms.has(armId)) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.DUPLICATE_ARM_RECORD,
          message: `Duplicate arm "${armId}" in trial executionOrder.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId,
        });
      }
      seenOrderArms.add(armId);
    }
  }

  // 4. Resolve arms to inspect
  const rawArms = options?.arms ?? trial.arms;
  const armsMap = new Map<BenchmarkArmId, TrialArmRecord>();

  if (!rawArms) {
    violations.push({
      code: INTEGRITY_VIOLATION_CODES.MISSING_ARM_RECORD,
      message: 'Trial arms record is missing or undefined.',
      category: 'CATEGORY_A',
      severity: 'CRITICAL',
    });
  } else if (Array.isArray(rawArms)) {
    // Array format inspection (supports duplicate arm detection)
    const seenArmIds = new Set<BenchmarkArmId>();
    for (const arm of rawArms) {
      if (!arm || typeof arm !== 'object' || !arm.armId) {
        continue;
      }
      if (seenArmIds.has(arm.armId)) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.DUPLICATE_ARM_RECORD,
          message: `Duplicate arm record for "${arm.armId}" in trial arms array.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: arm.armId,
        });
      }
      seenArmIds.add(arm.armId);
      if (!armsMap.has(arm.armId) && BENCHMARK_ARM_IDS.includes(arm.armId)) {
        armsMap.set(arm.armId, arm);
      }
    }
    // Check all required arms exist
    for (const expectedArmId of BENCHMARK_ARM_IDS) {
      if (!seenArmIds.has(expectedArmId)) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.MISSING_ARM_RECORD,
          message: `Required arm "${expectedArmId}" is missing from trial arms.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: expectedArmId,
        });
      }
    }
  } else if (typeof rawArms === 'object') {
    // Object format inspection
    const keys = Object.keys(rawArms);
    for (const expectedArmId of BENCHMARK_ARM_IDS) {
      const arm = (rawArms as Record<string, TrialArmRecord>)[expectedArmId];
      if (!arm) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.MISSING_ARM_RECORD,
          message: `Required arm "${expectedArmId}" is missing from trial arms.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: expectedArmId,
        });
      } else {
        if (arm.armId !== expectedArmId) {
          violations.push({
            code: INTEGRITY_VIOLATION_CODES.DUPLICATE_ARM_RECORD,
            message: `Arm key "${expectedArmId}" contains mismatched armId "${arm.armId}".`,
            category: 'CATEGORY_A',
            severity: 'CRITICAL',
            armId: expectedArmId,
          });
        }
        armsMap.set(expectedArmId, arm);
      }
    }
    for (const key of keys) {
      if (!BENCHMARK_ARM_IDS.includes(key as BenchmarkArmId)) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.MISSING_ARM_RECORD,
          message: `Unexpected arm key "${key}" found in trial arms.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
        });
      }
    }
  }

  const canonicalSnapshotSha = identity?.snapshotCommitSha?.toLowerCase().trim();

  // 5. Inspect individual arm inputs and snapshot consistency
  for (const [armId, arm] of armsMap.entries()) {
    const input = arm.input;
    if (!input || typeof input !== 'object') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.MISSING_ARM_RECORD,
        message: `Arm execution input for "${armId}" is missing.`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId,
      });
      continue;
    }

    // Arm snapshot consistency
    const armSnapshotSha = input.snapshotCommitSha?.toLowerCase().trim();
    if (!isValidCommitSha(input.snapshotCommitSha)) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH,
        message: `Arm ${armId} snapshotCommitSha must be a valid 40-character SHA, got "${input.snapshotCommitSha}".`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId,
      });
    } else if (canonicalSnapshotSha && armSnapshotSha !== canonicalSnapshotSha) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH,
        message: `Arm ${armId} starting snapshot commit SHA "${input.snapshotCommitSha}" does not match trial snapshot commit SHA "${identity.snapshotCommitSha}".`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId,
      });
    }

    // Arm agent blinding
    checkAgentBlinding(input.taskBPrompt, trial, armId, 'taskBPrompt', violations);
    checkAgentBlinding(input.systemPrompt, trial, armId, 'systemPrompt', violations);
    if (input.contextEnvelope?.rawPayload) {
      checkAgentBlinding(
        input.contextEnvelope.rawPayload,
        trial,
        armId,
        'contextEnvelope.rawPayload',
        violations
      );
    }
  }

  // 6. Control Equality Validation across arms
  const controlFields: (keyof ControlFingerprint)[] = [
    'snapshotCommitSha',
    'taskBPromptHash',
    'modelIdentity',
    'inferenceConfigHash',
    'systemInstructionsHash',
    'toolDefinitionsHash',
    'toolPermissionsHash',
    'environmentDependencyFingerprint',
    'executionLimitsHash',
    'filesystemPolicyHash',
    'networkPolicyHash',
    'harnessVersion',
    'runtimeConfigHash',
  ];

  for (const [armId, arm] of armsMap.entries()) {
    const armFp = arm.input?.controlFingerprint;
    if (!armFp) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.CONTROL_FINGERPRINT_MISMATCH,
        message: `Arm ${armId} is missing controlFingerprint.`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId,
      });
      continue;
    }

    // Compare with trial controlFingerprint if present
    if (trial.controlFingerprint) {
      for (const field of controlFields) {
        if (armFp[field] !== trial.controlFingerprint[field]) {
          violations.push({
            code: INTEGRITY_VIOLATION_CODES.CONTROL_FINGERPRINT_MISMATCH,
            message: `Control fingerprint mismatch for arm ${armId}: field "${field}" ("${armFp[field]}") does not match trial control fingerprint ("${trial.controlFingerprint[field]}").`,
            category: 'CATEGORY_A',
            severity: 'CRITICAL',
            armId,
          });
        }
      }
    }

    // Invariant: taskBPrompt in arm must hash to controlFingerprint.taskBPromptHash
    if (arm.input?.taskBPrompt && armFp.taskBPromptHash) {
      const computedPromptHash = sha256(canonicalJson(arm.input.taskBPrompt.trim()));
      if (computedPromptHash !== armFp.taskBPromptHash) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.CONTROL_FINGERPRINT_MISMATCH,
          message: `Arm ${armId} taskBPrompt hash does not match controlFingerprint.taskBPromptHash.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId,
        });
      }
    }
  }

  // Inter-arm control fingerprint pairwise check
  const armEntries = [...armsMap.entries()];
  for (let i = 0; i < armEntries.length; i++) {
    for (let j = i + 1; j < armEntries.length; j++) {
      const [armId1, arm1] = armEntries[i];
      const [armId2, arm2] = armEntries[j];
      const fp1 = arm1.input?.controlFingerprint;
      const fp2 = arm2.input?.controlFingerprint;
      if (fp1 && fp2) {
        for (const field of controlFields) {
          if (fp1[field] !== fp2[field]) {
            violations.push({
              code: INTEGRITY_VIOLATION_CODES.CONTROL_FINGERPRINT_MISMATCH,
              message: `Control fingerprint field "${field}" differs between arm ${armId1} and arm ${armId2}.`,
              category: 'CATEGORY_A',
              severity: 'CRITICAL',
              armId: armId2,
            });
          }
        }
      }
    }
  }

  // 7. Treatment Correctness Validation
  const armA = armsMap.get('ARM_A_BASELINE');
  const armB = armsMap.get('ARM_B_UNVERIFIED_HANDOFF');
  const armC = armsMap.get('ARM_C_ORCHESTRATE');

  // ARM_A treatment envelope checks
  if (armA) {
    const inputA = armA.input;
    const envA = inputA?.contextEnvelope;
    const fpA = inputA?.treatmentFingerprint;

    // ARM_A must not receive B/C context
    if (envA !== null && envA !== undefined) {
      if (envA.rawPayload !== null && envA.rawPayload !== '') {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION,
          message: 'ARM_A_BASELINE must not receive context envelope rawPayload.',
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: 'ARM_A_BASELINE',
        });
      }
      if (envA.formattedBlock !== null && envA.formattedBlock !== '') {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION,
          message: 'ARM_A_BASELINE must not receive context envelope formattedBlock.',
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: 'ARM_A_BASELINE',
        });
      }
    }

    if (
      inputA?.systemPrompt?.includes('<orchestrate_handoff>') ||
      inputA?.systemPrompt?.includes('<orchestrate_context>') ||
      inputA?.taskBPrompt?.includes('<orchestrate_handoff>') ||
      inputA?.taskBPrompt?.includes('<orchestrate_context>')
    ) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION,
        message: 'ARM_A_BASELINE prompt must not contain orchestrate handoff or context blocks.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_A_BASELINE',
      });
    }

    const expectedAHash = sha256('');
    if (fpA && fpA.treatmentPayloadHash !== expectedAHash) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
        message: `ARM_A_BASELINE treatment payload hash must be sha256(""), got "${fpA.treatmentPayloadHash}".`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_A_BASELINE',
      });
    }
  }

  // ARM_B treatment envelope checks
  if (armB) {
    const inputB = armB.input;
    const envB = inputB?.contextEnvelope;
    const fpB = inputB?.treatmentFingerprint;

    if (!envB || typeof envB.rawPayload !== 'string' || envB.rawPayload.trim() === '') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
        message: 'ARM_B_UNVERIFIED_HANDOFF must contain a non-empty rawPayload in contextEnvelope.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_B_UNVERIFIED_HANDOFF',
      });
    } else {
      const expectedBHash = sha256(canonicalJson(envB.rawPayload.trim()));
      if (fpB && fpB.treatmentPayloadHash !== expectedBHash) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
          message: `ARM_B_UNVERIFIED_HANDOFF treatmentFingerprint hash mismatch with envelope rawPayload.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: 'ARM_B_UNVERIFIED_HANDOFF',
        });
      }
      if (envB.treatmentPayloadHash !== expectedBHash) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
          message: `ARM_B_UNVERIFIED_HANDOFF contextEnvelope hash mismatch with rawPayload.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: 'ARM_B_UNVERIFIED_HANDOFF',
        });
      }
    }

    // B receiving C context check
    if (
      envB?.armId === 'ARM_C_ORCHESTRATE' ||
      envB?.formattedBlock?.includes('<orchestrate_context>') ||
      inputB?.systemPrompt?.includes('<orchestrate_context>') ||
      inputB?.taskBPrompt?.includes('<orchestrate_context>')
    ) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION,
        message: 'ARM_B_UNVERIFIED_HANDOFF received ARM_C context block or tags.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_B_UNVERIFIED_HANDOFF',
      });
    }

    if (envB && !envB.formattedBlock?.includes('<orchestrate_handoff>')) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
        message: 'ARM_B_UNVERIFIED_HANDOFF contextEnvelope must contain <orchestrate_handoff> formattedBlock.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_B_UNVERIFIED_HANDOFF',
      });
    }
  }

  // ARM_C treatment envelope checks
  if (armC) {
    const inputC = armC.input;
    const envC = inputC?.contextEnvelope;
    const fpC = inputC?.treatmentFingerprint;

    if (!envC || typeof envC.rawPayload !== 'string' || envC.rawPayload.trim() === '') {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
        message: 'ARM_C_ORCHESTRATE must contain a non-empty rawPayload in contextEnvelope.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_C_ORCHESTRATE',
      });
    } else {
      const expectedCHash = sha256(canonicalJson(envC.rawPayload.trim()));
      if (fpC && fpC.treatmentPayloadHash !== expectedCHash) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
          message: `ARM_C_ORCHESTRATE treatmentFingerprint hash mismatch with envelope rawPayload.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: 'ARM_C_ORCHESTRATE',
        });
      }
      if (envC.treatmentPayloadHash !== expectedCHash) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
          message: `ARM_C_ORCHESTRATE contextEnvelope hash mismatch with rawPayload.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: 'ARM_C_ORCHESTRATE',
        });
      }
    }

    // C receiving B context check
    if (
      envC?.armId === 'ARM_B_UNVERIFIED_HANDOFF' ||
      envC?.formattedBlock?.includes('<orchestrate_handoff>') ||
      inputC?.systemPrompt?.includes('<orchestrate_handoff>') ||
      inputC?.taskBPrompt?.includes('<orchestrate_handoff>')
    ) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION,
        message: 'ARM_C_ORCHESTRATE received ARM_B handoff block or tags.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_C_ORCHESTRATE',
      });
    }

    if (envC && !envC.formattedBlock?.includes('<orchestrate_context>')) {
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.TREATMENT_FINGERPRINT_MISMATCH,
        message: 'ARM_C_ORCHESTRATE contextEnvelope must contain <orchestrate_context> formattedBlock.',
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId: 'ARM_C_ORCHESTRATE',
      });
    }
  }

  // Cross-contamination: B and C payloads must differ
  if (
    armB?.input?.contextEnvelope?.rawPayload &&
    armC?.input?.contextEnvelope?.rawPayload &&
    armB.input.contextEnvelope.rawPayload.trim() === armC.input.contextEnvelope.rawPayload.trim()
  ) {
    violations.push({
      code: INTEGRITY_VIOLATION_CODES.UNINTENDED_CONTEXT_INJECTION,
      message: 'ARM_B and ARM_C have identical treatment context payloads.',
      category: 'CATEGORY_A',
      severity: 'CRITICAL',
      armId: 'ARM_C_ORCHESTRATE',
    });
  }

  // 8. Validate arm workspace isolation metadata
  const workspaceMap = new Map<BenchmarkArmId, string>();

  // Extract from options.armWorkspaces
  if (options?.armWorkspaces) {
    if (options.armWorkspaces instanceof Map) {
      for (const [armId, wsPath] of options.armWorkspaces.entries()) {
        if (typeof wsPath === 'string' && wsPath.trim() !== '') {
          workspaceMap.set(armId, wsPath);
        }
      }
    } else {
      for (const armId of BENCHMARK_ARM_IDS) {
        const wsPath = options.armWorkspaces[armId];
        if (typeof wsPath === 'string' && wsPath.trim() !== '') {
          workspaceMap.set(armId, wsPath);
        }
      }
    }
  }

  // Extract from arm records or evidence if not already set
  for (const [armId, arm] of armsMap.entries()) {
    if (!workspaceMap.has(armId)) {
      const armAny = arm as unknown as Record<string, unknown>;
      const inputAny = arm.input as unknown as Record<string, unknown>;
      const rawEv = options?.rawEvidence?.[armId] ?? (armAny.rawEvidence as RawExecutionEvidence);
      const verEv =
        options?.verificationEvidence?.[armId] ??
        (armAny.verificationEvidence as BenchmarkVerificationEvidence);

      const candidatePath =
        (typeof armAny.workspacePath === 'string' ? armAny.workspacePath : null) ??
        (typeof inputAny?.workspacePath === 'string' ? inputAny.workspacePath : null) ??
        (typeof rawEv?.workspacePath === 'string' ? rawEv.workspacePath : null) ??
        (typeof verEv?.workspacePath === 'string' ? verEv.workspacePath : null);

      if (candidatePath && candidatePath.trim() !== '') {
        workspaceMap.set(armId, candidatePath);
      }
    }
  }

  // Verify workspace path uniqueness across arms
  const seenWorkspaces = new Map<string, BenchmarkArmId>();
  for (const [armId, wsPath] of workspaceMap.entries()) {
    const normalized = normalizeWorkspacePath(wsPath);
    if (seenWorkspaces.has(normalized)) {
      const priorArm = seenWorkspaces.get(normalized)!;
      violations.push({
        code: INTEGRITY_VIOLATION_CODES.DUPLICATE_WORKSPACE_IDENTITY,
        message: `Arm ${armId} and arm ${priorArm} share the same workspace identity: "${wsPath}". Each arm must have an isolated workspace.`,
        category: 'CATEGORY_A',
        severity: 'CRITICAL',
        armId,
      });
    } else {
      seenWorkspaces.set(normalized, armId);
    }
  }

  // 9. Validate evidence completeness where applicable
  // Pre-execution states ('CREATED', 'SNAPSHOT_READY', 'ARMS_READY', 'EXECUTING')
  // do NOT require post-execution evidence.
  const state = trial.state;
  if (state === 'EVIDENCE_CAPTURED' || state === 'MEASURED' || state === 'COMPLETE') {
    for (const expectedArmId of BENCHMARK_ARM_IDS) {
      const armAny = armsMap.get(expectedArmId) as unknown as Record<string, unknown> | undefined;
      const rawEv =
        options?.rawEvidence?.[expectedArmId] ?? (armAny?.rawEvidence as RawExecutionEvidence);
      if (!rawEv) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.MISSING_REQUIRED_EVIDENCE,
          message: `Trial state is "${state}" but raw execution evidence for arm "${expectedArmId}" is missing.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: expectedArmId,
        });
      } else if (
        canonicalSnapshotSha &&
        rawEv.snapshotCommitSha &&
        rawEv.snapshotCommitSha.toLowerCase().trim() !== canonicalSnapshotSha
      ) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.STARTING_COMMIT_MISMATCH,
          message: `Raw execution evidence for arm "${expectedArmId}" has snapshot commit "${rawEv.snapshotCommitSha}" which does not match trial snapshot "${canonicalSnapshotSha}".`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: expectedArmId,
        });
      }
    }
  }

  if (state === 'MEASURED' || state === 'COMPLETE') {
    for (const expectedArmId of BENCHMARK_ARM_IDS) {
      const armAny = armsMap.get(expectedArmId) as unknown as Record<string, unknown> | undefined;
      const verEv =
        options?.verificationEvidence?.[expectedArmId] ??
        (armAny?.verificationEvidence as BenchmarkVerificationEvidence);
      if (!verEv) {
        violations.push({
          code: INTEGRITY_VIOLATION_CODES.MISSING_REQUIRED_EVIDENCE,
          message: `Trial state is "${state}" but verification evidence for arm "${expectedArmId}" is missing.`,
          category: 'CATEGORY_A',
          severity: 'CRITICAL',
          armId: expectedArmId,
        });
      }
    }
  }

  // 10. Sort violations deterministically by (armId, code, message)
  violations.sort((a, b) => {
    const armAStr = a.armId ?? '';
    const armBStr = b.armId ?? '';
    const armComp = armAStr.localeCompare(armBStr);
    if (armComp !== 0) return armComp;

    const codeComp = a.code.localeCompare(b.code);
    if (codeComp !== 0) return codeComp;

    return a.message.localeCompare(b.message);
  });

  return deepFreeze({
    valid: violations.length === 0,
    violations,
  });
}

/**
 * Convenience wrapper class for Integrity Guard.
 */
export class IntegrityGuard {
  static validate(
    trial: TrialRecord,
    options?: IntegrityCheckOptions
  ): IntegrityCheckResult {
    return validateTrialIntegrity(trial, options);
  }
}
