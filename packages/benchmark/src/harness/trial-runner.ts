import type {
  CommandExecutor,
  GitRepository,
  Workspace,
} from '@orchestrate/workspace';
import type { ModelClient } from '@orchestrate/model';
import type { VerificationCheck } from '@orchestrate/verification';
import {
  type BenchmarkArmId,
  type BenchmarkVerificationEvidence,
  type DownstreamDiffCapture,
  type HarnessExecutionControls,
  type RawExecutionEvidence,
  type ToolCallEvent,
  type TrialArmRecord,
  type TrialIdentity,
  type TrialRecord,
  type ArmExecutionStatus,
  type WorkspaceFactory,
  type BenchmarkWorkspace,
} from './types.js';
import { buildTrial } from './trial-builder.js';
import { attachArmTriad } from './arm-builder.js';
import { SnapshotLoader } from './snapshot-loader.js';
import {
  validateTrialIntegrity,
  type IntegrityCheckResult,
  type IntegrityViolation,
} from './integrity-guard.js';
import { transitionTrial } from './trial-state-machine.js';
import { AgentExecutionAdapter } from './agent-adapter.js';
import { VerificationAdapter } from './verification-adapter.js';
import {
  DefaultDiscoveryEvaluator,
  type DiscoveryEvaluationReport,
  type DiscoveryEvaluator,
  type DiscoveryEvent,
  type SuppliedContextReference,
  type UnclassifiedEvent,
} from '../discovery/index.js';
import { NON_QUALIFYING_TOOLS } from '../discovery/matcher.js';
import {
  evaluateRework,
  type ReworkEvaluationReport,
  type ReworkEvaluator,
} from '../evaluator/index.js';
import type { ArtifactManifest } from '../manifest/types.js';

/**
 * Maps raw tool invocation events to DiscoveryEvents according to M5/M7 discovery contract.
 */
export function mapToolEventsToDiscovery(
  toolEvents: readonly ToolCallEvent[]
): {
  events: DiscoveryEvent[];
  unclassifiedEvents: UnclassifiedEvent[];
} {
  const events: DiscoveryEvent[] = [];
  const unclassifiedEvents: UnclassifiedEvent[] = [];

  for (const event of toolEvents) {
    const rawToolName = event.toolName?.trim() || '';
    const toolName = rawToolName.toLowerCase();
    const args = event.arguments ?? {};

    // Excluded execution/mutation/verification tools
    if (NON_QUALIFYING_TOOLS.has(toolName)) {
      unclassifiedEvents.push({
        sequence: event.sequence,
        toolName: rawToolName,
        rawInput: args,
        reason: `Tool '${rawToolName}' is an excluded non-qualifying execution tool.`,
      });
      continue;
    }

    if (
      toolName === 'read_file' ||
      toolName === 'view_file' ||
      toolName === 'cat' ||
      toolName === 'head' ||
      toolName === 'tail'
    ) {
      const target =
        (typeof args.path === 'string' ? args.path : null) ??
        (typeof args.filePath === 'string' ? args.filePath : null) ??
        (typeof args.targetFile === 'string' ? args.targetFile : null) ??
        (typeof args.AbsolutePath === 'string' ? args.AbsolutePath : null) ??
        (typeof args.file === 'string' ? args.file : '');
      events.push({
        sequence: event.sequence,
        toolName: rawToolName,
        target,
        category: 'FILE_READ',
      });
    } else if (
      toolName === 'list_files' ||
      toolName === 'list_dir' ||
      toolName === 'ls' ||
      toolName === 'dir' ||
      toolName === 'tree'
    ) {
      const target =
        (typeof args.path === 'string' ? args.path : null) ??
        (typeof args.dir === 'string' ? args.dir : null) ??
        (typeof args.directory === 'string' ? args.directory : '');
      events.push({
        sequence: event.sequence,
        toolName: rawToolName,
        target,
        category: 'FILE_LIST',
      });
    } else if (
      toolName === 'search' ||
      toolName === 'grep' ||
      toolName === 'find_in_files' ||
      toolName === 'ripgrep'
    ) {
      const target =
        (typeof args.query === 'string' ? args.query : null) ??
        (typeof args.pattern === 'string' ? args.pattern : null) ??
        (typeof args.term === 'string' ? args.term : '');
      events.push({
        sequence: event.sequence,
        toolName: rawToolName,
        target,
        category: 'SEARCH',
      });
    } else if (
      toolName === 'lookup_symbol' ||
      toolName === 'find_symbol' ||
      toolName === 'get_definition'
    ) {
      const target =
        (typeof args.symbol === 'string' ? args.symbol : null) ??
        (typeof args.name === 'string' ? args.name : null) ??
        (typeof args.identifier === 'string' ? args.identifier : '');
      events.push({
        sequence: event.sequence,
        toolName: rawToolName,
        target,
        category: 'SYMBOL_LOOKUP',
      });
    } else if (toolName === 'git_status') {
      events.push({
        sequence: event.sequence,
        toolName: rawToolName,
        target: 'status',
        category: 'GIT_STATE',
      });
    } else if (toolName === 'git_log') {
      const target = typeof args.ref === 'string' ? args.ref : 'HEAD';
      events.push({
        sequence: event.sequence,
        toolName: rawToolName,
        target,
        category: 'GIT_HISTORY',
      });
    } else if (toolName === 'git_diff') {
      const target = typeof args.ref === 'string' ? args.ref : '';
      events.push({
        sequence: event.sequence,
        toolName: rawToolName,
        target,
        category: 'GIT_DIFF',
      });
    } else {
      unclassifiedEvents.push({
        sequence: event.sequence,
        toolName: rawToolName,
        rawInput: args,
        reason: `Tool '${rawToolName}' cannot be deterministically mapped to a discovery category.`,
      });
    }
  }

  return { events, unclassifiedEvents };
}

