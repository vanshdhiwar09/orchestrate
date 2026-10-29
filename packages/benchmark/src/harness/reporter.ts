import type { BenchmarkArmId, BenchmarkBudgetPolicy } from './types.js';
import type { TrialRunResult } from './trial-runner.js';

export interface ArmSummaryMetrics {
  armId: BenchmarkArmId;
  totalEvaluated: number;
  completedRuns: number;
  failedRuns: number;
  incompleteRuns: number;
  verifiedCount: number;
  verificationPassRatio: string;
  totalDiscoveryActions: number;
  meanDiscoveryActions: number | null;
  totalReworkEvents: number;
  meanReworkEvents: number | null;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokenUsageAvailable: boolean;
  estimatedCostText: string;
}

export interface BenchmarkReportSummary {
  generatedAt: string;
  totalTrials: number;
  validTrials: number;
  invalidTrials: number;
  scenarios: string[];
  budgetPolicy: BenchmarkBudgetPolicy;
  armSummaries: Record<BenchmarkArmId, ArmSummaryMetrics>;
  limitationsDisclaimer: string;
}

export const MANDATORY_METHODOLOGY_DISCLAIMER =
  'METHODOLOGY & STATISTICAL LIMITATIONS:\n' +
  '1. Exploratory sample: This evaluation reflects a small-sample benchmark trial. No formal statistical significance (p < 0.05) or generalizability across broader software repositories is claimed.\n' +
  '2. Intent-to-treat denominators: Failed, timed-out, or budget-exhausted runs are explicitly retained in all denominators to prevent survivorship bias.\n' +
  '3. Honest cost telemetry: Monetary costs are reported as "Unknown" because inference provider telemetry does not supply exact billing rates; zero cost is never fabricated.\n' +
  '4. Treatment awareness: Prompts are lexically sanitized against benchmark identifiers, but agents necessarily observe context envelope structural variations.\n' +
  '5. Monetary spending risk: Token budget ceilings constrain model token volume, not monetary billing. Accurate financial spend caps must be configured at the cloud provider project level (e.g. Nebius project budget quotas).';

/**
 * BenchmarkReporter aggregates multi-trial evaluation results into honest,
 * mathematically sound summary reports that separate primary outcomes from
 * exploratory metrics without overstating statistical power.
 */
