import { describe, it, expect, vi } from 'vitest';
import {
  AgentExecutionAdapter,
  TaskTimeoutError,
} from '../../src/harness/agent-adapter.js';
import type {
  ArmExecutionInput,
  BenchmarkWorkspace,
  WorkspaceFactory,
} from '../../src/harness/types.js';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import { computeTreatmentFingerprint } from '../../src/harness/fingerprints.js';

describe('Task Timeout Enforcement', () => {
  const dummyTreatment = computeTreatmentFingerprint('ARM_A_BASELINE', null);

  const dummyInput: ArmExecutionInput = {
    trialId: 'trial-timeout-test',
    armId: 'ARM_A_BASELINE',
    snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
    taskBPrompt: 'Do something that hangs.',
    systemPrompt: 'System prompt.',
    contextEnvelope: null,
    controlFingerprint: {
      snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
      taskBPromptHash: 'a',
      modelIdentity: 'test-model',
      inferenceConfigHash: 'b',
      systemInstructionsHash: 'c',
      toolDefinitionsHash: 'd',
      toolPermissionsHash: 'e',
      environmentDependencyFingerprint: 'f',
      executionLimitsHash: 'g',
      filesystemPolicyHash: 'h',
      networkPolicyHash: 'i',
      harnessVersion: '1.0.0',
      runtimeConfigHash: 'j',
    },
    treatmentFingerprint: dummyTreatment,
    taskTimeoutMs: 100, // 100ms timeout
  };

  it('aborts execution when agent exceeds taskTimeoutMs and marks outcome as FAILED', async () => {
    let workspaceCleanedUp = false;

    const mockWorkspace: BenchmarkWorkspace = {
      path: 'C:/fake/workspace',
      workspace: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        deleteFile: vi.fn(),
        listDirectory: vi.fn(),
        exists: vi.fn(),
      } as any,
      git: {} as any,
      cleanup: async () => {
        workspaceCleanedUp = true;
      },
    };

    const mockFactory: WorkspaceFactory = {
      create: async () => mockWorkspace,
    };

    // Model client that simulates a hanging completion
    const hangingClient: ModelClient = {
      complete: async (_req: ModelRequest): Promise<ModelResponse> => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              id: 'resp-hang',
              model: 'test-model',
              finishReason: 'stop',
              message: { role: 'assistant', content: 'Done late' },
            });
          }, 500); // 500ms > 100ms timeout
        });
      },
    };

    const adapter = new AgentExecutionAdapter({
      workspaceFactory: mockFactory,
      modelClient: hangingClient,
      taskTimeoutMs: 100,
    });

    const result = await adapter.execute(dummyInput);

    expect(result.evidence.outcome).toBe('FAILED');
    expect(result.evidence.error).toBeDefined();
    expect(result.evidence.error?.message).toMatch(/exceeded timeout limit of 100ms/);
    expect(workspaceCleanedUp).toBe(true);
  });
});