/**
 * Complete, independently inspectable evidence bundle for one arm.
 */
export interface ArmExecutionEvidenceBundle {
  armId: BenchmarkArmId;
  status: ArmExecutionStatus;
  rawEvidence: RawExecutionEvidence | null;
  verificationEvidence: BenchmarkVerificationEvidence | null;
  diffCapture: DownstreamDiffCapture | null;
  discoveryReport: Readonly<DiscoveryEvaluationReport> | null;
  reworkReport: Readonly<ReworkEvaluationReport> | null;
}

/**
 * Structured result of running a benchmark trial.
 */
export interface TrialRunResult {
  valid: boolean;
  trial: TrialRecord;
  integrityPreflight: IntegrityCheckResult;
  integrityFinal?: IntegrityCheckResult;
  armResults: Partial<Record<BenchmarkArmId, ArmExecutionEvidenceBundle>>;
  invalidationReason?: string;
  violations?: readonly IntegrityViolation[];
}

/**
 * Injected dependencies for TrialRunner.
 */
export interface TrialRunnerDependencies {
  snapshotRepo: GitRepository;
  workspaceFactory: WorkspaceFactory;
  modelClient: ModelClient;
  snapshotLoader?: SnapshotLoader;
  agentAdapter?: AgentExecutionAdapter;
  verificationAdapter?: VerificationAdapter;
  discoveryEvaluator?: DiscoveryEvaluator;
  reworkEvaluator?: ReworkEvaluator;
  executor?: CommandExecutor;
  customSecrets?: string[];
}

/**
 * Complete input parameters required to execute a trial.
 */
export interface RunTrialInput {
  identity: TrialIdentity;
  taskBPrompt: string;
  armBUnverifiedHandoff: string;
  armCCompiledContext: string;
  controls: HarnessExecutionControls;
  environmentDependencyFingerprint: string;
  verificationChecks: VerificationCheck[];
  armOrderSeed?: number;
  baseSystemPrompt?: string;
  manifest?: Readonly<ArtifactManifest>;
  upstreamWorkspace?: Pick<Workspace, 'readFile'>;
  suppliedContext?: Partial<Record<BenchmarkArmId, SuppliedContextReference[]>>;
}

/**
 * Orchestrates a complete, controlled 3-arm benchmark evaluation trial (M7 Phase 4).
 * Coordinates:
 * Snapshot resolution -> Trial & Arm building -> Integrity preflight ->
 * Arm execution in randomized order -> Independent verification & Diff capture ->
 * Discovery & Rework measurement -> Integrity finalization -> COMPLETE or INVALID.
 */
export class TrialRunner {
  constructor(private readonly dependencies: TrialRunnerDependencies) {
    if (!dependencies?.snapshotRepo) {
      throw new Error('TrialRunner requires snapshotRepo.');
    }
    if (!dependencies?.workspaceFactory) {
      throw new Error('TrialRunner requires workspaceFactory.');
    }
    if (!dependencies?.modelClient) {
      throw new Error('TrialRunner requires modelClient.');
    }
  }

