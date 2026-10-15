import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import {
  runPreflight,
  preflightScenario,
  parseArgs,
} from '../../../../scripts/benchmark-preflight.js';

const execFileAsync = promisify(execFile);
const preflightScriptPath = resolve(process.cwd(), 'scripts', 'benchmark-preflight.ts');

describe('Benchmark Preflight Suite', () => {
  describe('Argument Parsing (parseArgs)', () => {
    it('parses --help flag', () => {
      const parsed = parseArgs(['--help']);
      expect(parsed.help).toBe(true);
    });

    it('parses -h flag', () => {
      const parsed = parseArgs(['-h']);
      expect(parsed.help).toBe(true);
    });

    it('parses --all flag', () => {
      const parsed = parseArgs(['--all']);
      expect(parsed.all).toBe(true);
    });

    it('parses --scenario flag with value', () => {
      const parsed = parseArgs(['--scenario', 'auth-protected-api']);
      expect(parsed.scenarioId).toBe('auth-protected-api');
    });

    it('parses -s alias with value', () => {
      const parsed = parseArgs(['-s', 'data-model-feature']);
      expect(parsed.scenarioId).toBe('data-model-feature');
    });

    it('parses --replication flag with integer', () => {
      const parsed = parseArgs(['--all', '--replication', '3']);
      expect(parsed.replication).toBe(3);
    });

    it('throws error on unknown flag', () => {
      expect(() => parseArgs(['--unknown-flag'])).toThrow(/Unknown argument: --unknown-flag/);
    });

    it('throws error when --scenario has missing value', () => {
      expect(() => parseArgs(['--scenario'])).toThrow(/Missing value for --scenario/);
    });
  });

  describe('Programmatic runPreflight API', () => {
    it('successfully validates a single scenario', async () => {
      const summary = await runPreflight({ scenarioId: 'auth-protected-api' });

      expect(summary.success).toBe(true);
      expect(summary.reports).toHaveLength(1);

      const report = summary.reports[0];
      expect(report.scenarioId).toBe('auth-protected-api');
      expect(report.replication).toBe(1);
      expect(report.valid).toBe(true);
      expect(report.snapshotCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(report.controlFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(report.armATreatmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(report.armBTreatmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(report.armCTreatmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(report.violations).toBeUndefined();
    });

    it('supports scenario alias', async () => {
      const summary = await runPreflight({ scenarioId: 'sc-auth-api' });
      expect(summary.success).toBe(true);
      expect(summary.reports[0].scenarioId).toBe('auth-protected-api');
    });

    it('validates all three scenarios with --all', async () => {
      const summary = await runPreflight({ all: true });

      expect(summary.success).toBe(true);
      expect(summary.reports).toHaveLength(3);

      const scenarioIds = summary.reports.map((r) => r.scenarioId);
      expect(scenarioIds).toContain('auth-protected-api');
      expect(scenarioIds).toContain('auth-password-reset');
      expect(scenarioIds).toContain('data-model-feature');

      for (const report of summary.reports) {
        expect(report.valid).toBe(true);
        expect(report.snapshotCommitSha).toMatch(/^[0-9a-f]{40}$/);
        expect(report.controlFingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('respects replication index in trial identity and runId', async () => {
      const report = await preflightScenario('auth-password-reset', 2);

      expect(report.replication).toBe(2);
      expect(report.runId).toBe('trial-auth-password-reset-r2-preflight');
      expect(report.valid).toBe(true);
    });

    it('returns error when neither --scenario nor --all is specified', async () => {
      const summary = await runPreflight({});

      expect(summary.success).toBe(false);
      expect(summary.reports).toHaveLength(0);
      expect(summary.error).toMatch(/Missing required argument/);
    });

    it('throws when requested scenario is unknown', async () => {
      await expect(preflightScenario('completely-invalid-scenario')).rejects.toThrow(
        /Unknown benchmark scenario "completely-invalid-scenario"/
      );
    });
  });

  describe('CLI Subprocess Execution', () => {
    it('executes --help and exits with code 0', async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--experimental-strip-types', preflightScriptPath, '--help'],
        { cwd: process.cwd() }
      );

      expect(stdout).toContain('Orchestrate Benchmark Preflight CLI');
      expect(stdout).toContain('--all');
      expect(stdout).toContain('--scenario');
    });

    it('executes --all successfully across all scenarios', async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--experimental-strip-types', preflightScriptPath, '--all'],
        { cwd: process.cwd() }
      );

      expect(stdout).toContain('Preflight validation SUCCESSFUL');
      expect(stdout).toContain('Model Inference: DISABLED');
      expect(stdout).toContain('Workspace Creation: DISABLED');
      expect(stdout).toContain('Scenario: auth-protected-api');
      expect(stdout).toContain('Scenario: auth-password-reset');
      expect(stdout).toContain('Scenario: data-model-feature');
      expect(stdout).toContain('Integrity Status:     PASSED (Clean)');
    });

    it('fails when no flags are provided', async () => {
      let exitCode = 0;
      let stderrOutput = '';

      try {
        await execFileAsync(
          process.execPath,
          ['--experimental-strip-types', preflightScriptPath],
          { cwd: process.cwd() }
        );
      } catch (err: unknown) {
        const error = err as { code?: number; stderr?: string };
        exitCode = error.code ?? 1;
        stderrOutput = error.stderr ?? '';
      }

      expect(exitCode).toBe(1);
      expect(stderrOutput).toContain('Missing required argument');
    });
  });
});