export class BenchmarkReporter {
  generateSummary(results: TrialRunResult[]): BenchmarkReportSummary {
    const totalTrials = results.length;
    const validTrials = results.filter((r) => r.valid).length;
    const invalidTrials = totalTrials - validTrials;

    const scenarios = Array.from(
      new Set(
        results
          .map((r) => r.trial?.identity?.scenarioId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
    );

    const arms: BenchmarkArmId[] = [
      'ARM_A_BASELINE',
      'ARM_B_UNVERIFIED_HANDOFF',
      'ARM_C_ORCHESTRATE',
    ];

    const armSummaries = {} as Record<BenchmarkArmId, ArmSummaryMetrics>;

    for (const armId of arms) {
      let totalEvaluated = 0;
      let completedRuns = 0;
      let failedRuns = 0;
      let incompleteRuns = 0;
      let verifiedCount = 0;
      let totalDiscoveryActions = 0;
      let totalReworkEvents = 0;
      let totalTokens = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let tokenUsageAvailable = false;
      let hasKnownCost = false;
      let accumulatedCost = 0;

      for (const trialResult of results) {
        totalEvaluated++;
        const armBundle = trialResult.armResults?.[armId];

        if (!armBundle) {
          incompleteRuns++;
          continue;
        }

        if (armBundle.status === 'COMPLETED') {
          completedRuns++;
        } else if (armBundle.status === 'FAILED' || armBundle.status === 'BLOCKED_NEEDS_HUMAN') {
          failedRuns++;
        } else {
          incompleteRuns++;
        }

        // Verification outcome
        if (armBundle.verificationEvidence?.status === 'VERIFIED') {
          verifiedCount++;
        }

        // Discovery actions
        if (armBundle.discoveryReport) {
          totalDiscoveryActions += armBundle.discoveryReport.discovery_actions ?? 0;
        }

        // Rework events
        if (armBundle.reworkReport) {
          totalReworkEvents += armBundle.reworkReport.rework_events ?? 0;
        }

        // Token usage
        if (armBundle.rawEvidence?.usage) {
          const u = armBundle.rawEvidence.usage;
          if (u.usage_available) {
            tokenUsageAvailable = true;
            totalTokens += u.total_tokens ?? 0;
            totalInputTokens += u.input_tokens ?? 0;
            totalOutputTokens += u.output_tokens ?? 0;
          }
          if (u.estimated_cost_usd !== null && typeof u.estimated_cost_usd === 'number') {
            hasKnownCost = true;
            accumulatedCost += u.estimated_cost_usd;
          }
        }
      }

      const denominator = totalEvaluated > 0 ? totalEvaluated : 1;
      const passPct = ((verifiedCount / denominator) * 100).toFixed(1);
      const verificationPassRatio = `${verifiedCount}/${denominator} (${passPct}%)`;

      const completedDenom = completedRuns > 0 ? completedRuns : null;
      const meanDiscoveryActions = completedDenom !== null
        ? Number((totalDiscoveryActions / completedDenom).toFixed(2))
        : null;
      const meanReworkEvents = completedDenom !== null
        ? Number((totalReworkEvents / completedDenom).toFixed(2))
        : null;

      const estimatedCostText = hasKnownCost
        ? `$${accumulatedCost.toFixed(4)}`
        : 'Unknown (no billing telemetry)';

      armSummaries[armId] = {
        armId,
        totalEvaluated,
        completedRuns,
        failedRuns,
        incompleteRuns,
        verifiedCount,
        verificationPassRatio,
        totalDiscoveryActions,
        meanDiscoveryActions,
        totalReworkEvents,
        meanReworkEvents,
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        tokenUsageAvailable,
        estimatedCostText,
      };
    }

    const budgetPolicy: BenchmarkBudgetPolicy =
      results[0]?.trial?.controls?.budgetPolicy ??
      results[0]?.armResults?.ARM_A_BASELINE?.rawEvidence?.budget?.policy ??
      'ADAPTIVE_SESSION_BUDGET';

    return {
      generatedAt: new Date().toISOString(),
      totalTrials,
      validTrials,
      invalidTrials,
      scenarios,
      budgetPolicy,
      armSummaries,
      limitationsDisclaimer: MANDATORY_METHODOLOGY_DISCLAIMER,
    };
  }

  renderMarkdown(results: TrialRunResult[]): string {
    const s = this.generateSummary(results);

    let md = `# Orchestrate Benchmark Evaluation Report\n\n`;
    md += `**Generated At:** ${s.generatedAt}  \n`;
    md += `**Total Trials:** ${s.totalTrials} (Valid: ${s.validTrials}, Invalid: ${s.invalidTrials})  \n`;
    md += `**Scenarios Evaluated:** ${s.scenarios.join(', ') || 'None'}  \n`;
    md += `**Budget Policy:** ${s.budgetPolicy}\n\n`;

    md += `## 1. Primary Outcomes (Hypothesis Testing)\n\n`;
    md += `| Arm | Total Evaluated | Verified Passes | Pass Rate (Intent-to-Treat) | Total Discovery | Mean Discovery (Done) | Total Rework | Mean Rework (Done) |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const armId of Object.keys(s.armSummaries) as BenchmarkArmId[]) {
      const a = s.armSummaries[armId];
      md += `| **${a.armId}** | ${a.totalEvaluated} | ${a.verifiedCount} | ${a.verificationPassRatio} | ${a.totalDiscoveryActions} | ${a.meanDiscoveryActions ?? 'N/A'} | ${a.totalReworkEvents} | ${a.meanReworkEvents ?? 'N/A'} |\n`;
    }

    md += `\n## 2. Exploratory Metrics (Resource & Efficiency)\n\n`;
    md += `| Arm | Completed Runs | Failed Runs | Incomplete Runs | Total Tokens | Input Tokens | Output Tokens | Estimated Cost |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;

    for (const armId of Object.keys(s.armSummaries) as BenchmarkArmId[]) {
      const a = s.armSummaries[armId];
      md += `| **${a.armId}** | ${a.completedRuns} | ${a.failedRuns} | ${a.incompleteRuns} | ${a.totalTokens} | ${a.totalInputTokens} | ${a.totalOutputTokens} | ${a.estimatedCostText} |\n`;
    }

    md += `\n## 3. Methodology & Interpretation Disclaimers\n\n`;
    md += `> [!IMPORTANT]\n`;
    for (const line of s.limitationsDisclaimer.split('\n')) {
      md += `> ${line}\n`;
    }

    return md;
  }

  renderText(results: TrialRunResult[]): string {
    const s = this.generateSummary(results);

    let txt = `=======================================================================\n`;
    txt += ` Orchestrate Benchmark Evaluation Report\n`;
    txt += ` Generated:     ${s.generatedAt}\n`;
    txt += ` Budget Policy: ${s.budgetPolicy}\n`;
    txt += ` Trials:        Total ${s.totalTrials} | Valid ${s.validTrials} | Invalid ${s.invalidTrials}\n`;
    txt += `=======================================================================\n\n`;

    txt += `--- PRIMARY OUTCOMES ---\n`;
    for (const armId of Object.keys(s.armSummaries) as BenchmarkArmId[]) {
      const a = s.armSummaries[armId];
      txt += `[${a.armId}]\n`;
      txt += `  Pass Rate (Intent-to-Treat): ${a.verificationPassRatio}\n`;
      txt += `  Discovery Actions:          Total ${a.totalDiscoveryActions} | Mean ${a.meanDiscoveryActions ?? 'N/A'}\n`;
      txt += `  Rework Events:              Total ${a.totalReworkEvents} | Mean ${a.meanReworkEvents ?? 'N/A'}\n\n`;
    }

    txt += `--- EXPLORATORY METRICS ---\n`;
    for (const armId of Object.keys(s.armSummaries) as BenchmarkArmId[]) {
      const a = s.armSummaries[armId];
      txt += `[${a.armId}]\n`;
      txt += `  Runs Breakdown:             Completed ${a.completedRuns} | Failed ${a.failedRuns} | Incomplete ${a.incompleteRuns}\n`;
      txt += `  Tokens:                     Total ${a.totalTokens} (In: ${a.totalInputTokens}, Out: ${a.totalOutputTokens})\n`;
      txt += `  Estimated Cost:             ${a.estimatedCostText}\n\n`;
    }

    txt += `-----------------------------------------------------------------------\n`;
    txt += `${s.limitationsDisclaimer}\n`;
    txt += `=======================================================================\n`;

    return txt;
  }
}