  /**
   * Executes a benchmark trial through its frozen lifecycle states.
   */
  async runTrial(input: RunTrialInput): Promise<TrialRunResult> {
    if (!input || typeof input !== 'object') {
      throw new Error('TrialRunner.runTrial: input must be a valid RunTrialInput object.');
    }

    // 1. Build initial TrialRecord in CREATED state
    let trial = buildTrial({
      identity: input.identity,
      taskBPrompt: input.taskBPrompt,
      controls: input.controls,
      environmentDependencyFingerprint: input.environmentDependencyFingerprint,
      armOrderSeed: input.armOrderSeed,
    });

    // 2. Load and validate Task-A snapshot commit using SnapshotLoader
    const snapshotLoader =
      this.dependencies.snapshotLoader ??
      new SnapshotLoader({
        repo: this.dependencies.snapshotRepo,
        executor: this.dependencies.executor,
      });

    try {
      await snapshotLoader.resolveSnapshot(input.identity.snapshotCommitSha);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      trial = transitionTrial(trial, 'INVALID', reason);
      return Object.freeze({
        valid: false,
        trial,
        integrityPreflight: {
          valid: false,
          violations: [
            {
              code: 'SNAPSHOT_COMMIT_UNRESOLVABLE',
              message: reason,
              category: 'CATEGORY_A' as const,
              severity: 'CRITICAL' as const,
            },
          ],
        },
        armResults: {},
        invalidationReason: reason,
      });
    }

    // Transition to SNAPSHOT_READY
    trial = transitionTrial(trial, 'SNAPSHOT_READY');

    // 3. Build A/B/C arms and transition to ARMS_READY
    try {
      trial = attachArmTriad(trial, {
        taskBPrompt: input.taskBPrompt,
        armBUnverifiedHandoff: input.armBUnverifiedHandoff,
        armCCompiledContext: input.armCCompiledContext,
        baseSystemPrompt: input.baseSystemPrompt,
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      trial = transitionTrial(trial, 'INVALID', reason);
      return Object.freeze({
        valid: false,
        trial,
        integrityPreflight: {
          valid: false,
          violations: [
            {
              code: 'HARNESS_INTERNAL_ERROR',
              message: reason,
              category: 'CATEGORY_A' as const,
              severity: 'CRITICAL' as const,
            },
          ],
        },
        armResults: {},
        invalidationReason: reason,
      });
    }

    // 4. Run Integrity Guard preflight BEFORE agent execution
    const preflight = validateTrialIntegrity(trial);
    if (!preflight.valid) {
      const reason = preflight.violations[0]?.message ?? 'Integrity preflight failure';
      trial = transitionTrial(trial, 'INVALID', reason);
      return Object.freeze({
        valid: false,
        trial,
        integrityPreflight: preflight,
        armResults: {},
        invalidationReason: reason,
        violations: preflight.violations,
      });
    }

    // 5. Transition to EXECUTING
    trial = transitionTrial(trial, 'EXECUTING');

    const armResults: Partial<Record<BenchmarkArmId, ArmExecutionEvidenceBundle>> = {};
    const armWorkspaces: Partial<Record<BenchmarkArmId, string>> = {};
    const rawEvidenceMap: Partial<Record<BenchmarkArmId, RawExecutionEvidence>> = {};
    const verificationEvidenceMap: Partial<Record<BenchmarkArmId, BenchmarkVerificationEvidence>> = {};

    // 6. Sequential execution in randomized order
    for (const armId of trial.executionOrder) {
      const armRecord = trial.arms![armId];
      let workspace: BenchmarkWorkspace | null = null;
      let rawEvidence: RawExecutionEvidence | null = null;
      let verificationEvidence: BenchmarkVerificationEvidence | null = null;
      let diffCapture: DownstreamDiffCapture | null = null;
      let discoveryReport: Readonly<DiscoveryEvaluationReport> | null = null;
      let reworkReport: Readonly<ReworkEvaluationReport> | null = null;
      let armStatus: ArmExecutionStatus = 'COMPLETED';

      try {
        // A. Run Agent B in isolated workspace via AgentExecutionAdapter
        const agentAdapter =
          this.dependencies.agentAdapter ??
          new AgentExecutionAdapter({
            workspaceFactory: this.dependencies.workspaceFactory,
            modelClient: this.dependencies.modelClient,
            customSecrets: this.dependencies.customSecrets,
            cleanupWorkspace: false, // preserved for verification and diff capture
          });

        const execResult = await agentAdapter.execute(armRecord.input);
        rawEvidence = execResult.evidence;
        workspace = execResult.workspace;

        rawEvidenceMap[armId] = rawEvidence;
        armWorkspaces[armId] = workspace.path;

        if (rawEvidence.outcome === 'FAILED') {
          armStatus = 'FAILED';
        } else if (rawEvidence.outcome === 'BLOCKED_NEEDS_HUMAN') {
          armStatus = 'BLOCKED_NEEDS_HUMAN';
        }

        // B. Independent Verification against exact live arm workspace
        const verificationAdapter =
          this.dependencies.verificationAdapter ??
          new VerificationAdapter({
            customSecrets: this.dependencies.customSecrets,
          });

        verificationEvidence = await verificationAdapter.verify({
          armId,
          taskId: input.identity.taskBId,
          snapshotCommitSha: input.identity.snapshotCommitSha,
          workspace,
          checks: input.verificationChecks,
          customSecrets: this.dependencies.customSecrets,
        });

        verificationEvidenceMap[armId] = verificationEvidence;
        diffCapture = verificationEvidence.diffCapture;

        if (verificationEvidence.status === 'FAILED') {
          armStatus = 'FAILED';
        }

        // C. Discovery measurement against raw tool trace
        const discoveryEvaluator =
          this.dependencies.discoveryEvaluator ?? new DefaultDiscoveryEvaluator();
        const { events, unclassifiedEvents } = mapToolEventsToDiscovery(rawEvidence.toolEvents);
        const supplied = input.suppliedContext?.[armId] ?? [];
        discoveryReport = discoveryEvaluator.evaluate({
          taskId: input.identity.taskBId,
          suppliedContext: supplied,
          events,
          unclassifiedEvents,
        });

        // D. Rework measurement against frozen manifest + downstream diff
        if (input.manifest && input.upstreamWorkspace && diffCapture?.diff !== undefined) {
          const reworkEvaluator =
            this.dependencies.reworkEvaluator ?? { evaluate: evaluateRework };
          reworkReport = await reworkEvaluator.evaluate({
            manifest: input.manifest,
            upstreamWorkspace: input.upstreamWorkspace,
            diff: diffCapture.diff,
            downstreamTaskId: input.identity.taskBId,
          });
        }
      } catch (err: unknown) {
        // Infrastructure / harness setup failure (Category A)
        const reason = err instanceof Error ? err.message : String(err);
        trial = transitionTrial(trial, 'INVALID', reason);

        if (workspace) {
          try {
            await workspace.cleanup();
          } catch {
            // ignore secondary cleanup errors
          }
          workspace = null;
        }

        return Object.freeze({
          valid: false,
          trial,
          integrityPreflight: preflight,
          armResults,
          invalidationReason: reason,
        });
      } finally {
        // Workspace cleanup must occur even when the arm fails
        if (workspace) {
          await workspace.cleanup();
        }
      }

      armResults[armId] = Object.freeze({
        armId,
        status: armStatus,
        rawEvidence,
        verificationEvidence,
        diffCapture,
        discoveryReport,
        reworkReport,
      });
    }

    // 7. Transition to EVIDENCE_CAPTURED
    trial = transitionTrial(trial, 'EVIDENCE_CAPTURED');

    // 8. Transition to MEASURED
    trial = transitionTrial(trial, 'MEASURED');

    // 9. Run final Integrity Guard validation
    const integrityFinal = validateTrialIntegrity(trial, {
      armWorkspaces,
      rawEvidence: rawEvidenceMap,
      verificationEvidence: verificationEvidenceMap,
    });

    if (!integrityFinal.valid) {
      const reason = integrityFinal.violations[0]?.message ?? 'Final integrity validation failure';
      trial = transitionTrial(trial, 'INVALID', reason);
      return Object.freeze({
        valid: false,
        trial,
        integrityPreflight: preflight,
        integrityFinal,
        armResults,
        invalidationReason: reason,
        violations: integrityFinal.violations,
      });
    }

    // 10. Transition to COMPLETE
    trial = transitionTrial(trial, 'COMPLETE');

    return Object.freeze({
      valid: true,
      trial,
      integrityPreflight: preflight,
      integrityFinal,
      armResults,
    });
  }
}
