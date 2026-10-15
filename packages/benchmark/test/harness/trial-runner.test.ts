import { describe, it, expect, vi } from 'vitest';
import {
  TrialRunner,
  mapToolEventsToDiscovery,
  type ArmExecutionEvidenceBundle,
  type RunTrialInput,
} from '../../src/harness/trial-runner.js';
import { SnapshotLoader } from '../../src/harness/snapshot-loader.js';
import { AgentExecutionAdapter } from '../../src/harness/agent-adapter.js';
import { VerificationAdapter } from '../../src/harness/verification-adapter.js';
import { DefaultDiscoveryEvaluator } from '../../src/discovery/evaluator.js';
import { INTEGRITY_VIOLATION_CODES } from '../../src/harness/integrity-guard.js';
import type {
  BenchmarkArmId,
  BenchmarkVerificationEvidence,
  BenchmarkWorkspace,
  HarnessExecutionControls,
  RawExecutionEvidence,
  ToolCallEvent,
  TrialIdentity,
  WorkspaceFactory,
} from '../../src/harness/types.js';
import type { GitRepository, Workspace } from '@orchestrate/workspace';
import type { ModelClient } from '@orchestrate/model';
import type { ArtifactManifest } from '../../src/manifest/types.js';

describe('TrialRunner Orchestration (M7 Phase 4.2)', () => {
  const snapshotSha = '0123456789abcdef0123456789abcdef01234567';

  const validIdentity: TrialIdentity = {
    runId: 'run-orchestrate-001',
    scenarioId: 'scenario-auth-api',
    replication: 1,
    taskAId: 'task-a-jwt',
    taskBId: 'task-b-login',
    snapshotId: 'snap-auth-001',
    snapshotCommitSha: snapshotSha,
  };

  const dummyControls: HarnessExecutionControls = {
    modelId: 'nebius/meta-llama/Llama-3.3-70B-Instruct',
    temperature: 0.2,
    topP: 0.95,
    maxTokens: 4096,
    seed: 42,
    baseSystemInstructions: 'You are a senior software engineer.',
    toolDefinitions: [{ name: 'read_file', description: 'Read file contents' }],
    toolPermissions: ['read_file', 'git_status'],
    taskTimeoutMs: 600000,
    maxSteps: 30,
    commandTimeoutMs: 30000,
    sanitizedEnv: { PATH: '/usr/bin' },
    harnessVersion: '1.0.0',
  };

  const sampleManifest: ArtifactManifest = {
    version: '1.0.0',
    scenarioId: 'scenario-auth-api',
    taskId: 'task-a-jwt',
    agentRunId: 'agent-a-001',
    baseCommit: '0000000000000000000000000000000000000000',
    commitSha: snapshotSha,
    timestamp: '2026-10-01T00:00:00Z',
    files: [
      {
        path: 'src/jwt.ts',
        status: 'ADDED',
        symbols: [
          {
            name: 'verifyToken',
            kind: 'function',
            exported: true,
          },
        ],
      },
    ],
  };

  const createMockSnapshotRepo = (sha = snapshotSha): GitRepository => {
    return {
      isRepository: async () => true,
      getHeadCommit: async () => ({
        hash: sha,
        subject: 'Snapshot commit',
        author: 'Agent A',
        timestamp: '2026-10-01T00:00:00Z',
      }),
      getStatus: async () => ({
        clean: true,
        staged: [],
        unstaged: [],
        untracked: [],
        branch: null,
        detached: true,
      }),
      getRecentCommits: async () => [
        {
          hash: sha,
          subject: 'Snapshot commit',
          author: 'Agent A',
          timestamp: '2026-10-01T00:00:00Z',
        },
      ],
      getDiff: async () => '',
    } as unknown as GitRepository;
  };

  let workspaceCounter = 0;
  const createMockWorkspaceFactory = () => {
    const createdPaths: string[] = [];
    const cleanupCalls: string[] = [];

    const factory: WorkspaceFactory = {
      create: async (sha: string): Promise<BenchmarkWorkspace> => {
        const wsPath = `C:/mock/workspaces/ws-${++workspaceCounter}`;
        createdPaths.push(wsPath);
        const mockWorkspace: any = {
          rootPath: wsPath,
          readFile: async () => '{}',
        };
        const mockGit: any = {
          isRepository: async () => true,
          getStatus: async () => ({
            clean: true,
            staged: [],
            unstaged: [],
            untracked: [],
            branch: null,
            detached: true,
          }),
          getHeadCommit: async () => ({
            hash: sha,
            subject: 'commit',
            author: 'tester',
            timestamp: '2026-10-01T00:00:00Z',
          }),
          getRecentCommits: async () => [],
          getDiff: async () => '',
        };
        return {
          path: wsPath,
          workspace: mockWorkspace,
          git: mockGit,
          cleanup: async () => {
            cleanupCalls.push(wsPath);
          },
        };
      },
      cleanup: async (p: string) => {
        cleanupCalls.push(p);
      },
    };

    return { factory, createdPaths, cleanupCalls };
  };

  const createMockModelClient = (): ModelClient => ({
    complete: async () => ({
      message: { role: 'assistant', content: 'Task completed successfully.' },
      usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
      finishReason: 'stop',
    }),
  });

  const createMockUpstreamWorkspace = (): Pick<Workspace, 'readFile'> => ({
    readFile: async () => 'export function verifyToken() {}',
  });

  const createSampleTrialInput = (): RunTrialInput => ({
    identity: validIdentity,
    taskBPrompt: 'Implement the protected authentication endpoint according to requirements.',
    armBUnverifiedHandoff: 'Task A completed JWT middleware and created src/jwt.ts.',
    armCCompiledContext: 'Verified knowledge: JWT middleware exports verifyToken(req).',
    controls: dummyControls,
    environmentDependencyFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
    verificationChecks: [
      {
        name: 'unit_tests',
        command: 'npm test',
        timeoutMs: 30000,
      },
    ],
    armOrderSeed: 42,
    manifest: sampleManifest,
    upstreamWorkspace: createMockUpstreamWorkspace(),
  });

  const createSampleRawEvidence = (
    armId: BenchmarkArmId,
    workspacePath: string,
    outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED',
    toolEvents: ToolCallEvent[] = []
  ): RawExecutionEvidence => ({
    trialId: validIdentity.runId,
    armId,
    snapshotCommitSha: snapshotSha,
    workspacePath,
    modelIdentity: dummyControls.modelId,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1500,
    outcome,
    modelEvents: [],
    toolEvents,
    finalResponse: { content: 'Finished' },
    usage: {
      input_tokens: 50,
      output_tokens: 50,
      total_tokens: 100,
      estimated_cost_usd: 0.001,
      usage_available: true,
    },
    evidenceContentHash: `hash-${armId}`,
  });

  const createSampleVerificationEvidence = (
    armId: BenchmarkArmId,
    workspacePath: string,
    status: 'VERIFIED' | 'FAILED' = 'VERIFIED',
    diff = ''
  ): BenchmarkVerificationEvidence => ({
    armId,
    taskId: validIdentity.taskBId,
    snapshotCommitSha: snapshotSha,
    workspacePath,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 500,
    status,
    checks: [],
    workspaceBinding: {
      snapshotCommitSha: snapshotSha,
      workspacePath,
      headCommitSha: snapshotSha,
      headCommit: null,
      gitStatus: { clean: true, staged: [], unstaged: [], untracked: [], branch: null, detached: true },
    },
    diffCapture: {
      snapshotCommitSha: snapshotSha,
      headCommitSha: snapshotSha,
      headCommit: null,
      gitStatus: { clean: true, staged: [], unstaged: [], untracked: [], branch: null, detached: true },
      changes: { added: [], modified: [], deleted: [], renamed: [] },
      diff,
      capturedAt: new Date().toISOString(),
    },
    evidenceContentHash: `ver-hash-${armId}`,
  });

  // 11. valid trial runs all three arms
  it('11. valid trial runs all three arms', async () => {
    const { factory, cleanupCalls } = createMockWorkspaceFactory();
    const repo = createMockSnapshotRepo();
    const modelClient = createMockModelClient();

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        const ws = await factory.create(input.snapshotCommitSha);
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const mockVerificationAdapter = {
      verify: vi.fn(async (input) => {
        return createSampleVerificationEvidence(input.armId, input.workspace.path);
      }),
    } as unknown as VerificationAdapter;

    const runner = new TrialRunner({
      snapshotRepo: repo,
      workspaceFactory: factory,
      modelClient,
      agentAdapter: mockAgentAdapter,
      verificationAdapter: mockVerificationAdapter,
    });

    const result = await runner.runTrial(createSampleTrialInput());

    expect(result.valid).toBe(true);
    expect(result.trial.state).toBe('COMPLETE');
    expect(mockAgentAdapter.execute).toHaveBeenCalledTimes(3);
    expect(mockVerificationAdapter.verify).toHaveBeenCalledTimes(3);
    expect(result.armResults.ARM_A_BASELINE).toBeDefined();
    expect(result.armResults.ARM_B_UNVERIFIED_HANDOFF).toBeDefined();
    expect(result.armResults.ARM_C_ORCHESTRATE).toBeDefined();
  });

  // 12. randomized arm order is respected
  it('12. randomized arm order is respected', async () => {
    const { factory } = createMockWorkspaceFactory();
    const executedArmOrder: BenchmarkArmId[] = [];

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        executedArmOrder.push(input.armId);
        const ws = await factory.create(input.snapshotCommitSha);
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const mockVerificationAdapter = {
      verify: vi.fn(async (input) => {
        return createSampleVerificationEvidence(input.armId, input.workspace.path);
      }),
    } as unknown as VerificationAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: mockVerificationAdapter,
    });

    const result = await runner.runTrial(createSampleTrialInput());
    expect(result.valid).toBe(true);
    // The execution order in runner must exactly match the trial.executionOrder
    expect(executedArmOrder).toEqual(result.trial.executionOrder);
  });

  // 13. all arms receive same control fingerprint
  it('13. all arms receive same control fingerprint', async () => {
    const { factory } = createMockWorkspaceFactory();
    const receivedFingerprints: any[] = [];

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        receivedFingerprints.push(input.controlFingerprint);
        const ws = await factory.create(input.snapshotCommitSha);
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    await runner.runTrial(createSampleTrialInput());

    expect(receivedFingerprints).toHaveLength(3);
    expect(receivedFingerprints[0]).toEqual(receivedFingerprints[1]);
    expect(receivedFingerprints[1]).toEqual(receivedFingerprints[2]);
  });

  // 14. treatments remain distinct
  it('14. treatments remain distinct', async () => {
    const { factory } = createMockWorkspaceFactory();
    const treatments: Record<string, any> = {};

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        treatments[input.armId] = {
          envelope: input.contextEnvelope,
          treatmentFp: input.treatmentFingerprint,
          systemPrompt: input.systemPrompt,
        };
        const ws = await factory.create(input.snapshotCommitSha);
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    await runner.runTrial(createSampleTrialInput());

    // ARM_A has null envelope
    expect(treatments.ARM_A_BASELINE.envelope).toBeNull();
    // ARM_B has unverified handoff block
    expect(treatments.ARM_B_UNVERIFIED_HANDOFF.envelope.formattedBlock).toContain('<orchestrate_handoff>');
    // ARM_C has compiled context block
    expect(treatments.ARM_C_ORCHESTRATE.envelope.formattedBlock).toContain('<orchestrate_context>');

    // Treatment fingerprints are mutually distinct
    expect(treatments.ARM_A_BASELINE.treatmentFp.treatmentPayloadHash).not.toBe(
      treatments.ARM_B_UNVERIFIED_HANDOFF.treatmentFp.treatmentPayloadHash
    );
    expect(treatments.ARM_B_UNVERIFIED_HANDOFF.treatmentFp.treatmentPayloadHash).not.toBe(
      treatments.ARM_C_ORCHESTRATE.treatmentFp.treatmentPayloadHash
    );
  });

  // 15. each arm gets a distinct workspace
  it('15. each arm gets a distinct workspace', async () => {
    const { factory } = createMockWorkspaceFactory();
    const workspacesUsed: string[] = [];

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        const ws = await factory.create(input.snapshotCommitSha);
        workspacesUsed.push(ws.path);
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    await runner.runTrial(createSampleTrialInput());

    expect(workspacesUsed).toHaveLength(3);
    const uniqueWorkspaces = new Set(workspacesUsed);
    expect(uniqueWorkspaces.size).toBe(3);
  });

  // 16. Integrity Guard runs before execution
  it('16. Integrity Guard runs before execution', async () => {
    const { factory } = createMockWorkspaceFactory();
    const mockAgentAdapter = {
      execute: vi.fn(),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
    });

    // Provide taskBPrompt containing forbidden token
    const invalidInput = createSampleTrialInput();
    invalidInput.taskBPrompt += ' This references ARM_A_BASELINE.';

    const result = await runner.runTrial(invalidInput);

    expect(result.valid).toBe(false);
    expect(result.trial.state).toBe('INVALID');
    expect(result.integrityPreflight.valid).toBe(false);
    expect(mockAgentAdapter.execute).not.toHaveBeenCalled();
  });

  // 17. AgentExecutionAdapter is called with the correct arm treatment
  it('17. AgentExecutionAdapter is called with the correct arm treatment', async () => {
    const { factory } = createMockWorkspaceFactory();
    const executedInputs: any[] = [];

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        executedInputs.push(input);
        const ws = await factory.create(input.snapshotCommitSha);
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    await runner.runTrial(createSampleTrialInput());

    for (const inp of executedInputs) {
      if (inp.armId === 'ARM_A_BASELINE') {
        expect(inp.contextEnvelope).toBeNull();
      } else if (inp.armId === 'ARM_B_UNVERIFIED_HANDOFF') {
        expect(inp.contextEnvelope.formattedBlock).toContain('<orchestrate_handoff>');
      } else if (inp.armId === 'ARM_C_ORCHESTRATE') {
        expect(inp.contextEnvelope.formattedBlock).toContain('<orchestrate_context>');
      }
    }
  });

  // 18. VerificationAdapter receives the exact live arm workspace
  it('18. VerificationAdapter receives the exact live arm workspace', async () => {
    const { factory } = createMockWorkspaceFactory();
    const verifiedWorkspaces: string[] = [];

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        const ws = await factory.create(input.snapshotCommitSha);
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const mockVerificationAdapter = {
      verify: vi.fn(async (input) => {
        verifiedWorkspaces.push(input.workspace.path);
        return createSampleVerificationEvidence(input.armId, input.workspace.path);
      }),
    } as unknown as VerificationAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: mockVerificationAdapter,
    });

    await runner.runTrial(createSampleTrialInput());

    expect(verifiedWorkspaces).toHaveLength(3);
    for (const wsPath of verifiedWorkspaces) {
      expect(wsPath).toContain('C:/mock/workspaces/ws-');
    }
  });

  // 19. diff capture uses the canonical Task-A snapshot SHA
  it('19. diff capture uses the canonical Task-A snapshot SHA', async () => {
    const { factory } = createMockWorkspaceFactory();
    const verificationSnapshotShas: string[] = [];

    const mockVerificationAdapter = {
      verify: vi.fn(async (input) => {
        verificationSnapshotShas.push(input.snapshotCommitSha);
        return createSampleVerificationEvidence(input.armId, input.workspace.path);
      }),
    } as unknown as VerificationAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: mockVerificationAdapter,
    });

    await runner.runTrial(createSampleTrialInput());

    expect(verificationSnapshotShas).toHaveLength(3);
    for (const sha of verificationSnapshotShas) {
      expect(sha).toBe(snapshotSha);
    }
  });

  // 20. discovery measurement receives raw tool events
  it('20. discovery measurement receives raw tool events', async () => {
    const { factory } = createMockWorkspaceFactory();
    const evaluatedDiscoveryInputs: any[] = [];

    const mockToolEvents: ToolCallEvent[] = [
      {
        sequence: 1,
        type: 'TOOL_CALL',
        toolName: 'read_file',
        arguments: { path: 'src/auth.ts' },
        result: 'contents',
        success: true,
        durationMs: 10,
      },
      {
        sequence: 2,
        type: 'TOOL_CALL',
        toolName: 'git_status',
        arguments: {},
        result: 'clean',
        success: true,
        durationMs: 5,
      },
    ];

    const mockDiscoveryEvaluator = {
      evaluate: vi.fn((input) => {
        evaluatedDiscoveryInputs.push(input);
        return new DefaultDiscoveryEvaluator().evaluate(input);
      }),
    };

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path, 'COMPLETED', mockToolEvents),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
      discoveryEvaluator: mockDiscoveryEvaluator,
    });

    await runner.runTrial(createSampleTrialInput());

    expect(mockDiscoveryEvaluator.evaluate).toHaveBeenCalledTimes(3);
    expect(evaluatedDiscoveryInputs[0].events).toHaveLength(2);
    expect(evaluatedDiscoveryInputs[0].events[0].toolName).toBe('read_file');
    expect(evaluatedDiscoveryInputs[0].events[1].toolName).toBe('git_status');
  });

  // 21. rework measurement receives frozen manifest + downstream diff
  it('21. rework measurement receives frozen manifest + downstream diff', async () => {
    const { factory } = createMockWorkspaceFactory();
    const reworkInputs: any[] = [];

    const mockReworkEvaluator = {
      evaluate: vi.fn(async (input) => {
        reworkInputs.push(input);
        return {
          upstreamTaskId: 'task-a-jwt',
          downstreamTaskId: 'task-b-login',
          rework_events: 1,
          events: [],
          ambiguous: [],
          summary: {
            totalFilesEvaluated: 1,
            upstreamFilesChecked: 1,
            reworkFilesCount: 1,
            ambiguousFilesCount: 0,
          },
        };
      }),
    };

    const testDiff = 'diff --git a/src/jwt.ts b/src/jwt.ts\n--- a/src/jwt.ts\n+++ b/src/jwt.ts';

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: {
        verify: async (input) =>
          createSampleVerificationEvidence(input.armId, input.workspace.path, 'VERIFIED', testDiff),
      } as unknown as VerificationAdapter,
      reworkEvaluator: mockReworkEvaluator,
    });

    await runner.runTrial(createSampleTrialInput());

    expect(mockReworkEvaluator.evaluate).toHaveBeenCalledTimes(3);
    expect(reworkInputs[0].manifest).toBe(sampleManifest);
    expect(reworkInputs[0].diff).toBe(testDiff);
  });

  // 22. evidence is preserved when an arm fails
  it('22. evidence is preserved when an arm fails', async () => {
    const { factory } = createMockWorkspaceFactory();

    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        const ws = await factory.create(input.snapshotCommitSha);
        const outcome = input.armId === 'ARM_B_UNVERIFIED_HANDOFF' ? 'FAILED' : 'COMPLETED';
        return {
          evidence: createSampleRawEvidence(input.armId, ws.path, outcome),
          workspace: ws,
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    const result = await runner.runTrial(createSampleTrialInput());

    // Agent execution failure is valid benchmark evidence (Category B), trial completes
    expect(result.valid).toBe(true);
    expect(result.trial.state).toBe('COMPLETE');
    expect(result.armResults.ARM_B_UNVERIFIED_HANDOFF?.status).toBe('FAILED');
    expect(result.armResults.ARM_B_UNVERIFIED_HANDOFF?.rawEvidence).toBeDefined();
  });

  // 23. verification failure does not become harness failure
  it('23. verification failure does not become harness failure', async () => {
    const { factory } = createMockWorkspaceFactory();

    const mockVerificationAdapter = {
      verify: vi.fn(async (input) => {
        const status = input.armId === 'ARM_A_BASELINE' ? 'FAILED' : 'VERIFIED';
        return createSampleVerificationEvidence(input.armId, input.workspace.path, status);
      }),
    } as unknown as VerificationAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: mockVerificationAdapter,
    });

    const result = await runner.runTrial(createSampleTrialInput());

    // Verification failure is benchmark evidence (Category C), trial completes successfully
    expect(result.valid).toBe(true);
    expect(result.trial.state).toBe('COMPLETE');
    expect(result.armResults.ARM_A_BASELINE?.status).toBe('FAILED');
    expect(result.armResults.ARM_A_BASELINE?.verificationEvidence?.status).toBe('FAILED');
  });

  // 24. integrity violation produces INVALID
  it('24. integrity violation produces INVALID', async () => {
    const { factory } = createMockWorkspaceFactory();

    // Snapshot loader fails to resolve commit
    const failingRepo = {
      isRepository: async () => true,
      getHeadCommit: async () => null,
      getRecentCommits: async () => [],
      getStatus: async () => ({ clean: true, staged: [], unstaged: [], untracked: [], branch: null, detached: true }),
    } as unknown as GitRepository;

    const runner = new TrialRunner({
      snapshotRepo: failingRepo,
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
    });

    const result = await runner.runTrial(createSampleTrialInput());

    expect(result.valid).toBe(false);
    expect(result.trial.state).toBe('INVALID');
    expect(result.invalidationReason).toBeDefined();
  });

  // 25. cleanup happens after successful execution
  it('25. cleanup happens after successful execution', async () => {
    const { factory, cleanupCalls } = createMockWorkspaceFactory();

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    await runner.runTrial(createSampleTrialInput());

    // Cleaned up all 3 arm workspaces
    expect(cleanupCalls).toHaveLength(3);
  });

  // 26. cleanup happens after failed execution
  it('26. cleanup happens after failed execution', async () => {
    const { factory, cleanupCalls } = createMockWorkspaceFactory();

    const mockVerificationAdapter = {
      verify: vi.fn(async () => {
        throw new Error('Verification crash');
      }),
    } as unknown as VerificationAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: mockVerificationAdapter,
    });

    const result = await runner.runTrial(createSampleTrialInput());

    expect(result.valid).toBe(false);
    expect(result.trial.state).toBe('INVALID');
    // The workspace that was created before the crash is still cleaned up in finally
    expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);
  });

  // 27. no evidence is fabricated when an adapter throws
  it('27. no evidence is fabricated when an adapter throws', async () => {
    const { factory } = createMockWorkspaceFactory();

    const mockAgentAdapter = {
      execute: vi.fn(async () => {
        throw new Error('Host process crash in AgentAdapter');
      }),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
    });

    const result = await runner.runTrial(createSampleTrialInput());

    expect(result.valid).toBe(false);
    expect(result.trial.state).toBe('INVALID');
    expect(result.armResults).toEqual({});
    expect(result.invalidationReason).toContain('Host process crash in AgentAdapter');
  });

  // 28. final valid trial reaches COMPLETE
  it('28. final valid trial reaches COMPLETE', async () => {
    const { factory } = createMockWorkspaceFactory();

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    const result = await runner.runTrial(createSampleTrialInput());

    expect(result.valid).toBe(true);
    expect(result.trial.state).toBe('COMPLETE');
    expect(result.trial.invalidationReason).toBeUndefined();
  });

  // 29. final integrity validation is performed
  it('29. final integrity validation is performed', async () => {
    const { factory } = createMockWorkspaceFactory();

    // Fabricate two arms returning the exact same workspacePath in evidence to simulate isolation breach
    let callIndex = 0;
    const mockAgentAdapter = {
      execute: vi.fn(async (input) => {
        const ws = await factory.create(input.snapshotCommitSha);
        callIndex++;
        // Arms 1 and 2 reuse the exact same workspace path to trigger isolation breach
        const path = callIndex <= 2 ? 'C:/mock/workspaces/shared-breach' : ws.path;
        return {
          evidence: createSampleRawEvidence(input.armId, path),
          workspace: { ...ws, path },
        };
      }),
    } as unknown as AgentExecutionAdapter;

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: mockAgentAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    // Run trial where two arms share same workspace
    // Note: if arm 1 and 2 share the path, final integrity guard detects duplicate workspace identity!
    const sampleInput = createSampleTrialInput();
    const result = await runner.runTrial(sampleInput);

    expect(result.valid).toBe(false);
    expect(result.trial.state).toBe('INVALID');
    expect(
      result.violations?.some((v) => v.code === INTEGRITY_VIOLATION_CODES.DUPLICATE_WORKSPACE_IDENTITY)
    ).toBe(true);
  });

  // 30. execution order is reproducible from the same armOrderSeed
  it('30. execution order is reproducible from the same armOrderSeed', async () => {
    const { factory } = createMockWorkspaceFactory();

    const runner = new TrialRunner({
      snapshotRepo: createMockSnapshotRepo(),
      workspaceFactory: factory,
      modelClient: createMockModelClient(),
      agentAdapter: {
        execute: async (input) => {
          const ws = await factory.create(input.snapshotCommitSha);
          return {
            evidence: createSampleRawEvidence(input.armId, ws.path),
            workspace: ws,
          };
        },
      } as unknown as AgentExecutionAdapter,
      verificationAdapter: {
        verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
      } as unknown as VerificationAdapter,
    });

    const input1 = createSampleTrialInput();
    input1.armOrderSeed = 9999;
    const result1 = await runner.runTrial(input1);

    const input2 = createSampleTrialInput();
    input2.armOrderSeed = 9999;
    const result2 = await runner.runTrial(input2);

    expect(result1.trial.executionOrder).toEqual(result2.trial.executionOrder);
  });

  // Tool mapping helper test
  describe('mapToolEventsToDiscovery', () => {
    it('maps known qualifying tools to discovery categories and filters non-qualifying', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/main.ts' },
          result: 'code',
          success: true,
          durationMs: 10,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'write_file',
          arguments: { path: 'src/main.ts', content: 'new code' },
          result: 'ok',
          success: true,
          durationMs: 15,
        },
        {
          sequence: 3,
          type: 'TOOL_CALL',
          toolName: 'search',
          arguments: { query: 'authenticate' },
          result: 'matches',
          success: true,
          durationMs: 20,
        },
        {
          sequence: 4,
          type: 'TOOL_CALL',
          toolName: 'custom_mystery_tool',
          arguments: {},
          result: 'done',
          success: true,
          durationMs: 5,
        },
      ];

      const { events, unclassifiedEvents } = mapToolEventsToDiscovery(toolEvents);

      expect(events).toHaveLength(2);
      expect(events[0].category).toBe('FILE_READ');
      expect(events[0].target).toBe('src/main.ts');
      expect(events[1].category).toBe('SEARCH');
      expect(events[1].target).toBe('authenticate');

      expect(unclassifiedEvents).toHaveLength(2);
      expect(unclassifiedEvents[0].toolName).toBe('write_file');
      expect(unclassifiedEvents[1].toolName).toBe('custom_mystery_tool');
    });

    it('maps head to FILE_READ', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'head',
          arguments: { path: 'packages/core/src/index.ts', n: 20 },
          result: 'first 20 lines',
          success: true,
          durationMs: 5,
        },
      ];
      const { events } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('FILE_READ');
      expect(events[0].target).toBe('packages/core/src/index.ts');
    });

    it('maps tail to FILE_READ', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'tail',
          arguments: { filePath: 'packages/core/src/logger.ts', lines: 15 },
          result: 'last 15 lines',
          success: true,
          durationMs: 5,
        },
      ];
      const { events } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('FILE_READ');
      expect(events[0].target).toBe('packages/core/src/logger.ts');
    });

    it('maps tree to FILE_LIST', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'tree',
          arguments: { dir: 'packages/benchmark' },
          result: 'directory tree',
          success: true,
          durationMs: 8,
        },
      ];
      const { events } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('FILE_LIST');
      expect(events[0].target).toBe('packages/benchmark');
    });

    it('maps ripgrep to SEARCH', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'ripgrep',
          arguments: { pattern: 'TrialRunner' },
          result: 'matches found',
          success: true,
          durationMs: 12,
        },
      ];
      const { events } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(1);
      expect(events[0].category).toBe('SEARCH');
      expect(events[0].target).toBe('TrialRunner');
    });

    it('arbitrary run_command remains unclassified and is not guessed', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'run_command',
          arguments: { command: 'cat packages/core/src/index.ts' },
          result: 'output',
          success: true,
          durationMs: 10,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'run_command',
          arguments: { command: 'grep -r "test" .' },
          result: 'matches',
          success: true,
          durationMs: 15,
        },
        {
          sequence: 3,
          type: 'TOOL_CALL',
          toolName: 'run_command',
          arguments: { command: 'tree src/' },
          result: 'tree output',
          success: true,
          durationMs: 8,
        },
      ];
      const { events, unclassifiedEvents } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(0);
      expect(unclassifiedEvents).toHaveLength(3);
      expect(unclassifiedEvents[0].toolName).toBe('run_command');
      expect(unclassifiedEvents[1].toolName).toBe('run_command');
      expect(unclassifiedEvents[2].toolName).toBe('run_command');
    });

    // M7 Fix 2: Structured execute_command Git inspection mapping
    it('maps execute_command with git status to GIT_STATE', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['status'] },
          result: 'clean',
          success: true,
          durationMs: 5,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['status', '--porcelain'] },
          result: 'clean',
          success: true,
          durationMs: 5,
        },
      ];
      const { events, unclassifiedEvents } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(2);
      expect(events[0].category).toBe('GIT_STATE');
      expect(events[0].target).toBe('status');
      expect(events[1].category).toBe('GIT_STATE');
      expect(events[1].target).toBe('status');
      expect(unclassifiedEvents).toHaveLength(0);
    });

    it('maps execute_command with git log to GIT_HISTORY', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['log'] },
          result: 'commits',
          success: true,
          durationMs: 10,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['log', '-n', '5'] },
          result: 'commits',
          success: true,
          durationMs: 10,
        },
        {
          sequence: 3,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['log', 'main'] },
          result: 'commits',
          success: true,
          durationMs: 10,
        },
      ];
      const { events } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(3);
      expect(events[0].category).toBe('GIT_HISTORY');
      expect(events[0].target).toBe('HEAD');
      expect(events[1].category).toBe('GIT_HISTORY');
      expect(events[1].target).toBe('HEAD');
      expect(events[2].category).toBe('GIT_HISTORY');
      expect(events[2].target).toBe('main');
    });

    it('maps execute_command with git diff to GIT_DIFF', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['diff'] },
          result: '',
          success: true,
          durationMs: 10,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['diff', 'HEAD~1'] },
          result: '',
          success: true,
          durationMs: 10,
        },
      ];
      const { events } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(2);
      expect(events[0].category).toBe('GIT_DIFF');
      expect(events[0].target).toBe('');
      expect(events[1].category).toBe('GIT_DIFF');
      expect(events[1].target).toBe('HEAD~1');
    });

    it('non-inspection git commands remain non-qualifying and unclassified', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['commit', '-m', 'fix'] },
          result: 'committed',
          success: true,
          durationMs: 15,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['push', 'origin', 'main'] },
          result: 'pushed',
          success: true,
          durationMs: 20,
        },
        {
          sequence: 3,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['checkout', '-b', 'feat'] },
          result: 'checked out',
          success: true,
          durationMs: 10,
        },
        {
          sequence: 4,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: ['add', '.'] },
          result: 'added',
          success: true,
          durationMs: 5,
        },
      ];
      const { events, unclassifiedEvents } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(0);
      expect(unclassifiedEvents).toHaveLength(4);
      for (const u of unclassifiedEvents) {
        expect(u.toolName).toBe('execute_command');
      }
    });

    it('malformed command arguments do not crash the mapper and remain unclassified', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: {} as any,
          result: 'err',
          success: false,
          durationMs: 1,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git' } as any, // missing args array
          result: 'err',
          success: false,
          durationMs: 1,
        },
        {
          sequence: 3,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: 'not-an-array' } as any,
          result: 'err',
          success: false,
          durationMs: 1,
        },
        {
          sequence: 4,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'git', args: [] }, // empty args array
          result: 'err',
          success: false,
          durationMs: 1,
        },
        {
          sequence: 5,
          type: 'TOOL_CALL',
          toolName: 'execute_command',
          arguments: { command: 'npm', args: ['test'] }, // non-git command
          result: 'err',
          success: false,
          durationMs: 1,
        },
      ];
      const { events, unclassifiedEvents } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(0);
      expect(unclassifiedEvents).toHaveLength(5);
    });

    it('dedicated git tools retain their current behavior', () => {
      const toolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'git_status',
          arguments: {},
          result: 'clean',
          success: true,
          durationMs: 5,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'git_log',
          arguments: { ref: 'HEAD~2' },
          result: 'log',
          success: true,
          durationMs: 8,
        },
        {
          sequence: 3,
          type: 'TOOL_CALL',
          toolName: 'git_diff',
          arguments: { ref: 'main' },
          result: 'diff',
          success: true,
          durationMs: 7,
        },
      ];
      const { events } = mapToolEventsToDiscovery(toolEvents);
      expect(events).toHaveLength(3);
      expect(events[0].category).toBe('GIT_STATE');
      expect(events[0].target).toBe('status');
      expect(events[1].category).toBe('GIT_HISTORY');
      expect(events[1].target).toBe('HEAD~2');
      expect(events[2].category).toBe('GIT_DIFF');
      expect(events[2].target).toBe('main');
    });
  });

  describe('TrialRunner Automatic Context Derivation Integration (M7 Fix 1)', () => {
    it('automatically derives supplied context across arms, distinguishing Arm A vs B vs C', async () => {
      const { factory } = createMockWorkspaceFactory();
      const evaluatedContexts: Record<string, any[]> = {};

      // Tool events perform reads on:
      // 1. src/jwt.ts (supplied to Arm B in handoff and Arm C in compiled context)
      // 2. src/unrelated.ts (not supplied to any arm)
      const mockToolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/jwt.ts' },
          result: 'export function verifyToken() {}',
          success: true,
          durationMs: 10,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/unrelated.ts' },
          result: 'const x = 1;',
          success: true,
          durationMs: 10,
        },
      ];

      const mockDiscoveryEvaluator = {
        evaluate: vi.fn((input) => {
          evaluatedContexts[input.taskId] = evaluatedContexts[input.taskId] ?? [];
          evaluatedContexts[input.taskId].push(input);
          return new DefaultDiscoveryEvaluator().evaluate(input);
        }),
      };

      const runner = new TrialRunner({
        snapshotRepo: createMockSnapshotRepo(),
        workspaceFactory: factory,
        modelClient: createMockModelClient(),
        agentAdapter: {
          execute: async (input) => {
            const ws = await factory.create(input.snapshotCommitSha);
            return {
              evidence: createSampleRawEvidence(input.armId, ws.path, 'COMPLETED', mockToolEvents),
              workspace: ws,
            };
          },
        } as unknown as AgentExecutionAdapter,
        verificationAdapter: {
          verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
        } as unknown as VerificationAdapter,
        discoveryEvaluator: mockDiscoveryEvaluator,
      });

      const trialInput: RunTrialInput = {
        identity: validIdentity,
        taskBPrompt: 'Implement the protected authentication endpoint according to requirements.',
        // Arm B handoff mentions src/jwt.ts
        armBUnverifiedHandoff: 'Task A completed JWT middleware and created src/jwt.ts.',
        // Arm C compiled context XML contains src/jwt.ts
        armCCompiledContext: '<orchestrate_context><upstream_work task_id="task-a" trust_state="VERIFIED" attempt="1"><files_affected><file>src/jwt.ts</file></files_affected></upstream_work></orchestrate_context>',
        controls: dummyControls,
        environmentDependencyFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
        verificationChecks: [
          {
            name: 'unit_tests',
            command: 'npm test',
            timeoutMs: 30000,
          },
        ],
        // Note: suppliedContext is completely omitted here to test automatic derivation
      };

      const result = await runner.runTrial(trialInput);

      expect(result.valid).toBe(true);
      expect(result.trial.state).toBe('COMPLETE');

      const armAResult = result.armResults.ARM_A_BASELINE;
      const armBResult = result.armResults.ARM_B_UNVERIFIED_HANDOFF;
      const armCResult = result.armResults.ARM_C_ORCHESTRATE;

      // Arm A has no context envelope -> derives []
      // Both reads are discovery actions -> discovery_actions = 2
      expect(armAResult?.discoveryReport?.discovery_actions).toBe(2);
      expect(armAResult?.discoveryReport?.suppliedHits).toHaveLength(0);

      // Arm B handoff supplied src/jwt.ts -> read of src/jwt.ts is a supplied hit
      // Read of src/unrelated.ts is discovery -> discovery_actions = 1
      expect(armBResult?.discoveryReport?.discovery_actions).toBe(1);
      expect(armBResult?.discoveryReport?.suppliedHits).toHaveLength(1);
      expect(armBResult?.discoveryReport?.suppliedHits[0].target).toBe('src/jwt.ts');

      // Arm C compiled context supplied src/jwt.ts -> read of src/jwt.ts is a supplied hit
      // Read of src/unrelated.ts is discovery -> discovery_actions = 1
      expect(armCResult?.discoveryReport?.discovery_actions).toBe(1);
      expect(armCResult?.discoveryReport?.suppliedHits).toHaveLength(1);
      expect(armCResult?.discoveryReport?.suppliedHits[0].target).toBe('src/jwt.ts');
    });

    it('fails trial when context-bearing arm envelope is malformed XML', async () => {
      const { factory } = createMockWorkspaceFactory();

      const runner = new TrialRunner({
        snapshotRepo: createMockSnapshotRepo(),
        workspaceFactory: factory,
        modelClient: createMockModelClient(),
        agentAdapter: {
          execute: async (input) => {
            const ws = await factory.create(input.snapshotCommitSha);
            return {
              evidence: createSampleRawEvidence(input.armId, ws.path, 'COMPLETED', []),
              workspace: ws,
            };
          },
        } as unknown as AgentExecutionAdapter,
        verificationAdapter: {
          verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
        } as unknown as VerificationAdapter,
      });

      const trialInput: RunTrialInput = {
        identity: validIdentity,
        taskBPrompt: 'Implement the protected authentication endpoint according to requirements.',
        armBUnverifiedHandoff: 'Task A notes',
        // Malformed unclosed XML
        armCCompiledContext: '<orchestrate_context><file>src/jwt.ts</orchestrate_context>',
        controls: dummyControls,
        environmentDependencyFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
        verificationChecks: [
          {
            name: 'unit_tests',
            command: 'npm test',
            timeoutMs: 30000,
          },
        ],
      };

      const result = await runner.runTrial(trialInput);

      expect(result.valid).toBe(false);
      expect(result.trial.state).toBe('INVALID');
      expect(result.invalidationReason).toContain('Malformed XML');
    });

    it('fails trial when explicit suppliedContext claims an absent reference', async () => {
      const { factory } = createMockWorkspaceFactory();

      const runner = new TrialRunner({
        snapshotRepo: createMockSnapshotRepo(),
        workspaceFactory: factory,
        modelClient: createMockModelClient(),
        agentAdapter: {
          execute: async (input) => {
            const ws = await factory.create(input.snapshotCommitSha);
            return {
              evidence: createSampleRawEvidence(input.armId, ws.path, 'COMPLETED', []),
              workspace: ws,
            };
          },
        } as unknown as AgentExecutionAdapter,
        verificationAdapter: {
          verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
        } as unknown as VerificationAdapter,
      });

      const trialInput: RunTrialInput = {
        identity: validIdentity,
        taskBPrompt: 'Implement the protected authentication endpoint according to requirements.',
        armBUnverifiedHandoff: 'Task A created src/jwt.ts.',
        armCCompiledContext: '<orchestrate_context><file>src/jwt.ts</file></orchestrate_context>',
        controls: dummyControls,
        environmentDependencyFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
        verificationChecks: [
          {
            name: 'unit_tests',
            command: 'npm test',
            timeoutMs: 30000,
          },
        ],
        suppliedContext: {
          // Fraudulent claim: claims src/fraudulent.ts which was never in Arm B's envelope
          ARM_B_UNVERIFIED_HANDOFF: [{ type: 'FILE', value: 'src/fraudulent.ts' }],
        },
      };

      const result = await runner.runTrial(trialInput);

      expect(result.valid).toBe(false);
      expect(result.trial.state).toBe('INVALID');
      expect(result.invalidationReason).toContain('absent from the delivered context envelope');
    });

    it('repeated reads of unsupplied file count every time, repeated reads of supplied file remain exempt', async () => {
      const { factory } = createMockWorkspaceFactory();

      // Tool events: 3 reads of supplied file, 3 reads of unsupplied file
      const mockToolEvents: ToolCallEvent[] = [
        {
          sequence: 1,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/jwt.ts' },
          result: 'code',
          success: true,
          durationMs: 5,
        },
        {
          sequence: 2,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/jwt.ts' },
          result: 'code',
          success: true,
          durationMs: 5,
        },
        {
          sequence: 3,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/jwt.ts' },
          result: 'code',
          success: true,
          durationMs: 5,
        },
        {
          sequence: 4,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/unknown.ts' },
          result: 'code',
          success: true,
          durationMs: 5,
        },
        {
          sequence: 5,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/unknown.ts' },
          result: 'code',
          success: true,
          durationMs: 5,
        },
        {
          sequence: 6,
          type: 'TOOL_CALL',
          toolName: 'read_file',
          arguments: { path: 'src/unknown.ts' },
          result: 'code',
          success: true,
          durationMs: 5,
        },
      ];

      const runner = new TrialRunner({
        snapshotRepo: createMockSnapshotRepo(),
        workspaceFactory: factory,
        modelClient: createMockModelClient(),
        agentAdapter: {
          execute: async (input) => {
            const ws = await factory.create(input.snapshotCommitSha);
            return {
              evidence: createSampleRawEvidence(input.armId, ws.path, 'COMPLETED', mockToolEvents),
              workspace: ws,
            };
          },
        } as unknown as AgentExecutionAdapter,
        verificationAdapter: {
          verify: async (input) => createSampleVerificationEvidence(input.armId, input.workspace.path),
        } as unknown as VerificationAdapter,
      });

      const trialInput: RunTrialInput = {
        identity: validIdentity,
        taskBPrompt: 'Implement the protected authentication endpoint according to requirements.',
        armBUnverifiedHandoff: 'Created src/jwt.ts',
        armCCompiledContext: '<orchestrate_context><file>src/jwt.ts</file></orchestrate_context>',
        controls: dummyControls,
        environmentDependencyFingerprint: 'node:22.0.0|npm:10.0.0|os:win32',
        verificationChecks: [
          {
            name: 'unit_tests',
            command: 'npm test',
            timeoutMs: 30000,
          },
        ],
      };

      const result = await runner.runTrial(trialInput);

      expect(result.valid).toBe(true);

      const armB = result.armResults.ARM_B_UNVERIFIED_HANDOFF;
      // 3 reads of src/jwt.ts are suppliedHits, 3 reads of src/unknown.ts are discovery_actions
      expect(armB?.discoveryReport?.discovery_actions).toBe(3);
      expect(armB?.discoveryReport?.suppliedHits).toHaveLength(3);
      expect(armB?.discoveryReport?.summary.qualifyingCount).toBe(3);
      expect(armB?.discoveryReport?.summary.suppliedHitCount).toBe(3);
    });
  });
});
