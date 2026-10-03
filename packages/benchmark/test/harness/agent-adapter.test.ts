import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalCommandExecutor,
  LocalGitRepository,
  LocalWorkspace,
} from '@orchestrate/workspace';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import { ToolRegistry } from '@orchestrate/core';
import { AgentExecutionAdapter } from '../../src/harness/agent-adapter.js';
import { verifyEvidenceSeal } from '../../src/harness/evidence-sealer.js';
import type {
  ArmExecutionInput,
  BenchmarkWorkspace,
  WorkspaceFactory,
} from '../../src/harness/types.js';

describe('AgentExecutionAdapter', () => {
  const validSha = '0123456789abcdef0123456789abcdef01234567';

  const createMockWorkspaceFactory = (): WorkspaceFactory => {
    return {
      create: async (sha: string): Promise<BenchmarkWorkspace> => {
        const tempDir = join(tmpdir(), `agent-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
        await mkdir(join(tempDir, '.git'), { recursive: true });
        await writeFile(join(tempDir, 'package.json'), '{}', 'utf-8');

        const executor = new LocalCommandExecutor({ workspaceRoot: tempDir });
        const workspace = new LocalWorkspace({ rootPath: tempDir });
        const git: any = {
          isRepository: async () => true,
          getStatus: async () => ({ clean: true, staged: [], unstaged: [], untracked: [], branch: null, detached: true }),
          getHeadCommit: async () => ({ hash: sha, subject: 'commit', author: 'tester', timestamp: '2026-10-01T00:00:00Z' }),
          getRecentCommits: async () => [],
          getDiff: async () => '',
        };

        return {
          path: tempDir,
          workspace,
          git,
          cleanup: async () => {},
        };
      },
      cleanup: async (_path: string): Promise<void> => {},
    };
  };

  const sampleArmInput: ArmExecutionInput = {
    trialId: 'trial-run-100',
    armId: 'ARM_A_BASELINE',
    snapshotCommitSha: validSha,
    taskBPrompt: 'Create a greeting file named hello.txt with content Hello World.',
    systemPrompt: 'You are a coding agent.',
    contextEnvelope: null,
    controlFingerprint: {
      snapshotCommitSha: validSha,
      taskBPromptHash: 'hash-abc',
      modelIdentity: 'mock-model-v1',
      inferenceConfigHash: 'inf-hash',
      systemInstructionsHash: 'sys-hash',
      toolDefinitionsHash: 'tool-hash',
      toolPermissionsHash: 'perm-hash',
      environmentDependencyFingerprint: 'env-hash',
      executionLimitsHash: 'lim-hash',
      filesystemPolicyHash: 'fs-hash',
      networkPolicyHash: 'net-hash',
      harnessVersion: '1.0.0',
      runtimeConfigHash: 'rt-hash',
    },
    treatmentFingerprint: {
      armId: 'ARM_A_BASELINE',
      treatmentPayloadHash: 'treat-hash',
    },
  };

  it('executes single arm, captures model/tool events, and produces sealed evidence', async () => {
    let callCount = 0;
    const mockModel: ModelClient = {
      complete: async (req: ModelRequest): Promise<ModelResponse> => {
        callCount++;
        if (callCount === 1) {
          // Model invokes write_file tool
          return {
            id: 'resp-1',
            model: req.model,
            message: {
              role: 'assistant',
              content: null,
              toolCalls: [
                {
                  id: 'tc-1',
                  name: 'write_file',
                  arguments: { path: 'hello.txt', content: 'Hello World' },
                },
              ],
            },
            finishReason: 'tool_calls',
            usage: { promptTokens: 15, completionTokens: 25, totalTokens: 40 },
          };
        }

        // Final response
        return {
          id: 'resp-2',
          model: req.model,
          message: {
            role: 'assistant',
            content: 'I have written hello.txt.',
          },
          finishReason: 'stop',
          usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
        };
      },
    };

    const adapter = new AgentExecutionAdapter({
      workspaceFactory: createMockWorkspaceFactory(),
      modelClient: mockModel,
    });

    const { evidence, workspace } = await adapter.execute(sampleArmInput);

    expect(evidence.trialId).toBe('trial-run-100');
    expect(evidence.armId).toBe('ARM_A_BASELINE');
    expect(evidence.snapshotCommitSha).toBe(validSha);
    expect(evidence.outcome).toBe('COMPLETED');
    expect(evidence.finalResponse?.content).toBe('I have written hello.txt.');
    expect(evidence.finalResponse?.finishReason).toBe('stop');

    // Host-independent normalized workspace path (Fix 2)
    expect(evidence.workspacePath).toBe('workspace://ARM_A_BASELINE');
    expect(evidence.workspacePath).not.toContain(tmpdir());

    // Live workspace handle retained for verification and teardown (Fix 3)
    expect(workspace).toBeDefined();
    expect(workspace.path).toBeDefined();
    expect(typeof workspace.cleanup).toBe('function');

    // Model and Tool events captured
    expect(evidence.modelEvents).toHaveLength(2);
    expect(evidence.toolEvents).toHaveLength(1);
    expect(evidence.toolEvents[0].toolName).toBe('write_file');
    expect(evidence.toolEvents[0].success).toBe(true);

    // Token usage accumulated
    expect(evidence.usage.input_tokens).toBe(45);
    expect(evidence.usage.output_tokens).toBe(35);
    expect(evidence.usage.total_tokens).toBe(80);
    expect(evidence.usage.usage_available).toBe(true);
    expect(evidence.usage.estimated_cost_usd).toBe(0);

    // Timing captured
    expect(typeof evidence.durationMs).toBe('number');
    expect(evidence.startedAt).toBeDefined();
    expect(evidence.completedAt).toBeDefined();

    // Sealed evidence verification
    expect(evidence.evidenceContentHash).toBeDefined();
    expect(verifyEvidenceSeal(evidence)).toBe(true);
  });

  it('handles model failure cleanly and records FAILED outcome with error evidence', async () => {
    const failingModel: ModelClient = {
      complete: async () => {
        throw new Error('Connection refused to Nebius API with key: secret-nebius-key-12345');
      },
    };

    const adapter = new AgentExecutionAdapter({
      workspaceFactory: createMockWorkspaceFactory(),
      modelClient: failingModel,
    });

    const { evidence } = await adapter.execute(sampleArmInput);

    expect(evidence.outcome).toBe('FAILED');
    expect(evidence.error).toBeDefined();
    expect(evidence.error?.message).toContain('Connection refused');
    expect(evidence.error?.message).toContain('[REDACTED]');
    expect(evidence.error?.message).not.toContain('secret-nebius-key-12345');

    // Evidence is still sealed properly
    expect(verifyEvidenceSeal(evidence)).toBe(true);
  });

  it('handles tool execution failures and continues agent loop', async () => {
    let callCount = 0;
    const mockModel: ModelClient = {
      complete: async (req: ModelRequest): Promise<ModelResponse> => {
        callCount++;
        if (callCount === 1) {
          // Model invokes read_file on non-existent file
          return {
            id: 'resp-1',
            model: req.model,
            message: {
              role: 'assistant',
              content: null,
              toolCalls: [
                {
                  id: 'tc-1',
                  name: 'read_file',
                  arguments: { path: 'does_not_exist.txt' },
                },
              ],
            },
            finishReason: 'tool_calls',
          };
        }

        return {
          id: 'resp-2',
          model: req.model,
          message: {
            role: 'assistant',
            content: 'The file was not found.',
          },
          finishReason: 'stop',
        };
      },
    };

    const adapter = new AgentExecutionAdapter({
      workspaceFactory: createMockWorkspaceFactory(),
      modelClient: mockModel,
    });

    const { evidence } = await adapter.execute(sampleArmInput);

    expect(evidence.outcome).toBe('COMPLETED');
    expect(evidence.toolEvents).toHaveLength(1);
    expect(evidence.toolEvents[0].toolName).toBe('read_file');
    expect(evidence.toolEvents[0].success).toBe(false); // Tool execution failed
    expect(evidence.toolEvents[0].error).toBeDefined();

    expect(verifyEvidenceSeal(evidence)).toBe(true);
  });

  it('forwards sampling controls (temperature, maxTokens) to the model client (Fix 4)', async () => {
    let capturedRequest: ModelRequest | null = null;
    const mockModel: ModelClient = {
      complete: async (req: ModelRequest): Promise<ModelResponse> => {
        capturedRequest = req;
        return {
          id: 'resp-sampling',
          model: req.model,
          message: { role: 'assistant', content: 'Done' },
          finishReason: 'stop',
        };
      },
    };

    const adapter = new AgentExecutionAdapter({
      workspaceFactory: createMockWorkspaceFactory(),
      modelClient: mockModel,
    });

    const inputWithSampling: ArmExecutionInput = {
      ...sampleArmInput,
      samplingConfig: {
        temperature: 0.15,
        maxTokens: 2048,
      },
    };

    const { evidence, workspace } = await adapter.execute(inputWithSampling);

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.temperature).toBe(0.15);
    expect(capturedRequest?.maxTokens).toBe(2048);
    expect(evidence.outcome).toBe('COMPLETED');
    expect(evidence.workspacePath).toBe('workspace://ARM_A_BASELINE');
    await workspace.cleanup();
  });
});
