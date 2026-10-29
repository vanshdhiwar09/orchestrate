import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import { ToolRegistry } from '@orchestrate/core';
import { LocalCommandExecutor } from '@orchestrate/workspace';
import {
  TokenBudgetGuard,
  BudgetExceededError,
} from '../../src/harness/budget-guard.js';
import {
  AgentExecutionAdapter,
  TaskTimeoutError,
} from '../../src/harness/agent-adapter.js';
import { TrialResultStore, FileCollisionError } from '../../src/harness/result-store.js';
import { BenchmarkReporter } from '../../src/harness/reporter.js';
import { InterruptionHandler } from '../../src/harness/interruption-handler.js';
import { runBenchmarkSession } from '../../src/harness/session-runner.js';
import { computeTreatmentFingerprint } from '../../src/harness/fingerprints.js';
import type {
  ArmExecutionInput,
  BenchmarkWorkspace,
  WorkspaceFactory,
} from '../../src/harness/types.js';

describe('Step 10.3: No-Inference Safety Integration Audit', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'safety-integration-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 1: Shared Aggregate Budget Wiring
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 1: Shared Aggregate Budget Wiring', () => {
    it('proves consumption by earlier arms reduces budget for later arms and blocks calls exceeding cap', async () => {
      // Shared cap: 500 total tokens
      const budgetGuard = new TokenBudgetGuard({ maxTotalTokens: 500 });
      let providerCalls = 0;

      const mockModelClient: ModelClient = {
        complete: async (req: ModelRequest): Promise<ModelResponse> => {
          providerCalls++;
          return {
            id: `resp-${providerCalls}`,
            model: req.model,
            finishReason: 'stop',
            message: { role: 'assistant', content: 'Task completed.' },
            usage: {
              promptTokens: 200,
              completionTokens: 100,
              totalTokens: 300, // consumes 300 tokens on each call
            },
          };
        },
      };

      const mockWorkspace: BenchmarkWorkspace = {
        path: tmpDir,
        workspace: {
          readFile: vi.fn(),
          writeFile: vi.fn(),
          deleteFile: vi.fn(),
          listDirectory: vi.fn(),
          exists: vi.fn(),
        } as any,
        git: {} as any,
        cleanup: async () => {},
      };

      const mockFactory: WorkspaceFactory = {
        create: async () => mockWorkspace,
      };

      const adapter = new AgentExecutionAdapter({
        workspaceFactory: mockFactory,
        modelClient: mockModelClient,
        budgetGuard,
        toolRegistryFactory: () => new ToolRegistry(),
      });

      const makeArmInput = (armId: any): ArmExecutionInput => ({
        trialId: 'trial-audit-1',
        armId,
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        taskBPrompt: 'Complete task B',
        systemPrompt: 'System',
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
        treatmentFingerprint: computeTreatmentFingerprint(
          armId,
          armId === 'ARM_A_BASELINE' ? null : 'Unverified handoff payload from Task A'
        ),
        samplingConfig: {
          maxTokens: 300, // requires 300 token reservation
        },
      });

      // Arm A runs: cap is 500, reservation 300 succeeds, commits 300 tokens
      const resultArmA = await adapter.execute(makeArmInput('ARM_A_BASELINE'));
      expect(resultArmA.evidence.outcome).toBe('COMPLETED');
      expect(providerCalls).toBe(1);
      expect(budgetGuard.consumed).toBe(300);
      expect(budgetGuard.remaining).toBe(200);

      // Arm B runs: remaining is 200, but request requires 300 token reservation!
      // Must throw BudgetExceededError BEFORE provider is contacted!
      const resultArmB = await adapter.execute(makeArmInput('ARM_B_UNVERIFIED_HANDOFF'));

      // Assert arm B failed honestly
      expect(resultArmB.evidence.outcome).toBe('FAILED');
      expect(resultArmB.evidence.error?.message).toContain('Token budget exceeded');

      // Crucial invariant: Call beyond cap NEVER reached the mock model provider
      expect(providerCalls).toBe(1); // STILL 1! Call was blocked pre-flight.

      // Arm B is marked FAILED, never VERIFIED
      expect(resultArmB.evidence.outcome).not.toBe('COMPLETED');
    });

    it('proves the run cannot silently reset its aggregate budget between trials', () => {
      const budgetGuard = new TokenBudgetGuard({ maxTotalTokens: 1000 });
      const res1 = budgetGuard.reserve(400);
      res1.commit(400);

      // Next trial consumes from same guard
      const res2 = budgetGuard.reserve(400);
      res2.commit(400);

      expect(budgetGuard.consumed).toBe(800);
      expect(budgetGuard.remaining).toBe(200);

      // Third trial requesting 300 is blocked
      expect(() => budgetGuard.reserve(300)).toThrow(BudgetExceededError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 2: Timeout & Cancellation Integrity
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 2: Timeout and Cancellation Integrity', () => {
    it('aborts hanging operations, marks arm FAILED, and blocks subsequent mutations after timeout', async () => {
      let workspaceCleanedUp = false;

      const mockWorkspace: BenchmarkWorkspace = {
        path: tmpDir,
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

      // Model client that delays for 200ms
      const slowClient: ModelClient = {
        complete: async (_req: ModelRequest): Promise<ModelResponse> => {
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                id: 'resp-slow',
                model: 'test-model',
                finishReason: 'stop',
                message: { role: 'assistant', content: 'Finished late' },
              });
            }, 200);
          });
        },
      };

      const adapter = new AgentExecutionAdapter({
        workspaceFactory: mockFactory,
        modelClient: slowClient,
        taskTimeoutMs: 50, // 50ms timeout < 200ms delay
      });

      const input: ArmExecutionInput = {
        trialId: 'trial-audit-2',
        armId: 'ARM_A_BASELINE',
        snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        taskBPrompt: 'Do slow work',
        systemPrompt: 'System',
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
        treatmentFingerprint: computeTreatmentFingerprint('ARM_A_BASELINE', null),
        taskTimeoutMs: 50,
      };

      const result = await adapter.execute(input);

      // 1. Arm outcome is FAILED
      expect(result.evidence.outcome).toBe('FAILED');
      expect(result.evidence.error?.message).toMatch(/exceeded timeout limit of 50ms/);

      // 2. Workspace cleanup was executed to isolate the workspace
      expect(workspaceCleanedUp).toBe(true);

      // 3. Timed-out arm is never marked complete or verified
      expect(result.evidence.outcome).not.toBe('COMPLETED');
    });

    it('kills subprocesses when command executor AbortSignal is triggered', async () => {
      const abortController = new AbortController();
      const executor = new LocalCommandExecutor({
        workspaceRoot: tmpDir,
        signal: abortController.signal,
      });

      // Run a script that sleeps for 5 seconds
      const execPromise = executor.execute('node', ['-e', 'setTimeout(() => {}, 5000)']);

      // Abort after 50ms
      setTimeout(() => {
        abortController.abort();
      }, 50);

      const res = await execPromise;
      // Process was terminated by signal
      expect(res.exitCode).not.toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 3: Persistence and Interruption
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 3: Persistence and Interruption', () => {
    it('preserves interrupted partial evidence explicitly marked as incomplete', async () => {
      const store = new TrialResultStore({ storageDir: tmpDir });

      const partialResult: any = {
        valid: false,
        trial: {
          identity: {
            runId: 'trial-interrupted-boundary',
            scenarioId: 'auth-protected-api',
            replication: 1,
            taskAId: 'task-a',
            taskBId: 'task-b',
            snapshotId: 'snap-1',
            snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
          },
          controls: {} as any,
          controlFingerprint: {} as any,
          state: 'INVALID',
          armOrderSeed: 1,
          executionOrder: ['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE'],
        },
        integrityPreflight: { valid: false, violations: [] },
        armResults: {
          ARM_A_BASELINE: {
            armId: 'ARM_A_BASELINE',
            status: 'COMPLETED',
            rawEvidence: null,
            verificationEvidence: null,
            diffCapture: null,
            discoveryReport: null,
            reworkReport: null,
          },
        },
        invalidationReason: 'Process interrupted by signal SIGINT',
      };

      const savedPath = await store.saveTrialResult(partialResult, { interrupted: true });
      expect(existsSync(savedPath)).toBe(true);

      const loaded = await store.loadTrialResult(savedPath);
      expect(loaded.complete).toBe(false);
      expect(loaded.interrupted).toBe(true);
      expect(loaded.result.invalidationReason).toContain('SIGINT');
    });

    it('prevents accidental collision from silently overwriting existing result', async () => {
      const store = new TrialResultStore({ storageDir: tmpDir });
      const trialResult: any = {
        valid: true,
        trial: {
          identity: { runId: 'trial-collision-check' },
          state: 'COMPLETE',
        },
      };

      await store.saveTrialResult(trialResult);

      // Attempting to save again without overwrite: true must throw FileCollisionError
      await expect(store.saveTrialResult(trialResult)).rejects.toThrow(
        FileCollisionError
      );
    });

    it('cleans up temporary write files if write fails midway', async () => {
      const store = new TrialResultStore({ storageDir: tmpDir });
      // Saving an object that throws during serialization
      const circular: any = { valid: true };
      circular.self = circular;

      const badResult: any = {
        trial: { identity: { runId: 'trial-bad-write' } },
        circular,
      };

      await expect(store.saveTrialResult(badResult)).rejects.toThrow();

      // Destination file should not exist
      expect(existsSync(store.resolveFilePath('trial-bad-write'))).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 4: Reporter & Result Integrity
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 4: Reporter and Result Integrity', () => {
    it('consumes persisted trial results, keeps incomplete runs in denominator, and renders unknown cost honestly', async () => {
      const store = new TrialResultStore({ storageDir: tmpDir });
      const reporter = new BenchmarkReporter();

      const run1: any = {
        valid: true,
        trial: {
          identity: { runId: 'run-1', scenarioId: 'auth-protected-api', replication: 1 },
          state: 'COMPLETE',
        },
        armResults: {
          ARM_A_BASELINE: {
            armId: 'ARM_A_BASELINE',
            status: 'COMPLETED',
            verificationEvidence: { status: 'FAILED' },
            rawEvidence: {
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated_cost_usd: null, usage_available: true },
            },
          },
          ARM_B_UNVERIFIED_HANDOFF: {
            armId: 'ARM_B_UNVERIFIED_HANDOFF',
            status: 'FAILED',
            verificationEvidence: { status: 'FAILED' },
            rawEvidence: {
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: null, usage_available: false },
            },
          },
          ARM_C_ORCHESTRATE: {
            armId: 'ARM_C_ORCHESTRATE',
            status: 'COMPLETED',
            verificationEvidence: { status: 'VERIFIED' },
            rawEvidence: {
              usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, estimated_cost_usd: null, usage_available: true },
            },
          },
        },
      };

      await store.saveTrialResult(run1);
      const loaded = await store.loadTrialResult('run-1');

      const summary = reporter.generateSummary([loaded.result]);
      const md = reporter.renderMarkdown([loaded.result]);

      // All 3 arms in denominator
      expect(summary.armSummaries.ARM_A_BASELINE.totalEvaluated).toBe(1);
      expect(summary.armSummaries.ARM_B_UNVERIFIED_HANDOFF.totalEvaluated).toBe(1);
      expect(summary.armSummaries.ARM_C_ORCHESTRATE.totalEvaluated).toBe(1);

      // Arm B failed is counted in denominator
      expect(summary.armSummaries.ARM_B_UNVERIFIED_HANDOFF.verificationPassRatio).toBe('0/1 (0.0%)');
      expect(summary.armSummaries.ARM_C_ORCHESTRATE.verificationPassRatio).toBe('1/1 (100.0%)');

      // Unknown cost is honest
      expect(summary.armSummaries.ARM_A_BASELINE.estimatedCostText).toBe('Unknown (no billing telemetry)');
      expect(md).toContain('Unknown (no billing telemetry)');
      expect(md).not.toContain('$0.00');

      // Methodology disclaimer is present
      expect(summary.limitationsDisclaimer).toContain('METHODOLOGY & STATISTICAL LIMITATIONS');
    });

    it('fails clearly when result file is corrupted rather than fabricating empty success', async () => {
      const corruptPath = join(tmpDir, 'corrupted-run.json');
      await writeFile(corruptPath, '{ bad json syntax', 'utf-8');

      const store = new TrialResultStore({ storageDir: tmpDir });
      await expect(store.loadTrialResult(corruptPath)).rejects.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT 5: Clean No-Inference Integration Test (Session Runner)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit 5: Clean No-Inference Integration Test', () => {
    it('executes end-to-end benchmark session with mocked model client, shared budget, and durable persistence', async () => {
      let mockModelInvocations = 0;

      const mockModelClient: ModelClient = {
        complete: async (req: ModelRequest): Promise<ModelResponse> => {
          mockModelInvocations++;
          return {
            id: `mock-resp-${mockModelInvocations}`,
            model: req.model,
            finishReason: 'stop',
            message: {
              role: 'assistant',
              content: 'Reference implementation completed.',
            },
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
            },
          };
        },
      };

      const sessionResult = await runBenchmarkSession({
        scenarios: ['auth-protected-api'],
        replications: 1,
        maxTotalTokens: 5000, // Explicit budget cap
        outputDir: tmpDir,
        modelClient: mockModelClient,
        exitOnSignal: false,
        controls: {
          taskTimeoutMs: 5000,
          maxTokens: 500,
        },
      });

      // Assertions
      expect(sessionResult.trialResults).toHaveLength(1);
      expect(sessionResult.summary.totalTrials).toBe(1);
      expect(sessionResult.summary.scenarios).toContain('auth-protected-api');

      // Budget was tracked across all arms
      expect(sessionResult.budgetGuard.consumed).toBeGreaterThan(0);
      expect(sessionResult.budgetGuard.consumed).toBeLessThanOrEqual(2000);

      // Persisted files exist on disk
      expect(existsSync(join(tmpDir, 'benchmark-summary.json'))).toBe(true);
      expect(existsSync(join(tmpDir, 'benchmark-report.md'))).toBe(true);
      expect(sessionResult.persistedFilePaths.length).toBeGreaterThanOrEqual(2);

      // Markdown report contains disclaimer and no $0.00
      expect(sessionResult.markdownReport).toContain('Orchestrate Benchmark Evaluation Report');
      expect(sessionResult.markdownReport).toContain('METHODOLOGY & STATISTICAL LIMITATIONS');
      expect(sessionResult.markdownReport).not.toContain('$0.00');

      // Zero live external API calls occurred
      expect(mockModelInvocations).toBeGreaterThan(0); // Mock was used locally
    }, 30000);

    it('rejects session creation when maxTotalTokens is missing or non-positive', async () => {
      await expect(
        runBenchmarkSession({
          scenarios: ['auth-protected-api'],
          maxTotalTokens: 0,
          outputDir: tmpDir,
          modelClient: {} as any,
        })
      ).rejects.toThrow(/maxTotalTokens must be an explicit positive finite number/);

      await expect(
        runBenchmarkSession({
          scenarios: ['auth-protected-api'],
          maxTotalTokens: -100,
          outputDir: tmpDir,
          modelClient: {} as any,
        })
      ).rejects.toThrow(/maxTotalTokens must be an explicit positive finite number/);
    });

    it('enforces budget feasibility preflight before touching fixtures or models', async () => {
      // 1 scenario * 1 rep * 3 arms = 3 planned arms.
      // With maxTokens=4096, maxTotalTokens=3000 implies maxTokensPerArm=1000 < 4096 single-request reservation!
      await expect(
        runBenchmarkSession({
          scenarios: ['auth-protected-api'],
          maxTotalTokens: 3000,
          outputDir: tmpDir,
          modelClient: {} as any,
          controls: { maxTokens: 4096 },
        })
      ).rejects.toThrow(/less than the required single-request reservation/);
    });
  });
});
