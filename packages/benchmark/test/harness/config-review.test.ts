import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCliArgs } from '../../../../scripts/benchmark-runner.ts';
import {
  runBenchmarkSession,
  FileCollisionError,
  CANONICAL_SMOKE_CONTROLS,
} from '../../src/harness/session-runner.js';
import { TokenBudgetGuard } from '../../src/harness/budget-guard.js';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';

describe('Step 10.9: Live-Run Configuration & Safety Audit Tests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'config-review-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. CLI Parsing & Unknown Flag Handling
  // ───────────────────────────────────────────────────────────────────────────
  describe('CLI Parsing & Unknown Flag Rejection', () => {
    it('parses valid proposed arguments correctly', () => {
      const args = [
        '--scenarios', 'auth-protected-api',
        '--replications', '1',
        '--policy', 'adaptive',
        '--max-tokens', '90000',
        '--model', 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        '--output', tmpDir,
      ];

      const parsed = parseCliArgs(args);
      expect(parsed.scenarios).toEqual(['auth-protected-api']);
      expect(parsed.replications).toBe(1);
      expect(parsed.budgetPolicy).toBe('ADAPTIVE_SESSION_BUDGET');
      expect(parsed.maxTotalTokens).toBe(90000);
      expect(parsed.modelId).toBe('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
      expect(parsed.outputDir).toBe(tmpDir);
      expect(parsed.maxTokensPerArm).toBeUndefined(); // no artificial per-arm ceiling
    });

    it('rejects unknown options such as --max-completion-tokens or --timeout-ms with clear error', () => {
      expect(() =>
        parseCliArgs([
          '--scenarios', 'auth-protected-api',
          '--max-tokens', '90000',
          '--output', tmpDir,
          '--max-completion-tokens', '4096',
        ])
      ).toThrow(/Unknown option: "--max-completion-tokens"/);

      expect(() =>
        parseCliArgs([
          '--scenarios', 'auth-protected-api',
          '--max-tokens', '90000',
          '--output', tmpDir,
          '--timeout-ms', '600000',
        ])
      ).toThrow(/Unknown option: "--timeout-ms"/);
    });

    it('identifies canonical defaults for maxTokens and taskTimeoutMs', () => {
      // Confirms CANONICAL_SMOKE_CONTROLS defaults without requiring CLI flags
      expect(CANONICAL_SMOKE_CONTROLS.maxTokens).toBe(4096);
      expect(CANONICAL_SMOKE_CONTROLS.taskTimeoutMs).toBe(600000);
      expect(CANONICAL_SMOKE_CONTROLS.modelId).toBe('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Output Destination Safety & Collision Prevention
  // ───────────────────────────────────────────────────────────────────────────
  describe('Output Destination Collision Prevention', () => {
    it('refuses to proceed if output directory already contains benchmark-summary.json', async () => {
      const summaryFile = join(tmpDir, 'benchmark-summary.json');
      await writeFile(summaryFile, '{"prior": true}', 'utf-8');

      const mockModel: ModelClient = {
        complete: async () => ({
          id: '1',
          model: 'test',
          finishReason: 'stop',
          message: { role: 'assistant', content: 'test' },
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        }),
      };

      await expect(
        runBenchmarkSession({
          scenarios: ['auth-protected-api'],
          replications: 1,
          maxTotalTokens: 50000,
          outputDir: tmpDir,
          modelClient: mockModel,
        })
      ).rejects.toThrow(FileCollisionError);

      // Verify the prior file was NOT modified or overwritten
      const content = await readFile(summaryFile, 'utf-8');
      expect(content).toBe('{"prior": true}');
    });

    it('refuses to proceed if output directory already contains benchmark-report.md', async () => {
      const reportFile = join(tmpDir, 'benchmark-report.md');
      await writeFile(reportFile, '# Prior Report', 'utf-8');

      const mockModel: ModelClient = {
        complete: async () => ({
          id: '1',
          model: 'test',
          finishReason: 'stop',
          message: { role: 'assistant', content: 'test' },
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        }),
      };

      await expect(
        runBenchmarkSession({
          scenarios: ['auth-protected-api'],
          replications: 1,
          maxTotalTokens: 50000,
          outputDir: tmpDir,
          modelClient: mockModel,
        })
      ).rejects.toThrow(FileCollisionError);

      const content = await readFile(reportFile, 'utf-8');
      expect(content).toBe('# Prior Report');
    });

    it('persists summary and report with exclusive create flag wx', async () => {
      const mockModel: ModelClient = {
        complete: async () => ({
          id: '1',
          model: 'test',
          finishReason: 'stop',
          message: { role: 'assistant', content: 'test' },
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        }),
      };

      const freshDir = join(tmpDir, 'fresh-run');
      const sessionResult = await runBenchmarkSession({
        scenarios: ['auth-protected-api'],
        replications: 1,
        maxTotalTokens: 50000,
        outputDir: freshDir,
        modelClient: mockModel,
        controls: {
          taskTimeoutMs: 1000,
          maxTokens: 100,
        },
      });

      expect(sessionResult.persistedFilePaths.length).toBeGreaterThanOrEqual(3);

      // Attempting to run a second session targeting the same freshDir throws FileCollisionError
      await expect(
        runBenchmarkSession({
          scenarios: ['auth-protected-api'],
          replications: 1,
          maxTotalTokens: 50000,
          outputDir: freshDir,
          modelClient: mockModel,
        })
      ).rejects.toThrow(FileCollisionError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Adaptive 90,000 Token Cap Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe('Adaptive 90,000 Token Budget Behavior', () => {
    it('allows Arm A to consume > 30,000 tokens (e.g. 45,000) without being capped at 1/3 in adaptive mode', () => {
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 90000,
        policy: 'ADAPTIVE_SESSION_BUDGET',
        label: 'Session',
      });

      // Child guard has no local ceiling in adaptive mode
      const armAGuard = sessionGuard.createChild({ label: 'Arm-A' });
      expect(armAGuard.remaining).toBe(90000);

      // Arm A consumes 45000 tokens (50% of the session cap, > 1/3)
      const resA = armAGuard.reserve(45000);
      resA.commit(45000);

      expect(armAGuard.consumed).toBe(45000);
      expect(sessionGuard.consumed).toBe(45000);
      expect(sessionGuard.remaining).toBe(45000);

      // Peer arm B can still consume up to remaining 45000
      const armBGuard = sessionGuard.createChild({ label: 'Arm-B' });
      expect(armBGuard.remaining).toBe(45000);
      armBGuard.reserve(20000).commit(20000);
      expect(sessionGuard.remaining).toBe(25000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Historical Run Artifacts Immutability
  // ───────────────────────────────────────────────────────────────────────────
  describe('Historical Evidence Immutability', () => {
    it('historical run artifacts in benchmarks/runs remain byte-for-byte intact', async () => {
      const expectedHashes: Record<string, string> = {
        'benchmarks/runs/smoke-auth-protected-api-20261023-2053/benchmark-report.md':
          '0ca47d0d6db1a61769c7e89840c4d9256afd2a281f8b0eb7bcf8597dff3d36ca',
        'benchmarks/runs/smoke-auth-protected-api-20261023-2053/benchmark-summary.json':
          '2fe9a3a0a02e027a0261b1e5aeaad67b30a2114b22f6ad8ebbee7183abf96351',
        'benchmarks/runs/smoke-auth-protected-api-20261023-2053/trial-auth-protected-api-r1-1792769012935.json':
          'b5c3c75da27c2e5b0ee10f08b783da2dd01302266d03dff6fcec7601805c6b76',
        'benchmarks/runs/smoke-auth-protected-api-20261023-2145/benchmark-report.md':
          '7497b4d7ef809b1642a12bfe5f5f44697a5a5f4ea671122dd0afcc4889f3f0c5',
        'benchmarks/runs/smoke-auth-protected-api-20261023-2145/benchmark-summary.json':
          '44789bb85bce70b9a843a2e40c0eef595a97e635120871806aa964c3d47aad63',
        'benchmarks/runs/smoke-auth-protected-api-20261023-2145/trial-auth-protected-api-r1-1792772130129.json':
          'b9df96fe1eacfdb37ae51e786e78a76b1bc7ebe49ec33ee5a3c8a77495f37985',
      };

      for (const [relPath, expectedSha256] of Object.entries(expectedHashes)) {
        const fullPath = join(process.cwd(), relPath);
        const content = await readFile(fullPath);
        const actualHash = createHash('sha256').update(content).digest('hex').toLowerCase();
        expect(actualHash).toBe(expectedSha256.toLowerCase());
      }
    });
  });
});
