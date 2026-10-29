import { describe, it, expect } from 'vitest';
import {
  BenchmarkReporter,
  MANDATORY_METHODOLOGY_DISCLAIMER,
} from '../../src/harness/reporter.js';
import type { TrialRunResult } from '../../src/harness/trial-runner.js';

describe('BenchmarkReporter', () => {
  const mockResults: TrialRunResult[] = [
    {
      valid: true,
      trial: {
        identity: {
          runId: 'trial-1',
          scenarioId: 'auth-protected-api',
          replication: 1,
          taskAId: 'task-a',
          taskBId: 'task-b',
          snapshotId: 'snap-1',
          snapshotCommitSha: '0123456789abcdef0123456789abcdef01234567',
        },
        controls: {} as any,
        controlFingerprint: {} as any,
        state: 'COMPLETE',
        armOrderSeed: 1,
        executionOrder: ['ARM_A_BASELINE', 'ARM_B_UNVERIFIED_HANDOFF', 'ARM_C_ORCHESTRATE'],
      },
      integrityPreflight: { valid: true, violations: [] },
      armResults: {
        ARM_A_BASELINE: {
          armId: 'ARM_A_BASELINE',
          status: 'COMPLETED',
          rawEvidence: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
              estimated_cost_usd: null,
              usage_available: true,
            },
          } as any,
          verificationEvidence: { status: 'FAILED' } as any,
          diffCapture: null,
          discoveryReport: { discovery_actions: 5 } as any,
          reworkReport: { rework_events: 2 } as any,
        },
        ARM_B_UNVERIFIED_HANDOFF: {
          armId: 'ARM_B_UNVERIFIED_HANDOFF',
          status: 'COMPLETED',
          rawEvidence: {
            usage: {
              input_tokens: 120,
              output_tokens: 60,
              total_tokens: 180,
              estimated_cost_usd: null,
              usage_available: true,
            },
          } as any,
          verificationEvidence: { status: 'FAILED' } as any,
          diffCapture: null,
          discoveryReport: { discovery_actions: 3 } as any,
          reworkReport: { rework_events: 1 } as any,
        },
        ARM_C_ORCHESTRATE: {
          armId: 'ARM_C_ORCHESTRATE',
          status: 'COMPLETED',
          rawEvidence: {
            usage: {
              input_tokens: 150,
              output_tokens: 80,
              total_tokens: 230,
              estimated_cost_usd: null,
              usage_available: true,
            },
          } as any,
          verificationEvidence: { status: 'VERIFIED' } as any,
          diffCapture: null,
          discoveryReport: { discovery_actions: 1 } as any,
          reworkReport: { rework_events: 0 } as any,
        },
      },
    },
  ];

  it('generates summary with raw fractions and pass rates', () => {
    const reporter = new BenchmarkReporter();
    const summary = reporter.generateSummary(mockResults);

    expect(summary.totalTrials).toBe(1);
    expect(summary.validTrials).toBe(1);
    expect(summary.invalidTrials).toBe(0);

    const armA = summary.armSummaries.ARM_A_BASELINE;
    expect(armA.verificationPassRatio).toBe('0/1 (0.0%)');
    expect(armA.totalDiscoveryActions).toBe(5);
    expect(armA.totalReworkEvents).toBe(2);
    expect(armA.estimatedCostText).toBe('Unknown (no billing telemetry)');

    const armC = summary.armSummaries.ARM_C_ORCHESTRATE;
    expect(armC.verificationPassRatio).toBe('1/1 (100.0%)');
    expect(armC.totalDiscoveryActions).toBe(1);
    expect(armC.totalReworkEvents).toBe(0);
    expect(armC.estimatedCostText).toBe('Unknown (no billing telemetry)');
  });

  it('renders markdown report separating primary outcomes and exploratory metrics', () => {
    const reporter = new BenchmarkReporter();
    const md = reporter.renderMarkdown(mockResults);

    expect(md).toContain('## 1. Primary Outcomes (Hypothesis Testing)');
    expect(md).toContain('## 2. Exploratory Metrics (Resource & Efficiency)');
    expect(md).toContain('## 3. Methodology & Interpretation Disclaimers');
    expect(md).toContain('Unknown (no billing telemetry)');
    expect(md).not.toContain('$0.00');
    expect(md).toContain(MANDATORY_METHODOLOGY_DISCLAIMER.split('\n')[0]);
  });

  it('renders plain text report with honest unknown cost and intent-to-treat denominators', () => {
    const reporter = new BenchmarkReporter();
    const txt = reporter.renderText(mockResults);

    expect(txt).toContain('--- PRIMARY OUTCOMES ---');
    expect(txt).toContain('--- EXPLORATORY METRICS ---');
    expect(txt).toContain('Pass Rate (Intent-to-Treat): 1/1 (100.0%)');
    expect(txt).toContain('Estimated Cost:             Unknown (no billing telemetry)');
  });
});
