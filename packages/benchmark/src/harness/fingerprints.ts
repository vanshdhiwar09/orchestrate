import { createHash } from 'node:crypto';
import type {
  BenchmarkArmId,
  ControlFingerprint,
  HarnessExecutionControls,
  TreatmentFingerprint,
} from './types.js';

/**
 * Deterministically serializes any JavaScript value to a JSON string with sorted object keys.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`
  );
  return `{${pairs.join(',')}}`;
}

/**
 * Computes a SHA-256 hexadecimal hash over a string using UTF-8 encoding.
 */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ComputeControlFingerprintParams {
  snapshotCommitSha: string;
  taskBPrompt: string;
  controls: HarnessExecutionControls;
  environmentDependencyFingerprint: string;
}

/**
 * Computes the immutable ControlFingerprint for a benchmark trial.
 * Proves that all controls outside the intentional treatment block are identical across arms.
 * Timestamps, process IDs, arm IDs, and treatment payloads are STRICTLY EXCLUDED.
 */
export function computeControlFingerprint(
  params: ComputeControlFingerprintParams
): ControlFingerprint {
  const { snapshotCommitSha, taskBPrompt, controls, environmentDependencyFingerprint } = params;

  if (!snapshotCommitSha || typeof snapshotCommitSha !== 'string') {
    throw new Error('computeControlFingerprint: snapshotCommitSha must be a non-empty string.');
  }
  if (!taskBPrompt || typeof taskBPrompt !== 'string' || taskBPrompt.trim() === '') {
    throw new Error('computeControlFingerprint: taskBPrompt must be a non-empty string.');
  }
  if (!controls || typeof controls !== 'object') {
    throw new Error('computeControlFingerprint: controls must be a valid HarnessExecutionControls object.');
  }

  const taskBPromptHash = sha256(canonicalJson(taskBPrompt.trim()));

  const inferenceConfigHash = sha256(
    canonicalJson({
      modelId: controls.modelId,
      temperature: controls.temperature ?? null,
      topP: controls.topP ?? null,
      maxTokens: controls.maxTokens ?? null,
      seed: controls.seed ?? null,
    })
  );

  const systemInstructionsHash = sha256(
    canonicalJson(controls.baseSystemInstructions.trim())
  );

  const toolDefinitionsHash = sha256(
    canonicalJson(controls.toolDefinitions ?? [])
  );

  const toolPermissionsHash = sha256(
    canonicalJson([...(controls.toolPermissions ?? [])].sort())
  );

  const executionLimitsHash = sha256(
    canonicalJson({
      taskTimeoutMs: controls.taskTimeoutMs,
      maxSteps: controls.maxSteps,
      commandTimeoutMs: controls.commandTimeoutMs,
    })
  );

  const filesystemPolicyHash = sha256(
    canonicalJson({
      workspaceContainment: true,
      pathTraversalForbidden: true,
      symlinkEscapeForbidden: true,
    })
  );

  const networkPolicyHash = sha256(
    canonicalJson({
      localOnlySubprocesses: true,
      modelEgressPermitted: true,
    })
  );

  const runtimeConfigHash = sha256(
    canonicalJson({
      sanitizedEnv: controls.sanitizedEnv ?? {},
    })
  );

  return Object.freeze({
    snapshotCommitSha: snapshotCommitSha.toLowerCase().trim(),
    taskBPromptHash,
    modelIdentity: controls.modelId,
    inferenceConfigHash,
    systemInstructionsHash,
    toolDefinitionsHash,
    toolPermissionsHash,
    environmentDependencyFingerprint: environmentDependencyFingerprint.trim(),
    executionLimitsHash,
    filesystemPolicyHash,
    networkPolicyHash,
    harnessVersion: controls.harnessVersion.trim(),
    runtimeConfigHash,
  });
}

/**
 * Computes the immutable TreatmentFingerprint for an arm.
 * Captures ONLY the intentional treatment payload supplied to Agent B.
 */
export function computeTreatmentFingerprint(
  armId: BenchmarkArmId,
  rawPayload: string | null
): TreatmentFingerprint {
  let treatmentPayloadHash: string;

  switch (armId) {
    case 'ARM_A_BASELINE':
      // Empty context representation
      treatmentPayloadHash = sha256('');
      break;
    case 'ARM_B_UNVERIFIED_HANDOFF':
      if (typeof rawPayload !== 'string' || rawPayload.trim() === '') {
        throw new Error(
          'computeTreatmentFingerprint: ARM_B_UNVERIFIED_HANDOFF requires a non-empty rawPayload string.'
        );
      }
      treatmentPayloadHash = sha256(canonicalJson(rawPayload.trim()));
      break;
    case 'ARM_C_ORCHESTRATE':
      if (typeof rawPayload !== 'string' || rawPayload.trim() === '') {
        throw new Error(
          'computeTreatmentFingerprint: ARM_C_ORCHESTRATE requires a non-empty rawPayload string.'
        );
      }
      treatmentPayloadHash = sha256(canonicalJson(rawPayload.trim()));
      break;
    default:
      throw new Error(`computeTreatmentFingerprint: Unknown armId "${armId}".`);
  }

  return Object.freeze({
    armId,
    treatmentPayloadHash,
  });
}
