import { describe, expect, it } from 'vitest';
import {
  formatBoundedOutput,
  formatVerificationFailure,
  shouldRetainWorkspace,
  type DiagnosticCheckEvidence,
  type DiagnosticHandoff,
} from '../../../scripts/run-task-a-telemetry.js';

describe('Task A Verification Diagnostics and Workspace Retention', () => {
  describe('formatBoundedOutput', () => {
    it('returns "none" for null, undefined, empty, or whitespace strings', () => {
      expect(formatBoundedOutput(null)).toBe('none');
      expect(formatBoundedOutput(undefined)).toBe('none');
      expect(formatBoundedOutput('')).toBe('none');
      expect(formatBoundedOutput('   \n\t  ')).toBe('none');
    });

    it('returns short text unchanged when under the character bound', () => {
      const short = 'Error: Cannot find module ./src/greeting.ts';
      expect(formatBoundedOutput(short, 300)).toBe(short);
    });

    it('bounds output to maximum length and appends truncation marker', () => {
      const longOutput = 'A'.repeat(500);
      const formatted = formatBoundedOutput(longOutput, 300);

      expect(formatted.startsWith('A'.repeat(300))).toBe(true);
      expect(formatted.endsWith('... [TRUNCATED]')).toBe(true);
      expect(formatted).toBe(`${'A'.repeat(300)}... [TRUNCATED]`);
    });

    it('sanitizes embedded secrets, bearer tokens, and custom secrets in bounded output', () => {
      const customSecret = 'super-secret-nebius-token-xyz123';
      const outputWithSecrets = `Failed with auth: Bearer ${customSecret} and key sk-1234567890abcdef1234`;

      const sanitized = formatBoundedOutput(outputWithSecrets, 300, [customSecret]);

      expect(sanitized).not.toContain(customSecret);
      expect(sanitized).not.toContain('sk-1234567890abcdef1234');
      expect(sanitized).toContain('[REDACTED]');
    });
  });

  describe('formatVerificationFailure', () => {
    it('formats complete verification failure evidence correctly', () => {
      const evidence: DiagnosticCheckEvidence = {
        checkId: 'check-greeting-module',
        name: 'Verify greeting module',
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: 'Checking greeting module...',
        stderr: 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module "./src/greeting.ts"',
      };

      const handoff: DiagnosticHandoff = {
        filesAffected: ['greeting.ts'],
        status: 'CLAIMED',
      };

      const report = formatVerificationFailure(evidence, handoff);

      expect(report.exitCodeSnippet).toBe('1');
      expect(report.timedOutSnippet).toBe('false');
      expect(report.signalSnippet).toBe('none');
      expect(report.filesAffectedSnippet).toBe('greeting.ts');
      expect(report.stderrSnippet).toBe(
        'Error [ERR_MODULE_NOT_FOUND]: Cannot find module "./src/greeting.ts"'
      );
      expect(report.stdoutSnippet).toBe('Checking greeting module...');
    });

    it('handles missing or undefined evidence and handoff without throwing', () => {
      const report = formatVerificationFailure(undefined, undefined);

      expect(report.exitCodeSnippet).toBe('unknown');
      expect(report.timedOutSnippet).toBe('unknown');
      expect(report.signalSnippet).toBe('none');
      expect(report.filesAffectedSnippet).toBe('none reported');
      expect(report.stderrSnippet).toBe('none');
      expect(report.stdoutSnippet).toBe('none');
    });

    it('handles null exitCode and explicit signals gracefully', () => {
      const evidence: DiagnosticCheckEvidence = {
        exitCode: null,
        timedOut: true,
        signal: 'SIGKILL',
        stderr: '',
        stdout: '',
      };

      const report = formatVerificationFailure(evidence, { filesAffected: [] });

      expect(report.exitCodeSnippet).toBe('null');
      expect(report.timedOutSnippet).toBe('true');
      expect(report.signalSnippet).toBe('SIGKILL');
      expect(report.filesAffectedSnippet).toBe('none reported');
      expect(report.stderrSnippet).toBe('none');
      expect(report.stdoutSnippet).toBe('none');
    });

    it('sanitizes secrets present in stderr and stdout', () => {
      const secretKey = 'secret-api-key-998877';
      const evidence: DiagnosticCheckEvidence = {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stderr: `Process failed: api_key: ${secretKey}`,
        stdout: `Connecting to service with Bearer ${secretKey}`,
      };

      const report = formatVerificationFailure(evidence, null, [secretKey]);

      expect(report.stderrSnippet).not.toContain(secretKey);
      expect(report.stderrSnippet).toContain('[REDACTED]');
      expect(report.stdoutSnippet).not.toContain(secretKey);
      expect(report.stdoutSnippet).toContain('[REDACTED]');
    });
  });

  describe('shouldRetainWorkspace', () => {
    it('retains workspace when verification failed', () => {
      expect(shouldRetainWorkspace(false)).toBe(true);
    });

    it('does not retain workspace when verification passed', () => {
      expect(shouldRetainWorkspace(true)).toBe(false);
    });
  });
});
