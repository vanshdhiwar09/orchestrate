import {
  engineClient,
  escapeHtml,
  type EngineHealthInfo,
  type HandoffDto,
  type ProjectDto,
  type ProjectFactDto,
  type VerificationRecordDto,
  type TaskSummaryDto,
  type ExecutionTimelineStepDto,
  type TaskPlanDto,
  type TaskReviewDto,
  type TaskDetailDto,
  type RepositoryTreeDto,
  type RepositoryFileContentDto,
  type TaskEventsResponseDto,
} from '../services/engine-client.js';
import {
  loadApplicationSettings,
  saveApplicationSettings,
  validateEngineUrl,
  type ApplicationSettings,
} from '../services/settings-store.js';
import { router, type RouteMatch } from '../services/router.js';
import { renderStatusBadge, type StatusBadgeVariant } from './status-badge.js';
import { renderTaskWorkspaceScreen } from './task-workspace.js';
export { renderTaskWorkspaceScreen };
import {
  stripMarkdownFormatting,
  formatSummaryPreview,
  tryParseJson,
  renderCompactFactValueHtml,
  renderDetailFactValueHtml,
  renderBoundedLogBoxHtml,
  formatActivityDetailHtml,
} from './content-disclosure.js';

export type TrustStatus =
  | 'VERIFIED'
  | 'CLAIMED'
  | 'FAILED'
  | 'BLOCKED_NEEDS_HUMAN'
  | 'UNVERIFIED';

export type VerificationRejectionKind = 'MISMATCHED' | 'STALE';

export interface DerivedTaskAttempt {
  attemptNumber: number;
  handoff?: HandoffDto;
  rawVerification?: VerificationRecordDto;
  verification?: VerificationRecordDto;
  verificationRejectedReason?: string;
  verificationRejectedKind?: VerificationRejectionKind;
  trustState: TrustStatus;
  summary: string;
  timestamp: string;
  failedCheckNames: string[];
}

export interface DerivedTaskSummary {
  taskId: string;
  highestAttempt: number;
  attemptCount: number;
  trustState: TrustStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
  failedCheckNames: string[];
  handoffCount: number;
  verificationCount: number;
  latestAgentId?: string;
  latestModel?: string;
  explicitlyBlocked: boolean;
  attempts: DerivedTaskAttempt[];
  executionTimeline?: any[];
  model?: string;
  provider?: string;
  isRealInference?: boolean;
}

export interface AttentionItem {
  taskId: string;
  attemptNumber: number;
  trustState: 'FAILED' | 'BLOCKED_NEEDS_HUMAN' | 'CLAIMED';
  reason: string;
  actionLabel: string;
  targetSection: 'verifications' | 'handoffs' | 'tasks';
  timestamp: string;
}

export interface RecentHandoffItem {
  handoff: HandoffDto;
  outcomeStatus: 'VERIFIED' | 'FAILED' | 'CLAIMED';
  verificationUnknown?: boolean;
}

export interface DerivedDecisionSummary {
  id: string;
  statement: string;
  rationale: string;
  status: string;
  taskId: string;
  attemptNumber: number;
}

export type FactProvenanceFilter =
  | 'ALL'
  | 'CODE'
  | 'VERIFICATION'
  | 'SYSTEM'
  | 'AGENT'
  | 'HUMAN';

export type FactStatusFilter = 'ALL' | 'VERIFIED' | 'CLAIMED' | 'UNVERIFIED';

export interface DerivedBrainFactRevision {
  fact: ProjectFactDto;
  revisionIndex: number;
  isCurrent: boolean;
}

export interface DerivedBrainFactItem {
  key: string;
  current: ProjectFactDto;
  history: DerivedBrainFactRevision[];
  revisionCount: number;
  compilerScope: {
    admittedToContext: boolean;
    scopeKind: 'GLOBAL' | 'TAG_SCOPED' | 'UNSCOPED' | 'EXCLUDED_NOT_VERIFIED';
    scopeTag?: string;
    explanation: string;
  };
}

export interface DeriveProjectOverviewOptions {
  blockedTaskIds?: ReadonlySet<string> | readonly string[];
  handoffsAvailable?: boolean;
  verificationsAvailable?: boolean;
  tasks?: readonly TaskSummaryDto[];
}

export interface ProjectOverviewModel {
  project: ProjectDto;
  handoffsAvailable: boolean;
  verificationsAvailable: boolean;
  taskDerivationComplete: boolean;
  currentFacts: ProjectFactDto[];
  decisions: DerivedDecisionSummary[];
  derivedTasks: DerivedTaskSummary[];
  taskCounts: {
    all: number;
    verified: number;
    failed: number;
    blocked: number;
    claimed: number;
    unverified: number;
  };
  attentionItems: AttentionItem[];
  latestVerification: VerificationRecordDto | null;
  recentHandoffs: RecentHandoffItem[];
}

export function evaluateVerificationForHandoff(
  verif: VerificationRecordDto | undefined,
  handoff: HandoffDto | undefined,
  allTaskHandoffs?: readonly HandoffDto[]
): {
  validVerification?: VerificationRecordDto;
  rejectedReason?: string;
  rejectedKind?: VerificationRejectionKind;
} {
  if (!verif) {
    return { validVerification: undefined };
  }
  const verifHandoffId = verif.handoffId ? verif.handoffId.trim() : '';
  if (!handoff) {
    if (verifHandoffId && allTaskHandoffs && allTaskHandoffs.length > 0) {
      const otherAttemptHandoff = allTaskHandoffs.find(
        (h) =>
          h.id &&
          h.id.trim() === verifHandoffId &&
          Number(h.attemptNumber) !== Number(verif.attemptNumber)
      );
      if (otherAttemptHandoff) {
        return {
          validVerification: undefined,
          rejectedKind: 'MISMATCHED',
          rejectedReason: `Verification record "${verif.id}" references handoff "${verif.handoffId}" from attempt #${Number(otherAttemptHandoff.attemptNumber)}, not attempt #${Number(verif.attemptNumber)}.`,
        };
      }
    }
    return { validVerification: verif };
  }
  if (verifHandoffId && handoff.id && verifHandoffId !== handoff.id.trim()) {
    return {
      validVerification: undefined,
      rejectedKind: 'MISMATCHED',
      rejectedReason: `Verification record "${verif.id}" references handoff "${verif.handoffId}", which does not match this attempt's handoff "${handoff.id}".`,
    };
  }
  const verifTime = verif.recordedAt || verif.result?.executedAt;
  if (handoff.createdAt && verifTime) {
    const hMs = Date.parse(handoff.createdAt);
    const vMs = Date.parse(verifTime);
    if (Number.isFinite(hMs) && Number.isFinite(vMs) && hMs > vMs) {
      return {
        validVerification: undefined,
        rejectedKind: 'STALE',
        rejectedReason: `Verification record "${verif.id}" (${verifTime}) is older than handoff "${handoff.id}" (${handoff.createdAt}) and is not fresh for this attempt.`,
      };
    }
  }
  return { validVerification: verif };
}

/**
 * Pure, deterministic derivation of Project Brain fact items from the append-only
 * `project.facts` array returned by `GET /projects/:projectId`.
 *
 * Matches `MemoryProjectBrain` and `SqliteProjectBrain` (`getCurrentFact` and `getFactHistory`):
 * - `current` is the latest recorded entry for each `key` in insertion order.
 * - `history` preserves all recorded revisions for that `key` (newest revision first).
 * - `compilerScope` reflects the exact admission rules in `ContextCompilerCore.compile`.
 */
export function deriveProjectBrainFacts(
  rawFacts: readonly ProjectFactDto[] | undefined | null
): DerivedBrainFactItem[] {
  if (!rawFacts || rawFacts.length === 0) {
    return [];
  }

  const historyByKey = new Map<string, ProjectFactDto[]>();
  for (const fact of rawFacts) {
    const key = (fact.key ?? '').trim();
    if (!key) continue;
    const normalizedFact: ProjectFactDto = { ...fact, key };
    const existing = historyByKey.get(key);
    if (existing) {
      existing.push(normalizedFact);
    } else {
      historyByKey.set(key, [normalizedFact]);
    }
  }

  const items: DerivedBrainFactItem[] = [];
  for (const [key, chronological] of historyByKey.entries()) {
    const current = chronological[chronological.length - 1];
    const history: DerivedBrainFactRevision[] = chronological
      .map((fact, idx) => ({
        fact,
        revisionIndex: idx + 1,
        isCurrent: idx === chronological.length - 1,
      }))
      .reverse();

    const lowerKey = key.toLowerCase();
    let compilerScope: DerivedBrainFactItem['compilerScope'];

    if (current.status !== 'VERIFIED') {
      compilerScope = {
        admittedToContext: false,
        scopeKind: 'EXCLUDED_NOT_VERIFIED',
        explanation: `Excluded from compiled downstream prompts because status is ${current.status} (ContextCompiler admits only current VERIFIED facts).`,
      };
    } else if (lowerKey.startsWith('global.') || lowerKey.startsWith('global:')) {
      compilerScope = {
        admittedToContext: true,
        scopeKind: 'GLOBAL',
        scopeTag: 'global',
        explanation:
          'Admitted globally into compiled downstream task prompts (VERIFIED fact with "global." or "global:" prefix).',
      };
    } else {
      const dotIdx = lowerKey.indexOf('.');
      const colonIdx = lowerKey.indexOf(':');
      let sepIdx = -1;
      if (dotIdx > 0 && colonIdx > 0) {
        sepIdx = Math.min(dotIdx, colonIdx);
      } else if (dotIdx > 0) {
        sepIdx = dotIdx;
      } else if (colonIdx > 0) {
        sepIdx = colonIdx;
      }

      if (sepIdx > 0) {
        const scopeTag = lowerKey.slice(0, sepIdx);
        compilerScope = {
          admittedToContext: true,
          scopeKind: 'TAG_SCOPED',
          scopeTag,
          explanation: `Admitted into compiled downstream task prompts when tag "${scopeTag}" is requested (status is VERIFIED).`,
        };
      } else {
        compilerScope = {
          admittedToContext: false,
          scopeKind: 'UNSCOPED',
          explanation:
            'Stored in Project Brain as VERIFIED, but not auto-injected by ContextCompiler unless keyed with "global." or "<tag>.".',
        };
      }
    }

    items.push({
      key,
      current,
      history,
      revisionCount: chronological.length,
      compilerScope,
    });
  }

  return items;
}

/**
 * Pure search and filter helper for Project Brain facts.
 * Filters by current persisted `provenance`, current persisted `status`, and search query
 * across current fact fields (`key`, `value`, `provenance`, `status`, `recordedAt`, `scopeTag`).
 * Superseded revisions are never matched as if they were the current fact.
 */
export function filterProjectBrainFacts(
  facts: readonly DerivedBrainFactItem[],
  provenanceFilter: FactProvenanceFilter,
  statusFilter: FactStatusFilter,
  searchQuery: string
): DerivedBrainFactItem[] {
  const q = searchQuery.trim().toLowerCase();

  return facts.filter((item) => {
    if (provenanceFilter !== 'ALL' && item.current.provenance !== provenanceFilter) {
      return false;
    }
    if (statusFilter !== 'ALL' && item.current.status !== statusFilter) {
      return false;
    }
    if (!q) {
      return true;
    }
    const haystackParts = [
      item.key,
      item.current.value,
      item.current.provenance,
      item.current.status,
      item.current.recordedAt,
      item.compilerScope.scopeTag ?? '',
    ];
    return haystackParts.join(' ').toLowerCase().includes(q);
  });
}

/**
 * Pure, deterministic derivation of Project Overview state from persisted
 * project facts, handoff claims, and independent verification records.
 */
export function deriveProjectOverviewModel(
  project: ProjectDto,
  handoffs: HandoffDto[],
  verifications: VerificationRecordDto[],
  options?: DeriveProjectOverviewOptions
): ProjectOverviewModel {
  const handoffsAvailable = options?.handoffsAvailable ?? true;
  const verificationsAvailable = options?.verificationsAvailable ?? true;
  const taskDerivationComplete = handoffsAvailable && verificationsAvailable;

  const blockedSet = new Set<string>(
    options?.blockedTaskIds ? Array.from(options.blockedTaskIds, (id) => id.trim()) : []
  );

  // 1. Current facts: deduplicate append-only history by latest entry per key
  const currentFacts = deriveProjectBrainFacts(project.facts).map((item) => item.current);

  // 2. Decisions recorded across handoffs (ordered chronologically, deduplicated by id)
  const sortedHandoffsAsc = [...handoffs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || Number(a.attemptNumber) - Number(b.attemptNumber)
  );
  const decisionMap = new Map<string, DerivedDecisionSummary>();
  for (const h of sortedHandoffsAsc) {
    for (const d of h.decisionsCreated ?? []) {
      decisionMap.set(d.id, {
        id: d.id,
        statement: d.statement,
        rationale: d.rationale,
        status: d.status,
        taskId: h.taskId.trim(),
        attemptNumber: Number(h.attemptNumber),
      });
    }
  }
  const decisions = Array.from(decisionMap.values());

  // 3. Index handoffs and verifications by normalized taskId
  const taskIds = new Set<string>();
  const handoffsByTask = new Map<string, HandoffDto[]>();
  const verifsByTask = new Map<string, VerificationRecordDto[]>();

  for (const h of handoffs) {
    const tid = h.taskId.trim();
    taskIds.add(tid);
    const list = handoffsByTask.get(tid) ?? [];
    list.push(h);
    handoffsByTask.set(tid, list);
  }

  for (const v of verifications) {
    const tid = v.taskId.trim();
    taskIds.add(tid);
    const list = verifsByTask.get(tid) ?? [];
    list.push(v);
    verifsByTask.set(tid, list);
  }

  for (const blockedId of blockedSet) {
    if (blockedId) taskIds.add(blockedId);
  }

  if (options?.tasks) {
    for (const t of options.tasks) {
      if (t && t.id) taskIds.add(t.id.trim());
    }
  }

  const derivedTasks: DerivedTaskSummary[] = [];

  // Only derive task trust states when both handoff and verification streams are available
  if (taskDerivationComplete) {
    for (const taskId of taskIds) {
      const tHandoffs = handoffsByTask.get(taskId) ?? [];
      const tVerifs = verifsByTask.get(taskId) ?? [];

      const attemptsSet = new Set<number>();
      for (const h of tHandoffs) attemptsSet.add(Number(h.attemptNumber));
      for (const v of tVerifs) attemptsSet.add(Number(v.attemptNumber));

      const attemptNums = Array.from(attemptsSet).sort((a, b) => a - b);
      const highestAttempt = attemptNums.length > 0 ? attemptNums[attemptNums.length - 1] : 0;

      const chronologicalAttempts: DerivedTaskAttempt[] = attemptNums.map((attemptNum) => {
        const matchingHandoffs = tHandoffs
          .filter((h) => Number(h.attemptNumber) === attemptNum)
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        const attHandoff = matchingHandoffs[0];

        const matchingVerifs = tVerifs
          .filter((v) => Number(v.attemptNumber) === attemptNum)
          .sort((a, b) => {
            const ta = a.recordedAt || a.result?.executedAt || '';
            const tb = b.recordedAt || b.result?.executedAt || '';
            return tb.localeCompare(ta);
          });
        const attRawVerif = matchingVerifs[0];

        const {
          validVerification: attVerif,
          rejectedReason,
          rejectedKind,
        } = evaluateVerificationForHandoff(attRawVerif, attHandoff, tHandoffs);

        const attExplicitBlocked =
          attHandoff?.status === 'BLOCKED_NEEDS_HUMAN' ||
          (attRawVerif?.result as { status?: string } | undefined)?.status ===
            'BLOCKED_NEEDS_HUMAN';

        let attTrustState: TrustStatus = 'UNVERIFIED';
        if (attExplicitBlocked) {
          attTrustState = 'BLOCKED_NEEDS_HUMAN';
        } else if (attVerif) {
          attTrustState = attVerif.result.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED';
        } else if (attHandoff) {
          attTrustState = 'CLAIMED';
        } else {
          attTrustState = 'UNVERIFIED';
        }

        const attFailedChecks = attVerif
          ? attVerif.result.checks.filter((c) => !c.passed).map((c) => c.name)
          : [];

        const attSummary =
          attHandoff?.summary ||
          (attFailedChecks.length > 0
            ? `Failed checks: ${attFailedChecks.join(', ')}`
            : `Attempt ${attemptNum} recorded`);

        const attTimestamp =
          attVerif?.recordedAt ||
          attVerif?.result.executedAt ||
          attHandoff?.createdAt ||
          attRawVerif?.recordedAt ||
          attRawVerif?.result.executedAt ||
          project.createdAt;

        return {
          attemptNumber: attemptNum,
          handoff: attHandoff,
          rawVerification: attRawVerif,
          verification: attVerif,
          verificationRejectedReason: rejectedReason,
          verificationRejectedKind: rejectedKind,
          trustState: attTrustState,
          summary: attSummary,
          timestamp: attTimestamp,
          failedCheckNames: attFailedChecks,
        };
      });

      const latestAttemptObj =
        chronologicalAttempts.length > 0
          ? chronologicalAttempts[chronologicalAttempts.length - 1]
          : undefined;

      const latestHandoff = latestAttemptObj?.handoff;
      const fallbackHandoff =
        latestHandoff ??
        [...tHandoffs].sort((a, b) => Number(b.attemptNumber) - Number(a.attemptNumber))[0];
      const latestVerif = latestAttemptObj?.verification;

      const explicitlyBlocked =
        blockedSet.has(taskId) ||
        Boolean(latestAttemptObj && latestAttemptObj.trustState === 'BLOCKED_NEEDS_HUMAN');

      const knownTask = options?.tasks?.find((t) => t.id === taskId);
      let trustState: TrustStatus = 'UNVERIFIED';
      if (explicitlyBlocked) {
        trustState = 'BLOCKED_NEEDS_HUMAN';
      } else if (highestAttempt === 0) {
        trustState = (knownTask?.trustState as TrustStatus) || 'UNVERIFIED';
      } else if (latestAttemptObj) {
        trustState = latestAttemptObj.trustState;
      }

      const failedCheckNames = latestAttemptObj?.failedCheckNames ?? [];

      const summary =
        fallbackHandoff?.summary ||
        (failedCheckNames.length > 0
          ? `Failed checks: ${failedCheckNames.join(', ')}`
          : highestAttempt > 0
            ? `Attempt ${highestAttempt} recorded`
            : knownTask?.title || knownTask?.description || 'No attempts recorded');

      const updatedAt =
        latestVerif?.recordedAt ||
        latestVerif?.result.executedAt ||
        latestHandoff?.createdAt ||
        fallbackHandoff?.createdAt ||
        project.createdAt;

      const allTimestamps: string[] = [];
      for (const h of tHandoffs) {
        if (h.createdAt) allTimestamps.push(h.createdAt);
      }
      for (const v of tVerifs) {
        const vt = v.recordedAt || v.result?.executedAt;
        if (vt) allTimestamps.push(vt);
      }
      allTimestamps.sort();
      const createdAt = allTimestamps[0] || updatedAt;

      derivedTasks.push({
        taskId,
        highestAttempt,
        attemptCount: attemptNums.length,
        trustState,
        summary,
        createdAt,
        updatedAt,
        failedCheckNames,
        handoffCount: tHandoffs.length,
        verificationCount: tVerifs.length,
        latestAgentId: latestHandoff?.agentId || fallbackHandoff?.agentId,
        latestModel: latestHandoff?.model || fallbackHandoff?.model,
        explicitlyBlocked,
        attempts: chronologicalAttempts,
      });
    }
  }

  derivedTasks.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId)
  );

  // 4. Task counts by trust state (driven by the exact same derivedTasks array)
  const taskCounts = {
    all: derivedTasks.length,
    verified: derivedTasks.filter((t) => t.trustState === 'VERIFIED').length,
    failed: derivedTasks.filter((t) => t.trustState === 'FAILED').length,
    blocked: derivedTasks.filter((t) => t.trustState === 'BLOCKED_NEEDS_HUMAN').length,
    claimed: derivedTasks.filter((t) => t.trustState === 'CLAIMED').length,
    unverified: derivedTasks.filter((t) => t.trustState === 'UNVERIFIED').length,
  };

  // 5. Tasks requiring attention (driven by the exact same derivedTasks array)
  const severityOrder: Record<string, number> = {
    BLOCKED_NEEDS_HUMAN: 0,
    FAILED: 1,
    CLAIMED: 2,
  };

  const attentionItems: AttentionItem[] = derivedTasks
    .filter(
      (t): t is DerivedTaskSummary & { trustState: 'FAILED' | 'BLOCKED_NEEDS_HUMAN' | 'CLAIMED' } =>
        t.trustState === 'BLOCKED_NEEDS_HUMAN' ||
        t.trustState === 'FAILED' ||
        t.trustState === 'CLAIMED'
    )
    .sort(
      (a, b) =>
        severityOrder[a.trustState] - severityOrder[b.trustState] ||
        b.updatedAt.localeCompare(a.updatedAt)
    )
    .map((t) => {
      if (t.trustState === 'BLOCKED_NEEDS_HUMAN') {
        return {
          taskId: t.taskId,
          attemptNumber: t.highestAttempt,
          trustState: 'BLOCKED_NEEDS_HUMAN',
          reason:
            t.highestAttempt > 0
              ? `Task marked blocked on attempt ${t.highestAttempt} · needs a human`
              : 'Task marked blocked · needs a human',
          actionLabel: 'Review attempts →',
          targetSection: 'tasks',
          timestamp: t.updatedAt,
        };
      }
      if (t.trustState === 'FAILED') {
        const checkLabel =
          t.failedCheckNames.length > 0 ? t.failedCheckNames.join(', ') : 'Verification';
        return {
          taskId: t.taskId,
          attemptNumber: t.highestAttempt,
          trustState: 'FAILED',
          reason: `${checkLabel} failed on attempt ${t.highestAttempt}`,
          actionLabel: 'View evidence →',
          targetSection: 'verifications',
          timestamp: t.updatedAt,
        };
      }
      return {
        taskId: t.taskId,
        attemptNumber: t.highestAttempt,
        trustState: 'CLAIMED',
        reason: `Agent claimed attempt ${t.highestAttempt} · awaiting independent verification`,
        actionLabel: 'Inspect handoff →',
        targetSection: 'handoffs',
        timestamp: t.updatedAt,
      };
    });

  // 6. Latest verification record
  const sortedVerifsDesc = [...verifications].sort((a, b) => {
    const timeA = a.recordedAt || a.result.executedAt || '';
    const timeB = b.recordedAt || b.result.executedAt || '';
    return timeB.localeCompare(timeA) || Number(b.attemptNumber) - Number(a.attemptNumber);
  });
  const latestVerification = sortedVerifsDesc[0] ?? null;

  // 7. Recent handoffs paired with verification outcome for that exact (taskId, attemptNumber)
  const verifByTaskAttempt = new Map<string, VerificationRecordDto>();
  for (const v of sortedVerifsDesc) {
    const key = `${v.taskId.trim()}:${Number(v.attemptNumber)}`;
    if (!verifByTaskAttempt.has(key)) {
      verifByTaskAttempt.set(key, v);
    }
  }

  const recentHandoffs: RecentHandoffItem[] = [...handoffs]
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || Number(b.attemptNumber) - Number(a.attemptNumber)
    )
    .map((h) => {
      if (!verificationsAvailable) {
        return {
          handoff: h,
          outcomeStatus: 'CLAIMED',
          verificationUnknown: true,
        };
      }
      const candidateVerif = verifByTaskAttempt.get(
        `${h.taskId.trim()}:${Number(h.attemptNumber)}`
      );
      const { validVerification: validVerif } = evaluateVerificationForHandoff(
        candidateVerif,
        h,
        handoffsByTask.get(h.taskId.trim())
      );
      return {
        handoff: h,
        outcomeStatus: validVerif ? validVerif.result.status : 'CLAIMED',
        verificationUnknown: false,
      };
    });

  return {
    project,
    handoffsAvailable,
    verificationsAvailable,
    taskDerivationComplete,
    currentFacts,
    decisions,
    derivedTasks,
    taskCounts,
    attentionItems,
    latestVerification,
    recentHandoffs,
  };
}

export function slugifyProjectId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatProjectTitle(projectId: string): string {
  const known = engineClient.getKnownProjects().find((p) => p.id === projectId);
  if (known && known.name) return known.name;
  return projectId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * 1. PROJECTS SCREEN (Exact match to uploaded screenshot & PDF Page 1)
 */
function renderProjectsScreen(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';

  const grid = document.createElement('div');
  grid.className = 'projects-workspace-grid';

  // ── LEFT / CENTER MAIN COLUMN ─────────────────────────────────────────────
  const mainCol = document.createElement('div');
  mainCol.className = 'projects-main-col';

  const header = document.createElement('div');
  header.className = 'page-header';
  header.innerHTML = `
    <div class="page-header-titles">
      <h1 class="page-title">Projects</h1>
      <p class="page-subtitle">Create or open a project to start orchestrating AI agents.</p>
    </div>
    <div class="page-actions" style="display: flex; gap: 8px;">
      <button type="button" class="btn btn-secondary btn-lg" id="top-open-folder-btn">
        <span>📁</span>
        <span>Open Local Folder</span>
      </button>
      <button type="button" class="btn btn-primary btn-lg" id="top-new-project-btn">
        <span style="font-size: 16px; font-weight: 400; line-height: 1;">+</span>
        <span>New Project</span>
      </button>
    </div>
  `;
  mainCol.appendChild(header);

  const toolbar = document.createElement('div');
  toolbar.className = 'projects-toolbar';
  toolbar.innerHTML = `
    <div class="projects-tabs">
      <button type="button" class="projects-tab active" data-tab="all">All Projects</button>
      <button type="button" class="projects-tab" data-tab="recent">Recent</button>
    </div>
    <div class="projects-toolbar-controls">
      <div class="view-mode-toggle" role="group" aria-label="View mode">
        <button type="button" class="view-mode-btn active" data-view="grid" title="Grid view">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
        </button>
        <button type="button" class="view-mode-btn" data-view="list" title="List view">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>
        </button>
      </div>
      <input type="text" class="projects-inline-search" id="project-lookup-input" placeholder="Search projects..." title="Filter projects by name or ID" aria-label="Filter projects" />
    </div>
  `;
  mainCol.appendChild(toolbar);

  const heroSurface = document.createElement('div');
  heroSurface.className = 'hero-gradient-surface';

  let loadedProjects: ProjectDto[] = engineClient.getKnownProjects();
  let isLoading = true;
  let loadError: string | null = null;
  let activeTab: 'all' | 'recent' = 'all';
  let viewMode: 'grid' | 'list' = 'grid';
  let filterQuery = '';

  const renderHeroContent = () => {
    heroSurface.innerHTML = '';

    if (isLoading) {
      const loadingCard = document.createElement('div');
      loadingCard.className = 'empty-projects-modal-card';
      loadingCard.id = 'projects-loading-state';
      loadingCard.innerHTML = `
        <div class="empty-projects-folder-circle">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        </div>
        <div class="empty-projects-title">Loading projects...</div>
        <p class="empty-projects-desc">
          Fetching persisted projects from the SQLite Project Brain.
        </p>
      `;
      heroSurface.appendChild(loadingCard);
      return;
    }

    if (loadError) {
      const errorCard = document.createElement('div');
      errorCard.className = 'empty-projects-modal-card';
      errorCard.id = 'projects-error-state';
      errorCard.innerHTML = `
        <div class="empty-projects-folder-circle" style="color: var(--status-failed-text); border-color: var(--status-failed-border);">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
        </div>
        <div class="empty-projects-title">Unable to load projects</div>
        <p class="empty-projects-desc" style="color: var(--status-failed-text);">
          ${escapeHtml(loadError)}
        </p>
        <div class="empty-projects-divider"></div>
        <button type="button" class="btn btn-primary btn-lg" id="retry-load-projects-btn">
          <span>Retry</span>
          <span>↻</span>
        </button>
      `;
      heroSurface.appendChild(errorCard);
      errorCard.querySelector('#retry-load-projects-btn')?.addEventListener('click', () => {
        void loadProjects();
      });
      return;
    }

    if (loadedProjects.length === 0) {
      const modalCard = document.createElement('div');
      modalCard.className = 'empty-projects-modal-card';
      modalCard.id = 'projects-empty-state';
      modalCard.innerHTML = `
        <div class="empty-projects-folder-circle">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        </div>
        <div class="empty-projects-title">No projects yet</div>
        <p class="empty-projects-desc">
          Create your first project to start orchestrating AI agents, tracking verifications, and building your project brain.
        </p>
        <div class="empty-projects-divider"></div>
        <button type="button" class="btn btn-primary btn-lg" id="hero-create-project-btn">
          <span>Create Project</span>
          <span>→</span>
        </button>
      `;
      heroSurface.appendChild(modalCard);
      modalCard.querySelector('#hero-create-project-btn')?.addEventListener('click', () => {
        (wrapper.querySelector('#proj-name-input') as HTMLInputElement | null)?.focus();
      });
      return;
    }

    const q = filterQuery.trim().toLowerCase();
    let filtered = loadedProjects.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );

    if (activeTab === 'recent') {
      // Honest ordering derived directly from persisted createdAt timestamp (newest first)
      filtered = [...filtered].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
      );
    }

    if (filtered.length === 0) {
      const noMatchCard = document.createElement('div');
      noMatchCard.className = 'empty-projects-modal-card';
      noMatchCard.id = 'projects-no-match-state';
      noMatchCard.innerHTML = `
        <div class="empty-projects-folder-circle">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        </div>
        <div class="empty-projects-title">No matching projects</div>
        <p class="empty-projects-desc">
          No persisted projects matched "${escapeHtml(filterQuery.trim())}".
        </p>
        <div class="empty-projects-divider"></div>
        <button type="button" class="btn btn-secondary btn-md" id="clear-search-btn">
          <span>Clear search</span>
        </button>
      `;
      heroSurface.appendChild(noMatchCard);
      noMatchCard.querySelector('#clear-search-btn')?.addEventListener('click', () => {
        filterQuery = '';
        if (lookupInput) lookupInput.value = '';
        renderHeroContent();
      });
      return;
    }

    const cardsGrid = document.createElement('div');
    cardsGrid.className = 'project-cards-grid';
    if (viewMode === 'list') {
      cardsGrid.style.gridTemplateColumns = '1fr';
    }

    for (const proj of filtered) {
      const card = document.createElement('div');
      card.className = 'project-item-card';
      card.setAttribute('data-project-id', proj.id);
      card.innerHTML = `
        <div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
            <span style="font-size: 16px; font-weight: 600; color: var(--text-primary);">${escapeHtml(proj.name)}</span>
            <span class="status-badge verified">ACTIVE</span>
          </div>
          <div style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); margin-bottom: 8px;">${escapeHtml(proj.id)}</div>
          <p style="font-size: 12px; color: var(--text-muted);">
            Created ${escapeHtml(new Date(proj.createdAt).toLocaleDateString())}
          </p>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 10px; border-top: 1px dotted var(--border-default); font-size: 12px;">
          <span style="color: var(--text-muted);">${proj.facts?.length ?? 0} brain facts</span>
          <span style="font-weight: 600; color: var(--brand-blue);">Open project →</span>
        </div>
      `;
      card.addEventListener('click', () => {
        router.navigateToProject(proj.id, 'overview');
      });
      cardsGrid.appendChild(card);
    }

    heroSurface.appendChild(cardsGrid);
  };

  const loadProjects = async () => {
    isLoading = true;
    loadError = null;
    renderHeroContent();
    try {
      loadedProjects = await engineClient.listProjects();
      isLoading = false;
      renderHeroContent();
    } catch (err) {
      isLoading = false;
      loadError = (err as Error).message || 'Failed to load projects from Engine.';
      renderHeroContent();
    }
  };

  mainCol.appendChild(heroSurface);
  void loadProjects();

  // Filter / Lookup by ID
  const lookupInput = toolbar.querySelector('#project-lookup-input') as HTMLInputElement | null;
  lookupInput?.addEventListener('input', () => {
    filterQuery = lookupInput.value;
    renderHeroContent();
  });
  lookupInput?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && lookupInput.value.trim()) {
      const q = lookupInput.value.trim();
      const exactLocal = loadedProjects.find(
        (p) => p.id.toLowerCase() === q.toLowerCase() || p.name.toLowerCase() === q.toLowerCase()
      );
      if (exactLocal) {
        router.navigateToProject(exactLocal.id, 'overview');
        return;
      }
      try {
        const found = await engineClient.getProject(q);
        if (found) {
          loadedProjects = engineClient.getKnownProjects();
          renderHeroContent();
          router.navigateToProject(found.id, 'overview');
        }
      } catch {
        // Ignore network error during Enter lookup; filter UI already shows local match state
      }
    }
  });

  const capabilities = document.createElement('div');
  capabilities.className = 'capabilities-section';
  capabilities.innerHTML = `
    <div class="capabilities-heading">WHAT YOU CAN DO WITH ORCHESTRATE</div>
    <div class="capabilities-grid">
      <div class="capability-item">
        <div class="capability-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>
        </div>
        <div class="capability-title">Manage AI agents</div>
        <div class="capability-desc">Plan, assign and track coding tasks</div>
      </div>
      <div class="capability-item">
        <div class="capability-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
        </div>
        <div class="capability-title">Verify their work</div>
        <div class="capability-desc">Independent checks and evidence</div>
      </div>
      <div class="capability-item">
        <div class="capability-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>
        </div>
        <div class="capability-title">Build project brain</div>
        <div class="capability-desc">Persistent knowledge across sessions</div>
      </div>
      <div class="capability-item">
        <div class="capability-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        </div>
        <div class="capability-title">Maintain handoffs</div>
        <div class="capability-desc">Structured context for next steps</div>
      </div>
    </div>
  `;
  mainCol.appendChild(capabilities);

  // ── RIGHT COLUMN: CREATE PROJECT PANEL ────────────────────────────────────
  const createPanel = document.createElement('aside');
  createPanel.className = 'create-project-panel';
  createPanel.innerHTML = `
    <div>
      <div class="create-project-header">
        <h2 class="create-project-title">Create Project</h2>
        <button type="button" class="create-project-close" aria-label="Reset form" title="Clear form">×</button>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px; line-height: 1.45;">
        Set up a new project to start orchestrating AI agents.
      </p>
    </div>

    <hr class="divider-dotted" style="margin: 2px 0;" />

    <div class="form-field">
      <label class="form-label" for="proj-name-input">Project Name</label>
      <input type="text" id="proj-name-input" class="input" placeholder="e.g. my-app, orchestrate, invoice-fi" />
    </div>

    <div class="form-field">
      <label class="form-label" for="proj-id-input">Project Identifier</label>
      <input type="text" id="proj-id-input" class="input" placeholder="e.g. my-app" />
      <span class="form-helper">Lowercase, numbers and hyphens only. Used in paths and references.</span>
    </div>

    <div class="form-field">
      <label class="form-label" for="proj-desc-input">Description (optional)</label>
      <textarea id="proj-desc-input" class="textarea" placeholder="A short description of your project..." disabled title="Not persisted by POST /projects yet"></textarea>
    </div>


    <div class="form-field">
      <label class="form-label">Initialize with</label>
      <div class="init-options-list" id="create-project-init-options">
        <div class="init-option-card selected" data-mode="benchmark" style="cursor: pointer;">
          <div class="radio-circle"><div class="radio-dot"></div></div>
          <div class="init-option-text">
            <span class="init-option-title">Sample Benchmark Template (Recommended)</span>
            <span class="init-option-sub">Connects built-in profile validation repository with runnable verification checks.</span>
          </div>
        </div>
        <div class="init-option-card" data-mode="local" style="cursor: pointer;">
          <div class="radio-circle"></div>
          <div class="init-option-text">
            <span class="init-option-title">Import local repository</span>
            <span class="init-option-sub">Connect an existing folder on disk.</span>
          </div>
        </div>
        <div class="init-option-card" data-mode="github" style="cursor: pointer;">
          <div class="radio-circle"></div>
          <div class="init-option-text">
            <span class="init-option-title">Clone from Git URL</span>
            <span class="init-option-sub">Clone from GitHub / Git repository.</span>
          </div>
        </div>
        <div class="init-option-card" data-mode="empty" style="cursor: pointer;">
          <div class="radio-circle"></div>
          <div class="init-option-text">
            <span class="init-option-title">Empty project</span>
            <span class="init-option-sub">Start with a clean project (link repo later).</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Dynamic repo details based on mode -->
    <div id="repo-config-container" style="display: none; flex-direction: column; gap: 10px; padding: 12px; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 8px;">
      <div id="repo-local-fields" style="display: none; flex-direction: column; gap: 6px;">
        <label class="form-label" for="proj-local-path-input">Local Repository Directory</label>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="proj-local-path-input" class="input" style="flex: 1;" placeholder="e.g. ./my-repo or benchmarks/profile-validation" />
          <button type="button" class="btn btn-secondary btn-sm" id="validate-repo-btn">Validate</button>
        </div>
        <div id="repo-validation-feedback" style="display: none; font-size: 11.5px; padding: 6px 10px; border-radius: 6px;"></div>
      </div>
      <div id="repo-github-fields" style="display: none; flex-direction: column; gap: 6px;">
        <label class="form-label" for="proj-github-url-input">GitHub Repository URL</label>
        <input type="text" id="proj-github-url-input" class="input" placeholder="e.g. https://github.com/owner/repo.git" />
      </div>
    </div>

    <div id="create-project-feedback" role="alert" style="display: none; font-size: 12px; padding: 8px 12px; border-radius: 8px;"></div>

    <div class="create-project-footer">
      <button type="button" class="btn btn-secondary" id="cancel-project-btn">Cancel</button>
      <button type="button" class="btn btn-primary" id="submit-project-btn">
        <span id="submit-project-btn-label">Create Project</span>
        <span>→</span>
      </button>
    </div>
  `;

  grid.appendChild(mainCol);
  grid.appendChild(createPanel);
  wrapper.appendChild(grid);

  const nameInput = createPanel.querySelector('#proj-name-input') as HTMLInputElement | null;
  const idInput = createPanel.querySelector('#proj-id-input') as HTMLInputElement | null;
  const pathInput = createPanel.querySelector('#proj-path-input') as HTMLInputElement | null;
  const feedbackEl = createPanel.querySelector('#create-project-feedback') as HTMLElement | null;
  const submitBtn = createPanel.querySelector('#submit-project-btn') as HTMLButtonElement | null;
  const submitBtnLabel = createPanel.querySelector('#submit-project-btn-label') as HTMLElement | null;
  const cancelBtn = createPanel.querySelector('#cancel-project-btn') as HTMLButtonElement | null;
  const closeBtn = createPanel.querySelector('.create-project-close') as HTMLButtonElement | null;

  let idManuallyEdited = false;
  let isSubmitting = false;
  let selectedRepoMode: 'empty' | 'local' | 'github' | 'benchmark' = 'benchmark';

  const repoConfigContainer = createPanel.querySelector('#repo-config-container') as HTMLElement | null;
  const repoLocalFields = createPanel.querySelector('#repo-local-fields') as HTMLElement | null;
  const repoGithubFields = createPanel.querySelector('#repo-github-fields') as HTMLElement | null;
  const localPathInput = createPanel.querySelector('#proj-local-path-input') as HTMLInputElement | null;
  const githubUrlInput = createPanel.querySelector('#proj-github-url-input') as HTMLInputElement | null;
  const validateRepoBtn = createPanel.querySelector('#validate-repo-btn') as HTMLButtonElement | null;
  const repoValidationFeedback = createPanel.querySelector('#repo-validation-feedback') as HTMLElement | null;

  const initCards = createPanel.querySelectorAll('.init-option-card');
  initCards.forEach((card) => {
    card.addEventListener('click', () => {
      initCards.forEach((c) => {
        c.classList.remove('selected');
        const dot = c.querySelector('.radio-dot');
        if (dot) dot.remove();
      });
      card.classList.add('selected');
      const radioCircle = card.querySelector('.radio-circle');
      if (radioCircle && !radioCircle.querySelector('.radio-dot')) {
        const dot = document.createElement('div');
        dot.className = 'radio-dot';
        radioCircle.appendChild(dot);
      }

      const mode = (card.getAttribute('data-mode') || 'empty') as 'empty' | 'local' | 'github' | 'benchmark';
      selectedRepoMode = mode;

      if (repoConfigContainer) {
        if (mode === 'empty' || mode === 'benchmark') {
          repoConfigContainer.style.display = 'none';
        } else {
          repoConfigContainer.style.display = 'flex';
          if (repoLocalFields) repoLocalFields.style.display = mode === 'local' ? 'flex' : 'none';
          if (repoGithubFields) repoGithubFields.style.display = mode === 'github' ? 'flex' : 'none';
        }
      }
    });
  });

  validateRepoBtn?.addEventListener('click', async () => {
    const rawPath = localPathInput?.value.trim() ?? '';
    if (!rawPath) {
      if (repoValidationFeedback) {
        repoValidationFeedback.style.display = 'block';
        repoValidationFeedback.style.backgroundColor = 'var(--status-failed-bg)';
        repoValidationFeedback.style.color = 'var(--status-failed-text)';
        repoValidationFeedback.textContent = 'Please enter a local path to validate.';
      }
      return;
    }
    if (validateRepoBtn) validateRepoBtn.disabled = true;
    try {
      const res = await engineClient.validateRepository('temp', { type: 'local', path: rawPath });
      if (repoValidationFeedback) {
        repoValidationFeedback.style.display = 'block';
        if (res.valid) {
          repoValidationFeedback.style.backgroundColor = 'var(--status-verified-bg)';
          repoValidationFeedback.style.color = 'var(--status-verified-text)';
          repoValidationFeedback.textContent = `✓ Valid Git Repository (Branch: ${res.branch || 'main'}, Clean: ${res.isClean ? 'Yes' : 'No'})`;
        } else {
          repoValidationFeedback.style.backgroundColor = 'var(--status-failed-bg)';
          repoValidationFeedback.style.color = 'var(--status-failed-text)';
          repoValidationFeedback.textContent = `✕ ${res.error || 'Path is not a valid directory or git repo.'}`;
        }
      }
    } catch (err) {
      if (repoValidationFeedback) {
        repoValidationFeedback.style.display = 'block';
        repoValidationFeedback.style.backgroundColor = 'var(--status-failed-bg)';
        repoValidationFeedback.style.color = 'var(--status-failed-text)';
        repoValidationFeedback.textContent = `✕ Validation error: ${(err as Error).message}`;
      }
    } finally {
      if (validateRepoBtn) validateRepoBtn.disabled = false;
    }
  });

  const showFeedback = (type: 'error' | 'success' | 'info', message: string) => {
    if (!feedbackEl) return;
    feedbackEl.style.display = 'block';
    if (type === 'error') {
      feedbackEl.style.backgroundColor = 'var(--status-failed-bg)';
      feedbackEl.style.color = 'var(--status-failed-text)';
    } else if (type === 'success') {
      feedbackEl.style.backgroundColor = 'var(--status-verified-bg)';
      feedbackEl.style.color = 'var(--status-verified-text)';
    } else {
      feedbackEl.style.backgroundColor = 'var(--bg-surface-muted)';
      feedbackEl.style.color = 'var(--text-secondary)';
    }
    feedbackEl.textContent = message;
  };

  idInput?.addEventListener('input', () => {
    idManuallyEdited = idInput.value.trim().length > 0;
    if (feedbackEl) feedbackEl.style.display = 'none';
  });

  if (nameInput && idInput && pathInput) {
    nameInput.addEventListener('input', () => {
      if (feedbackEl) feedbackEl.style.display = 'none';
      if (!idManuallyEdited) {
        const slug = slugifyProjectId(nameInput.value);
        idInput.value = slug;
        pathInput.value = `./projects/${slug || 'repo'}`;
      }
    });
  }

  wrapper.querySelector('#top-new-project-btn')?.addEventListener('click', () => {
    nameInput?.focus();
  });

  wrapper.querySelector('#top-open-folder-btn')?.addEventListener('click', async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker();
        const res = await engineClient.openFolder({ path: `./${handle.name}`, name: handle.name });
        if (res && res.project) {
          router.navigateToProject(res.project.id, 'tasks');
          return;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return;
      }
    }
    const defaultPath = 'benchmarks/profile-validation';
    const folderPath = prompt('Enter path to project folder on your computer:', defaultPath);
    if (!folderPath || !folderPath.trim()) return;
    try {
      const res = await engineClient.openFolder({ path: folderPath.trim() });
      if (res && res.project) {
        router.navigateToProject(res.project.id, 'tasks');
      }
    } catch (e) {
      alert('Failed to open folder: ' + (e as Error).message);
    }
  });

  const resetForm = () => {
    if (isSubmitting) return;
    if (nameInput) nameInput.value = '';
    if (idInput) idInput.value = '';
    if (pathInput) pathInput.value = './projects/repo';
    if (localPathInput) localPathInput.value = '';
    if (githubUrlInput) githubUrlInput.value = '';
    selectedRepoMode = 'empty';
    if (repoConfigContainer) repoConfigContainer.style.display = 'none';
    if (repoValidationFeedback) repoValidationFeedback.style.display = 'none';
    idManuallyEdited = false;
    if (feedbackEl) feedbackEl.style.display = 'none';
  };

  cancelBtn?.addEventListener('click', resetForm);
  closeBtn?.addEventListener('click', resetForm);

  const handleCreateSubmit = async () => {
    if (isSubmitting) return;

    const name = nameInput?.value.trim() ?? '';
    const id = idInput?.value.trim() ?? '';

    if (!name) {
      showFeedback('error', 'Project Name is required.');
      nameInput?.focus();
      return;
    }

    if (!id) {
      showFeedback('error', 'Project Identifier is required.');
      idInput?.focus();
      return;
    }

    if (!/^[a-z0-9-]+$/.test(id) || id.startsWith('-') || id.endsWith('-')) {
      showFeedback(
        'error',
        'Identifier must contain lowercase letters, numbers, and interior hyphens only (e.g. my-app).'
      );
      idInput?.focus();
      return;
    }

    if (loadedProjects.some((p) => p.id === id)) {
      showFeedback('error', `Project "${id}" already exists. Choose a unique identifier.`);
      idInput?.focus();
      return;
    }

    const payload: {
      id: string;
      name: string;
      repositoryType?: 'local' | 'github' | 'none';
      repositoryPath?: string;
      repositoryUrl?: string;
    } = { id, name };

    if (selectedRepoMode === 'benchmark') {
      payload.repositoryType = 'local';
      payload.repositoryPath = 'benchmarks/profile-validation';
    } else if (selectedRepoMode === 'local') {
      const localPath = localPathInput?.value.trim() ?? '';
      if (!localPath) {
        showFeedback('error', 'Local repository directory path is required.');
        localPathInput?.focus();
        return;
      }
      payload.repositoryType = 'local';
      payload.repositoryPath = localPath;
    } else if (selectedRepoMode === 'github') {
      const gitUrl = githubUrlInput?.value.trim() ?? '';
      if (!gitUrl || (!gitUrl.startsWith('http://') && !gitUrl.startsWith('https://') && !gitUrl.startsWith('git@'))) {
        showFeedback('error', 'A valid Git or GitHub clone URL is required.');
        githubUrlInput?.focus();
        return;
      }
      payload.repositoryType = 'github';
      payload.repositoryUrl = gitUrl;
    } else {
      payload.repositoryType = 'none';
    }

    isSubmitting = true;
    if (submitBtn) submitBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (nameInput) nameInput.disabled = true;
    if (idInput) idInput.disabled = true;
    if (submitBtnLabel) submitBtnLabel.textContent = 'Creating...';
    showFeedback('info', `Creating project "${name}"...`);

    try {
      const created = await engineClient.createProject(payload);
      loadedProjects = engineClient.getKnownProjects();
      renderHeroContent();
      showFeedback('success', `Project "${created.name}" created. Opening overview...`);
      router.navigateToProject(created.id, 'overview');
    } catch (err) {
      showFeedback('error', (err as Error).message || 'Failed to create project.');
    } finally {
      isSubmitting = false;
      if (submitBtn) submitBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      if (nameInput) nameInput.disabled = false;
      if (idInput) idInput.disabled = false;
      if (submitBtnLabel) submitBtnLabel.textContent = 'Create Project';
    }
  };

  submitBtn?.addEventListener('click', () => {
    void handleCreateSubmit();
  });

  const handleEnterKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleCreateSubmit();
    }
  };
  nameInput?.addEventListener('keydown', handleEnterKey);
  idInput?.addEventListener('keydown', handleEnterKey);

  const tabs = toolbar.querySelectorAll('.projects-tab');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((el) => el.classList.remove('active'));
      t.classList.add('active');
      activeTab = t.getAttribute('data-tab') === 'recent' ? 'recent' : 'all';
      renderHeroContent();
    });
  });

  const viewBtns = toolbar.querySelectorAll('.view-mode-btn');
  viewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      viewBtns.forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      viewMode = btn.getAttribute('data-view') === 'list' ? 'list' : 'grid';
      renderHeroContent();
    });
  });

  return wrapper;
}

function formatDuration(durationMs: number): string {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatDateLabel(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderInlineStatusBadgeHtml(status: TrustStatus): string {
  const el = renderStatusBadge({ status });
  return `<span class="${el.className}">${el.innerHTML}</span>`;
}

/**
 * 2. PROJECT OVERVIEW SCREEN (Exact match to PDF Page 2)
 */
function renderOverviewScreen(route: RouteMatch): HTMLElement {
  const projectId = route.projectId || '';
  const safeId = escapeHtml(projectId);
  const encodedId = encodeURIComponent(projectId);
  const projectTitle = escapeHtml(formatProjectTitle(projectId));

  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';

  wrapper.innerHTML = `
    <nav class="app-breadcrumbs">
      <a href="#/projects" id="overview-back-projects">Projects</a>
      <span class="separator">/</span>
      <span class="current" id="overview-crumb-name">${projectTitle}</span>
    </nav>

    <div class="page-header">
      <div class="page-header-titles">
        <h1 class="page-title" id="overview-title">${projectTitle}</h1>
        <p class="page-subtitle">Evidence-backed project workspace · CODE › VERIFICATION EVIDENCE › PROJECT BRAIN › AGENT CLAIMS</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn btn-primary btn-lg" id="overview-new-task-btn">
          <span>+ New Task</span>
        </button>
      </div>
    </div>

    <div id="overview-metadata-strip" style="display: flex; align-items: center; gap: 48px; padding-bottom: 14px; border-bottom: 1px dotted var(--border-strong); font-size: 12.5px; flex-wrap: wrap;">
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Identifier</div>
        <div style="font-family: var(--font-mono); font-weight: 500; margin-top: 2px;" id="overview-meta-id">${safeId}</div>
      </div>
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Created</div>
        <div style="font-weight: 500; margin-top: 2px;" id="overview-created-at">Loading...</div>
      </div>
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Recorded Brain Facts</div>
        <div style="font-weight: 500; margin-top: 2px;" id="overview-meta-facts">—</div>
      </div>
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Recorded Attempts</div>
        <div style="font-weight: 500; margin-top: 2px;" id="overview-meta-attempts">—</div>
      </div>
    </div>

    <div id="overview-repo-banner" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 10px; font-size: 12.5px; margin-top: 14px;">
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <span style="font-weight: 600; color: var(--text-primary);" id="overview-repo-status-label">Repository: Checking status...</span>
        <span id="overview-repo-branch-badge" style="font-family: var(--font-mono); font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--bg-subtle); border: 1px solid var(--border-default); display: none;"></span>
        <span id="overview-repo-clean-badge" style="font-size: 11px; display: none;"></span>
      </div>
      <div id="overview-repo-actions"></div>
    </div>

    <div id="overview-status-banner" style="display: none;"></div>

    <div id="overview-main-body" style="display: flex; flex-direction: column; gap: 26px;">
      <div class="hero-gradient-surface" style="min-height: auto; padding: 24px;">
        <div class="hero-dual-grid" style="width: 100%;">
          <div class="card" style="padding: 22px; display: flex; flex-direction: column; gap: 14px;">
            <div>
              <div style="font-size: 11px; color: var(--text-muted);" id="overview-attention-sub">Loading task & verification status...</div>
              <h3 style="font-size: 19px; font-weight: 600; margin-top: 2px;">Needs attention</h3>
            </div>
            <div id="overview-attention-list" style="display: flex; flex-direction: column; gap: 12px;">
              <div style="padding: 18px 0; color: var(--text-muted); font-size: 13px;">
                Loading recorded task attempts...
              </div>
            </div>
          </div>

          <div class="card" style="padding: 22px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px;">
            <div>
              <div style="font-size: 11px; color: var(--text-muted);" id="overview-latest-verif-sub">Independent verification runner</div>
              <div style="display: flex; align-items: center; gap: 10px; margin-top: 2px;">
                <h3 style="font-size: 19px; font-weight: 600;">Latest verification</h3>
                <span class="status-badge unverified" id="overview-latest-verif-badge">○ Unverified</span>
              </div>
            </div>
            <div id="overview-latest-checks" style="display: flex; flex-direction: column; gap: 10px; padding: 8px 0;">
              <div style="font-size: 12.5px; color: var(--text-muted);">
                Loading independent verification records...
              </div>
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 10px; border-top: 1px dotted var(--border-default); font-size: 12px;">
              <span style="font-family: var(--font-mono); color: var(--text-muted);" id="overview-latest-verif-footer">Configured checks status</span>
              <a href="#/projects/${encodedId}/verifications" data-nav-section="verifications" style="font-weight: 600; color: var(--text-primary);">All verifications →</a>
            </div>
          </div>
        </div>
      </div>

      <div class="overview-split-grid">
        <div style="display: flex; flex-direction: column; gap: 28px;">
          <div style="display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <h2 style="font-size: 19px; font-weight: 600;">Tasks</h2>
                <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">
                  Derived from persisted handoff and verification records (dedicated GET /projects/:id/tasks endpoint not exposed)
                </div>
              </div>
              <a href="#/projects/${encodedId}/tasks" data-nav-section="tasks" style="font-size: 12.5px; font-weight: 500; color: var(--text-secondary);">View all tasks →</a>
            </div>
            <div class="filter-pills-row" id="overview-task-filters" role="group" aria-label="Filter derived tasks by trust state"></div>
            <div class="card" style="padding: 18px 22px;" id="overview-tasks-list">
              <div style="font-size: 13px; color: var(--text-muted);">
                Loading derived task state...
              </div>
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <h2 style="font-size: 19px; font-weight: 600;">Recent handoffs & evidence</h2>
              <div style="display: flex; gap: 14px; font-size: 12.5px; font-weight: 600;">
                <a href="#/projects/${encodedId}/handoffs" data-nav-section="handoffs">Handoffs</a>
                <a href="#/projects/${encodedId}/verifications" data-nav-section="verifications" style="color: var(--text-muted);">Verifications</a>
              </div>
            </div>
            <div class="card" style="padding: 18px 22px;" id="overview-handoffs-list">
              <div style="font-size: 13px; color: var(--text-muted);">Loading project handoffs...</div>
            </div>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div class="card" style="padding: 22px; display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <h3 style="font-size: 17px; font-weight: 600;">Project facts</h3>
              <a href="#/projects/${encodedId}/brain" data-nav-section="brain" style="font-size: 12px; font-weight: 500; color: var(--text-secondary);">Open Brain</a>
            </div>
            <div id="overview-facts-list" style="display: flex; flex-direction: column; gap: 12px;">
              <div style="font-size: 13px; color: var(--text-muted);">Loading project facts...</div>
            </div>
          </div>

          <a href="#/projects/${encodedId}/brain" data-nav-section="brain" class="card" style="padding: 18px 22px; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <div style="font-weight: 600; font-size: 14px;">Project Brain</div>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;" id="overview-brain-card-sub">Facts, decisions, attempt history</div>
            </div>
            <span>→</span>
          </a>

          <a href="#/projects/${encodedId}/context" data-nav-section="context" class="card" style="padding: 18px 22px; display: flex; align-items: center; justify-content: space-between;">
            <div>
              <div style="font-weight: 600; font-size: 14px;">Compiled context</div>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">What the next agent receives</div>
            </div>
            <span>→</span>
          </a>
        </div>
      </div>
    </div>
  `;

  // Wire section navigation links so they preserve active projectId via router
  wrapper.querySelectorAll('[data-nav-section]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const section = el.getAttribute('data-nav-section') as
        | 'tasks'
        | 'handoffs'
        | 'verifications'
        | 'brain'
        | 'context';
      if (section && projectId) {
        router.navigateToProject(projectId, section);
      }
    });
  });

  wrapper.querySelector('#overview-back-projects')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigate('#/projects');
  });

  let currentModel: ProjectOverviewModel | null = null;
  let activeTaskFilter: string = 'ALL';

  const renderTasksList = () => {
    const tasksListEl = wrapper.querySelector('#overview-tasks-list');
    const filtersRow = wrapper.querySelector('#overview-task-filters');
    if (!tasksListEl || !currentModel) return;

    const { derivedTasks, taskCounts } = currentModel;

    if (!currentModel.taskDerivationComplete) {
      if (filtersRow) {
        filtersRow.innerHTML = `<span class="status-badge claimed">Task counts unavailable (partial data)</span>`;
      }
      tasksListEl.innerHTML = `
        <div style="font-size: 13px; color: var(--status-claimed-text); line-height: 1.5;">
          Task trust states cannot be derived while handoffs or verification records are unavailable. Retry loading above to evaluate recorded attempts.
        </div>
      `;
      return;
    }

    if (filtersRow) {
      const labels: Array<{ key: string; text: string }> = [
        { key: 'ALL', text: `All ${taskCounts.all}` },
        { key: 'VERIFIED', text: `Verified ${taskCounts.verified}` },
        { key: 'FAILED', text: `Failed ${taskCounts.failed}` },
        { key: 'BLOCKED_NEEDS_HUMAN', text: `Blocked ${taskCounts.blocked}` },
        { key: 'CLAIMED', text: `Claimed ${taskCounts.claimed}` },
        { key: 'UNVERIFIED', text: `Unverified ${taskCounts.unverified}` },
      ];
      filtersRow.innerHTML = labels
        .map(
          (l) =>
            `<button type="button" class="filter-pill ${activeTaskFilter === l.key ? 'active' : ''}" data-filter="${l.key}">${escapeHtml(l.text)}</button>`
        )
        .join('');

      filtersRow.querySelectorAll('.filter-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeTaskFilter = btn.getAttribute('data-filter') || 'ALL';
          renderTasksList();
        });
      });
    }

    if (derivedTasks.length === 0) {
      tasksListEl.innerHTML = `
        <div style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
          No task attempts have been recorded for project <code>${safeId}</code> yet. Once an agent records a handoff or VerificationEngine evaluates a check, derived task states appear here.
        </div>
      `;
      return;
    }

    const filtered =
      activeTaskFilter === 'ALL'
        ? derivedTasks
        : derivedTasks.filter((t) => t.trustState === activeTaskFilter);

    if (filtered.length === 0) {
      tasksListEl.innerHTML = `
        <div style="font-size: 13px; color: var(--text-muted);">
          No derived tasks match filter <strong>${escapeHtml(activeTaskFilter)}</strong>.
        </div>
      `;
      return;
    }

    tasksListEl.innerHTML = filtered
      .map(
        (t, idx) => `
        <div class="overview-derived-task-row" data-task-id="${escapeHtml(t.taskId)}" style="display: grid; grid-template-columns: 1.6fr 1fr 0.8fr 0.8fr; align-items: center; gap: 12px; padding: 12px 0; ${idx < filtered.length - 1 ? 'border-bottom: 1px solid var(--border-subtle);' : ''} cursor: pointer;">
          <div>
            <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">${escapeHtml(t.taskId)}</div>
            <div class="line-clamp-2" style="font-size: 12px; color: var(--text-muted); margin-top: 2px; line-height: 1.45;" title="${escapeHtml(stripMarkdownFormatting(t.summary))}">${escapeHtml(formatSummaryPreview(t.summary, 120))}</div>
          </div>
          <div>${renderInlineStatusBadgeHtml(t.trustState)}</div>
          <div style="font-size: 12px; color: var(--text-secondary);">Attempt ${Number(t.highestAttempt)}</div>
          <div style="font-size: 12px; color: var(--text-muted); text-align: right;">${escapeHtml(formatDateLabel(t.updatedAt))}</div>
        </div>
      `
      )
      .join('');

    tasksListEl.querySelectorAll('.overview-derived-task-row').forEach((row) => {
      row.addEventListener('click', () => {
        const tid = row.getAttribute('data-task-id') || undefined;
        router.navigateToProject(projectId, 'tasks', tid);
      });
    });
  };

  const renderOverviewModel = (model: ProjectOverviewModel) => {
    currentModel = model;
    const {
      project,
      currentFacts,
      decisions,
      attentionItems,
      latestVerification,
      recentHandoffs,
    } = model;

    // 1. Header & Metadata Strip
    const titleEl = wrapper.querySelector('#overview-title');
    const crumbEl = wrapper.querySelector('#overview-crumb-name');
    const createdEl = wrapper.querySelector('#overview-created-at');
    const metaFactsEl = wrapper.querySelector('#overview-meta-facts');
    const metaAttemptsEl = wrapper.querySelector('#overview-meta-attempts');

    if (titleEl) titleEl.textContent = project.name;
    if (crumbEl) crumbEl.textContent = project.name;
    if (createdEl) createdEl.textContent = formatDateLabel(project.createdAt);
    if (metaFactsEl) metaFactsEl.textContent = `${currentFacts.length} facts`;
    if (metaAttemptsEl) {
      const handoffCountLabel = model.handoffsAvailable
        ? `${recentHandoffs.length} handoffs`
        : 'handoffs unavailable';
      const verifCountLabel = !model.verificationsAvailable
        ? 'verifications unavailable'
        : latestVerification
          ? 'verified checks recorded'
          : '0 verifications';
      metaAttemptsEl.textContent = `${handoffCountLabel} · ${verifCountLabel}`;
    }

    // 2. Needs Attention Card
    const attentionSubEl = wrapper.querySelector('#overview-attention-sub');
    const attentionListEl = wrapper.querySelector('#overview-attention-list');
    if (attentionSubEl) {
      if (!model.taskDerivationComplete) {
        attentionSubEl.textContent =
          'Task derivation paused · handoffs or verifications could not be loaded';
      } else {
        attentionSubEl.textContent =
          attentionItems.length === 0
            ? '0 items need you · derived from recorded attempts'
            : `${attentionItems.length} ${attentionItems.length === 1 ? 'item needs' : 'items need'} you · derived from recorded attempts`;
      }
    }
    if (attentionListEl) {
      if (!model.taskDerivationComplete) {
        attentionListEl.innerHTML = `
          <div style="padding: 16px 0; color: var(--status-claimed-text); font-size: 13px;">
            Attention items require both handoffs and verification records to avoid misreporting task trust states.
          </div>
        `;
      } else if (attentionItems.length === 0) {
        if (model.derivedTasks.length === 0) {
          attentionListEl.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 10px; padding: 6px 0;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">First-Run Onboarding</div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 12.5px;">
                <span style="color: var(--status-verified-text); font-weight: 700;">✓</span>
                <span>1. Connect Repository &amp; Configure Model Provider</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 12.5px;">
                <span style="color: var(--brand-blue); font-weight: 700;">→</span>
                <span><a href="#/projects/${encodedId}/tasks?action=new" id="onboarding-create-first-task-btn" style="font-weight: 600; color: var(--brand-blue);">2. Create your first task →</a></span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-muted);">
                <span>○</span>
                <span>3. Run agent in workspace &amp; inspect verified diff</span>
              </div>
            </div>
          `;
          attentionListEl.querySelector('#onboarding-create-first-task-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            router.navigate(`#/projects/${encodedId}/tasks?action=new`);
          });
        } else {
          attentionListEl.innerHTML = `
            <div style="padding: 16px 0; color: var(--text-muted); font-size: 13px;">
              All recorded task attempts passed their configured verification checks.
            </div>
          `;
        }
      } else {
        attentionListEl.innerHTML = attentionItems
          .map(
            (item, idx) => `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; ${idx < attentionItems.length - 1 ? 'border-bottom: 1px solid var(--border-subtle);' : ''}">
              <div style="display: flex; align-items: flex-start; gap: 12px;">
                <div style="margin-top: 2px;">${renderInlineStatusBadgeHtml(item.trustState)}</div>
                <div>
                  <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">${escapeHtml(item.taskId)}</div>
                  <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(item.reason)} · ${escapeHtml(formatDateLabel(item.timestamp))}</div>
                </div>
              </div>
              <a href="#/projects/${encodedId}/${item.targetSection}" class="overview-attention-action" data-target="${item.targetSection}" style="font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap;">
                ${escapeHtml(item.actionLabel)}
              </a>
            </div>
          `
          )
          .join('');

        attentionListEl.querySelectorAll('.overview-attention-action').forEach((link) => {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = link.getAttribute('data-target') as
              | 'tasks'
              | 'verifications'
              | 'handoffs';
            if (target) router.navigateToProject(projectId, target);
          });
        });
      }
    }

    // 3. Latest Verification Card (scoped strictly to latest verification record, never project-wide)
    const verifSubEl = wrapper.querySelector('#overview-latest-verif-sub');
    const verifBadgeEl = wrapper.querySelector('#overview-latest-verif-badge');
    const verifChecksEl = wrapper.querySelector('#overview-latest-checks');
    const verifFooterEl = wrapper.querySelector('#overview-latest-verif-footer');

    if (!model.verificationsAvailable) {
      if (verifSubEl) verifSubEl.textContent = 'Verification records failed to load';
      if (verifBadgeEl) {
        verifBadgeEl.className = 'status-badge claimed';
        verifBadgeEl.innerHTML = 'VERIFICATIONS UNAVAILABLE';
      }
      if (verifChecksEl) {
        verifChecksEl.innerHTML = `
          <div style="font-size: 12.5px; color: var(--status-claimed-text); padding: 8px 0;">
            Verification records are currently unavailable due to an API error. Orchestrate does not assume an empty verification history when the endpoint fails.
          </div>
        `;
      }
      if (verifFooterEl) {
        verifFooterEl.textContent = 'Verification status unavailable · retry above';
      }
    } else if (!latestVerification) {
      if (verifSubEl) verifSubEl.textContent = 'Independent verification runner';
      if (verifBadgeEl) {
        const b = renderStatusBadge({ status: 'UNVERIFIED' });
        verifBadgeEl.className = b.className;
        verifBadgeEl.innerHTML = b.innerHTML;
      }
      if (verifChecksEl) {
        verifChecksEl.innerHTML = `
          <div style="font-size: 12.5px; color: var(--text-muted); padding: 8px 0;">
            No verification records yet. Checks appear here once a task attempt is evaluated by VerificationEngine.
          </div>
        `;
      }
      if (verifFooterEl) {
        verifFooterEl.textContent = 'Configured checks not yet executed';
      }
    } else {
      if (verifSubEl) {
        verifSubEl.textContent = `${latestVerification.taskId} · attempt ${Number(latestVerification.attemptNumber)}`;
      }
      if (verifBadgeEl) {
        const b = renderStatusBadge({ status: latestVerification.result.status });
        verifBadgeEl.className = b.className;
        verifBadgeEl.innerHTML = b.innerHTML;
      }
      if (verifChecksEl) {
        if (latestVerification.result.checks.length === 0) {
          verifChecksEl.innerHTML = `
            <div style="font-size: 12.5px; color: var(--text-muted);">
              No individual check entries recorded in this verification payload.
            </div>
          `;
        } else {
          verifChecksEl.innerHTML = latestVerification.result.checks
            .map((c, idx) => {
              const cmdText =
                Array.isArray(c.args) && c.args.length > 0
                  ? `${c.command} ${c.args.join(' ')}`
                  : c.command;
              const icon = c.passed ? '✓' : '✕';
              const iconColor = c.passed
                ? 'var(--status-verified-text)'
                : 'var(--status-failed-text)';
              return `
                <div style="display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; padding: 7px 0; ${idx < latestVerification.result.checks.length - 1 ? 'border-bottom: 1px solid var(--border-subtle);' : ''}">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="color: ${iconColor}; font-weight: 700;">${icon}</span>
                    <strong>${escapeHtml(c.name)}</strong>
                    <code style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);">${escapeHtml(cmdText)}</code>
                  </div>
                  <span style="font-family: var(--font-mono); font-size: 11.5px; color: ${iconColor};">
                    ${c.passed ? 'passed' : 'failed'} · ${escapeHtml(formatDuration(c.durationMs))}
                  </span>
                </div>
              `;
            })
            .join('');
        }
      }
      if (verifFooterEl) {
        verifFooterEl.textContent = `Configured checks only · ${formatDateLabel(latestVerification.recordedAt || latestVerification.result.executedAt)}`;
      }
    }

    // 4. Tasks Section (with filter pills)
    renderTasksList();

    // 5. Recent Handoffs & Evidence Section
    const handoffsEl = wrapper.querySelector('#overview-handoffs-list');
    if (handoffsEl) {
      if (!model.handoffsAvailable) {
        handoffsEl.innerHTML = `
          <div style="font-size: 13px; color: var(--status-claimed-text);">
            Handoff records failed to load from the Engine API. Orchestrate does not assume an empty handoff history when the endpoint is unavailable.
          </div>
        `;
      } else if (recentHandoffs.length === 0) {
        handoffsEl.innerHTML = `
          <div style="font-size: 13px; color: var(--text-muted);">
            No handoffs recorded yet for project <code>${safeId}</code>. Agent claims and their verification status appear here after task execution.
          </div>
        `;
      } else {
        handoffsEl.innerHTML = recentHandoffs
          .map(({ handoff: h, outcomeStatus, verificationUnknown }, idx) => {
            const filesCount = Array.isArray(h.filesAffected) ? h.filesAffected.length : 0;
            return `
              <div class="overview-handoff-row" style="display: grid; grid-template-columns: 1.8fr 0.6fr 0.8fr 0.8fr; align-items: center; gap: 12px; padding: 12px 0; ${idx < recentHandoffs.length - 1 ? 'border-bottom: 1px solid var(--border-subtle);' : ''} cursor: pointer;">
                <div>
                  <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">${escapeHtml(h.taskId)} · attempt ${Number(h.attemptNumber)}</div>
                  <div class="line-clamp-2" style="font-size: 12.5px; color: var(--text-muted); margin-top: 2px; line-height: 1.45;" title="${escapeHtml(stripMarkdownFormatting(h.summary))}">${escapeHtml(formatSummaryPreview(h.summary, 140))}</div>
                </div>
                <div style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);">
                  ${filesCount} ${filesCount === 1 ? 'file' : 'files'}
                </div>
                <div>
                  ${renderInlineStatusBadgeHtml(outcomeStatus)}
                  ${verificationUnknown ? '<div style="font-size: 10.5px; color: var(--text-muted); margin-top: 2px;">verification status unavailable</div>' : ''}
                </div>
                <div style="font-size: 12px; color: var(--text-muted); text-align: right;">${escapeHtml(formatDateLabel(h.createdAt))}</div>
              </div>
            `;
          })
          .join('');

        handoffsEl.querySelectorAll('.overview-handoff-row').forEach((row) => {
          row.addEventListener('click', () => {
            router.navigateToProject(projectId, 'handoffs');
          });
        });
      }
    }

    // 6. Project Brain Summary (Project Facts + Handoff Decisions)
    const factsEl = wrapper.querySelector('#overview-facts-list');
    const brainSubEl = wrapper.querySelector('#overview-brain-card-sub');
    if (brainSubEl) {
      brainSubEl.textContent = model.handoffsAvailable
        ? `${currentFacts.length} facts · ${decisions.length} decisions · ${recentHandoffs.length} handoffs`
        : `${currentFacts.length} facts · decisions & handoffs unavailable`;
    }
    if (factsEl) {
      if (currentFacts.length === 0 && decisions.length === 0) {
        factsEl.innerHTML = `
          <div style="font-size: 13px; color: var(--text-muted);">
            No project facts or decisions recorded in Project Brain yet.
          </div>
        `;
      } else {
        const factRows = currentFacts.map((f) => {
          const showTrustBadge = f.status === 'CLAIMED' || f.status === 'UNVERIFIED';
          const trustBadgeHtml = showTrustBadge
            ? renderInlineStatusBadgeHtml(f.status as TrustStatus)
            : '';
          return `
            <div class="overview-fact-row" data-fact-key="${escapeHtml(f.key)}" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); cursor: pointer;">
              <div style="min-width: 0; flex: 1;">
                <div style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(f.key)}</div>
                <div style="margin-top: 2px; max-width: 380px;">${renderCompactFactValueHtml(f.key, f.value)}</div>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); padding: 2px 6px; border: 1px solid var(--border-default); border-radius: 6px;">${escapeHtml(f.provenance)}</span>
                ${trustBadgeHtml}
              </div>
            </div>
          `;
        });

        const decisionRows = decisions.map(
          (d) => `
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle);">
              <div>
                <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">${escapeHtml(d.statement)}</div>
                <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">From ${escapeHtml(d.taskId)} · attempt ${Number(d.attemptNumber)}</div>
              </div>
              <span style="font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">${d.status === 'ACTIVE' ? 'Active decision' : escapeHtml(d.status)}</span>
            </div>
          `
        );

        factsEl.innerHTML = [...factRows, ...decisionRows].join('');
        factsEl.querySelectorAll('.overview-fact-row').forEach((row) => {
          row.addEventListener('click', () => {
            const key = row.getAttribute('data-fact-key');
            if (key) {
              router.navigate(
                `#/projects/${encodeURIComponent(projectId)}/brain?key=${encodeURIComponent(key)}`
              );
            } else {
              router.navigateToProject(projectId, 'brain');
            }
          });
        });
      }
    }
  };

  const loadOverview = async () => {
    const statusBanner = wrapper.querySelector('#overview-status-banner') as HTMLElement | null;
    const mainBody = wrapper.querySelector('#overview-main-body') as HTMLElement | null;
    if (statusBanner) {
      statusBanner.style.display = 'none';
      statusBanner.innerHTML = '';
    }
    if (mainBody) {
      mainBody.style.display = 'flex';
    }

    const [projRes, handoffsRes, verifsRes, tasksRes, repoRes] = await Promise.allSettled([
      engineClient.getProject(projectId),
      engineClient.getHandoffs(projectId),
      engineClient.getVerifications(projectId),
      engineClient.listTasks(projectId),
      engineClient.getRepositoryStatus(projectId),
    ]);

    // 1. Check if project was explicitly 404 Not Found
    if (projRes.status === 'fulfilled' && projRes.value === null) {
      if (mainBody) mainBody.style.display = 'none';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="overview-not-found" style="padding: 28px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;">
            <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);">Project not found</div>
            <p style="font-size: 13px; color: var(--text-muted); max-width: 420px;">
              Project <code>${safeId}</code> does not exist in the SQLite Project Brain.
            </p>
            <button type="button" class="btn btn-primary btn-md" id="overview-not-found-back-btn">
              ← Back to All Projects
            </button>
          </div>
        `;
        statusBanner
          .querySelector('#overview-not-found-back-btn')
          ?.addEventListener('click', () => {
            router.navigate('#/projects');
          });
      }
      return;
    }

    // 2. Check if project request failed and no fallback project data is available
    const cachedProject = engineClient.getKnownProjects().find((p) => p.id === projectId);
    const project: ProjectDto | null =
      projRes.status === 'fulfilled' ? projRes.value : (cachedProject ?? null);

    const errors: string[] = [];
    if (projRes.status === 'rejected') {
      errors.push((projRes.reason as Error)?.message || 'Failed to load project metadata.');
    }
    if (handoffsRes.status === 'rejected') {
      errors.push((handoffsRes.reason as Error)?.message || 'Failed to load project handoffs.');
    }
    if (verifsRes.status === 'rejected') {
      errors.push(
        (verifsRes.reason as Error)?.message || 'Failed to load project verifications.'
      );
    }

    if (!project) {
      if (mainBody) mainBody.style.display = 'none';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="overview-error-state" style="padding: 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-color: var(--status-failed-border);">
            <div>
              <div style="font-size: 16px; font-weight: 600; color: var(--status-failed-text);">Unable to load project overview</div>
              <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
                ${escapeHtml(errors[0] || 'Orchestrate Engine could not be reached.')}
              </p>
            </div>
            <button type="button" class="btn btn-primary btn-md" id="overview-retry-btn">
              <span>Retry</span>
              <span>↻</span>
            </button>
          </div>
        `;
        statusBanner.querySelector('#overview-retry-btn')?.addEventListener('click', () => {
          void loadOverview();
        });
      }
      return;
    }

    // 3. Partial-data banner if one of the secondary endpoints failed while project is available
    if (errors.length > 0 && statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div class="callout-banner" id="overview-partial-banner" style="justify-content: space-between; border-color: var(--status-claimed-border); background: var(--status-claimed-bg); color: var(--status-claimed-text);">
          <span><strong>Partial data loaded:</strong> ${escapeHtml(errors.join(' · '))}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="overview-partial-retry-btn">Retry ↻</button>
        </div>
      `;
      statusBanner.querySelector('#overview-partial-retry-btn')?.addEventListener('click', () => {
        void loadOverview();
      });
    }

    const handoffsAvailable = handoffsRes.status === 'fulfilled';
    const verificationsAvailable = verifsRes.status === 'fulfilled';
    const handoffs = handoffsAvailable ? handoffsRes.value : [];
    const verifications = verificationsAvailable ? verifsRes.value : [];

    if (repoRes.status === 'fulfilled') {
      const repo = repoRes.value;
      const labelEl = wrapper.querySelector('#overview-repo-status-label');
      const branchBadge = wrapper.querySelector('#overview-repo-branch-badge') as HTMLElement | null;
      const cleanBadge = wrapper.querySelector('#overview-repo-clean-badge') as HTMLElement | null;
      const actionsEl = wrapper.querySelector('#overview-repo-actions') as HTMLElement | null;

      if (labelEl) {
        if (repo.connected) {
          labelEl.textContent = `Repository: ${repo.path || repo.url || 'Connected'}`;
          if (branchBadge) {
            branchBadge.style.display = 'inline-block';
            branchBadge.textContent = `git: ${repo.branch || 'main'}`;
          }
          if (cleanBadge) {
            cleanBadge.style.display = 'inline-block';
            cleanBadge.style.color = repo.isClean ? 'var(--status-verified-text)' : 'var(--status-claimed-text)';
            cleanBadge.textContent = repo.isClean ? '✓ Clean' : '● Modified files';
          }
        } else {
          labelEl.textContent = 'No repository attached (Local files or GitHub clone)';
          if (actionsEl) {
            actionsEl.innerHTML = `<button type="button" class="btn btn-secondary btn-sm" id="overview-connect-repo-btn">Attach Repository</button>`;
            actionsEl.querySelector('#overview-connect-repo-btn')?.addEventListener('click', () => {
              const targetPath = prompt(
                'Enter path to local repository directory:',
                '.'
              );
              if (targetPath && targetPath.trim()) {
                void engineClient
                  .importRepository(projectId, { type: 'local', path: targetPath.trim() })
                  .then(() => {
                    void loadOverview();
                  })
                  .catch((err) => {
                    alert(`Failed to import repository: ${(err as Error).message}`);
                  });
              }
            });
          }
        }
      }
    }

    const tasks = tasksRes.status === 'fulfilled' ? tasksRes.value : [];
    const model = deriveProjectOverviewModel(project, handoffs, verifications, {
      handoffsAvailable,
      verificationsAvailable,
      tasks,
    });
    renderOverviewModel(model);
  };

  wrapper.querySelector('#overview-new-task-btn')?.addEventListener('click', () => {
    router.navigate(`#/projects/${encodedId}/tasks?action=new`);
  });

  void loadOverview();

  return wrapper;
}

export interface FactAdmissionItem {
  key: string;
  value: string;
  provenance: string;
  status: string;
  admitted: boolean;
  reason: string;
  isCurrent: boolean;
  revisionIndex?: number;
  totalRevisions?: number;
}

export interface FactAdmissionSummary {
  items: FactAdmissionItem[];
  admittedCount: number;
  excludedCount: number;
  totalCurrentFacts: number;
  supersededRevisionsCount: number;
}

/**
 * Pure derivation of fact admissions comparing persisted Project Brain facts
 * against facts actually admitted by ContextCompilerCore.
 */
export function deriveFactAdmissions(
  projectFacts: readonly ProjectFactDto[] | undefined | null,
  compiledFacts: readonly { key: string; value: string; provenance?: string; status?: string }[] | undefined | null,
  requestTags?: readonly string[],
  contextMetadata?: { truncatedFacts?: boolean; totalFactsCount?: number } | null
): FactAdmissionSummary {
  const brainItems = deriveProjectBrainFacts(projectFacts);
  const admittedList = Array.isArray(compiledFacts) ? compiledFacts : [];

  const normalizedRequestTags = (requestTags || [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const items: FactAdmissionItem[] = [];
  let admittedCount = 0;
  let excludedCount = 0;
  let supersededRevisionsCount = 0;

  for (const bItem of brainItems) {
    const isAdmitted = admittedList.some(
      (cf) =>
        cf.key.trim().toLowerCase() === bItem.key.toLowerCase() &&
        cf.value === bItem.current.value
    );

    let reason = '';
    if (isAdmitted) {
      admittedCount++;
      reason =
        bItem.compilerScope.scopeKind === 'GLOBAL'
          ? 'Admitted: current VERIFIED fact matching global prefix.'
          : bItem.compilerScope.scopeKind === 'TAG_SCOPED'
            ? `Admitted: current VERIFIED fact matching tag "${bItem.compilerScope.scopeTag ?? ''}".`
            : 'Admitted: current VERIFIED fact admitted into context.';
    } else {
      excludedCount++;
      if (bItem.current.status !== 'VERIFIED') {
        reason = `Excluded: fact status is "${bItem.current.status}" (ContextCompiler admits only VERIFIED facts).`;
      } else if (bItem.compilerScope.scopeKind === 'UNSCOPED') {
        reason = 'Excluded: key is unscoped (no "global." or "<tag>." prefix; ContextCompiler admits only global or tag-scoped facts).';
      } else if (bItem.compilerScope.scopeKind === 'TAG_SCOPED') {
        const factTag = (bItem.compilerScope.scopeTag ?? '').toLowerCase();
        const tagWasRequested = normalizedRequestTags.includes(factTag);
        if (!tagWasRequested) {
          reason =
            normalizedRequestTags.length > 0
              ? `Excluded: tag "${bItem.compilerScope.scopeTag ?? ''}" was not included in requested compilation tags.`
              : `Excluded: tag "${bItem.compilerScope.scopeTag ?? ''}" was not requested (no tags specified in compilation request).`;
        } else if (contextMetadata?.truncatedFacts) {
          reason = 'Excluded: context budget limit reached (compiler truncated facts).';
        } else {
          reason = 'Excluded: omitted from compiled context (reason unconfirmed by compiler metadata).';
        }
      } else if (bItem.compilerScope.scopeKind === 'GLOBAL') {
        if (contextMetadata?.truncatedFacts) {
          reason = 'Excluded: context budget limit reached (compiler truncated facts).';
        } else {
          reason = 'Excluded: omitted from compiled context (reason unconfirmed by compiler metadata).';
        }
      } else {
        reason = 'Excluded: omitted from compiled context (reason unconfirmed by compiler metadata).';
      }
    }

    items.push({
      key: bItem.key,
      value: bItem.current.value,
      provenance: bItem.current.provenance,
      status: bItem.current.status,
      admitted: isAdmitted,
      reason,
      isCurrent: true,
      revisionIndex: bItem.revisionCount,
      totalRevisions: bItem.revisionCount,
    });

    // Record older superseded revisions as excluded by definition
    for (const rev of bItem.history) {
      if (!rev.isCurrent) {
        supersededRevisionsCount++;
        items.push({
          key: rev.fact.key,
          value: rev.fact.value,
          provenance: rev.fact.provenance,
          status: rev.fact.status,
          admitted: false,
          reason: `Excluded: superseded revision (Rev #${rev.revisionIndex}); only the latest revision per fact key is eligible for compilation.`,
          isCurrent: false,
          revisionIndex: rev.revisionIndex,
          totalRevisions: bItem.revisionCount,
        });
      }
    }
  }

  return {
    items,
    admittedCount,
    excludedCount,
    totalCurrentFacts: brainItems.length,
    supersededRevisionsCount,
  };
}

/**
 * Pure HTML builder for Structured Context Tree view.
 */
export function buildCompiledContextTreeHtml(
  context: Record<string, unknown> | null | undefined
): string {
  if (!context || typeof context !== 'object') {
    return `
      <div style="text-align: center; padding: 24px 0 8px 0;">
        <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Nothing compiled yet</div>
        <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">Choose a target task and compile to see<br/>the context the engine returns.</div>
      </div>
    `;
  }

  const meta = (context.metadata ?? {}) as Record<string, unknown>;
  const facts = Array.isArray(context.facts) ? (context.facts as Array<Record<string, unknown>>) : [];
  const decisions = Array.isArray(context.decisions)
    ? (context.decisions as Array<Record<string, unknown>>)
    : [];
  const upstream = context.upstreamWork as Record<string, unknown> | undefined;
  const git = context.gitState as Record<string, unknown> | undefined;

  const factsHtml =
    facts.length > 0
      ? facts
          .map(
            (f) => `
            <div style="padding: 8px 10px; border-radius: 6px; background: var(--bg-surface); border: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center; gap: 8px;">
              <div>
                <span style="font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--text-primary);">${escapeHtml(String(f.key ?? ''))}</span>:
                <span style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(String(f.value ?? ''))}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--border-default);">${escapeHtml(String(f.provenance ?? ''))}</span>
                <span class="status-badge verified" style="font-size: 10px; padding: 1px 6px;">${escapeHtml(String(f.status ?? ''))}</span>
              </div>
            </div>
          `
          )
          .join('')
      : '<div style="font-size: 12px; color: var(--text-muted);">No facts admitted into compiled context.</div>';

  const decisionsHtml =
    decisions.length > 0
      ? decisions
          .map(
            (d) => `
            <div style="padding: 8px 10px; border-radius: 6px; background: var(--bg-surface); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                <span style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${escapeHtml(String(d.statement ?? ''))}</span>
                <span style="font-family: var(--font-mono); font-size: 10px; color: var(--text-muted);">${escapeHtml(String(d.status ?? 'ACTIVE'))}</span>
              </div>
              <div style="font-size: 11.5px; color: var(--text-secondary);">${escapeHtml(String(d.rationale ?? ''))}</div>
            </div>
          `
          )
          .join('')
      : '<div style="font-size: 12px; color: var(--text-muted);">No active decisions included.</div>';

  let upstreamHtml = '<div style="font-size: 12px; color: var(--text-muted);">No upstream task specified.</div>';
  if (upstream) {
    const checks = Array.isArray(upstream.verificationChecks)
      ? (upstream.verificationChecks as Array<Record<string, unknown>>)
      : [];
    const notes = upstream.unverifiedAgentNotes as Record<string, unknown> | undefined;

    const checksHtml =
      checks.length > 0
        ? checks
            .map(
              (c) => `
              <div style="font-family: var(--font-mono); font-size: 11px; padding: 4px 6px; border-radius: 4px; background: var(--bg-canvas); display: flex; justify-content: space-between; align-items: center;">
                <span>${escapeHtml(String(c.name ?? ''))} (<code>${escapeHtml(String(c.command ?? ''))}</code>)</span>
                <span style="color: ${c.passed ? 'var(--status-verified-text)' : 'var(--status-failed-text)'}; font-weight: 600;">${c.passed ? 'PASSED' : 'FAILED'}</span>
              </div>
            `
            )
            .join('')
        : '<div style="font-size: 11px; color: var(--text-muted);">No independent verification checks recorded.</div>';

    upstreamHtml = `
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-family: var(--font-mono); font-size: 12px; font-weight: 600;">Task: ${escapeHtml(String(upstream.taskId ?? ''))} (attempt #${String(upstream.attemptNumber ?? 1)})</span>
          <span class="status-badge ${upstream.trustState === 'VERIFIED' ? 'verified' : 'claimed'}" style="font-size: 10.5px;">${escapeHtml(String(upstream.trustState ?? 'UNVERIFIED'))}</span>
        </div>
        <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-top: 2px;">Independent Verification Evidence:</div>
        <div style="display: flex; flex-direction: column; gap: 4px;">${checksHtml}</div>
        ${
          notes
            ? `
            <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin-top: 6px;">Quarantined Agent Claims (Level 4):</div>
            <div style="padding: 6px 8px; border-radius: 4px; background: var(--status-claimed-bg); border: 1px solid var(--status-claimed-border); font-size: 11.5px; color: var(--status-claimed-text);">
              ${escapeHtml(String(notes.summary ?? ''))}
            </div>
          `
            : ''
        }
      </div>
    `;
  }

  return `
    <div style="display: flex; flex-direction: column; gap: 14px; font-size: 12px;">
      <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 10px; border-radius: 8px; background: var(--bg-surface); border: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: 11px;">
        <div>Target Task: <strong>${escapeHtml(String(meta.targetTaskId ?? ''))}</strong></div>
        <div>Upstream Task: <strong>${escapeHtml(String(meta.upstreamTaskId ?? 'None'))}</strong></div>
        <div>Admitted Facts: <strong>${facts.length}</strong></div>
        <div>Decisions: <strong>${decisions.length}</strong></div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          Admitted Facts (${facts.length})
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">${factsHtml}</div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          Architectural Decisions (${decisions.length})
        </div>
        <div style="display: flex; flex-direction: column; gap: 6px;">${decisionsHtml}</div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          Upstream Work &amp; Verification Evidence
        </div>
        ${upstreamHtml}
      </div>

      ${
        git
          ? `
          <div style="display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 6px; background: var(--bg-surface); border: 1px solid var(--border-subtle); font-family: var(--font-mono); font-size: 11px;">
            <div style="font-weight: 600; color: var(--text-muted); text-transform: uppercase;">Git Repository State:</div>
            <div>Branch: ${escapeHtml(String(git.branch ?? 'unknown'))}</div>
            ${git.headCommit ? `<div>Commit: ${escapeHtml(String((git.headCommit as Record<string, unknown>).hash ?? '')).slice(0, 7)} — ${escapeHtml(String((git.headCommit as Record<string, unknown>).subject ?? ''))}</div>` : ''}
          </div>
        `
          : ''
      }
    </div>
  `;
}

/**
 * Pure HTML builder for Serialized Envelope Wrapped view.
 */
export function buildSerializedEnvelopeWrappedHtml(
  serializedXml: string | null | undefined
): string {
  if (!serializedXml) {
    return `
      <div style="text-align: center; padding: 24px 0 8px 0;">
        <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Nothing compiled yet</div>
        <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">Choose a target task and compile to see<br/>the context the engine returns.</div>
      </div>
    `;
  }

  return `
    <pre style="font-family: var(--font-mono); font-size: 11.5px; line-height: 1.5; color: var(--text-primary); margin: 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word;">${escapeHtml(serializedXml)}</pre>
  `;
}

/**
 * Pure HTML builder for Fact Admission Breakdown section.
 */
export function buildFactAdmissionViewHtml(
  admissions: FactAdmissionSummary,
  hasCompiled: boolean
): string {
  if (!hasCompiled) {
    return `
      <div class="card" style="padding: 20px 24px; margin-top: 18px;">
        <h3 class="card-title" style="margin-bottom: 6px;">Fact Admission Breakdown</h3>
        <p style="font-size: 12.5px; color: var(--text-muted); margin: 0;">
          Compile context for a target task to inspect which Project Brain facts are admitted or excluded and their governing rules.
        </p>
      </div>
    `;
  }

  const itemsHtml =
    admissions.items.length > 0
      ? admissions.items
          .map((item) => {
            const statusBadgeClass = item.admitted ? 'verified' : 'claimed';
            const statusLabel = item.admitted ? '✓ ADMITTED' : '✕ EXCLUDED';
            return `
              <div class="ctx-fact-admission-row" style="padding: 10px 14px; border-radius: 8px; background: ${item.admitted ? 'var(--bg-surface)' : 'var(--bg-subtle)'}; border: 1px solid ${item.admitted ? 'var(--status-verified-border)' : 'var(--border-default)'}; display: flex; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap;">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <span class="status-badge ${statusBadgeClass}" style="font-size: 10.5px; font-weight: 700;">${statusLabel}</span>
                    <strong style="font-family: var(--font-mono); font-size: 12px; color: var(--text-primary);">${escapeHtml(item.key)}</strong>
                    <span style="font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border-default);">status: ${escapeHtml(item.status)}</span>
                    <span style="font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border-default);">provenance: ${escapeHtml(item.provenance)}</span>
                    ${!item.isCurrent ? `<span style="font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); background: var(--bg-canvas); padding: 1px 5px; border-radius: 4px;">Rev #${item.revisionIndex} (superseded)</span>` : ''}
                  </div>
                  <span style="font-size: 11.5px; color: ${item.admitted ? 'var(--status-verified-text)' : 'var(--text-muted)'}; font-weight: 500;">
                    ${escapeHtml(item.reason)}
                  </span>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); word-break: break-word;">
                  Value: <code>${escapeHtml(item.value)}</code>
                </div>
              </div>
            `;
          })
          .join('')
      : '<div style="font-size: 12.5px; color: var(--text-muted);">No facts recorded in Project Brain for this project.</div>';

  return `
    <div class="card" style="padding: 20px 24px; margin-top: 18px; display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
        <div>
          <h3 class="card-title" style="margin: 0;">Fact Admission Breakdown</h3>
          <p class="card-subtitle" style="margin-top: 2px;">
            Admission status of Project Brain facts into this target task's compiled context.
          </p>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="badge-count" style="font-family: var(--font-mono); font-size: 11.5px; background: var(--status-verified-bg); color: var(--status-verified-text); border: 1px solid var(--status-verified-border);">
            ${admissions.admittedCount} Admitted
          </span>
          <span class="badge-count" style="font-family: var(--font-mono); font-size: 11.5px; background: var(--bg-subtle); color: var(--text-muted); border: 1px solid var(--border-default);">
            ${admissions.excludedCount} Excluded
          </span>
        </div>
      </div>

      <div class="callout-banner" style="border-color: var(--status-verified-border); background: var(--status-verified-bg); color: var(--status-verified-text); font-size: 12px;">
        <span>
          <strong>Source-of-Truth Notice:</strong>
          Admitted <code>VERIFIED</code> facts reflect persisted Brain records and passing verification checks. They are not proof that the underlying implementation is universally or formally correct.
        </span>
      </div>

      <div id="ctx-fact-admission-list" style="display: flex; flex-direction: column; gap: 8px;">
        ${itemsHtml}
      </div>
    </div>
  `;
}

/**
 * 3. COMPILED CONTEXT SCREEN (Exact match to PDF Page 3 + Step 7 requirements)
 */
export function renderContextScreen(route: RouteMatch): HTMLElement {
  const projectId = route.projectId || '';
  const encodedId = encodeURIComponent(projectId);
  const projectTitle = escapeHtml(formatProjectTitle(projectId));

  const initialTargetTaskId = (
    route.params?.targetTaskId ||
    route.params?.taskId ||
    route.subpath ||
    ''
  ).trim();
  const initialUpstreamTaskId = (route.params?.upstreamTaskId || '').trim();
  const initialTagsRaw = (route.params?.tags || '').trim();
  const requestTags = initialTagsRaw
    ? initialTagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';

  wrapper.innerHTML = `
    <nav class="app-breadcrumbs" aria-label="Breadcrumb">
      <a href="#/projects">Projects</a>
      <span class="separator">&gt;</span>
      <a href="#/projects/${encodedId}/overview" id="ctx-crumb-project">${projectTitle}</a>
      <span class="separator">&gt;</span>
      <span class="current">Compiled context</span>
      <span id="ctx-back-task-container">
        ${
          initialTargetTaskId
            ? `<span class="separator">·</span><a href="#/projects/${encodedId}/tasks/${encodeURIComponent(initialTargetTaskId)}" id="ctx-back-to-task-link">← Back to Task #${escapeHtml(initialTargetTaskId)}</a>`
            : ''
        }
      </span>
    </nav>

    <div class="page-header">
      <div class="page-header-titles">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <h1 class="page-title">Compiled context</h1>
          <span class="badge-count" id="ctx-project-badge" style="font-family: var(--font-mono); font-size: 11.5px;">${escapeHtml(projectId)}</span>
        </div>
        <p class="page-subtitle">Inspect the evidence-backed context before it is passed to another agent.</p>
      </div>
      <div class="page-header-actions">
        <a href="#/projects/${encodedId}/brain" class="btn btn-secondary btn-sm" style="text-decoration: none;">Project Brain →</a>
        <a href="#/projects/${encodedId}/tasks" class="btn btn-secondary btn-sm" style="text-decoration: none;">Tasks →</a>
      </div>
    </div>

    <div class="card" style="padding: 20px 24px;">
      <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 18px; align-items: center;" class="ctx-form-grid">
        <div class="form-field">
          <label class="form-label" for="ctx-target-input">Target task</label>
          <input
            type="text"
            id="ctx-target-input"
            class="input"
            placeholder="Task ID"
            value="${escapeHtml(initialTargetTaskId)}"
            aria-required="true"
            aria-label="Target task ID"
          />
          <span class="form-helper">The task the next agent will work on.</span>
        </div>
        <div class="form-field">
          <label class="form-label" for="ctx-upstream-input">Upstream task (when required)</label>
          <input
            type="text"
            id="ctx-upstream-input"
            class="input"
            placeholder="Upstream task ID"
            value="${escapeHtml(initialUpstreamTaskId)}"
            aria-label="Upstream task ID"
          />
          <span class="form-helper">Completed work this task builds on.</span>
        </div>
        <div style="padding-top: 4px;">
          <button type="button" class="btn btn-primary btn-lg" id="compile-ctx-btn" style="min-width: 160px; justify-content: center;">
            <span>Compile context</span>
            <span>→</span>
          </button>
        </div>
      </div>
      <div id="ctx-error-banner" style="display: none; margin-top: 14px; padding: 10px 14px; border-radius: 8px; background: var(--status-failed-bg); border: 1px solid var(--status-failed-border); color: var(--status-failed-text); font-size: 12.5px;"></div>
    </div>

    <div class="hero-dual-grid" style="grid-template-columns: 1fr 1fr; margin-top: 18px;">
      <div class="card" style="padding: 22px; display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
          <div>
            <h3 class="card-title" style="margin: 0;">Structured context</h3>
            <p class="card-subtitle" style="margin-top: 2px;">JSON as returned by the engine</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="copy-json-btn" disabled>Copy</button>
        </div>
        <div class="projects-tabs" id="ctx-json-tabs" style="border-bottom: 1px solid var(--border-default); padding-bottom: 8px;">
          <button type="button" class="projects-tab active" data-view="json" style="padding-bottom: 8px;">JSON</button>
          <button type="button" class="projects-tab" data-view="tree" style="padding-bottom: 8px;">Tree</button>
        </div>
        <div id="ctx-json-output" style="background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 12px; padding: 20px; min-height: 260px; max-height: 460px; overflow-y: auto; overflow-x: auto; display: flex; flex-direction: column; justify-content: space-between;">
          <div style="display: flex; flex-direction: column; gap: 12px;" class="skeleton-container">
            <div class="skeleton-line" style="width: 38%;"></div>
            <div class="skeleton-line" style="width: 72%;"></div>
            <div class="skeleton-line" style="width: 58%;"></div>
            <div class="skeleton-line" style="width: 82%;"></div>
            <div class="skeleton-line" style="width: 48%;"></div>
          </div>
          <div style="text-align: center; padding: 24px 0 8px 0;" class="ctx-empty-hint">
            <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Nothing compiled yet</div>
            <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">Choose a target task and compile to see<br/>the context the engine returns.</div>
          </div>
        </div>
      </div>

      <div class="card" style="padding: 22px; display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
          <div>
            <h3 class="card-title" style="margin: 0;">Serialized envelope</h3>
            <p class="card-subtitle" style="margin-top: 2px;">XML handed to the agent</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="copy-xml-btn" disabled>Copy</button>
        </div>
        <div class="projects-tabs" id="ctx-xml-tabs" style="border-bottom: 1px solid var(--border-default); padding-bottom: 8px;">
          <button type="button" class="projects-tab active" data-view="xml" style="padding-bottom: 8px;">XML</button>
          <button type="button" class="projects-tab" data-view="wrapped" style="padding-bottom: 8px;">Wrapped</button>
        </div>
        <div id="ctx-xml-output" style="background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 12px; padding: 20px; min-height: 260px; max-height: 460px; overflow-y: auto; overflow-x: auto; display: flex; flex-direction: column; justify-content: space-between;">
          <div style="display: flex; flex-direction: column; gap: 12px;" class="skeleton-container">
            <div class="skeleton-line" style="width: 44%;"></div>
            <div class="skeleton-line" style="width: 68%;"></div>
            <div class="skeleton-line" style="width: 62%;"></div>
            <div class="skeleton-line" style="width: 78%;"></div>
            <div class="skeleton-line" style="width: 52%;"></div>
          </div>
          <div style="text-align: center; padding: 24px 0 8px 0;" class="ctx-empty-hint">
            <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Nothing compiled yet</div>
            <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">Choose a target task and compile to see<br/>the context the engine returns.</div>
          </div>
        </div>
      </div>
    </div>

    <div id="ctx-fact-admission-container">
      ${buildFactAdmissionViewHtml(
        { items: [], admittedCount: 0, excludedCount: 0, totalCurrentFacts: 0, supersededRevisionsCount: 0 },
        false
      )}
    </div>

    <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 14px; margin-top: 18px; border-top: 1px dotted var(--border-strong); font-size: 11.5px; color: var(--text-muted); flex-wrap: wrap; gap: 8px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="letter-spacing: 0.06em; font-weight: 600;">TRUST ORDER</span>
        <span style="font-family: var(--font-mono); color: var(--text-primary); font-weight: 600;">CODE › VERIFICATION EVIDENCE › PROJECT BRAIN › AGENT CLAIMS</span>
      </div>
      <span id="ctx-footer-status">Compiled items will show their source and status here once returned.</span>
    </div>
  `;

  const compileBtn = wrapper.querySelector('#compile-ctx-btn') as HTMLButtonElement | null;
  const targetInput = wrapper.querySelector('#ctx-target-input') as HTMLInputElement | null;
  const upstreamInput = wrapper.querySelector('#ctx-upstream-input') as HTMLInputElement | null;
  const errorBanner = wrapper.querySelector('#ctx-error-banner') as HTMLElement | null;
  const jsonOutput = wrapper.querySelector('#ctx-json-output') as HTMLElement | null;
  const xmlOutput = wrapper.querySelector('#ctx-xml-output') as HTMLElement | null;
  const copyJsonBtn = wrapper.querySelector('#copy-json-btn') as HTMLButtonElement | null;
  const copyXmlBtn = wrapper.querySelector('#copy-xml-btn') as HTMLButtonElement | null;
  const admissionContainer = wrapper.querySelector('#ctx-fact-admission-container') as HTMLElement | null;
  const footerStatus = wrapper.querySelector('#ctx-footer-status') as HTMLElement | null;
  const backTaskContainer = wrapper.querySelector('#ctx-back-task-container') as HTMLElement | null;

  if (targetInput && initialTargetTaskId) {
    targetInput.value = initialTargetTaskId;
  }
  if (upstreamInput && initialUpstreamTaskId) {
    upstreamInput.value = initialUpstreamTaskId;
  }

  let activeJsonView: 'json' | 'tree' = 'json';
  let activeXmlView: 'xml' | 'wrapped' = 'xml';

  let lastContext: Record<string, unknown> | null = null;
  let lastJson = '';
  let lastXml = '';
  let projectFactsCache: ProjectFactDto[] | null = null;

  const renderJsonPanel = () => {
    if (!jsonOutput) return;
    if (!lastContext) {
      jsonOutput.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div class="skeleton-line" style="width: 38%;"></div>
          <div class="skeleton-line" style="width: 72%;"></div>
          <div class="skeleton-line" style="width: 58%;"></div>
          <div class="skeleton-line" style="width: 82%;"></div>
          <div class="skeleton-line" style="width: 48%;"></div>
        </div>
        <div style="text-align: center; padding: 24px 0 8px 0;">
          <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Nothing compiled yet</div>
          <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">Choose a target task and compile to see<br/>the context the engine returns.</div>
        </div>
      `;
      return;
    }
    if (activeJsonView === 'json') {
      jsonOutput.innerHTML = `<pre style="font-family: var(--font-mono); font-size: 11.5px; overflow-x: auto; white-space: pre-wrap; margin: 0; word-break: break-word;">${escapeHtml(lastJson)}</pre>`;
    } else {
      jsonOutput.innerHTML = buildCompiledContextTreeHtml(lastContext);
    }
  };

  const renderXmlPanel = () => {
    if (!xmlOutput) return;
    if (!lastXml) {
      xmlOutput.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div class="skeleton-line" style="width: 44%;"></div>
          <div class="skeleton-line" style="width: 68%;"></div>
          <div class="skeleton-line" style="width: 62%;"></div>
          <div class="skeleton-line" style="width: 78%;"></div>
          <div class="skeleton-line" style="width: 52%;"></div>
        </div>
        <div style="text-align: center; padding: 24px 0 8px 0;">
          <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Nothing compiled yet</div>
          <div style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">Choose a target task and compile to see<br/>the context the engine returns.</div>
        </div>
      `;
      return;
    }
    if (activeXmlView === 'xml') {
      xmlOutput.innerHTML = `<pre style="font-family: var(--font-mono); font-size: 11.5px; overflow-x: auto; white-space: pre-wrap; margin: 0; word-break: break-word;">${escapeHtml(lastXml)}</pre>`;
    } else {
      xmlOutput.innerHTML = buildSerializedEnvelopeWrappedHtml(lastXml);
    }
  };

  // Wire view tabs
  const jsonTabs = wrapper.querySelector('#ctx-json-tabs');
  jsonTabs?.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-view') as 'json' | 'tree' | null;
      if (v && v !== activeJsonView) {
        activeJsonView = v;
        jsonTabs.querySelectorAll('button[data-view]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-view') === activeJsonView);
        });
        renderJsonPanel();
      }
    });
  });

  const xmlTabs = wrapper.querySelector('#ctx-xml-tabs');
  xmlTabs?.querySelectorAll('button[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-view') as 'xml' | 'wrapped' | null;
      if (v && v !== activeXmlView) {
        activeXmlView = v;
        xmlTabs.querySelectorAll('button[data-view]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-view') === activeXmlView);
        });
        renderXmlPanel();
      }
    });
  });

  const executeCompile = async () => {
    const targetTaskId = (targetInput?.value?.trim() || initialTargetTaskId).trim();
    const upstreamTaskId = (upstreamInput?.value?.trim() || initialUpstreamTaskId).trim();

    if (!targetTaskId) {
      if (errorBanner) {
        errorBanner.style.display = 'block';
        errorBanner.textContent = 'Query parameter "targetTaskId" is required to compile context.';
      }
      return;
    }

    if (errorBanner) {
      errorBanner.style.display = 'none';
      errorBanner.textContent = '';
    }

    if (backTaskContainer) {
      backTaskContainer.innerHTML = `<span class="separator">·</span><a href="#/projects/${encodedId}/tasks/${encodeURIComponent(targetTaskId)}" id="ctx-back-to-task-link">← Back to Task #${escapeHtml(targetTaskId)}</a>`;
    }

    if (compileBtn) {
      compileBtn.disabled = true;
      compileBtn.innerHTML = `<span>Compiling...</span>`;
    }

    try {
      // 1. Fetch compilation result and project facts in parallel for fact admission breakdown
      const [compileRes, projectRes] = await Promise.allSettled([
        engineClient.compileContext(
          projectId,
          targetTaskId,
          upstreamTaskId || undefined,
          requestTags
        ),
        projectFactsCache ? Promise.resolve({ facts: projectFactsCache }) : engineClient.getProject(projectId),
      ]);

      if (compileRes.status === 'rejected') {
        const err = compileRes.reason;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(msg);
      }

      const result = compileRes.value;
      lastContext = result.context;
      lastJson = JSON.stringify(result.context, null, 2);
      lastXml = result.serialized;

      if (copyJsonBtn) copyJsonBtn.disabled = false;
      if (copyXmlBtn) copyXmlBtn.disabled = false;

      renderJsonPanel();
      renderXmlPanel();

      // 2. Compute Fact Admissions breakdown
      let projectFacts: ProjectFactDto[] = [];
      if (projectRes.status === 'fulfilled' && projectRes.value) {
        projectFacts = projectRes.value.facts ?? [];
        projectFactsCache = projectFacts;
      }

      const compiledFactsList = Array.isArray(result.context?.facts)
        ? (result.context.facts as Array<{ key: string; value: string; provenance?: string; status?: string }>)
        : [];

      const admissions = deriveFactAdmissions(
        projectFacts,
        compiledFactsList,
        requestTags,
        result.context?.metadata as { truncatedFacts?: boolean; totalFactsCount?: number } | undefined
      );
      if (admissionContainer) {
        admissionContainer.innerHTML = buildFactAdmissionViewHtml(admissions, true);
      }

      if (footerStatus) {
        const factsCount = compiledFactsList.length;
        const decCount = Array.isArray(result.context?.decisions) ? result.context.decisions.length : 0;
        footerStatus.innerHTML = `Compiled for task "<code>${escapeHtml(targetTaskId)}</code>": ${factsCount} facts admitted, ${decCount} decisions, envelope serialized (${lastXml.length} chars).`;
      }
    } catch (err) {
      if (errorBanner) {
        errorBanner.style.display = 'block';
        errorBanner.textContent = (err as Error).message || 'Failed to compile context.';
      }
      if (footerStatus) {
        footerStatus.textContent = 'Compilation failed. Inspect error message above.';
      }
    } finally {
      if (compileBtn) {
        compileBtn.disabled = false;
        compileBtn.innerHTML = `<span>Compile context</span><span>→</span>`;
      }
    }
  };

  compileBtn?.addEventListener('click', () => {
    void executeCompile();
  });

  // Clipboard copy handlers with safe fallback
  const handleCopy = async (btn: HTMLButtonElement | null, text: string) => {
    if (!btn || !text) return;
    try {
      let succeeded = false;
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        succeeded = true;
      } else if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        succeeded = document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      if (!succeeded) {
        throw new Error('Clipboard copy not supported');
      }
      const prevText = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(() => {
        btn.textContent = prevText;
      }, 2000);
    } catch {
      btn.textContent = 'Failed to copy';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 2000);
    }
  };

  copyJsonBtn?.addEventListener('click', () => {
    void handleCopy(copyJsonBtn, lastJson);
  });
  copyXmlBtn?.addEventListener('click', () => {
    void handleCopy(copyXmlBtn, lastXml);
  });

  // If a targetTaskId was supplied via route query/params, auto-trigger compilation
  if (initialTargetTaskId) {
    void executeCompile();
  }

  return wrapper;
}

export interface DerivedHandoffItem {
  handoff: HandoffDto;
  verificationsAvailable: boolean;
  relatedVerification?: VerificationRecordDto;
  verificationRejectedReason?: string;
  verificationRejectedKind?: VerificationRejectionKind;
  attemptTrustState: TrustStatus | 'UNKNOWN_PARTIAL';
}

export interface DerivedVerificationItem {
  verification: VerificationRecordDto;
  handoffsAvailable: boolean;
  relatedHandoff?: HandoffDto;
  handoffLinkStatus:
    | 'MATCHED'
    | 'NO_HANDOFF'
    | 'MISMATCHED'
    | 'STALE'
    | 'HANDOFFS_UNAVAILABLE';
  mismatchReason?: string;
}

function getHandoffDecisionStrings(h: HandoffDto): string[] {
  if (!Array.isArray(h.decisionsCreated)) return [];
  return h.decisionsCreated.map((d: unknown) => {
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      const obj = d as { id?: string; statement?: string; rationale?: string; status?: string };
      const parts = [obj.id ? `[${obj.id}]` : '', obj.statement || '', obj.rationale ? `(${obj.rationale})` : ''].filter(Boolean);
      return parts.join(' ') || JSON.stringify(d);
    }
    return String(d);
  });
}

function getHandoffFollowUpStrings(h: HandoffDto): string[] {
  const list = Array.isArray(h.recommendedFollowUp) ? [...h.recommendedFollowUp] : [];
  const legacyNext = (h as { nextSteps?: string }).nextSteps;
  if (typeof legacyNext === 'string' && legacyNext.trim() && !list.includes(legacyNext.trim())) {
    list.push(legacyNext.trim());
  }
  return list;
}

/**
 * Pure derivation of project-scoped handoff items paired with their independently
 * validated verification records via evaluateVerificationForHandoff.
 */
export function deriveHandoffItems(
  projectId: string,
  handoffs: readonly HandoffDto[],
  verifications: readonly VerificationRecordDto[],
  verificationsAvailable = true
): DerivedHandoffItem[] {
  const scopedHandoffs = (Array.isArray(handoffs) ? handoffs : []).filter((h) => {
    const recProjId = (h as { projectId?: string }).projectId;
    if (recProjId && projectId && recProjId !== projectId) return false;
    return (
      typeof h.taskId === 'string' &&
      h.taskId.trim() !== '' &&
      Number.isFinite(Number(h.attemptNumber)) &&
      Number(h.attemptNumber) > 0
    );
  });

  const scopedVerifs = verificationsAvailable
    ? (Array.isArray(verifications) ? verifications : []).filter((v) => {
        const recProjId = (v as { projectId?: string }).projectId;
        if (recProjId && projectId && recProjId !== projectId) return false;
        return (
          typeof v.taskId === 'string' &&
          v.taskId.trim() !== '' &&
          Number.isFinite(Number(v.attemptNumber)) &&
          Number(v.attemptNumber) > 0
        );
      })
    : [];

  // Map latest verification per (taskId, attemptNumber) using same deterministic rules as deriveProjectOverviewModel
  const latestVerifByTaskAttempt = new Map<string, VerificationRecordDto>();
  for (const v of scopedVerifs) {
    const key = `${v.taskId.trim()}::${Number(v.attemptNumber)}`;
    const existing = latestVerifByTaskAttempt.get(key);
    const vTime = v.recordedAt || v.result?.executedAt || '';
    const exTime = existing ? existing.recordedAt || existing.result?.executedAt || '' : '';
    const vMs = Date.parse(vTime);
    const exMs = Date.parse(exTime);
    const isNewer =
      !existing ||
      (Number.isFinite(vMs) && Number.isFinite(exMs) ? vMs >= exMs : vTime >= exTime);
    if (isNewer) {
      latestVerifByTaskAttempt.set(key, v);
    }
  }

  const sortedHandoffs = [...scopedHandoffs].sort((a, b) => {
    const aMs = Date.parse(a.createdAt || '');
    const bMs = Date.parse(b.createdAt || '');
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && bMs !== aMs) {
      return bMs - aMs;
    }
    const cmpTime = (b.createdAt || '').localeCompare(a.createdAt || '');
    if (cmpTime !== 0) return cmpTime;
    const cmpAtt = Number(b.attemptNumber) - Number(a.attemptNumber);
    if (cmpAtt !== 0) return cmpAtt;
    const cmpTask = a.taskId.trim().localeCompare(b.taskId.trim());
    if (cmpTask !== 0) return cmpTask;
    return (a.id || '').localeCompare(b.id || '');
  });

  return sortedHandoffs.map((h) => {
    if (!verificationsAvailable) {
      return {
        handoff: h,
        verificationsAvailable: false,
        attemptTrustState:
          h.status === 'BLOCKED_NEEDS_HUMAN' ? 'BLOCKED_NEEDS_HUMAN' : 'UNKNOWN_PARTIAL',
      };
    }

    const key = `${h.taskId.trim()}::${Number(h.attemptNumber)}`;
    const candidateVerif = latestVerifByTaskAttempt.get(key);
    const taskHandoffs = scopedHandoffs.filter((th) => th.taskId.trim() === h.taskId.trim());
    const { validVerification, rejectedReason, rejectedKind } = evaluateVerificationForHandoff(
      candidateVerif,
      h,
      taskHandoffs
    );

    const explicitlyBlocked =
      h.status === 'BLOCKED_NEEDS_HUMAN' ||
      (candidateVerif?.result as { status?: string })?.status === 'BLOCKED_NEEDS_HUMAN';

    const attemptTrustState: TrustStatus = explicitlyBlocked
      ? 'BLOCKED_NEEDS_HUMAN'
      : validVerification
        ? validVerification.result.status === 'VERIFIED'
          ? 'VERIFIED'
          : 'FAILED'
        : 'CLAIMED';

    return {
      handoff: h,
      verificationsAvailable: true,
      relatedVerification: validVerification,
      verificationRejectedReason: rejectedReason,
      verificationRejectedKind: rejectedKind,
      attemptTrustState,
    };
  });
}

/**
 * Pure filter helper for Handoffs screen search and outcome filtering.
 */
export function filterHandoffItems(
  items: readonly DerivedHandoffItem[],
  searchQuery: string,
  outcomeFilter: string
): DerivedHandoffItem[] {
  const normalizedFilter = (outcomeFilter || 'ALL').trim().toUpperCase();
  const q = (searchQuery || '').trim().toLowerCase();

  return items.filter((item) => {
    if (normalizedFilter !== 'ALL' && !item.verificationsAvailable) {
      return false;
    }
    if (normalizedFilter === 'VERIFIED' && item.attemptTrustState !== 'VERIFIED') {
      return false;
    }
    if (normalizedFilter === 'FAILED' && item.attemptTrustState !== 'FAILED') {
      return false;
    }
    if (
      (normalizedFilter === 'UNVERIFIED' || normalizedFilter === 'CLAIMED_ONLY') &&
      (item.attemptTrustState !== 'CLAIMED' || Boolean(item.verificationRejectedReason))
    ) {
      return false;
    }
    if (normalizedFilter === 'MISMATCHED' && item.verificationRejectedKind !== 'MISMATCHED') {
      return false;
    }
    if (normalizedFilter === 'STALE' && item.verificationRejectedKind !== 'STALE') {
      return false;
    }

    if (!q) return true;

    const h = item.handoff;
    const attemptStr = `attempt ${Number(h.attemptNumber)}`;
    const attemptHashStr = `#${Number(h.attemptNumber)}`;
    const fields = [
      h.id,
      h.taskId,
      `#${h.taskId}`,
      attemptStr,
      attemptHashStr,
      String(h.attemptNumber),
      h.agentId || '',
      h.model || '',
      h.status,
      item.attemptTrustState,
      item.verificationRejectedKind || '',
      h.summary || '',
      h.changes || '',
      ...getHandoffFollowUpStrings(h),
      h.createdAt || '',
      ...(Array.isArray(h.filesAffected) ? h.filesAffected : []),
      ...getHandoffDecisionStrings(h),
      ...(Array.isArray(h.assumptions) ? h.assumptions : []),
      ...(Array.isArray(h.limitations) ? h.limitations : []),
    ];

    return fields.some((val) => val.toLowerCase().includes(q));
  });
}

/**
 * Pure HTML builder for the Handoff Detail inspector panel.
 * Always badges the handoff itself as CLAIMED and shows independent verification
 * evidence separately in the Related verification record section.
 */
export function buildHandoffDetailHtml(projectId: string, item: DerivedHandoffItem): string {
  const h = item.handoff;
  const fallbackProjId = (h as { projectId?: string }).projectId || '';
  const trimmedProjectId = (projectId || fallbackProjId).trim();
  const trimmedTaskId = (h.taskId || '').trim();
  const attNum = Number(h.attemptNumber);
  const encodedProjectId = encodeURIComponent(trimmedProjectId);
  const encodedTaskId = encodeURIComponent(trimmedTaskId);
  const taskHref = `#/projects/${encodedProjectId}/tasks/${encodedTaskId}`;
  const verifHref = `#/projects/${encodedProjectId}/verifications?taskId=${encodedTaskId}&attempt=${attNum}`;

  const files = Array.isArray(h.filesAffected) ? h.filesAffected : [];
  const decisions = getHandoffDecisionStrings(h);
  const assumptions = Array.isArray(h.assumptions) ? h.assumptions : [];
  const limitations = Array.isArray(h.limitations) ? h.limitations : [];
  const followUps = getHandoffFollowUpStrings(h);

  const renderStringListHtml = (entries: string[], emptyText: string, asCode = false): string => {
    if (entries.length === 0) {
      return `<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(emptyText)}</div>`;
    }
    if (asCode) {
      return `
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          ${entries
            .map(
              (entry) =>
                `<code style="font-family: var(--font-mono); font-size: 11.5px; padding: 3px 8px; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-primary);">${escapeHtml(entry)}</code>`
            )
            .join('')}
        </div>
      `;
    }
    return `
      <ul style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-secondary);">
        ${entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}
      </ul>
    `;
  };

  let relatedVerifHtml = '';
  if (!item.verificationsAvailable) {
    relatedVerifHtml = `
      <div id="handoff-related-verification-card" style="border: 1.5px solid var(--status-claimed-border); background: var(--status-claimed-bg); border-radius: 12px; padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Related verification record</span>
            <span class="status-badge claimed">VERIFICATIONS UNAVAILABLE</span>
          </div>
          <div style="font-size: 12px; color: var(--status-claimed-text);">
            Verification records failed to load from the Engine API. Orchestrate will not infer verification status for this handoff without verification evidence.
          </div>
        </div>
        <a href="${verifHref}" class="handoff-open-verifications-link" style="font-weight: 600; font-size: 12.5px; color: var(--text-primary); white-space: nowrap;">Open in Verifications →</a>
      </div>
    `;
  } else if (item.relatedVerification) {
    const v = item.relatedVerification;
    const checks = Array.isArray(v.result?.checks) ? v.result.checks : [];
    const passedCount = checks.filter((c) => c.passed).length;
    const verifTime = v.recordedAt || v.result.executedAt;
    relatedVerifHtml = `
      <div id="handoff-related-verification-card" style="border: 1.5px solid var(--border-active-card); border-radius: 12px; padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Related verification record</span>
            ${renderInlineStatusBadgeHtml(v.result.status)}
            <code style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);">${escapeHtml(v.id)}</code>
          </div>
          <div style="font-size: 12px; color: var(--text-secondary);">
            ${passedCount}/${checks.length} configured ${checks.length === 1 ? 'check' : 'checks'} passed · Executed ${escapeHtml(formatDateLabel(verifTime))} · Duration ${escapeHtml(formatDuration(v.result.totalDurationMs))}
          </div>
        </div>
        <a href="${verifHref}" class="handoff-open-verifications-link" style="font-weight: 600; font-size: 12.5px; color: var(--brand-blue); white-space: nowrap;">Open in Verifications →</a>
      </div>
    `;
  } else if (item.verificationRejectedReason) {
    const isStale = item.verificationRejectedKind === 'STALE';
    const rejectedBadge = isStale ? 'STALE' : 'MISMATCHED';
    const rejectedLabel = isStale ? 'stale' : 'mismatched';
    relatedVerifHtml = `
      <div id="handoff-related-verification-card" style="border: 1.5px solid var(--status-failed-border); background: var(--status-failed-bg); border-radius: 12px; padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 600; font-size: 13.5px; color: var(--status-failed-text);">Related verification record (rejected as ${rejectedLabel})</span>
            <span class="status-badge failed">${rejectedBadge}</span>
          </div>
          <div style="font-size: 12px; color: var(--status-failed-text);">
            ${escapeHtml(item.verificationRejectedReason)} This handoff remains <strong>CLAIMED</strong>.
          </div>
        </div>
        <a href="${verifHref}" class="handoff-open-verifications-link" style="font-weight: 600; font-size: 12.5px; color: var(--status-failed-text); white-space: nowrap;">Inspect in Verifications →</a>
      </div>
    `;
  } else {
    relatedVerifHtml = `
      <div id="handoff-related-verification-card" style="border: 1.5px solid var(--border-active-card); border-radius: 12px; padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">Related verification record</span>
            <span class="status-badge unverified">○ UNVERIFIED</span>
          </div>
          <div style="font-size: 12px; color: var(--text-muted);">
            None recorded for Task #${escapeHtml(trimmedTaskId)} attempt #${attNum} yet. This handoff remains an unverified agent claim.
          </div>
        </div>
        <a href="${verifHref}" class="handoff-open-verifications-link" style="font-weight: 600; font-size: 12.5px; color: var(--brand-blue); white-space: nowrap;">Open in Verifications →</a>
      </div>
    `;
  }

  return `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <h3 class="card-title">Handoff detail</h3>
        <span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-muted);">
          #${escapeHtml(trimmedTaskId)} · attempt #${attNum}
        </span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px;">
        <a href="${taskHref}" class="btn btn-secondary btn-sm handoff-back-task-btn">← Task #${escapeHtml(trimmedTaskId)}</a>
        <span class="status-badge claimed" id="handoff-detail-claim-badge">◔ CLAIMED</span>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--border-subtle); font-size: 12px;">
      <div>
        <div style="color: var(--text-muted); font-size: 11px;">Task</div>
        <div style="margin-top: 2px; font-family: var(--font-mono); font-weight: 600;">
          <a href="${taskHref}" class="handoff-back-task-btn" style="color: var(--brand-blue);">#${escapeHtml(trimmedTaskId)}</a>
        </div>
      </div>
      <div>
        <div style="color: var(--text-muted); font-size: 11px;">Attempt</div>
        <div style="margin-top: 2px; font-family: var(--font-mono); font-weight: 600;">#${attNum}</div>
      </div>
      <div>
        <div style="color: var(--text-muted); font-size: 11px;">Agent (optional)</div>
        <div style="margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(h.agentId || 'Not recorded')}</div>
      </div>
      <div>
        <div style="color: var(--text-muted); font-size: 11px;">Model (optional)</div>
        <div style="margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(h.model || 'Not recorded')}</div>
      </div>
      <div>
        <div style="color: var(--text-muted); font-size: 11px;">Recorded</div>
        <div style="margin-top: 2px;" title="${escapeHtml(h.createdAt)}">${escapeHtml(formatDateLabel(h.createdAt))}</div>
      </div>
      <div>
        <div style="color: var(--text-muted); font-size: 11px;">Handoff ID</div>
        <div style="margin-top: 2px; font-family: var(--font-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(h.id)}">${escapeHtml(h.id)}</div>
      </div>
    </div>

    <div class="callout-banner" id="handoff-provenance-banner">
      <span>ⓘ</span>
      <span><strong>Claim, not evidence.</strong> An agent reported this. Only an independent verification record can establish it as verified.</span>
    </div>

    <div style="display: flex; flex-direction: column; gap: 6px;">
      <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.05em;">SUMMARY</div>
      <div style="font-size: 13.5px; color: var(--text-primary); line-height: 1.5;" id="handoff-detail-summary">
        ${renderDetailFactValueHtml('summary', h.summary || 'No summary provided by agent.')}
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 6px;">
      <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.05em;">CHANGES</div>
      <div id="handoff-detail-changes">
        ${renderBoundedLogBoxHtml(h.changes || 'No detailed change description recorded.', { maxHeight: '200px' })}
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.05em;">FILES AFFECTED (${files.length})</div>
        <div id="handoff-detail-files">${renderStringListHtml(files, 'None recorded', true)}</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.05em;">DECISIONS CREATED (${decisions.length})</div>
        <div id="handoff-detail-decisions">${renderStringListHtml(decisions, 'None recorded')}</div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.05em;">ASSUMPTIONS (${assumptions.length})</div>
        <div id="handoff-detail-assumptions">${renderStringListHtml(assumptions, 'None recorded')}</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.05em;">LIMITATIONS (${limitations.length})</div>
        <div id="handoff-detail-limitations">${renderStringListHtml(limitations, 'None recorded')}</div>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 6px;">
      <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.05em;">RECOMMENDED FOLLOW-UP (${followUps.length})</div>
      <div style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.5;" id="handoff-detail-followup">
        ${renderStringListHtml(followUps, 'None recorded.')}
      </div>
    </div>

    ${relatedVerifHtml}
  `;
}

/**
 * Pure derivation of project-scoped verification items paired with their associated
 * handoff claims and validated via evaluateVerificationForHandoff.
 */
export function deriveVerificationItems(
  projectId: string,
  verifications: readonly VerificationRecordDto[],
  handoffs: readonly HandoffDto[],
  handoffsAvailable = true
): DerivedVerificationItem[] {
  const scopedVerifs = (Array.isArray(verifications) ? verifications : []).filter((v) => {
    const recProjId = (v as { projectId?: string }).projectId;
    if (recProjId && projectId && recProjId !== projectId) return false;
    return (
      typeof v.taskId === 'string' &&
      v.taskId.trim() !== '' &&
      Number.isFinite(Number(v.attemptNumber)) &&
      Number(v.attemptNumber) > 0
    );
  });

  const scopedHandoffs = handoffsAvailable
    ? (Array.isArray(handoffs) ? handoffs : []).filter((h) => {
        const recProjId = (h as { projectId?: string }).projectId;
        if (recProjId && projectId && recProjId !== projectId) return false;
        return (
          typeof h.taskId === 'string' &&
          h.taskId.trim() !== '' &&
          Number.isFinite(Number(h.attemptNumber)) &&
          Number(h.attemptNumber) > 0
        );
      })
    : [];

  // Latest handoff per (taskId, attemptNumber)
  const latestHandoffByTaskAttempt = new Map<string, HandoffDto>();
  for (const h of scopedHandoffs) {
    const key = `${h.taskId.trim()}::${Number(h.attemptNumber)}`;
    const existing = latestHandoffByTaskAttempt.get(key);
    const hMs = Date.parse(h.createdAt || '');
    const exMs = existing ? Date.parse(existing.createdAt || '') : NaN;
    const isNewer =
      !existing ||
      (Number.isFinite(hMs) && Number.isFinite(exMs)
        ? hMs >= exMs
        : (h.createdAt || '') >= (existing.createdAt || ''));
    if (isNewer) {
      latestHandoffByTaskAttempt.set(key, h);
    }
  }

  const sortedVerifs = [...scopedVerifs].sort((a, b) => {
    const aTime = a.recordedAt || a.result?.executedAt || '';
    const bTime = b.recordedAt || b.result?.executedAt || '';
    const aMs = Date.parse(aTime);
    const bMs = Date.parse(bTime);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && bMs !== aMs) {
      return bMs - aMs;
    }
    const cmpTime = bTime.localeCompare(aTime);
    if (cmpTime !== 0) return cmpTime;
    const cmpAtt = Number(b.attemptNumber) - Number(a.attemptNumber);
    if (cmpAtt !== 0) return cmpAtt;
    const cmpTask = a.taskId.trim().localeCompare(b.taskId.trim());
    if (cmpTask !== 0) return cmpTask;
    return (a.id || '').localeCompare(b.id || '');
  });

  return sortedVerifs.map((v) => {
    if (!handoffsAvailable) {
      return {
        verification: v,
        handoffsAvailable: false,
        handoffLinkStatus: 'HANDOFFS_UNAVAILABLE',
      };
    }

    const key = `${v.taskId.trim()}::${Number(v.attemptNumber)}`;
    const attemptHandoff = latestHandoffByTaskAttempt.get(key);
    const taskHandoffs = scopedHandoffs.filter((th) => th.taskId.trim() === v.taskId.trim());
    const { rejectedReason, rejectedKind } = evaluateVerificationForHandoff(
      v,
      attemptHandoff,
      taskHandoffs
    );

    if (rejectedReason) {
      return {
        verification: v,
        handoffsAvailable: true,
        relatedHandoff: attemptHandoff,
        handoffLinkStatus: rejectedKind === 'STALE' ? 'STALE' : 'MISMATCHED',
        mismatchReason: rejectedReason,
      };
    }

    if (attemptHandoff) {
      return {
        verification: v,
        handoffsAvailable: true,
        relatedHandoff: attemptHandoff,
        handoffLinkStatus: 'MATCHED',
      };
    }

    return {
      verification: v,
      handoffsAvailable: true,
      handoffLinkStatus: 'NO_HANDOFF',
    };
  });
}

/**
 * Pure filter helper for Verifications screen search and status filtering.
 */
export function filterVerificationItems(
  items: readonly DerivedVerificationItem[],
  searchQuery: string,
  statusFilter: string
): DerivedVerificationItem[] {
  const normalizedFilter = (statusFilter || 'ALL').trim().toUpperCase();
  const q = (searchQuery || '').trim().toLowerCase();

  return items.filter((item) => {
    const v = item.verification;
    if (normalizedFilter === 'VERIFIED' && v.result.status !== 'VERIFIED') {
      return false;
    }
    if (normalizedFilter === 'FAILED' && v.result.status !== 'FAILED') {
      return false;
    }
    if (normalizedFilter === 'MISMATCHED' && item.handoffLinkStatus !== 'MISMATCHED') {
      return false;
    }
    if (normalizedFilter === 'STALE' && item.handoffLinkStatus !== 'STALE') {
      return false;
    }
    if (normalizedFilter === 'NO_HANDOFF' && item.handoffLinkStatus !== 'NO_HANDOFF') {
      return false;
    }

    if (!q) return true;

    const attemptStr = `attempt ${Number(v.attemptNumber)}`;
    const attemptHashStr = `#${Number(v.attemptNumber)}`;
    const checkFields: string[] = [];
    for (const c of v.result?.checks ?? []) {
      checkFields.push(c.name || '', c.command || '', ...(Array.isArray(c.args) ? c.args : []));
      if (c.stdout) checkFields.push(c.stdout);
      if (c.stderr) checkFields.push(c.stderr);
    }

    const fields = [
      v.id,
      v.taskId,
      `#${v.taskId}`,
      v.handoffId || '',
      attemptStr,
      attemptHashStr,
      String(v.attemptNumber),
      v.result.status,
      item.handoffLinkStatus,
      v.recordedAt || '',
      v.result.executedAt || '',
      item.relatedHandoff?.summary || '',
      item.relatedHandoff?.agentId || '',
      item.relatedHandoff?.model || '',
      ...checkFields,
    ];

    return fields.some((val) => val.toLowerCase().includes(q));
  });
}

/**
 * Pure HTML builder for the Verification Record detail panel.
 * Contrasts the associated Agent claim (untrusted) against Independent verification evidence.
 */
export function buildVerificationDetailHtml(
  projectId: string,
  item: DerivedVerificationItem
): string {
  const v = item.verification;
  const fallbackProjId = (v as { projectId?: string }).projectId || '';
  const trimmedProjectId = (projectId || fallbackProjId).trim();
  const trimmedTaskId = (v.taskId || '').trim();
  const attNum = Number(v.attemptNumber);
  const encodedProjectId = encodeURIComponent(trimmedProjectId);
  const encodedTaskId = encodeURIComponent(trimmedTaskId);
  const taskHref = `#/projects/${encodedProjectId}/tasks/${encodedTaskId}?attempt=${attNum}`;
  const handoffHref = `#/projects/${encodedProjectId}/handoffs?taskId=${encodedTaskId}&attempt=${attNum}`;
  const verifTime = v.recordedAt || v.result.executedAt;
  const checks = Array.isArray(v.result?.checks) ? v.result.checks : [];
  const passedCount = checks.filter((c) => c.passed).length;

  const isStaleOrMismatched =
    item.handoffLinkStatus === 'MISMATCHED' || item.handoffLinkStatus === 'STALE';
  const isStale = item.handoffLinkStatus === 'STALE';

  const mismatchBannerHtml =
    isStaleOrMismatched && item.mismatchReason
      ? `
        <div id="verification-mismatch-banner" style="border: 1.5px solid var(--status-failed-border); background: var(--status-failed-bg); border-radius: 12px; padding: 12px 14px; font-size: 12.5px; color: var(--status-failed-text); line-height: 1.45;">
          <strong>${isStale ? 'Stale verification record' : 'Mismatched verification record'}:</strong> ${escapeHtml(item.mismatchReason)} Task trust-state derivation does not promote the attempt's current handoff from this record.
        </div>
      `
      : '';

  // 1. Agent Claim Card
  let agentClaimCardHtml = '';
  if (!item.handoffsAvailable) {
    agentClaimCardHtml = `
      <div style="border: 1px dashed var(--border-strong); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;" id="verification-agent-claim-card">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">Agent claim</span>
          <span class="status-badge claimed">HANDOFFS UNAVAILABLE</span>
        </div>
        <div style="font-size: 12px; color: var(--status-claimed-text); line-height: 1.45;">
          Handoff records failed to load from the Engine API. Associated agent claim details cannot be confirmed until handoffs are reloaded.
        </div>
      </div>
    `;
  } else if (isStaleOrMismatched) {
    const h = item.relatedHandoff;
    agentClaimCardHtml = `
      <div style="border: 1px dashed var(--status-failed-border); background: var(--status-failed-bg); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;" id="verification-agent-claim-card">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <span style="font-size: 11.5px; font-weight: 600; color: var(--status-failed-text);">${isStale ? 'Agent claim (newer than verification)' : 'Agent claim (mismatched)'}</span>
          <span class="status-badge failed">${isStale ? 'STALE' : 'MISMATCHED'}</span>
        </div>
        <div style="font-size: 12px; color: var(--status-failed-text); line-height: 1.45;">
          ${escapeHtml(item.mismatchReason || 'This verification record does not match the current handoff for this attempt.')}
        </div>
        ${
          h
            ? `<div style="font-size: 11.5px; color: var(--text-secondary);">
                Attempt #${attNum} handoff <code>${escapeHtml(h.id)}</code>: ${escapeHtml(h.summary)}
              </div>
              <div style="margin-top: auto; padding-top: 4px;">
                <a href="${handoffHref}" class="verif-open-handoff-link" style="font-size: 12px; font-weight: 600; color: var(--text-primary);">Inspect handoff →</a>
              </div>`
            : ''
        }
      </div>
    `;
  } else if (item.relatedHandoff) {
    const h = item.relatedHandoff;
    const filesCount = Array.isArray(h.filesAffected) ? h.filesAffected.length : 0;
    agentClaimCardHtml = `
      <div style="border: 1px dashed var(--border-strong); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;" id="verification-agent-claim-card">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">Agent claim</span>
          <span class="status-badge claimed">◔ CLAIMED</span>
        </div>
        <div style="font-size: 12.5px; color: var(--text-primary); font-weight: 500; line-height: 1.45;">
          ${escapeHtml(h.summary || 'No summary provided')}
        </div>
        <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono);">
          Handoff <code>${escapeHtml(h.id)}</code> · ${escapeHtml(formatDateLabel(h.createdAt))}
          ${h.agentId || h.model ? ` · ${escapeHtml([h.agentId, h.model].filter(Boolean).join(' / '))}` : ''}
        </div>
        <div style="font-size: 11.5px; color: var(--text-muted);">
          ${filesCount} ${filesCount === 1 ? 'file' : 'files'} affected
        </div>
        <div style="margin-top: auto; padding-top: 4px;">
          <a href="${handoffHref}" class="verif-open-handoff-link" style="font-size: 12px; font-weight: 600; color: var(--brand-blue);">Open handoff →</a>
        </div>
      </div>
    `;
  } else {
    agentClaimCardHtml = `
      <div style="border: 1px dashed var(--border-strong); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;" id="verification-agent-claim-card">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
          <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">Agent claim</span>
          <span class="status-badge unverified">NO HANDOFF</span>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); line-height: 1.45;">
          No agent handoff claim was recorded for Task #${escapeHtml(trimmedTaskId)} attempt #${attNum}. Verification ran independently without a linked handoff record.
        </div>
      </div>
    `;
  }

  // 2. Independent Verification Card
  const independentVerifCardHtml = `
    <div style="border: 1.5px solid var(--border-active-card); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;" id="verification-evidence-card">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
        <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">Independent verification</span>
        ${renderInlineStatusBadgeHtml(v.result.status)}
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45;">
        <strong>Verification ID:</strong> <code style="font-family: var(--font-mono); font-size: 11px;">${escapeHtml(v.id)}</code>
        ${v.handoffId ? `<span style="color: var(--text-muted);"> (checked handoff <code>${escapeHtml(v.handoffId)}</code>)</span>` : '<span style="color: var(--text-muted);"> (no handoffId linked)</span>'}
      </div>
      <div style="font-size: 11.5px; color: var(--text-muted);">
        ${passedCount} of ${checks.length} ${checks.length === 1 ? 'check' : 'checks'} passed · Executed ${escapeHtml(formatDateLabel(verifTime))} · Duration ${escapeHtml(formatDuration(v.result.totalDurationMs))}
      </div>
      <div style="font-size: 11px; color: var(--text-muted); background: var(--bg-subtle); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-subtle);">
        Configured checks ${v.result.status === 'VERIFIED' ? 'passed' : 'failed'} for attempt #${attNum} at ${escapeHtml(formatDateLabel(verifTime))}. <strong>VERIFIED</strong> means configured checks passed; it does not prove universal correctness, and code revision SHA is not persisted in schema.
      </div>
    </div>
  `;

  // 3. Checks Table
  const checksRowsHtml =
    checks.length === 0
      ? `
        <div style="font-size: 12px; color: var(--text-muted); padding: 12px 0;">
          No individual check entries recorded in this verification payload.
        </div>
      `
      : checks
          .map((c, idx) => {
            const cmdText =
              Array.isArray(c.args) && c.args.length > 0
                ? `${c.command} ${c.args.join(' ')}`
                : c.command;
            const passed = Boolean(c.passed);
            const color = passed ? 'var(--status-verified-text)' : 'var(--status-failed-text)';
            const icon = passed ? '✓' : '✕';
            return `
              <div style="display: grid; grid-template-columns: 1.2fr 2fr 1fr 0.8fr; gap: 10px; align-items: center; font-size: 12px; padding: 9px 0; ${idx < checks.length - 1 ? 'border-bottom: 1px solid var(--border-subtle);' : ''}">
                <div style="font-weight: 600; color: var(--text-primary);">
                  <span style="color: ${color}; font-weight: 700; margin-right: 4px;">${icon}</span>${escapeHtml(c.name)}
                </div>
                <code style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(cmdText)}">${escapeHtml(cmdText)}</code>
                <span style="font-family: var(--font-mono); font-size: 11px; color: ${color};">
                  ${passed ? 'PASSED' : 'FAILED'}${c.exitCode !== null && c.exitCode !== undefined ? ` (exit ${Number(c.exitCode)})` : ''}
                </span>
                <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-align: right;">
                  ${escapeHtml(formatDuration(c.durationMs))}
                </span>
              </div>
            `;
          })
          .join('');

  // 4. Failure Output
  const failedChecks = checks.filter((c) => !c.passed);
  let failureOutputHtml = '';
  if (failedChecks.length === 0 && v.result.status === 'VERIFIED') {
    failureOutputHtml = `<div class="mono-code-box" id="verification-failure-output" style="color: var(--status-verified-text);">All configured checks passed on attempt #${attNum}. No failure stdout/stderr recorded.</div>`;
  } else if (failedChecks.length === 0) {
    failureOutputHtml = `<div class="mono-code-box" id="verification-failure-output" style="color: var(--status-failed-text);">Verification status is FAILED on attempt #${attNum}, with no individual failed check stdout/stderr recorded.</div>`;
  } else {
    const blocks = failedChecks.map((fc) => {
      const stderr = (fc.stderr || '').trim();
      const stdout = (fc.stdout || '').trim();
      const combined = [
        `# ${fc.name} (${fc.command}${Array.isArray(fc.args) && fc.args.length ? ' ' + fc.args.join(' ') : ''}) — exit code ${fc.exitCode ?? '—'}`,
        stderr ? `[stderr]\n${stderr}` : '',
        stdout ? `[stdout]\n${stdout}` : '',
        !stderr && !stdout ? '(No stdout or stderr output captured by check runner)' : '',
      ]
        .filter(Boolean)
        .join('\n');
      return escapeHtml(combined);
    });
    failureOutputHtml = `<div class="mono-code-box" id="verification-failure-output" style="max-height: 260px; overflow-y: auto; color: var(--status-failed-text);">${blocks.join('\n\n')}</div>`;
  }

  return `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <h3 class="card-title">Record detail</h3>
        <span style="font-family: var(--font-mono); font-size: 12px; color: var(--text-muted);">
          #${escapeHtml(trimmedTaskId)} · attempt #${attNum}
        </span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px;">
        <a href="${taskHref}" class="btn btn-secondary btn-sm verif-back-task-btn">← Task #${escapeHtml(trimmedTaskId)}</a>
        <span id="verification-detail-status-badge">${renderInlineStatusBadgeHtml(v.result.status)}</span>
      </div>
    </div>

    ${mismatchBannerHtml}

    <div class="task-detail-claim-vs-evidence">
      ${agentClaimCardHtml}
      ${independentVerifCardHtml}
    </div>

    <div>
      <div style="font-weight: 600; font-size: 13.5px; margin-bottom: 10px;">Checks (${checks.length})</div>
      <div style="display: grid; grid-template-columns: 1.2fr 2fr 1fr 0.8fr; gap: 10px; font-size: 11.5px; font-weight: 600; color: var(--text-muted); padding-bottom: 8px; border-bottom: 1px solid var(--border-default);">
        <span>Check</span><span>Command</span><span>Result</span><span style="text-align: right;">Duration</span>
      </div>
      <div id="verification-checks-list">${checksRowsHtml}</div>
    </div>

    <div>
      <div style="font-weight: 600; font-size: 13.5px; margin-bottom: 8px;">Failure output</div>
      ${failureOutputHtml}
    </div>
  `;
}

/**
 * 4. VERIFICATIONS SCREEN (Step 5 — Canonical Evidence Inspector matching PDF Page 4)
 */
function renderVerificationsScreen(route: RouteMatch): HTMLElement {
  const projectId = route.projectId || '';
  const safeId = escapeHtml(projectId);
  const encodedId = encodeURIComponent(projectId);
  const initialProjectTitle = escapeHtml(formatProjectTitle(projectId));

  const requestedTaskId =
    route.params.taskId && route.params.taskId.trim() ? route.params.taskId.trim() : undefined;
  const requestedAttempt =
    route.params.attempt && Number.isFinite(Number(route.params.attempt))
      ? Number(route.params.attempt)
      : undefined;

  let allItems: DerivedVerificationItem[] = [];
  let handoffsLoaded = true;
  let searchQuery = '';
  let statusFilter = 'ALL';
  let selectedVerifId: string | undefined;
  let explicitDeepLinkMissing = false;

  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';

  wrapper.innerHTML = `
    <nav class="app-breadcrumbs" aria-label="Breadcrumb">
      <a href="#/projects" id="verif-crumb-projects">Projects</a>
      <span class="separator">&gt;</span>
      <a href="#/projects/${encodedId}/overview" id="verif-crumb-project">${initialProjectTitle}</a>
      <span class="separator">/</span>
      <span class="current" id="verif-crumb-current">Verifications</span>
      ${
        requestedTaskId
          ? `<span class="separator">·</span><a href="#/projects/${encodedId}/tasks/${encodeURIComponent(requestedTaskId)}" id="verif-back-to-task-link">← Back to Task #${escapeHtml(requestedTaskId)}</a>`
          : ''
      }
    </nav>

    <div class="page-header">
      <div class="page-header-titles">
        <h1 class="page-title">Verifications</h1>
        <p class="page-subtitle">Independent evidence recorded for each task attempt.</p>
      </div>
    </div>

    <div id="verifications-status-banner" style="display: none;"></div>

    <div class="inspector-split-grid" id="verifications-main-grid">
      <div class="card" style="padding: 22px; display: flex; flex-direction: column; gap: 14px; min-height: 420px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Records</h3>
          <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);">task · attempt</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          <input
            type="search"
            id="verifications-search-input"
            class="input"
            placeholder="Search by task, attempt, check, command..."
            aria-label="Search verification records"
          />
          <div class="filter-pills-row" id="verifications-filter-pills"></div>
        </div>

        <div id="verifications-list-slot" role="listbox" aria-label="Verification records" style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
          <div style="padding: 28px 12px; text-align: center; font-size: 13px; color: var(--text-muted);">
            Loading verification records for <code>${safeId}</code>...
          </div>
        </div>

        <div id="verifications-list-footer" style="padding-top: 8px; border-top: 1px solid var(--border-subtle); font-size: 11.5px; color: var(--text-muted); display: flex; justify-content: space-between;">
          <span>Loading...</span>
          <span>Independent evidence</span>
        </div>
      </div>

      <div class="card" id="verification-detail-panel" style="padding: 22px; display: flex; flex-direction: column; gap: 18px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Record detail</h3>
          <span class="status-badge unverified">Loading</span>
        </div>
        <div style="padding: 36px 16px; text-align: center; font-size: 13px; color: var(--text-muted);">
          Loading verification evidence...
        </div>
      </div>
    </div>

    <div class="card" style="padding: 22px;">
      <h3 class="card-title" style="margin-bottom: 14px;">What each state means</h3>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        <div style="display: grid; grid-template-columns: 200px 1fr; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle);">
          <div><span class="status-badge claimed">◔ CLAIMED</span></div>
          <span style="font-size: 12.5px; color: var(--text-secondary);">Agent reported an outcome; verification not yet attempted.</span>
        </div>
        <div style="display: grid; grid-template-columns: 200px 1fr; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle);">
          <div><span class="status-badge unverified">○ UNVERIFIED</span></div>
          <span style="font-size: 12.5px; color: var(--text-secondary);">No successful verification evidence exists for it.</span>
        </div>
        <div style="display: grid; grid-template-columns: 200px 1fr; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle);">
          <div><span class="status-badge verified">✓ VERIFIED</span></div>
          <span style="font-size: 12.5px; color: var(--text-secondary);">Configured checks passed.</span>
        </div>
        <div style="display: grid; grid-template-columns: 200px 1fr; align-items: center; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle);">
          <div><span class="status-badge failed">✕ FAILED</span></div>
          <span style="font-size: 12.5px; color: var(--text-secondary);">Verification ran and at least one check failed.</span>
        </div>
        <div style="display: grid; grid-template-columns: 200px 1fr; align-items: center;">
          <div><span class="status-badge blocked">! BLOCKED_NEEDS_HUMAN</span></div>
          <span style="font-size: 12.5px; color: var(--text-secondary);">Orchestrator stopped; a person must intervene.</span>
        </div>
      </div>
    </div>
  `;

  wrapper.querySelector('#verif-crumb-projects')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigate('#/projects');
  });
  wrapper.querySelector('#verif-crumb-project')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigateToProject(projectId, 'overview');
  });
  wrapper.querySelector('#verif-back-to-task-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    const href = (e.currentTarget as HTMLAnchorElement).getAttribute('href');
    if (href) router.navigate(href);
  });

  const renderVerificationsView = () => {
    const listSlot = wrapper.querySelector('#verifications-list-slot') as HTMLElement | null;
    const pillsSlot = wrapper.querySelector('#verifications-filter-pills') as HTMLElement | null;
    const footerSlot = wrapper.querySelector('#verifications-list-footer') as HTMLElement | null;
    const detailPanel = wrapper.querySelector('#verification-detail-panel') as HTMLElement | null;
    if (!listSlot || !detailPanel) return;

    const verifiedCount = allItems.filter((i) => i.verification.result.status === 'VERIFIED').length;
    const failedCount = allItems.filter((i) => i.verification.result.status === 'FAILED').length;
    const mismatchedCount = allItems.filter((i) => i.handoffLinkStatus === 'MISMATCHED').length;
    const staleCount = allItems.filter((i) => i.handoffLinkStatus === 'STALE').length;
    const noHandoffCount = allItems.filter((i) => i.handoffLinkStatus === 'NO_HANDOFF').length;

    if (pillsSlot) {
      const pills: Array<{ key: string; label: string }> = [
        { key: 'ALL', label: `All ${allItems.length}` },
        { key: 'VERIFIED', label: `Verified ${verifiedCount}` },
        { key: 'FAILED', label: `Failed ${failedCount}` },
      ];
      if (handoffsLoaded) {
        if (mismatchedCount > 0 || statusFilter === 'MISMATCHED') {
          pills.push({ key: 'MISMATCHED', label: `Mismatched ${mismatchedCount}` });
        }
        if (staleCount > 0 || statusFilter === 'STALE') {
          pills.push({ key: 'STALE', label: `Stale ${staleCount}` });
        }
        if (noHandoffCount > 0 || statusFilter === 'NO_HANDOFF') {
          pills.push({ key: 'NO_HANDOFF', label: `No Handoff ${noHandoffCount}` });
        }
      }
      pillsSlot.innerHTML =
        pills
          .map(
            (p) =>
              `<button type="button" class="filter-pill ${statusFilter === p.key ? 'active' : ''}" data-verif-filter="${p.key}">${escapeHtml(p.label)}</button>`
          )
          .join('') +
        (!handoffsLoaded
          ? `<span style="font-size: 11px; color: var(--status-claimed-text); align-self: center;">Handoffs unavailable</span>`
          : '');
      pillsSlot.querySelectorAll('.filter-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
          statusFilter = btn.getAttribute('data-verif-filter') || 'ALL';
          explicitDeepLinkMissing = false;
          renderVerificationsView();
        });
      });
    }

    if (allItems.length === 0) {
      listSlot.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px;">
          <div style="font-weight: 600; font-size: 13.5px;">No verification records</div>
          <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px; max-width: 220px;">
            Records appear here once a task attempt has been verified.
          </p>
        </div>
      `;
      if (footerSlot) {
        footerSlot.innerHTML = `<span>0 records</span><span>Independent evidence</span>`;
      }
      detailPanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Record detail</h3>
          <span class="status-badge unverified">No records</span>
        </div>
        <div style="padding: 28px 12px; font-size: 13px; color: var(--text-muted); line-height: 1.55;">
          No verification runs have been recorded for project <code>${safeId}</code> yet. When VerificationEngine runs configured checks on a task attempt, its check results and stdout/stderr evidence appear here.
        </div>
      `;
      return;
    }

    const filtered = filterVerificationItems(allItems, searchQuery, statusFilter);
    if (footerSlot) {
      footerSlot.innerHTML = `<span>Showing ${filtered.length} of ${allItems.length}</span><span>Independent evidence</span>`;
    }

    if (filtered.length === 0) {
      listSlot.innerHTML = `
        <div style="padding: 24px 12px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px;">
          <div style="font-size: 12.5px; color: var(--text-muted);">
            No verification records match <code>${escapeHtml(searchQuery || '—')}</code> (${escapeHtml(statusFilter)}).
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="verifications-clear-filters-btn">
            Clear search &amp; filters
          </button>
        </div>
      `;
      listSlot.querySelector('#verifications-clear-filters-btn')?.addEventListener('click', () => {
        searchQuery = '';
        statusFilter = 'ALL';
        const sInput = wrapper.querySelector('#verifications-search-input') as HTMLInputElement | null;
        if (sInput) sInput.value = '';
        renderVerificationsView();
      });
      detailPanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Record detail</h3>
          <span class="status-badge unverified">No matching record</span>
        </div>
        <div style="padding: 24px 12px; font-size: 13px; color: var(--text-muted);">
          No verification records match the current search or filter criteria.
        </div>
      `;
      return;
    }

    if (
      !explicitDeepLinkMissing &&
      (!selectedVerifId || !filtered.some((i) => i.verification.id === selectedVerifId))
    ) {
      selectedVerifId = filtered[0].verification.id;
    }

    listSlot.innerHTML = filtered
      .map((item, idx) => {
        const v = item.verification;
        const isSelected = !explicitDeepLinkMissing && v.id === selectedVerifId;
        const verifTime = v.recordedAt || v.result.executedAt;
        const checksCount = Array.isArray(v.result?.checks) ? v.result.checks.length : 0;
        let handoffLinkBadgeHtml = '';
        if (item.handoffLinkStatus === 'MISMATCHED') {
          handoffLinkBadgeHtml =
            '<span class="status-badge failed" style="font-size: 9.5px; padding: 1px 6px;">MISMATCHED</span>';
        } else if (item.handoffLinkStatus === 'STALE') {
          handoffLinkBadgeHtml =
            '<span class="status-badge failed" style="font-size: 9.5px; padding: 1px 6px;">STALE</span>';
        } else if (item.handoffLinkStatus === 'NO_HANDOFF') {
          handoffLinkBadgeHtml =
            '<span class="status-badge unverified" style="font-size: 9.5px; padding: 1px 6px;">NO HANDOFF</span>';
        } else if (item.handoffLinkStatus === 'HANDOFFS_UNAVAILABLE') {
          handoffLinkBadgeHtml =
            '<span style="font-size: 10px; color: var(--status-claimed-text);">Handoffs unavailable</span>';
        }
        return `
          <button
            type="button"
            role="option"
            aria-selected="${isSelected ? 'true' : 'false'}"
            class="task-attempt-row verif-record-row ${isSelected ? 'selected' : ''}"
            data-verif-index="${idx}"
            data-verif-id="${escapeHtml(v.id)}"
            style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px;"
          >
            <div style="min-width: 0; flex: 1;">
              <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); font-family: var(--font-mono);">
                #${escapeHtml(v.taskId)} · attempt #${Number(v.attemptNumber)}
              </div>
              <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${escapeHtml(v.id)} · ${checksCount} ${checksCount === 1 ? 'check' : 'checks'} · ${escapeHtml(formatDateLabel(verifTime))}
              </div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
              ${renderInlineStatusBadgeHtml(v.result.status)}
              ${handoffLinkBadgeHtml}
            </div>
          </button>
        `;
      })
      .join('');

    const rowEls = Array.from(listSlot.querySelectorAll('.verif-record-row')) as HTMLElement[];
    rowEls.forEach((row, idx) => {
      const selectAt = (targetIdx: number) => {
        const target = filtered[targetIdx];
        if (target) {
          explicitDeepLinkMissing = false;
          selectedVerifId = target.verification.id;
          renderVerificationsView();
        }
      };
      row.addEventListener('click', () => selectAt(idx));
      row.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const nextIdx =
            e.key === 'ArrowDown'
              ? Math.min(filtered.length - 1, idx + 1)
              : Math.max(0, idx - 1);
          selectAt(nextIdx);
        }
      });
    });

    if (explicitDeepLinkMissing && requestedTaskId) {
      const taskHref = `#/projects/${encodedId}/tasks/${encodeURIComponent(requestedTaskId)}`;
      detailPanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Record detail</h3>
          <span class="status-badge unverified">Not found</span>
        </div>
        <div id="verifications-deep-link-missing" style="padding: 20px 12px; display: flex; flex-direction: column; gap: 12px;">
          <div style="font-size: 15px; font-weight: 600; color: var(--text-primary);">
            No verification record found for Task <code>#${escapeHtml(requestedTaskId)}</code>${requestedAttempt !== undefined ? ` attempt <code>#${requestedAttempt}</code>` : ''}
          </div>
          <p style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
            VerificationEngine has not recorded an independent check run for this task${requestedAttempt !== undefined ? ' attempt' : ''} yet, or the requested attempt does not exist in project <code>${safeId}</code>.
          </p>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="verif-select-first-btn">
              Inspect latest verification (#${escapeHtml(filtered[0].verification.taskId)} · attempt #${Number(filtered[0].verification.attemptNumber)})
            </button>
            <a href="${taskHref}" class="btn btn-secondary btn-sm verif-back-task-btn">
              ← Back to Task #${escapeHtml(requestedTaskId)}
            </a>
          </div>
        </div>
      `;
      detailPanel.querySelector('#verif-select-first-btn')?.addEventListener('click', () => {
        explicitDeepLinkMissing = false;
        selectedVerifId = filtered[0].verification.id;
        renderVerificationsView();
      });
      detailPanel.querySelectorAll('.verif-back-task-btn').forEach((link) => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const href = link.getAttribute('href');
          if (href) router.navigate(href);
        });
      });
      return;
    }

    const activeItem =
      filtered.find((i) => i.verification.id === selectedVerifId) ?? filtered[0];
    selectedVerifId = activeItem.verification.id;
    detailPanel.innerHTML = buildVerificationDetailHtml(projectId, activeItem);

    detailPanel
      .querySelectorAll('.verif-open-handoff-link, .verif-back-task-btn')
      .forEach((link) => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const href = link.getAttribute('href');
          if (href) router.navigate(href);
        });
      });
  };

  const searchInput = wrapper.querySelector('#verifications-search-input') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    explicitDeepLinkMissing = false;
    renderVerificationsView();
  });

  const loadVerificationsWorkspace = async () => {
    const statusBanner = wrapper.querySelector('#verifications-status-banner') as HTMLElement | null;
    const mainGrid = wrapper.querySelector('#verifications-main-grid') as HTMLElement | null;
    if (statusBanner) {
      statusBanner.style.display = 'none';
      statusBanner.innerHTML = '';
    }
    if (mainGrid) mainGrid.style.display = 'grid';

    const [projRes, verifsRes, handoffsRes] = await Promise.allSettled([
      engineClient.getProject(projectId),
      engineClient.getVerifications(projectId),
      engineClient.getHandoffs(projectId),
    ]);

    if (projRes.status === 'fulfilled' && projRes.value === null) {
      if (mainGrid) mainGrid.style.display = 'none';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="verifications-not-found" style="padding: 28px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;">
            <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);">Project not found</div>
            <p style="font-size: 13px; color: var(--text-muted); max-width: 420px;">
              Project <code>${safeId}</code> does not exist in the SQLite Project Brain.
            </p>
            <button type="button" class="btn btn-primary btn-md" id="verifications-not-found-back-btn">
              ← Back to All Projects
            </button>
          </div>
        `;
        statusBanner
          .querySelector('#verifications-not-found-back-btn')
          ?.addEventListener('click', () => router.navigate('#/projects'));
      }
      return;
    }

    if (verifsRes.status === 'rejected') {
      if (mainGrid) mainGrid.style.display = 'none';
      const errMsg =
        (verifsRes.reason as Error)?.message || 'Failed to load verification records from Engine.';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="verifications-error-state" style="padding: 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-color: var(--status-failed-border);">
            <div>
              <div style="font-size: 16px; font-weight: 600; color: var(--status-failed-text);">Unable to load Verifications</div>
              <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">${escapeHtml(errMsg)}</p>
            </div>
            <button type="button" class="btn btn-primary btn-md" id="verifications-retry-btn">
              <span>Retry</span><span>↻</span>
            </button>
          </div>
        `;
        statusBanner
          .querySelector('#verifications-retry-btn')
          ?.addEventListener('click', () => void loadVerificationsWorkspace());
      }
      return;
    }

    if (projRes.status === 'fulfilled' && projRes.value) {
      const crumbProj = wrapper.querySelector('#verif-crumb-project');
      if (crumbProj) crumbProj.textContent = projRes.value.name;
    }

    const partialErrors: string[] = [];
    if (projRes.status === 'rejected') {
      partialErrors.push((projRes.reason as Error)?.message || 'Failed to load project metadata.');
    }
    if (handoffsRes.status === 'rejected') {
      partialErrors.push(
        (handoffsRes.reason as Error)?.message ||
          'Failed to load handoff claims (agent claim comparison unavailable).'
      );
    }

    if (partialErrors.length > 0 && statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div class="callout-banner" id="verifications-partial-banner" style="justify-content: space-between; border-color: var(--status-claimed-border); background: var(--status-claimed-bg); color: var(--status-claimed-text);">
          <span><strong>Partial data loaded:</strong> ${escapeHtml(partialErrors.join(' · '))}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="verifications-partial-retry-btn">Retry ↻</button>
        </div>
      `;
      statusBanner
        .querySelector('#verifications-partial-retry-btn')
        ?.addEventListener('click', () => void loadVerificationsWorkspace());
    }

    const handoffsAvailable = handoffsRes.status === 'fulfilled';
    handoffsLoaded = handoffsAvailable;
    allItems = deriveVerificationItems(
      projectId,
      verifsRes.value,
      handoffsAvailable ? handoffsRes.value : [],
      handoffsAvailable
    );

    if (requestedTaskId && allItems.length > 0) {
      const matched = allItems.find(
        (i) =>
          i.verification.taskId.trim() === requestedTaskId &&
          (requestedAttempt === undefined ||
            Number(i.verification.attemptNumber) === requestedAttempt)
      );
      if (matched) {
        selectedVerifId = matched.verification.id;
        explicitDeepLinkMissing = false;
      } else {
        explicitDeepLinkMissing = true;
      }
    }

    renderVerificationsView();
  };

  void loadVerificationsWorkspace();

  return wrapper;
}

/**
 * 5. HANDOFF INSPECTOR SCREEN (Step 5 — Canonical Agent Claim Inspector matching PDF Page 5)
 */
function renderHandoffsScreen(route: RouteMatch): HTMLElement {
  const projectId = route.projectId || '';
  const safeId = escapeHtml(projectId);
  const encodedId = encodeURIComponent(projectId);
  const initialProjectTitle = escapeHtml(formatProjectTitle(projectId));

  const requestedTaskId =
    route.params.taskId && route.params.taskId.trim() ? route.params.taskId.trim() : undefined;
  const requestedAttempt =
    route.params.attempt && Number.isFinite(Number(route.params.attempt))
      ? Number(route.params.attempt)
      : undefined;

  let allItems: DerivedHandoffItem[] = [];
  let verificationsLoaded = true;
  let searchQuery = '';
  let outcomeFilter = 'ALL';
  let selectedHandoffId: string | undefined;
  let explicitDeepLinkMissing = false;

  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';

  wrapper.innerHTML = `
    <nav class="app-breadcrumbs" aria-label="Breadcrumb">
      <a href="#/projects" id="handoff-crumb-projects">Projects</a>
      <span class="separator">&gt;</span>
      <a href="#/projects/${encodedId}/overview" id="handoff-crumb-project">${initialProjectTitle}</a>
      <span class="separator">/</span>
      <span class="current" id="handoff-crumb-current">Handoffs</span>
      ${
        requestedTaskId
          ? `<span class="separator">·</span><a href="#/projects/${encodedId}/tasks/${encodeURIComponent(requestedTaskId)}" id="handoff-back-to-task-link">← Back to Task #${escapeHtml(requestedTaskId)}</a>`
          : ''
      }
    </nav>

    <div class="page-header">
      <div class="page-header-titles">
        <h1 class="page-title">Handoff inspector</h1>
        <p class="page-subtitle">What an agent reported about a task attempt — a claim, not evidence.</p>
      </div>
    </div>

    <div id="handoffs-status-banner" style="display: none;"></div>

    <div class="inspector-split-grid" id="handoffs-main-grid">
      <div class="card" style="padding: 22px; display: flex; flex-direction: column; gap: 14px; min-height: 420px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Handoffs</h3>
          <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);">task · attempt</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          <input
            type="search"
            id="handoffs-search-input"
            class="input"
            placeholder="Search by task, attempt, summary, file, agent..."
            aria-label="Search handoff records"
          />
          <div class="filter-pills-row" id="handoffs-filter-pills"></div>
        </div>

        <div id="handoffs-list-slot" role="listbox" aria-label="Recorded handoffs" style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
          <div style="padding: 28px 12px; text-align: center; font-size: 13px; color: var(--text-muted);">
            Loading handoff claims for <code>${safeId}</code>...
          </div>
        </div>

        <div id="handoffs-list-footer" style="padding-top: 8px; border-top: 1px solid var(--border-subtle); font-size: 11.5px; color: var(--text-muted); display: flex; justify-content: space-between;">
          <span>Loading...</span>
          <span>Agent claims (untrusted)</span>
        </div>
      </div>

      <div class="card" id="handoff-detail-panel" style="padding: 24px; display: flex; flex-direction: column; gap: 20px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Handoff detail</h3>
          <span class="status-badge claimed">◔ CLAIMED</span>
        </div>
        <div style="padding: 36px 16px; text-align: center; font-size: 13px; color: var(--text-muted);">
          Loading handoff details...
        </div>
      </div>
    </div>
  `;

  wrapper.querySelector('#handoff-crumb-projects')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigate('#/projects');
  });
  wrapper.querySelector('#handoff-crumb-project')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigateToProject(projectId, 'overview');
  });
  wrapper.querySelector('#handoff-back-to-task-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    const href = (e.currentTarget as HTMLAnchorElement).getAttribute('href');
    if (href) router.navigate(href);
  });

  const renderHandoffsView = () => {
    const listSlot = wrapper.querySelector('#handoffs-list-slot') as HTMLElement | null;
    const pillsSlot = wrapper.querySelector('#handoffs-filter-pills') as HTMLElement | null;
    const footerSlot = wrapper.querySelector('#handoffs-list-footer') as HTMLElement | null;
    const detailPanel = wrapper.querySelector('#handoff-detail-panel') as HTMLElement | null;
    if (!listSlot || !detailPanel) return;

    const verifiedCount = allItems.filter((i) => i.attemptTrustState === 'VERIFIED').length;
    const failedCount = allItems.filter((i) => i.attemptTrustState === 'FAILED').length;
    const unverifiedCount = allItems.filter(
      (i) => i.attemptTrustState === 'CLAIMED' && !i.verificationRejectedReason
    ).length;
    const mismatchedCount = allItems.filter(
      (i) => i.verificationRejectedKind === 'MISMATCHED'
    ).length;
    const staleCount = allItems.filter((i) => i.verificationRejectedKind === 'STALE').length;

    if (pillsSlot) {
      if (!verificationsLoaded) {
        pillsSlot.innerHTML = `
          <button type="button" class="filter-pill active" data-handoff-filter="ALL">All ${allItems.length}</button>
          <span style="font-size: 11px; color: var(--status-claimed-text); align-self: center;">Verification outcomes unavailable</span>
        `;
      } else {
        const pills: Array<{ key: string; label: string }> = [
          { key: 'ALL', label: `All ${allItems.length}` },
          { key: 'VERIFIED', label: `Verified ${verifiedCount}` },
          { key: 'FAILED', label: `Failed ${failedCount}` },
          { key: 'UNVERIFIED', label: `Unverified ${unverifiedCount}` },
        ];
        if (mismatchedCount > 0 || outcomeFilter === 'MISMATCHED') {
          pills.push({ key: 'MISMATCHED', label: `Mismatched ${mismatchedCount}` });
        }
        if (staleCount > 0 || outcomeFilter === 'STALE') {
          pills.push({ key: 'STALE', label: `Stale ${staleCount}` });
        }
        pillsSlot.innerHTML = pills
          .map(
            (p) =>
              `<button type="button" class="filter-pill ${outcomeFilter === p.key ? 'active' : ''}" data-handoff-filter="${p.key}">${escapeHtml(p.label)}</button>`
          )
          .join('');
      }
      pillsSlot.querySelectorAll('.filter-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
          outcomeFilter = btn.getAttribute('data-handoff-filter') || 'ALL';
          explicitDeepLinkMissing = false;
          renderHandoffsView();
        });
      });
    }

    if (allItems.length === 0) {
      listSlot.innerHTML = `
        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px;">
          <div style="font-weight: 600; font-size: 13.5px;">No handoffs recorded</div>
          <p style="font-size: 12px; color: var(--text-muted); margin-top: 4px; max-width: 220px;">
            Handoffs appear once an agent reports on a task attempt.
          </p>
        </div>
      `;
      if (footerSlot) {
        footerSlot.innerHTML = `<span>0 handoffs</span><span>Agent claims (untrusted)</span>`;
      }
      detailPanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Handoff detail</h3>
          <span class="status-badge unverified">No handoffs</span>
        </div>
        <div style="padding: 28px 12px; font-size: 13px; color: var(--text-muted); line-height: 1.55;">
          No agent handoff claims have been recorded for project <code>${safeId}</code> yet.
        </div>
      `;
      return;
    }

    const filtered = filterHandoffItems(allItems, searchQuery, outcomeFilter);
    if (footerSlot) {
      footerSlot.innerHTML = `<span>Showing ${filtered.length} of ${allItems.length}</span><span>Agent claims (untrusted)</span>`;
    }

    if (filtered.length === 0) {
      listSlot.innerHTML = `
        <div style="padding: 24px 12px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px;">
          <div style="font-size: 12.5px; color: var(--text-muted);">
            No handoffs match <code>${escapeHtml(searchQuery || '—')}</code> (${escapeHtml(outcomeFilter)}).
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="handoffs-clear-filters-btn">
            Clear search &amp; filters
          </button>
        </div>
      `;
      listSlot.querySelector('#handoffs-clear-filters-btn')?.addEventListener('click', () => {
        searchQuery = '';
        outcomeFilter = 'ALL';
        const sInput = wrapper.querySelector('#handoffs-search-input') as HTMLInputElement | null;
        if (sInput) sInput.value = '';
        renderHandoffsView();
      });
      detailPanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Handoff detail</h3>
          <span class="status-badge unverified">No matching handoff</span>
        </div>
        <div style="padding: 24px 12px; font-size: 13px; color: var(--text-muted);">
          No recorded handoffs match the current search or filter criteria.
        </div>
      `;
      return;
    }

    if (
      !explicitDeepLinkMissing &&
      (!selectedHandoffId || !filtered.some((i) => i.handoff.id === selectedHandoffId))
    ) {
      selectedHandoffId = filtered[0].handoff.id;
    }

    listSlot.innerHTML = filtered
      .map((item, idx) => {
        const h = item.handoff;
        const isSelected = !explicitDeepLinkMissing && h.id === selectedHandoffId;
        let verifNoteHtml = '';
        if (!item.verificationsAvailable) {
          verifNoteHtml = `<span style="font-size: 10.5px; color: var(--status-claimed-text);">Verifications unavailable</span>`;
        } else if (item.relatedVerification) {
          const isPass = item.relatedVerification.result.status === 'VERIFIED';
          verifNoteHtml = `<span style="font-size: 10.5px; font-family: var(--font-mono); color: ${isPass ? 'var(--status-verified-text)' : 'var(--status-failed-text)'};">${isPass ? '✓ VERIFIED' : '✕ FAILED'}</span>`;
        } else if (item.verificationRejectedKind === 'STALE') {
          verifNoteHtml = `<span style="font-size: 10.5px; font-family: var(--font-mono); color: var(--status-failed-text);">! STALE</span>`;
        } else if (item.verificationRejectedReason) {
          verifNoteHtml = `<span style="font-size: 10.5px; font-family: var(--font-mono); color: var(--status-failed-text);">! MISMATCHED</span>`;
        } else {
          verifNoteHtml = `<span style="font-size: 10.5px; color: var(--text-muted);">○ UNVERIFIED</span>`;
        }

        return `
          <button
            type="button"
            role="option"
            aria-selected="${isSelected ? 'true' : 'false'}"
            class="task-attempt-row handoff-record-row ${isSelected ? 'selected' : ''}"
            data-handoff-index="${idx}"
            data-handoff-id="${escapeHtml(h.id)}"
            style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px;"
          >
            <div style="min-width: 0; flex: 1;">
              <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); font-family: var(--font-mono);">
                #${escapeHtml(h.taskId)} · attempt #${Number(h.attemptNumber)}
              </div>
              <div class="line-clamp-2" style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px; line-height: 1.4;" title="${escapeHtml(stripMarkdownFormatting(h.summary))}">
                ${escapeHtml(formatSummaryPreview(h.summary, 120))}
              </div>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                ${escapeHtml(formatDateLabel(h.createdAt))}${h.agentId ? ` · ${escapeHtml(h.agentId)}` : ''}
              </div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0;">
              <span class="status-badge claimed">◔ CLAIMED</span>
              ${verifNoteHtml}
            </div>
          </button>
        `;
      })
      .join('');

    const rowEls = Array.from(listSlot.querySelectorAll('.handoff-record-row')) as HTMLElement[];
    rowEls.forEach((row, idx) => {
      const selectAt = (targetIdx: number) => {
        const target = filtered[targetIdx];
        if (target) {
          explicitDeepLinkMissing = false;
          selectedHandoffId = target.handoff.id;
          renderHandoffsView();
        }
      };
      row.addEventListener('click', () => selectAt(idx));
      row.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const nextIdx =
            e.key === 'ArrowDown'
              ? Math.min(filtered.length - 1, idx + 1)
              : Math.max(0, idx - 1);
          selectAt(nextIdx);
        }
      });
    });

    if (explicitDeepLinkMissing && requestedTaskId) {
      const taskHref = `#/projects/${encodedId}/tasks/${encodeURIComponent(requestedTaskId)}`;
      detailPanel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <h3 class="card-title">Handoff detail</h3>
          <span class="status-badge unverified">Not found</span>
        </div>
        <div id="handoffs-deep-link-missing" style="padding: 20px 12px; display: flex; flex-direction: column; gap: 12px;">
          <div style="font-size: 15px; font-weight: 600; color: var(--text-primary);">
            No handoff claim found for Task <code>#${escapeHtml(requestedTaskId)}</code>${requestedAttempt !== undefined ? ` attempt <code>#${requestedAttempt}</code>` : ''}
          </div>
          <p style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
            No agent handoff record exists for this task${requestedAttempt !== undefined ? ' attempt' : ''} in project <code>${safeId}</code>.
          </p>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="handoff-select-first-btn">
              Inspect latest handoff (#${escapeHtml(filtered[0].handoff.taskId)} · attempt #${Number(filtered[0].handoff.attemptNumber)})
            </button>
            <a href="${taskHref}" class="btn btn-secondary btn-sm handoff-back-task-btn">
              ← Back to Task #${escapeHtml(requestedTaskId)}
            </a>
          </div>
        </div>
      `;
      detailPanel.querySelector('#handoff-select-first-btn')?.addEventListener('click', () => {
        explicitDeepLinkMissing = false;
        selectedHandoffId = filtered[0].handoff.id;
        renderHandoffsView();
      });
      detailPanel.querySelectorAll('.handoff-back-task-btn').forEach((link) => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const href = link.getAttribute('href');
          if (href) router.navigate(href);
        });
      });
      return;
    }

    const activeItem =
      filtered.find((i) => i.handoff.id === selectedHandoffId) ?? filtered[0];
    selectedHandoffId = activeItem.handoff.id;
    detailPanel.innerHTML = buildHandoffDetailHtml(projectId, activeItem);

    detailPanel
      .querySelectorAll('.handoff-open-verifications-link, .handoff-back-task-btn')
      .forEach((link) => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const href = link.getAttribute('href');
          if (href) router.navigate(href);
        });
      });
  };

  const searchInput = wrapper.querySelector('#handoffs-search-input') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    explicitDeepLinkMissing = false;
    renderHandoffsView();
  });

  const loadHandoffsWorkspace = async () => {
    const statusBanner = wrapper.querySelector('#handoffs-status-banner') as HTMLElement | null;
    const mainGrid = wrapper.querySelector('#handoffs-main-grid') as HTMLElement | null;
    if (statusBanner) {
      statusBanner.style.display = 'none';
      statusBanner.innerHTML = '';
    }
    if (mainGrid) mainGrid.style.display = 'grid';

    const [projRes, handoffsRes, verifsRes, tasksRes, repoRes] = await Promise.allSettled([
      engineClient.getProject(projectId),
      engineClient.getHandoffs(projectId),
      engineClient.getVerifications(projectId),
      engineClient.listTasks(projectId),
      engineClient.getRepositoryStatus(projectId),
    ]);

    if (projRes.status === 'fulfilled' && projRes.value === null) {
      if (mainGrid) mainGrid.style.display = 'none';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="handoffs-not-found" style="padding: 28px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;">
            <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);">Project not found</div>
            <p style="font-size: 13px; color: var(--text-muted); max-width: 420px;">
              Project <code>${safeId}</code> does not exist in the SQLite Project Brain.
            </p>
            <button type="button" class="btn btn-primary btn-md" id="handoffs-not-found-back-btn">
              ← Back to All Projects
            </button>
          </div>
        `;
        statusBanner
          .querySelector('#handoffs-not-found-back-btn')
          ?.addEventListener('click', () => router.navigate('#/projects'));
      }
      return;
    }

    if (handoffsRes.status === 'rejected') {
      if (mainGrid) mainGrid.style.display = 'none';
      const errMsg =
        (handoffsRes.reason as Error)?.message || 'Failed to load handoff records from Engine.';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="handoffs-error-state" style="padding: 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-color: var(--status-failed-border);">
            <div>
              <div style="font-size: 16px; font-weight: 600; color: var(--status-failed-text);">Unable to load Handoffs</div>
              <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">${escapeHtml(errMsg)}</p>
            </div>
            <button type="button" class="btn btn-primary btn-md" id="handoffs-retry-btn">
              <span>Retry</span><span>↻</span>
            </button>
          </div>
        `;
        statusBanner
          .querySelector('#handoffs-retry-btn')
          ?.addEventListener('click', () => void loadHandoffsWorkspace());
      }
      return;
    }

    if (projRes.status === 'fulfilled' && projRes.value) {
      const crumbProj = wrapper.querySelector('#handoff-crumb-project');
      if (crumbProj) crumbProj.textContent = projRes.value.name;
    }

    const partialErrors: string[] = [];
    if (projRes.status === 'rejected') {
      partialErrors.push((projRes.reason as Error)?.message || 'Failed to load project metadata.');
    }
    if (verifsRes.status === 'rejected') {
      partialErrors.push(
        (verifsRes.reason as Error)?.message ||
          'Failed to load verification records (related verification status unavailable).'
      );
    }

    if (partialErrors.length > 0 && statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div class="callout-banner" id="handoffs-partial-banner" style="justify-content: space-between; border-color: var(--status-claimed-border); background: var(--status-claimed-bg); color: var(--status-claimed-text);">
          <span><strong>Partial data loaded:</strong> ${escapeHtml(partialErrors.join(' · '))}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="handoffs-partial-retry-btn">Retry ↻</button>
        </div>
      `;
      statusBanner
        .querySelector('#handoffs-partial-retry-btn')
        ?.addEventListener('click', () => void loadHandoffsWorkspace());
    }

    const verificationsAvailable = verifsRes.status === 'fulfilled';
    verificationsLoaded = verificationsAvailable;
    allItems = deriveHandoffItems(
      projectId,
      handoffsRes.value,
      verificationsAvailable ? verifsRes.value : [],
      verificationsAvailable
    );

    if (requestedTaskId && allItems.length > 0) {
      const matched = allItems.find(
        (i) =>
          i.handoff.taskId.trim() === requestedTaskId &&
          (requestedAttempt === undefined || Number(i.handoff.attemptNumber) === requestedAttempt)
      );
      if (matched) {
        selectedHandoffId = matched.handoff.id;
        explicitDeepLinkMissing = false;
      } else {
        explicitDeepLinkMissing = true;
      }
    }

    renderHandoffsView();
  };

  void loadHandoffsWorkspace();

  return wrapper;
}

/**
 * Pure filter helper for Task Explorer search and status filtering.
 * Uses the exact DerivedTaskSummary records produced by deriveProjectOverviewModel.
 */
export function filterDerivedTasks(
  tasks: readonly DerivedTaskSummary[],
  searchQuery: string,
  statusFilter: string
): DerivedTaskSummary[] {
  const normalizedStatus = (statusFilter || 'ALL').trim().toUpperCase();
  const q = (searchQuery || '').trim().toLowerCase();

  return tasks.filter((task) => {
    if (normalizedStatus !== 'ALL' && task.trustState !== normalizedStatus) {
      return false;
    }
    if (!q) {
      return true;
    }
    if (task.taskId.toLowerCase().includes(q) || task.summary.toLowerCase().includes(q)) {
      return true;
    }
    return task.attempts.some((att) => {
      if (att.summary.toLowerCase().includes(q)) return true;
      if (att.handoff?.changes && att.handoff.changes.toLowerCase().includes(q)) return true;
      if (
        Array.isArray(att.handoff?.filesAffected) &&
        att.handoff.filesAffected.some((f) => f.toLowerCase().includes(q))
      ) {
        return true;
      }
      return false;
    });
  });
}

/**
 * Pure HTML builder for the Task Detail investigation panel.
 * Renders chronological attempts, agent claims vs. independent verification evidence,
 * check tables, failure stdout/stderr, explicit blocked state, and related record links.
 */
export function buildTaskDetailHtml(
  projectId: string,
  task: DerivedTaskSummary,
  selectedAttemptNumber?: number
): string {
  const trimmedProjectId = (projectId || '').trim();
  const trimmedTaskId = (task.taskId || '').trim();
  const encodedProjectId = encodeURIComponent(trimmedProjectId);
  const encodedTaskId = encodeURIComponent(trimmedTaskId);
  const canLinkContext = Boolean(trimmedProjectId && trimmedTaskId);
  const contextHref = canLinkContext
    ? `#/projects/${encodedProjectId}/context?targetTaskId=${encodedTaskId}`
    : '';

  const targetAttemptNum =
    selectedAttemptNumber !== undefined ? Number(selectedAttemptNumber) : task.highestAttempt;
  const selectedAttempt =
    task.attempts.find((a) => a.attemptNumber === targetAttemptNum) ??
    task.attempts[task.attempts.length - 1];

  const blockedBannerHtml =
    task.trustState === 'BLOCKED_NEEDS_HUMAN'
      ? `
      <div id="task-detail-blocked-banner" style="border: 1.5px solid var(--status-blocked-border); background: var(--status-blocked-bg); border-radius: 12px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          ${renderInlineStatusBadgeHtml('BLOCKED_NEEDS_HUMAN')}
          <span style="font-size: 12.5px; color: var(--status-blocked-text); font-weight: 500;">
            Orchestrator stopped autonomous execution for this task. Human intervention is required.
          </span>
        </div>
        <span style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Explicitly recorded</span>
      </div>
    `
      : '';

  const attemptsRowsHtml =
    task.attempts.length === 0
      ? `
        <div style="font-size: 12.5px; color: var(--text-muted); padding: 8px 0;">
          No attempts recorded for this task yet.
        </div>
      `
      : task.attempts
          .map((att) => {
            const isSelected = selectedAttempt?.attemptNumber === att.attemptNumber;
            return `
              <button
                type="button"
                class="task-attempt-row ${isSelected ? 'selected' : ''}"
                data-attempt-number="${Number(att.attemptNumber)}"
                aria-pressed="${isSelected ? 'true' : 'false'}"
              >
                <span style="font-family: var(--font-mono); font-weight: 600; font-size: 12.5px; color: var(--text-primary);">#${Number(att.attemptNumber)}</span>
                <span>${renderInlineStatusBadgeHtml(att.trustState)}</span>
                <span style="font-size: 12px; color: var(--text-muted);">${escapeHtml(formatDateLabel(att.timestamp))}</span>
                <span style="font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(att.summary)}</span>
              </button>
            `;
          })
          .join('');

  let attemptInspectorHtml = '';
  if (selectedAttempt) {
    const attNum = Number(selectedAttempt.attemptNumber);
    const isLatestAttempt = attNum === task.highestAttempt;
    const h = selectedAttempt.handoff;
    const v = selectedAttempt.verification;

    // 1. Agent Claim Card
    let claimBodyHtml = '';
    if (h) {
      const files = Array.isArray(h.filesAffected) ? h.filesAffected : [];
      const decisions = Array.isArray(h.decisionsCreated) ? h.decisionsCreated : [];
      const assumptions = Array.isArray(h.assumptions) ? h.assumptions : [];
      const limitations = Array.isArray(h.limitations) ? h.limitations : [];

      claimBodyHtml = `
        <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45;">
          <strong>Summary:</strong> ${escapeHtml(h.summary || 'No summary provided')}
        </div>
        ${
          h.changes
            ? `<div style="font-size: 11.5px; color: var(--text-muted); line-height: 1.4;"><strong>Changes:</strong> ${escapeHtml(h.changes)}</div>`
            : ''
        }
        <div style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">
          Handoff <code>${escapeHtml(h.id)}</code> · ${escapeHtml(formatDateLabel(h.createdAt))}
          ${h.agentId || h.model ? ` · ${escapeHtml([h.agentId, h.model].filter(Boolean).join(' / '))}` : ''}
        </div>
        <div>
          <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); margin-bottom: 4px;">
            FILES AFFECTED (${files.length})
          </div>
          ${
            files.length === 0
              ? '<div style="font-size: 11.5px; color: var(--text-muted);">None listed</div>'
              : `<div style="max-height: 110px; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0;">
                  ${files
                    .map(
                      (file) =>
                        `<code style="font-family: var(--font-mono); font-size: 11px; padding: 2px 6px; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 5px; color: var(--text-primary);">${escapeHtml(file)}</code>`
                    )
                    .join('')}
                </div>`
          }
        </div>
        ${
          decisions.length > 0 || assumptions.length > 0 || limitations.length > 0
            ? `<div style="font-size: 11px; color: var(--text-muted);">
                ${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} · ${assumptions.length} ${assumptions.length === 1 ? 'assumption' : 'assumptions'} · ${limitations.length} ${limitations.length === 1 ? 'limitation' : 'limitations'}
              </div>`
            : ''
        }
        <div style="margin-top: auto; padding-top: 6px;">
          <a href="#/projects/${encodedProjectId}/handoffs?taskId=${encodedTaskId}&attempt=${attNum}" class="task-detail-handoff-link" data-nav-section="handoffs" style="font-size: 12px; font-weight: 600; color: var(--text-primary);">
            Open handoff →
          </a>
        </div>
      `;
    } else {
      claimBodyHtml = `
        <div style="font-size: 12px; color: var(--text-muted); line-height: 1.45;">
          No agent handoff claim was recorded for attempt #${attNum}.
        </div>
      `;
    }

    // 2. Independent Verification Card
    let verifBodyHtml = '';
    if (v) {
      const verifTime = v.recordedAt || v.result.executedAt;
      verifBodyHtml = `
        <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45;">
          <strong>Verification ID:</strong> <code style="font-family: var(--font-mono); font-size: 11px;">${escapeHtml(v.id)}</code>
          ${v.handoffId ? `<span style="color: var(--text-muted);"> (checked handoff <code>${escapeHtml(v.handoffId)}</code>)</span>` : ''}
        </div>
        <div style="font-size: 11.5px; color: var(--text-muted);">
          Executed ${escapeHtml(formatDateLabel(verifTime))} · Total duration ${escapeHtml(formatDuration(v.result.totalDurationMs))}
        </div>
        <div style="font-size: 11px; color: var(--text-muted); background: var(--bg-subtle); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-subtle);">
          Checked attempt #${attNum} at ${escapeHtml(formatDateLabel(verifTime))}. Code revision SHA is not persisted in schema.
        </div>
        <div style="margin-top: auto; padding-top: 6px;">
          <a href="#/projects/${encodedProjectId}/verifications?taskId=${encodedTaskId}&attempt=${attNum}" class="task-detail-verif-link" data-nav-section="verifications" style="font-size: 12px; font-weight: 600; color: var(--text-primary);">
            Open in Verifications →
          </a>
        </div>
      `;
    } else if (selectedAttempt.verificationRejectedReason) {
      verifBodyHtml = `
        <div style="font-size: 12px; color: var(--status-failed-text); background: var(--status-failed-bg); border: 1px solid var(--status-failed-border); border-radius: 8px; padding: 8px 10px; line-height: 1.45;">
          <strong>Stale or mismatched verification ignored:</strong> ${escapeHtml(selectedAttempt.verificationRejectedReason)}
        </div>
        <div style="margin-top: auto; padding-top: 6px;">
          <a href="#/projects/${encodedProjectId}/verifications?taskId=${encodedTaskId}&attempt=${attNum}" class="task-detail-verif-link" data-nav-section="verifications" style="font-size: 12px; font-weight: 600; color: var(--text-primary);">
            Inspect raw verifications →
          </a>
        </div>
      `;
    } else {
      verifBodyHtml = `
        <div style="font-size: 12px; color: var(--text-muted); line-height: 1.45;">
          No independent verification record exists for attempt #${attNum} yet. Agent claims remain <strong>CLAIMED</strong> until VerificationEngine evaluates configured checks.
        </div>
      `;
    }

    // 3. Checks Table
    const checks = v?.result?.checks ?? [];
    const checksRowsHtml =
      checks.length === 0
        ? `
          <div style="font-size: 12px; color: var(--text-muted); padding: 10px 0;">
            ${v ? 'No individual check entries recorded in this verification payload.' : `No verification checks executed for attempt #${attNum}.`}
          </div>
        `
        : checks
            .map((c, idx) => {
              const cmdText =
                Array.isArray(c.args) && c.args.length > 0
                  ? `${c.command} ${c.args.join(' ')}`
                  : c.command;
              const passed = Boolean(c.passed);
              const color = passed ? 'var(--status-verified-text)' : 'var(--status-failed-text)';
              const icon = passed ? '✓' : '✕';
              return `
                <div style="display: grid; grid-template-columns: 1.1fr 1.8fr 0.9fr 0.7fr; gap: 10px; align-items: center; font-size: 12px; padding: 8px 0; ${idx < checks.length - 1 ? 'border-bottom: 1px solid var(--border-subtle);' : ''}">
                  <div style="font-weight: 600; color: var(--text-primary);">
                    <span style="color: ${color}; font-weight: 700; margin-right: 4px;">${icon}</span>${escapeHtml(c.name)}
                  </div>
                  <code style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(cmdText)}</code>
                  <span style="font-family: var(--font-mono); font-size: 11px; color: ${color};">
                    ${passed ? 'PASSED' : 'FAILED'}${c.exitCode !== null && c.exitCode !== undefined ? ` (exit ${Number(c.exitCode)})` : ''}
                  </span>
                  <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-align: right;">
                    ${escapeHtml(formatDuration(c.durationMs))}
                  </span>
                </div>
              `;
            })
            .join('');

    // 4. Failure Output (from actual recorded evidence)
    const failedChecks = checks.filter((c) => !c.passed);
    let failureDetailsHtml = '';
    if (!v) {
      failureDetailsHtml = `<div class="mono-code-box" style="color: var(--text-muted);">No verification evidence recorded for attempt #${attNum}.</div>`;
    } else if (failedChecks.length === 0 && v.result.status === 'VERIFIED') {
      failureDetailsHtml = `<div class="mono-code-box" style="color: var(--status-verified-text);">All configured checks passed on attempt #${attNum}. No failure output recorded.</div>`;
    } else if (failedChecks.length === 0) {
      failureDetailsHtml = `<div class="mono-code-box" style="color: var(--status-failed-text);">Verification status is FAILED on attempt #${attNum}, with no individual failed check output recorded.</div>`;
    } else {
      const outputBlocks = failedChecks.map((fc) => {
        const stderr = (fc.stderr || '').trim();
        const stdout = (fc.stdout || '').trim();
        const combined = [
          `# ${fc.name} (${fc.command}${Array.isArray(fc.args) && fc.args.length ? ' ' + fc.args.join(' ') : ''}) — exit code ${fc.exitCode ?? '—'}`,
          stderr ? `[stderr]\n${stderr}` : '',
          stdout ? `[stdout]\n${stdout}` : '',
          !stderr && !stdout ? '(No stdout or stderr output captured by check runner)' : '',
        ]
          .filter(Boolean)
          .join('\n');
        return escapeHtml(combined);
      });
      failureDetailsHtml = `<div class="mono-code-box" id="task-detail-failure-output" style="max-height: 240px; overflow-y: auto; color: var(--status-failed-text);">${outputBlocks.join('\n\n')}</div>`;
    }

    attemptInspectorHtml = `
      <div style="border-top: 1px solid var(--border-default); padding-top: 16px; display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <h4 style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0;">
              Attempt #${attNum} investigation
            </h4>
            <span style="font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--bg-subtle); border: 1px solid var(--border-default); color: var(--text-secondary);">
              ${isLatestAttempt ? 'Latest attempt · governs task trust state' : `Historical attempt · superseded by #${Number(task.highestAttempt)}`}
            </span>
          </div>
          ${
            canLinkContext
              ? `<a href="${contextHref}" class="task-detail-context-link" style="font-size: 12px; font-weight: 600; color: var(--brand-blue);">Compiled context for this task →</a>`
              : ''
          }
        </div>

        <div class="task-detail-claim-vs-evidence">
          <div style="border: 1px dashed var(--border-strong); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">Agent claim (untrusted)</span>
              ${h ? renderInlineStatusBadgeHtml('CLAIMED') : '<span class="status-badge unverified">NO HANDOFF</span>'}
            </div>
            ${claimBodyHtml}
          </div>

          <div style="border: 1.5px solid var(--border-active-card); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">Independent verification</span>
              ${renderInlineStatusBadgeHtml(v ? v.result.status : 'UNVERIFIED')}
            </div>
            ${verifBodyHtml}
          </div>
        </div>

        <div>
          <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 6px;">
            Verification checks (Attempt #${attNum})
          </div>
          <div style="display: grid; grid-template-columns: 1.1fr 1.8fr 0.9fr 0.7fr; gap: 10px; font-size: 11px; font-weight: 600; color: var(--text-muted); padding-bottom: 6px; border-bottom: 1px solid var(--border-default);">
            <span>Check</span><span>Command</span><span>Result</span><span style="text-align: right;">Duration</span>
          </div>
          <div>${checksRowsHtml}</div>
        </div>

        <div>
          <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 6px;">
            Failure details (Attempt #${attNum})
          </div>
          ${failureDetailsHtml}
        </div>
      </div>
    `;
  }

  const timelineHtml = `
    <div id="task-detail-timeline-container" class="timeline-container" style="display: ${Array.isArray(task.executionTimeline) && task.executionTimeline.length > 0 ? 'flex' : 'none'}; flex-direction: column; gap: 10px; border-top: 1px solid var(--border-subtle); padding-top: 14px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px;">
        <span style="font-size: 12.5px; font-weight: 650; color: var(--text-primary);">Execution Activity (4-Phase Autonomous Pipeline)</span>
        <span id="live-timeline-status-badge" style="font-size: 11px; font-weight: 600; color: var(--text-muted);">
          ${task.trustState === 'VERIFIED' ? '✓ Verified' : task.trustState === 'FAILED' ? '✕ Failed' : 'Idle'}
        </span>
      </div>

      <!-- 4-Phase Stepper -->
      <div id="execution-timeline-stepper" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 4px;">
        <div class="stepper-step" id="step-phase-plan" style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; padding: 6px 10px; background: var(--bg-subtle); border-radius: 6px; border: 1px solid var(--border-default); color: var(--text-secondary);">
          <span class="step-circle" style="width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; background: #e2e8f0; color: #475569;">1</span>
          <span>Plan</span>
        </div>
        <div class="stepper-step" id="step-phase-implement" style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; padding: 6px 10px; background: var(--bg-subtle); border-radius: 6px; border: 1px solid var(--border-default); color: var(--text-secondary);">
          <span class="step-circle" style="width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; background: #e2e8f0; color: #475569;">2</span>
          <span>Implement</span>
        </div>
        <div class="stepper-step" id="step-phase-review" style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; padding: 6px 10px; background: var(--bg-subtle); border-radius: 6px; border: 1px solid var(--border-default); color: var(--text-secondary);">
          <span class="step-circle" style="width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; background: #e2e8f0; color: #475569;">3</span>
          <span>Review</span>
        </div>
        <div class="stepper-step" id="step-phase-verify" style="display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; padding: 6px 10px; background: var(--bg-subtle); border-radius: 6px; border: 1px solid var(--border-default); color: var(--text-secondary);">
          <span class="step-circle" style="width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; background: #e2e8f0; color: #475569;">4</span>
          <span>Verify</span>
        </div>
      </div>

      <!-- Active Status Line -->
      <div id="live-timeline-active-status" style="display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-secondary); padding: 6px 10px; background: var(--bg-subtle); border-radius: 6px; border-left: 3px solid var(--brand-blue);">
        <span class="status-dot" style="width: 7px; height: 7px; border-radius: 50%; background: var(--brand-blue); display: inline-block;"></span>
        <span id="live-timeline-status-text">${task.trustState === 'VERIFIED' ? 'Task execution complete · Verified by independent test runner' : 'Standing by for execution'}</span>
      </div>

      <!-- Grouped Activity Feed with Follow-tail auto-scroll -->
      <div id="live-timeline-steps-list" style="max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border-default); border-radius: 6px; padding: 8px; background: #ffffff;">
        ${(task.executionTimeline || []).map((item: any) => `
          <div style="display: flex; flex-direction: column; gap: 4px; font-size: 11px; padding: 6px 8px; border-radius: 6px; background: var(--bg-subtle); border: 1px solid var(--border-subtle);">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
              <span style="font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); font-size: 11px;">${escapeHtml(item.title || item.step)}</span>
              <span style="color: var(--text-muted); font-size: 10px; font-family: var(--font-mono);">${item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : ''}</span>
            </div>
            <div style="min-width: 0; width: 100%;">
              ${formatActivityDetailHtml(item.detail || item.details || '')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  return `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
      <h3 class="card-title">Task Detail</h3>
      <div style="display: flex; align-items: center; gap: 8px;">
        ${
          canLinkContext
            ? `<a href="${contextHref}" class="btn btn-secondary btn-sm task-detail-context-link" id="task-detail-open-context-btn">Open in Context</a>`
            : `<button type="button" class="btn btn-secondary btn-sm" disabled title="Valid project and task identifier required">Open in Context</button>`
        }
      </div>
    </div>

    <div>
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <h2 style="font-size: 22px; font-weight: 700; font-family: var(--font-mono); color: var(--text-primary); margin: 0;" id="task-detail-id">#${escapeHtml(task.taskId)}</h2>
        <span id="task-detail-status-badge">${renderInlineStatusBadgeHtml(task.trustState)}</span>
      </div>
      <div style="font-size: 14px; color: var(--text-secondary); margin-top: 6px; font-weight: 500;">
        ${escapeHtml(task.summary)}
      </div>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
        First recorded ${escapeHtml(formatDateLabel(task.createdAt))} · Updated ${escapeHtml(formatDateLabel(task.updatedAt))}
      </div>
    </div>

    ${blockedBannerHtml}

    <div id="task-execution-card" style="padding: 16px 20px; background: #ffffff; border: 1.5px solid var(--border-default); border-radius: 12px; display: flex; flex-direction: column; gap: 14px; margin-top: 6px; box-shadow: var(--shadow-xs);">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
        <div>
          <div style="font-size: 13.5px; font-weight: 650; color: var(--text-primary); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span>Autonomous Agent Execution</span>
            <span class="badge" id="task-orchestration-mode-badge" style="font-family: var(--font-mono); font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e0f2fe; border: 1px solid #bae6fd; color: #0284c7;">
              nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B (Nebius)
            </span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 3px;">
            Planner (GLM-5.3-Flash) → Implementer (Kimi-K2.6) → Reviewer (Nemotron-3.5-Super-VL) → Independent Verification.
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${
            task.trustState === 'BLOCKED_NEEDS_HUMAN'
              ? `<button type="button" class="btn btn-secondary btn-sm" id="task-detail-unblock-btn" style="color: var(--status-blocked-text); border-color: var(--status-blocked-border);">
                  <span>⚑ Unblock Task</span>
                </button>`
              : ''
          }
          <button type="button" class="btn btn-primary btn-sm" id="task-detail-run-btn">
            <span id="task-detail-run-icon">▷</span>
            <span id="task-detail-run-label">Run Task</span>
          </button>
        </div>
      </div>

      <!-- Execution Pipeline Selector -->
      <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 8px 12px; background: var(--bg-subtle); border-radius: 8px; font-size: 11.5px; border: 1px solid var(--border-default);">
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; color: var(--text-primary);">
          <input type="radio" name="exec-pipeline-mode" id="mode-multi-agent" value="multi" checked />
          <span>Multi-Agent Pipeline (GLM Planner + Kimi Implementer + Nemotron Reviewer)</span>
        </label>
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-secondary);">
          <input type="radio" name="exec-pipeline-mode" id="mode-single-agent" value="single" />
          <span>Single Agent (Nemotron-3-Nano)</span>
        </label>
      </div>

      <!-- Target Scope Selector & Native File Picker -->
      <div id="task-target-scope-section" style="display: flex; flex-direction: column; gap: 8px; padding: 10px 14px; background: var(--bg-subtle); border-radius: 8px; border: 1px solid var(--border-default); font-size: 11.5px;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 650; color: var(--text-primary);">Target Scope</span>
            <span id="scope-count-badge" class="badge" style="font-size: 10px; background: #e2e8f0; color: #334155;">All Repository Files (Full Project)</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="file" id="native-scope-file-picker" multiple style="display: none;" />
            <input type="file" id="native-scope-folder-picker" webkitdirectory style="display: none;" />
            <button type="button" class="btn btn-secondary btn-xs" id="scope-add-files-btn" style="padding: 2px 8px; font-size: 11px;">
              + Add Files
            </button>
            <button type="button" class="btn btn-secondary btn-xs" id="scope-add-folder-btn" style="padding: 2px 8px; font-size: 11px;">
              + Add Folder to Scope
            </button>
            <button type="button" class="btn btn-secondary btn-xs" id="scope-clear-btn" style="padding: 2px 8px; font-size: 11px; display: none;">
              Reset to All
            </button>
          </div>
        </div>
        <div id="scope-selected-chips-container" style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
          <span style="color: var(--text-muted); font-style: italic;">No individual files restricted. Agent has access to search and inspect the entire repository.</span>
        </div>
      </div>

      <div id="task-detail-run-feedback" style="display: none; font-size: 12px; padding: 10px 14px; border-radius: 8px; line-height: 1.5;"></div>

      <!-- MULTI-AGENT ARTIFACTS CONTAINER -->
      <div id="task-multi-agent-artifacts" style="display: none; flex-direction: column; gap: 10px;">
        <div id="task-planner-card" style="padding: 12px 14px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; font-size: 12px;">
          <div style="font-weight: 650; color: #166534; display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span>📋 Lead Planner Architectural Plan (GLM-5.3-Flash)</span>
            <span class="badge" style="background: #dcfce7; color: #15803d; font-size: 10px;">CLAIMED</span>
          </div>
          <div id="planner-card-summary" style="color: #1e293b; line-height: 1.45;"></div>
          <div id="planner-card-criteria" style="margin-top: 6px; font-size: 11px; color: #475569;"></div>
        </div>

        <div id="task-reviewer-card" style="padding: 12px 14px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; font-size: 12px;">
          <div style="font-weight: 650; color: #1e40af; display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span>🔍 Independent Code Review (Nemotron-3.5-Super-VL)</span>
            <span id="reviewer-card-verdict" class="badge" style="background: #dbeafe; color: #1d4ed8; font-size: 10px;">APPROVED</span>
          </div>
          <div id="reviewer-card-summary" style="color: #1e293b; line-height: 1.45;"></div>
        </div>
      </div>

      ${timelineHtml}
    </div>

    <!-- Evidence & Verified Context Reused Card -->
    <div id="task-context-reused-card" style="display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 10px; font-size: 12px; margin-top: 6px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="font-weight: 650; color: #1e293b; display: flex; align-items: center; gap: 6px;">
          <span>🧠 Project Brain Verified Context Reused</span>
          <span class="badge" style="font-size: 10px; background: #e2e8f0; color: #334155;">Persistent Memory</span>
        </span>
        ${
          canLinkContext
            ? `<a href="${contextHref}" style="font-size: 11px; font-weight: 600; color: var(--brand-blue); text-decoration: none;">View Compiled Context →</a>`
            : ''
        }
      </div>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 11.5px; margin-top: 2px;">
        <div style="background: #ffffff; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-default);">
          <div style="color: var(--text-muted); font-size: 10px; font-weight: 600;">SOURCE FRESHNESS</div>
          <div style="font-weight: 600; color: #166534; margin-top: 2px;">✓ Verified Clean</div>
          <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 1px;">Snapshot matches HEAD</div>
        </div>
        <div style="background: #ffffff; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-default);">
          <div style="color: var(--text-muted); font-size: 10px; font-weight: 600;">CODE CONVENTIONS</div>
          <div style="font-weight: 600; color: var(--text-primary); margin-top: 2px;">node24-esm</div>
          <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 1px;">Type import contracts</div>
        </div>
        <div style="background: #ffffff; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-default);">
          <div style="color: var(--text-muted); font-size: 10px; font-weight: 600;">INDEPENDENT VERIFICATION</div>
          <div style="font-weight: 600; color: #1d4ed8; margin-top: 2px;">Pre-Commit Test Suite</div>
          <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 1px;">Independent Vitest checks</div>
        </div>
      </div>
    </div>

    <div>
      <div style="font-size: 12.5px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">Description &amp; provenance</div>
      <div style="background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 10px; padding: 12px 14px; font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); line-height: 1.5;">
        <div>${escapeHtml(task.summary)}</div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">
          Source: Derived from attempt #${Number(task.highestAttempt)} record. Standalone task specifications and dependency graphs are not exposed by the Engine HTTP API.
        </div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 10px 0; border-top: 1px solid var(--border-subtle); border-bottom: 1px solid var(--border-subtle); font-size: 12.5px;">
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Attempts</div>
        <div style="font-weight: 600; margin-top: 3px;">${Number(task.attemptCount)}</div>
      </div>
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Trust state</div>
        <div style="margin-top: 3px;">${renderInlineStatusBadgeHtml(task.trustState)}</div>
      </div>
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Agent / Model</div>
        <div style="font-weight: 500; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(task.latestAgentId || 'System')}${task.latestModel ? ` · ${escapeHtml(task.latestModel)}` : ''}
        </div>
      </div>
      <div>
        <div style="font-size: 11px; color: var(--text-muted);">Last updated</div>
        <div style="font-weight: 500; margin-top: 3px;">${escapeHtml(formatDateLabel(task.updatedAt))}</div>
      </div>
    </div>

    <div>
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">Attempts</div>
        <span style="font-size: 11px; color: var(--text-muted);">chronological · oldest first (click to inspect)</span>
      </div>
      <div style="display: grid; grid-template-columns: 44px 128px 116px minmax(0, 1fr); gap: 10px; padding: 6px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-subtle); border-radius: 8px; margin-bottom: 6px;">
        <span>#</span>
        <span>Status</span>
        <span>Updated</span>
        <span>Summary</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px;" id="task-detail-attempts-list">
        ${attemptsRowsHtml}
      </div>
    </div>

    ${attemptInspectorHtml}

    <div id="task-detail-diff-section" style="border-top: 1px solid var(--border-default); padding-top: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">Code Changes (Captured Git Diff)</div>
        <span style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);" id="task-diff-status-label">Loading diff...</span>
      </div>
      <div class="mono-code-box" id="task-detail-diff-viewer" style="max-height: 260px; overflow-y: auto; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.5; white-space: pre;">(Checking for recorded workspace diff...)</div>
    </div>

    <div>
      <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;">Related Records</div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <a href="#/projects/${encodedProjectId}/verifications?taskId=${encodedTaskId}" class="related-record-link task-detail-verif-link" data-nav-section="verifications">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="color: var(--text-secondary);">✓</span>
            <div>
              <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">Verifications</div>
              <div style="font-size: 11.5px; color: var(--text-muted);">Independent verification records for this task</div>
            </div>
          </div>
          <span style="font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-secondary);">${Number(task.verificationCount)} →</span>
        </a>

        <a href="#/projects/${encodedProjectId}/handoffs?taskId=${encodedTaskId}" class="related-record-link task-detail-handoff-link" data-nav-section="handoffs">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="color: var(--text-secondary);">◔</span>
            <div>
              <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">Handoffs</div>
              <div style="font-size: 11.5px; color: var(--text-muted);">Agent handoff claims referencing this task</div>
            </div>
          </div>
          <span style="font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-secondary);">${Number(task.handoffCount)} →</span>
        </a>

        ${
          canLinkContext
            ? `<a href="${contextHref}" class="related-record-link task-detail-context-link">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="color: var(--text-secondary);">≣</span>
                  <div>
                    <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">Related Context</div>
                    <div style="font-size: 11.5px; color: var(--text-muted);">Compile verified facts, decisions, and upstream state for this task</div>
                  </div>
                </div>
                <span style="font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-secondary);">Open →</span>
              </a>`
            : ''
        }
      </div>
    </div>
  `;
}

/**
 * 6. TASK EXPLORER SCREEN (Clean Task List — Architecture Upgrade)
 */
export function renderTasksScreen(route: RouteMatch): HTMLElement {
  const projectId = route.projectId || '';
  const safeId = escapeHtml(projectId);
  const encodedId = encodeURIComponent(projectId);
  const initialProjectTitle = escapeHtml(formatProjectTitle(projectId));

  // If a specific task is requested in the route, route directly to the dedicated full-width Task Workspace
  const explicitTaskId =
    (route.params.taskId && route.params.taskId.trim()) ||
    (route.subpath && route.subpath.trim()) ||
    (route.params.task && route.params.task.trim()) ||
    undefined;

  if (explicitTaskId) {
    return renderTaskWorkspaceScreen(route);
  }

  let currentModel: ProjectOverviewModel | null = null;
  let searchQuery = '';
  let statusFilter = 'ALL';

  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';
  wrapper.id = 'tasks-page-container';

  wrapper.innerHTML = `
    <nav class="app-breadcrumbs" aria-label="Breadcrumb">
      <a href="#/projects" id="tasks-crumb-projects">Projects</a>
      <span class="separator">&gt;</span>
      <a href="#/projects/${encodedId}/overview" id="tasks-crumb-project">${initialProjectTitle}</a>
      <span class="separator">&gt;</span>
      <span class="current" id="tasks-crumb-current">Tasks</span>
    </nav>

    <div class="page-header">
      <div class="page-header-titles">
        <h1 class="page-title">Task Explorer</h1>
        <p class="page-subtitle">Browse and manage project tasks, execution status, and verification evidence.</p>
      </div>
      <button
        type="button"
        class="btn btn-primary btn-md"
        id="tasks-new-task-btn"
      >
        + New Task
      </button>
    </div>

    <div class="callout-banner" id="tasks-derivation-notice">
      <span>ⓘ</span>
      <span>
        <strong>Derived from recorded attempts:</strong> Tasks and trust states are orchestrated with live agents, local workspaces, and independent verification.
      </span>
    </div>

    <!-- Create Task Modal Backdrop -->
    <div id="new-task-modal-backdrop" class="modal-backdrop" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="modal-task-title">
      <div class="modal-dialog" id="new-task-modal-card">
        <div class="modal-header">
          <h3 class="modal-title" id="modal-task-title">Create New Task</h3>
          <button type="button" id="modal-close-task-btn" class="modal-close-btn" aria-label="Close dialog">✕</button>
        </div>
        <div class="form-field">
          <label class="form-label" for="new-task-title-input">Task Title *</label>
          <input type="text" id="new-task-title-input" class="input" placeholder="e.g. Implement validateProfile function" />
        </div>
        <div class="form-field">
          <label class="form-label" for="new-task-desc-input">Task Description</label>
          <textarea id="new-task-desc-input" class="textarea" rows="3" placeholder="Detailed technical requirements for the agent"></textarea>
        </div>
        <div class="form-field">
          <label class="form-label" for="new-task-acceptance-input">Acceptance Criteria</label>
          <input type="text" id="new-task-acceptance-input" class="input" placeholder="e.g. src/validate-profile.ts exports validateProfile" />
        </div>
        <div class="form-field">
          <label class="form-label" for="new-task-cmd-input">Verification Command</label>
          <input type="text" id="new-task-cmd-input" class="input" placeholder="e.g. npm test or node -e &quot;...&quot;" value="npm test" />
        </div>
        <div class="form-field">
          <label class="form-label" for="new-task-upstream-select">Upstream Task (Dependency)</label>
          <select id="new-task-upstream-select" class="select">
            <option value="">None (Independent Root Task)</option>
          </select>
        </div>
        <div id="new-task-modal-feedback" style="display: none; font-size: 12px; padding: 8px 12px; border-radius: 6px;"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="modal-cancel-task-btn">Cancel</button>
          <button type="button" class="btn btn-primary" id="modal-submit-task-btn">Create Task</button>
        </div>
      </div>
    </div>

    <div id="tasks-status-banner" style="display: none;"></div>

    <!-- REPOSITORY STATUS & SCOPE TOOLBAR -->
    <div id="tasks-repo-bar" style="margin-bottom: 16px; padding: 12px 18px; background: #ffffff; border: 1.5px solid var(--border-default); border-radius: 10px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; box-shadow: var(--shadow-xs);">
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <span style="font-size: 13px; font-weight: 600; color: var(--text-primary);">📁 Repository:</span>
        <code id="tasks-repo-path-label" style="font-size: 12px; background: var(--bg-subtle); padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border-default);">Connecting...</code>
        <span id="tasks-repo-branch-badge" class="badge" style="font-size: 11px; background: var(--bg-subtle); color: var(--text-secondary);"></span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button type="button" class="btn btn-secondary btn-sm" id="tasks-open-folder-btn">
          <span>📁 Open Local Folder</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="tasks-toggle-explorer-btn">
          <span>🗂 Browse Files &amp; Scope</span>
        </button>
        <button type="button" class="btn btn-secondary btn-sm" id="tasks-attach-repo-btn">
          <span>Attach Repository</span>
        </button>
      </div>
    </div>

    <!-- PROJECT EXPLORER & CODE VIEWER (Toggleable) -->
    <div id="project-explorer-container" class="card" style="display: none; padding: 20px; margin-bottom: 20px; border: 1.5px solid var(--border-default); border-radius: 12px; flex-direction: column; gap: 14px;">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
        <div>
          <h3 class="card-title" style="display: flex; align-items: center; gap: 8px;">
            <span>Project Explorer</span>
            <span class="badge" style="font-size: 11px; font-weight: normal; background: var(--bg-subtle); color: var(--text-secondary);">
              Inspect files &amp; select task scope
            </span>
          </h3>
          <p class="card-subtitle">Select files or folders to include as targeted scope for new tasks</p>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="btn btn-primary btn-sm" id="explorer-create-scoped-task-btn">
            + Create Task with Selected Scope
          </button>
          <button type="button" class="btn btn-secondary btn-sm" id="explorer-hide-btn">
            ✕ Hide Explorer
          </button>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 14px; border: 1px solid var(--border-default); border-radius: 8px; overflow: hidden; min-height: 380px;">
        <!-- TREE -->
        <div id="explorer-tree-view" style="background: var(--bg-subtle); border-right: 1px solid var(--border-default); padding: 12px; overflow-y: auto; max-height: 480px; display: flex; flex-direction: column; gap: 4px;">
          <div style="font-size: 12px; color: var(--text-muted); padding: 8px;">Loading repository files...</div>
        </div>
        <!-- CODE VIEWER -->
        <div style="display: flex; flex-direction: column; background: #ffffff; overflow: hidden;">
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: var(--bg-surface); border-bottom: 1px solid var(--border-default); font-size: 12px;">
            <span id="explorer-viewer-filename" style="font-family: var(--font-mono); font-weight: 600; color: var(--text-primary);">Select a file to inspect</span>
            <span id="explorer-viewer-meta" style="font-size: 11px; color: var(--text-muted);"></span>
          </div>
          <pre id="explorer-viewer-code" style="margin: 0; padding: 14px; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; overflow: auto; flex: 1; background: #fafafa; color: var(--text-primary); white-space: pre-wrap;">// Click any file in the tree to inspect source code and define tasks.</pre>
        </div>
      </div>
    </div>

    <!-- FULL-WIDTH TASKS LIST (Dedicated, Clean View — No inline card squishing!) -->
    <div class="card" id="tasks-main-grid" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div>
          <h3 class="card-title">Tasks</h3>
          <p class="card-subtitle">Click any task to enter its full-width coding workspace</p>
        </div>
      </div>

      <div class="task-explorer-toolbar">
        <input
          type="search"
          id="task-explorer-search"
          class="input"
          placeholder="Search tasks by ID, summary, or file..."
          aria-label="Search tasks"
        />
        <select id="task-explorer-status-filter" class="select" aria-label="Filter tasks by trust state">
          <option value="ALL">All Tasks</option>
          <option value="VERIFIED">Verified</option>
          <option value="FAILED">Failed</option>
          <option value="BLOCKED_NEEDS_HUMAN">Blocked</option>
          <option value="CLAIMED">Claimed</option>
          <option value="UNVERIFIED">Unverified</option>
        </select>
      </div>

      <div class="filter-pills-row" id="task-explorer-filter-pills"></div>

      <div>
        <div class="tasks-list-table-header">
          <span>Task</span>
          <span>Description (derived)</span>
          <span>Attempts</span>
          <span>Trust State</span>
          <span style="text-align: right;">Updated</span>
          <span style="text-align: right;">Action</span>
        </div>
        <div id="task-explorer-list" role="listbox" aria-label="Derived project tasks" style="display: flex; flex-direction: column; min-height: 240px; padding-top: 4px;">
          <div style="padding: 28px 12px; text-align: center; font-size: 13px; color: var(--text-muted);">
            Loading recorded task attempts for <code>${safeId}</code>...
          </div>
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; padding-top: 8px; border-top: 1px solid var(--border-subtle); font-size: 12px; color: var(--text-muted);" id="task-explorer-footer">
        <span>Loading tasks...</span>
        <span>Derived from handoffs &amp; verifications</span>
      </div>
    </div>
  `;

  wrapper.querySelector('#tasks-crumb-projects')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigate('#/projects');
  });
  wrapper.querySelector('#tasks-crumb-project')?.addEventListener('click', (e) => {
    e.preventDefault();
    router.navigateToProject(projectId, 'overview');
  });

  const renderTaskExplorerList = () => {
    const listEl = wrapper.querySelector('#task-explorer-list') as HTMLElement | null;
    const pillsEl = wrapper.querySelector('#task-explorer-filter-pills') as HTMLElement | null;
    const footerEl = wrapper.querySelector('#task-explorer-footer') as HTMLElement | null;
    const selectEl = wrapper.querySelector('#task-explorer-status-filter') as HTMLSelectElement | null;
    if (!listEl || !currentModel) return;

    const { taskCounts, derivedTasks, taskDerivationComplete } = currentModel;

    if (selectEl && selectEl.value !== statusFilter) {
      selectEl.value = statusFilter;
    }

    if (!taskDerivationComplete) {
      if (pillsEl) {
        pillsEl.innerHTML = `<span style="font-size: 11px; color: var(--status-claimed-text);">Task status counts unavailable until both handoffs and verifications load</span>`;
      }
      listEl.innerHTML = `
        <div style="padding: 24px 12px; font-size: 13px; color: var(--status-claimed-text); line-height: 1.5;">
          Task list unavailable because either handoffs or verification records failed to load. Retry above to derive task states safely.
        </div>
      `;
      if (footerEl) {
        footerEl.innerHTML = `<span>Derivation paused (partial data)</span><span>Retry required</span>`;
      }
      return;
    }

    if (pillsEl) {
      const pills: Array<{ key: string; label: string }> = [
        { key: 'ALL', label: `All ${taskCounts.all}` },
        { key: 'VERIFIED', label: `Verified ${taskCounts.verified}` },
        { key: 'FAILED', label: `Failed ${taskCounts.failed}` },
        { key: 'BLOCKED_NEEDS_HUMAN', label: `Blocked ${taskCounts.blocked}` },
        { key: 'CLAIMED', label: `Claimed ${taskCounts.claimed}` },
        { key: 'UNVERIFIED', label: `Unverified ${taskCounts.unverified}` },
      ];
      pillsEl.innerHTML = pills
        .map(
          (p) =>
            `<button type="button" class="filter-pill ${statusFilter === p.key ? 'active' : ''}" data-status-filter="${p.key}">${escapeHtml(p.label)}</button>`
        )
        .join('');

      pillsEl.querySelectorAll('.filter-pill').forEach((btn) => {
        btn.addEventListener('click', () => {
          statusFilter = btn.getAttribute('data-status-filter') || 'ALL';
          renderTaskExplorerList();
        });
      });
    }

    if (derivedTasks.length === 0) {
      listEl.innerHTML = `
        <div style="padding: 28px 12px; font-size: 13px; color: var(--text-muted); line-height: 1.5; text-align: center;">
          No task attempts recorded for project <code>${safeId}</code> yet.
        </div>
      `;
      if (footerEl) {
        footerEl.innerHTML = `<span>Showing 0 of 0 derived tasks</span><span>Derived from handoffs &amp; verifications</span>`;
      }
      return;
    }

    const filtered = filterDerivedTasks(derivedTasks, searchQuery, statusFilter);

    if (footerEl) {
      footerEl.innerHTML = `
        <span>Showing ${filtered.length === 0 ? '0' : `1–${filtered.length}`} of ${derivedTasks.length} derived ${derivedTasks.length === 1 ? 'task' : 'tasks'}</span>
        <span>Derived from handoffs &amp; verifications</span>
      `;
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div style="padding: 28px 12px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px;">
          <div style="font-size: 13px; color: var(--text-muted);">
            No derived tasks match search <code>${escapeHtml(searchQuery || '—')}</code> and filter <strong>${escapeHtml(statusFilter)}</strong>.
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="task-explorer-clear-filters-btn">
            Clear search &amp; filters
          </button>
        </div>
      `;
      listEl.querySelector('#task-explorer-clear-filters-btn')?.addEventListener('click', () => {
        searchQuery = '';
        statusFilter = 'ALL';
        const sInput = wrapper.querySelector('#task-explorer-search') as HTMLInputElement | null;
        if (sInput) sInput.value = '';
        renderTaskExplorerList();
      });
      return;
    }

    listEl.innerHTML = filtered
      .map((t, idx) => {
        return `
          <div
            role="option"
            tabindex="0"
            class="tasks-list-table-row task-explorer-row"
            data-task-index="${idx}"
            data-task-id="${escapeHtml(t.taskId)}"
          >
            <div style="font-family: var(--font-mono); font-weight: 600; font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              #${escapeHtml(t.taskId)}
            </div>
            <div style="font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(t.summary)}">
              ${escapeHtml(t.summary)}
            </div>
            <div style="font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--text-primary);">
              ${Number(t.attemptCount)}
            </div>
            <div>${renderInlineStatusBadgeHtml(t.trustState)}</div>
            <div style="font-size: 12px; color: var(--text-muted); text-align: right;">
              ${escapeHtml(formatDateLabel(t.updatedAt))}
            </div>
            <div style="text-align: right;">
              <button type="button" class="btn btn-secondary btn-sm task-open-btn" data-task-id="${escapeHtml(t.taskId)}">
                Open Workspace →
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    const taskRowEls = Array.from(listEl.querySelectorAll('.task-explorer-row')) as HTMLElement[];
    taskRowEls.forEach((row, idx) => {
      const openWorkspaceForTask = (targetIdx: number) => {
        const picked = filtered[targetIdx];
        const tid = picked ? picked.taskId : row.getAttribute('data-task-id');
        if (tid) {
          router.navigateToProject(projectId, 'tasks', tid);
        }
      };

      row.addEventListener('click', () => openWorkspaceForTask(idx));
      row.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openWorkspaceForTask(idx);
        }
      });
    });

    listEl.querySelectorAll('.task-open-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = (btn as HTMLElement).getAttribute('data-task-id');
        if (tid) {
          router.navigateToProject(projectId, 'tasks', tid);
        }
      });
    });
  };

  const searchInput = wrapper.querySelector('#task-explorer-search') as HTMLInputElement | null;
  const statusSelect = wrapper.querySelector('#task-explorer-status-filter') as HTMLSelectElement | null;

  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderTaskExplorerList();
  });

  statusSelect?.addEventListener('change', () => {
    statusFilter = statusSelect.value || 'ALL';
    renderTaskExplorerList();
  });

  const loadTasksWorkspace = async () => {
    const statusBanner = wrapper.querySelector('#tasks-status-banner') as HTMLElement | null;
    const mainGrid = wrapper.querySelector('#tasks-main-grid') as HTMLElement | null;
    if (statusBanner) {
      statusBanner.style.display = 'none';
      statusBanner.innerHTML = '';
    }
    if (mainGrid) {
      mainGrid.style.display = 'flex';
    }

    const [projRes, handoffsRes, verifsRes, tasksRes, repoRes] = await Promise.allSettled([
      engineClient.getProject(projectId),
      engineClient.getHandoffs(projectId),
      engineClient.getVerifications(projectId),
      engineClient.listTasks(projectId),
      engineClient.getRepositoryStatus(projectId),
    ]);

    if (projRes.status === 'fulfilled' && projRes.value === null) {
      if (mainGrid) mainGrid.style.display = 'none';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="tasks-not-found" style="padding: 28px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;">
            <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);">Project not found</div>
            <p style="font-size: 13px; color: var(--text-muted); max-width: 420px;">
              Project <code>${safeId}</code> does not exist in the SQLite Project Brain.
            </p>
            <button type="button" class="btn btn-primary btn-md" id="tasks-not-found-back-btn">
              ← Back to All Projects
            </button>
          </div>
        `;
        statusBanner
          .querySelector('#tasks-not-found-back-btn')
          ?.addEventListener('click', () => {
            router.navigate('#/projects');
          });
      }
      return;
    }

    const cachedProject = engineClient.getKnownProjects().find((p) => p.id === projectId);
    const project: ProjectDto | null =
      projRes.status === 'fulfilled' ? projRes.value : (cachedProject ?? null);

    const errors: string[] = [];
    if (projRes.status === 'rejected') {
      errors.push((projRes.reason as Error)?.message || 'Failed to load project metadata.');
    }
    if (handoffsRes.status === 'rejected') {
      errors.push((handoffsRes.reason as Error)?.message || 'Failed to load project handoffs.');
    }
    if (verifsRes.status === 'rejected') {
      errors.push(
        (verifsRes.reason as Error)?.message || 'Failed to load project verifications.'
      );
    }

    if (!project) {
      if (mainGrid) mainGrid.style.display = 'none';
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = `
          <div class="card" id="tasks-error-state" style="padding: 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-color: var(--status-failed-border);">
            <div>
              <div style="font-size: 16px; font-weight: 600; color: var(--status-failed-text);">Unable to load Task Explorer</div>
              <p style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
                ${escapeHtml(errors[0] || 'Orchestrate Engine could not be reached.')}
              </p>
            </div>
            <button type="button" class="btn btn-primary btn-md" id="tasks-retry-btn">
              <span>Retry</span>
              <span>↻</span>
            </button>
          </div>
        `;
        statusBanner.querySelector('#tasks-retry-btn')?.addEventListener('click', () => {
          void loadTasksWorkspace();
        });
      }
      return;
    }

    const crumbProj = wrapper.querySelector('#tasks-crumb-project');
    if (crumbProj) crumbProj.textContent = project.name;

    if (errors.length > 0 && statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div class="callout-banner" id="tasks-partial-banner" style="justify-content: space-between; border-color: var(--status-claimed-border); background: var(--status-claimed-bg); color: var(--status-claimed-text);">
          <span><strong>Partial data loaded:</strong> ${escapeHtml(errors.join(' · '))}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="tasks-partial-retry-btn">Retry ↻</button>
        </div>
      `;
      statusBanner.querySelector('#tasks-partial-retry-btn')?.addEventListener('click', () => {
        void loadTasksWorkspace();
      });
    }

    const handoffsAvailable = handoffsRes.status === 'fulfilled';
    const verificationsAvailable = verifsRes.status === 'fulfilled';
    const handoffs = handoffsAvailable ? handoffsRes.value : [];
    const verifications = verificationsAvailable ? verifsRes.value : [];
    const tasks = tasksRes.status === 'fulfilled' ? tasksRes.value : [];

    currentModel = deriveProjectOverviewModel(project, handoffs, verifications, {
      handoffsAvailable,
      verificationsAvailable,
      tasks,
    });

    // Update repository status bar
    const repoPathLabel = wrapper.querySelector('#tasks-repo-path-label') as HTMLElement | null;
    const repoBranchBadge = wrapper.querySelector('#tasks-repo-branch-badge') as HTMLElement | null;
    const repoConnected = repoRes.status === 'fulfilled' && repoRes.value.connected;
    if (repoPathLabel) {
      if (repoConnected && repoRes.value.path) {
        repoPathLabel.textContent = repoRes.value.path;
        repoPathLabel.style.color = 'var(--text-primary)';
      } else {
        repoPathLabel.textContent = 'No repository attached';
        repoPathLabel.style.color = 'var(--status-failed-text)';
      }
    }
    if (repoBranchBadge) {
      if (repoConnected && repoRes.value.branch) {
        repoBranchBadge.textContent = repoRes.value.branch;
        repoBranchBadge.style.display = 'inline-block';
      } else {
        repoBranchBadge.style.display = 'none';
      }
    }

    renderTaskExplorerList();
  };

  // ── Project Explorer & Code Viewer Handlers ────────────────────────────────
  const toggleExplorerBtn = wrapper.querySelector('#tasks-toggle-explorer-btn') as HTMLButtonElement | null;
  const explorerContainer = wrapper.querySelector('#project-explorer-container') as HTMLElement | null;
  const hideExplorerBtn = wrapper.querySelector('#explorer-hide-btn') as HTMLButtonElement | null;
  const attachRepoBtn = wrapper.querySelector('#tasks-attach-repo-btn') as HTMLButtonElement | null;
  const explorerTree = wrapper.querySelector('#explorer-tree-view') as HTMLElement | null;
  const viewerFilename = wrapper.querySelector('#explorer-viewer-filename') as HTMLElement | null;
  const viewerMeta = wrapper.querySelector('#explorer-viewer-meta') as HTMLElement | null;
  const viewerCode = wrapper.querySelector('#explorer-viewer-code') as HTMLElement | null;
  const createScopedTaskBtn = wrapper.querySelector('#explorer-create-scoped-task-btn') as HTMLButtonElement | null;

  const renderExplorerTreeRecursively = (directories: any[], files: any[]): string => {
    let out = '';
    for (const dir of directories) {
      out += `
        <div class="tree-dir-item" style="margin-bottom: 2px;">
          <div class="tree-dir-header" data-path="${escapeHtml(dir.path)}" style="display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px; color: var(--text-primary); user-select: none;">
            <span class="dir-caret" style="font-size: 9px; width: 12px; color: var(--text-muted);">▼</span>
            <span>📁 ${escapeHtml(dir.name)}</span>
          </div>
          <div class="tree-dir-children" style="padding-left: 16px; display: flex; flex-direction: column; gap: 2px;">
            ${renderExplorerTreeRecursively(dir.directories || [], dir.files || [])}
          </div>
        </div>
      `;
    }
    for (const file of files) {
      out += `
        <div class="tree-file-item" style="display: flex; align-items: center; justify-content: space-between; padding: 3px 6px; border-radius: 4px; font-size: 11.5px; cursor: pointer; transition: background 0.1s;" data-file-path="${escapeHtml(file.path)}">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0;">
            <input type="checkbox" class="tree-file-scope-cb" data-file-path="${escapeHtml(file.path)}" style="cursor: pointer;" />
            <span style="font-family: var(--font-mono); color: var(--text-primary);">${escapeHtml(file.name)}</span>
          </label>
          <span style="font-size: 10px; color: var(--text-muted); font-family: var(--font-mono);">${file.size ? (file.size > 1024 ? Math.round(file.size / 1024) + ' KB' : file.size + ' B') : ''}</span>
        </div>
      `;
    }
    return out;
  };

  const loadExplorerTree = async () => {
    if (!explorerTree) return;
    explorerTree.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); padding: 8px;">Scanning repository directory...</div>';
    try {
      const tree = await engineClient.getRepositoryTree(projectId);
      if (!tree.connected) {
        explorerTree.innerHTML = '<div style="font-size: 12px; color: var(--status-failed-text); padding: 8px;">No repository attached. Please attach a repository first.</div>';
        return;
      }
      explorerTree.innerHTML = renderExplorerTreeRecursively(tree.directories, tree.files);

      // Attach file click listeners
      explorerTree.querySelectorAll('.tree-file-item').forEach((item) => {
        item.addEventListener('click', async (e) => {
          if ((e.target as HTMLElement).tagName.toLowerCase() === 'input') return;
          const filePath = item.getAttribute('data-file-path');
          if (!filePath) return;
          explorerTree.querySelectorAll('.tree-file-item').forEach((el) => ((el as HTMLElement).style.background = 'transparent'));
          (item as HTMLElement).style.background = 'var(--bg-surface)';
          if (viewerFilename) viewerFilename.textContent = filePath;
          if (viewerMeta) viewerMeta.textContent = 'Loading...';
          try {
            const fileData = await engineClient.getRepositoryFile(projectId, filePath);
            if (viewerCode) viewerCode.textContent = fileData.content;
            if (viewerMeta) viewerMeta.textContent = `${fileData.lines} lines · ${Math.round(fileData.size / 1024 * 10) / 10} KB`;
          } catch (err) {
            if (viewerCode) viewerCode.textContent = `Error loading file: ${(err as Error).message}`;
          }
        });
      });

      // Attach directory toggle listeners
      explorerTree.querySelectorAll('.tree-dir-header').forEach((header) => {
        header.addEventListener('click', () => {
          const children = header.parentElement?.querySelector('.tree-dir-children') as HTMLElement | null;
          const caret = header.querySelector('.dir-caret') as HTMLElement | null;
          if (children) {
            if (children.style.display === 'none') {
              children.style.display = 'flex';
              if (caret) caret.textContent = '▼';
            } else {
              children.style.display = 'none';
              if (caret) caret.textContent = '▶';
            }
          }
        });
      });
    } catch (err) {
      explorerTree.innerHTML = `<div style="font-size: 12px; color: var(--status-failed-text); padding: 8px;">Error: ${(err as Error).message}</div>`;
    }
  };

  toggleExplorerBtn?.addEventListener('click', () => {
    if (!explorerContainer) return;
    if (explorerContainer.style.display === 'none' || !explorerContainer.style.display) {
      explorerContainer.style.display = 'flex';
      void loadExplorerTree();
    } else {
      explorerContainer.style.display = 'none';
    }
  });

  hideExplorerBtn?.addEventListener('click', () => {
    if (explorerContainer) explorerContainer.style.display = 'none';
  });

  const openFolderBtn = wrapper.querySelector('#tasks-open-folder-btn') as HTMLButtonElement | null;
  openFolderBtn?.addEventListener('click', async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker();
        await engineClient.importRepository(projectId, { type: 'local', path: `./${handle.name}` });
        await loadTasksWorkspace();
        if (explorerContainer && explorerContainer.style.display !== 'none') {
          void loadExplorerTree();
        }
        return;
      } catch (err: any) {
        if (err.name === 'AbortError') return;
      }
    }
    const defaultPath = 'benchmarks/profile-validation';
    const folderPath = prompt('Enter path to project folder on disk:', defaultPath);
    if (!folderPath || !folderPath.trim()) return;
    try {
      await engineClient.importRepository(projectId, { type: 'local', path: folderPath.trim() });
      await loadTasksWorkspace();
      if (explorerContainer && explorerContainer.style.display !== 'none') {
        void loadExplorerTree();
      }
    } catch (e) {
      alert('Failed to attach folder: ' + (e as Error).message);
    }
  });

  attachRepoBtn?.addEventListener('click', async () => {
    const target = prompt('Enter path to local repository directory:', 'benchmarks/profile-validation');
    if (target && target.trim()) {
      try {
        await engineClient.importRepository(projectId, { type: 'local', path: target.trim() });
        await loadTasksWorkspace();
        if (explorerContainer && explorerContainer.style.display !== 'none') {
          void loadExplorerTree();
        }
      } catch (e) {
        alert('Failed to attach: ' + (e as Error).message);
      }
    }
  });

  createScopedTaskBtn?.addEventListener('click', () => {
    const selected = Array.from(wrapper.querySelectorAll('.tree-file-scope-cb:checked'))
      .map((cb) => (cb as HTMLElement).getAttribute('data-file-path'))
      .filter(Boolean);
    openModal();
    if (selected.length > 0) {
      if (taskTitleInput) taskTitleInput.value = `Update ${selected[0]}`;
      if (taskDescInput) taskDescInput.value = `Focus on the following repository scope:\n${selected.map((f) => `- ${f}`).join('\n')}\n\nRequirements:\nImplement required functionality and verify.`;
      if (taskAcceptanceInput) taskAcceptanceInput.value = `Changes in ${selected[0]} pass test verification`;
      if (selected[0]?.includes('.ts') || selected[0]?.includes('.js')) {
        if (taskCmdInput) taskCmdInput.value = 'node --test';
      }
    }
  });

  const newTaskModal = wrapper.querySelector('#new-task-modal-backdrop') as HTMLElement | null;
  const openNewTaskBtn = wrapper.querySelector('#tasks-new-task-btn') as HTMLButtonElement | null;
  const closeNewTaskBtn = wrapper.querySelector('#modal-close-task-btn') as HTMLButtonElement | null;
  const cancelNewTaskBtn = wrapper.querySelector('#modal-cancel-task-btn') as HTMLButtonElement | null;
  const submitNewTaskBtn = wrapper.querySelector('#modal-submit-task-btn') as HTMLButtonElement | null;
  const taskTitleInput = wrapper.querySelector('#new-task-title-input') as HTMLInputElement | null;
  const taskDescInput = wrapper.querySelector('#new-task-desc-input') as HTMLTextAreaElement | null;
  const taskAcceptanceInput = wrapper.querySelector('#new-task-acceptance-input') as HTMLInputElement | null;
  const taskCmdInput = wrapper.querySelector('#new-task-cmd-input') as HTMLInputElement | null;
  const taskUpstreamSelect = wrapper.querySelector('#new-task-upstream-select') as HTMLSelectElement | null;
  const modalFeedback = wrapper.querySelector('#new-task-modal-feedback') as HTMLElement | null;

  let lastActiveElement: HTMLElement | null = null;
  const modalCard = newTaskModal?.querySelector('#new-task-modal-card') as HTMLElement | null;
  modalCard?.addEventListener('click', (e) => e.stopPropagation());

  const openModal = () => {
    if (!newTaskModal) return;
    lastActiveElement = (document.activeElement as HTMLElement) || null;
    newTaskModal.style.display = 'flex';
    if (modalFeedback) modalFeedback.style.display = 'none';
    if (taskTitleInput) taskTitleInput.value = '';
    if (taskDescInput) taskDescInput.value = '';
    if (taskAcceptanceInput) taskAcceptanceInput.value = '';
    if (taskCmdInput) taskCmdInput.value = 'npm test';

    // Populate upstream tasks
    if (taskUpstreamSelect && currentModel) {
      taskUpstreamSelect.innerHTML = '<option value="">None (Independent Root Task)</option>';
      for (const t of currentModel.derivedTasks) {
        const opt = document.createElement('option');
        opt.value = t.taskId;
        opt.textContent = `${t.taskId} (${t.trustState}) - ${t.summary}`;
        taskUpstreamSelect.appendChild(opt);
      }
    }
    setTimeout(() => taskTitleInput?.focus(), 50);
  };

  const closeModal = () => {
    if (!newTaskModal) return;
    newTaskModal.style.display = 'none';
    if (lastActiveElement && typeof lastActiveElement.focus === 'function') {
      lastActiveElement.focus();
    }
  };

  newTaskModal?.addEventListener('click', (e) => {
    if (e.target === newTaskModal) closeModal();
  });

  const onModalKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && newTaskModal && newTaskModal.style.display !== 'none') {
      closeModal();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onModalKeyDown);
  }

  openNewTaskBtn?.addEventListener('click', openModal);
  closeNewTaskBtn?.addEventListener('click', closeModal);
  cancelNewTaskBtn?.addEventListener('click', closeModal);

  submitNewTaskBtn?.addEventListener('click', async () => {
    const title = taskTitleInput?.value.trim() ?? '';
    const description = taskDescInput?.value.trim() ?? '';
    const acceptanceCriteria = taskAcceptanceInput?.value.trim() ?? '';
    const verificationCommand = taskCmdInput?.value.trim() ?? 'npm test';
    const upstreamTaskId = taskUpstreamSelect?.value || undefined;

    if (!title) {
      if (modalFeedback) {
        modalFeedback.style.display = 'block';
        modalFeedback.style.backgroundColor = 'var(--status-failed-bg)';
        modalFeedback.style.color = 'var(--status-failed-text)';
        modalFeedback.textContent = 'Task title is required.';
      }
      taskTitleInput?.focus();
      return;
    }

    if (submitNewTaskBtn) submitNewTaskBtn.disabled = true;
    try {
      const res = await engineClient.createTask(projectId, {
        title,
        description,
        acceptanceCriteria,
        verificationCommand,
        upstreamTaskId,
      });
      closeModal();
      router.navigateToProject(projectId, 'tasks', res.task.id);
    } catch (err) {
      if (modalFeedback) {
        modalFeedback.style.display = 'block';
        modalFeedback.style.backgroundColor = 'var(--status-failed-bg)';
        modalFeedback.style.color = 'var(--status-failed-text)';
        modalFeedback.textContent = `Failed to create task: ${(err as Error).message}`;
      }
    } finally {
      if (submitNewTaskBtn) submitNewTaskBtn.disabled = false;
    }
  });

  if (
    route.params.action === 'new' ||
    (typeof window !== 'undefined' && window.location.hash.includes('action=new'))
  ) {
    setTimeout(openModal, 150);
  }

  void loadTasksWorkspace();

  return wrapper;
}

const FACT_PROVENANCE_DESCRIPTIONS: Record<string, string> = {
  CODE: 'Extracted from repository code or static workspace inspection (Level 1 source).',
  VERIFICATION: 'Derived from independent verification check execution (Level 2 evidence).',
  SYSTEM: 'Recorded by the Orchestrate runtime or project initialization.',
  HUMAN: 'Explicitly provided or confirmed by a human operator.',
  AGENT: 'Reported by an agent execution; treated as an untrusted claim unless independently verified.',
};

function findFactReferencedTasks(
  item: DerivedBrainFactItem,
  derivedTasks: readonly DerivedTaskSummary[]
): DerivedTaskSummary[] {
  if (derivedTasks.length === 0) return [];
  const text = `${item.key} ${item.current.value}`.toLowerCase();
  return derivedTasks.filter((t) => {
    const tid = t.taskId.trim().toLowerCase();
    if (!tid) return false;
    const escaped = tid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i');
    return regex.test(text);
  });
}

/**
 * Pure HTML builder for the Project Brain Fact Detail inspector.
 * Never fabricates confidence scores, file paths, or verification links.
 */
export function buildBrainFactDetailHtml(
  item: DerivedBrainFactItem,
  projectId: string,
  model?: ProjectOverviewModel | null
): string {
  const encodedProjectId = encodeURIComponent(projectId);
  const f = item.current;
  const provenanceDesc =
    FACT_PROVENANCE_DESCRIPTIONS[f.provenance] ??
    'Recorded with persisted provenance in Project Brain.';

  const isUntrustedOrUnverified =
    f.status === 'CLAIMED' || f.status === 'UNVERIFIED' || f.provenance === 'AGENT';

  const isJsonPayload = Boolean(tryParseJson(f.value));
  const headingText = isJsonPayload
    ? escapeHtml(f.key)
    : `${escapeHtml(f.key)}: ${escapeHtml(f.value)}`;

  const trustNoticeHtml = isUntrustedOrUnverified
    ? `
      <div class="callout-banner" id="brain-fact-trust-callout" style="border-color: var(--status-claimed-border); background: var(--status-claimed-bg); color: var(--status-claimed-text);">
        <span>
          <strong>Source-of-Truth Notice:</strong>
          ${
            f.status !== 'VERIFIED'
              ? `This fact has status <strong>${escapeHtml(f.status)}</strong> (not VERIFIED). Under <code>CODE → VERIFICATION EVIDENCE → PROJECT BRAIN → AGENT CLAIMS</code>, unverified or claimed facts are excluded from compiled downstream prompts.`
              : `This fact was recorded with <strong>AGENT</strong> provenance. Even when marked VERIFIED in Project Brain, it does not supersede live repository code or independent verification evidence.`
          }
        </span>
      </div>
    `
    : '';

  const scopeBadgeStyle = item.compilerScope.admittedToContext
    ? 'background: var(--status-verified-bg); color: var(--status-verified-text); border: 1px solid var(--status-verified-border);'
    : 'background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-default);';

  const scopeBadgeLabel =
    item.compilerScope.scopeKind === 'GLOBAL'
      ? 'ADMITTED (GLOBAL)'
      : item.compilerScope.scopeKind === 'TAG_SCOPED'
        ? `ADMITTED (TAG: ${item.compilerScope.scopeTag ?? ''})`
        : item.compilerScope.scopeKind === 'UNSCOPED'
          ? 'NOT AUTO-BROADCAST (UNSCOPED KEY)'
          : 'EXCLUDED (NOT VERIFIED)';

  const historyRowsHtml = item.history
    .map((rev) => {
      const revBadge = rev.isCurrent
        ? `<span style="font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: var(--accent-primary-subtle); color: var(--accent-primary); border: 1px solid rgba(37, 99, 235, 0.25);">Current (Rev #${rev.revisionIndex})</span>`
        : `<span style="font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: var(--bg-subtle); color: var(--text-muted); border: 1px solid var(--border-default);">Superseded (Rev #${rev.revisionIndex})</span>`;

      return `
        <div class="brain-fact-history-item" data-revision-index="${rev.revisionIndex}" style="padding: 12px 14px; border-radius: 8px; background: ${rev.isCurrent ? 'var(--bg-surface)' : 'var(--bg-subtle)'}; border: 1px solid ${rev.isCurrent ? 'var(--border-strong)' : 'var(--border-default)'}; display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              ${revBadge}
              <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border-default); background: var(--bg-canvas);">Provenance: ${escapeHtml(rev.fact.provenance)}</span>
              ${renderInlineStatusBadgeHtml(rev.fact.status as TrustStatus)}
            </div>
            <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);" title="${escapeHtml(rev.fact.recordedAt)}">
              ${escapeHtml(formatDateLabel(rev.fact.recordedAt))} · ${escapeHtml(rev.fact.recordedAt)}
            </span>
          </div>
          <div style="font-family: var(--font-mono); font-size: 12.5px; color: var(--text-primary); word-break: break-word; margin-top: 4px;">
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600; margin-bottom: 2px;">${escapeHtml(rev.fact.key)}</div>
            ${renderCompactFactValueHtml(rev.fact.key, rev.fact.value)}
          </div>
        </div>
      `;
    })
    .join('');

  let relatedSectionHtml = '';
  if (model && (!model.handoffsAvailable || !model.verificationsAvailable)) {
    const missingStreams: string[] = [];
    if (!model.handoffsAvailable) missingStreams.push('handoffs');
    if (!model.verificationsAvailable) missingStreams.push('verifications');
    relatedSectionHtml = `
      <div id="brain-fact-related-unavailable" style="padding: 12px; border-radius: 8px; background: var(--status-claimed-bg); border: 1px solid var(--status-claimed-border); color: var(--status-claimed-text); font-size: 12.5px;">
        <strong>Related Evidence Status: UNAVAILABLE</strong> — Could not inspect ${escapeHtml(missingStreams.join(' and '))} from Engine. Related task and verification cross-references cannot be determined while evidence streams are unavailable.
      </div>
    `;
  } else {
    const referencedTasks = model ? findFactReferencedTasks(item, model.derivedTasks) : [];
    const referencedLinksHtml =
      referencedTasks.length > 0
        ? `
          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
            ${referencedTasks
              .map((t) => {
                const encodedTask = encodeURIComponent(t.taskId);
                return `
                  <div style="padding: 10px 12px; border-radius: 8px; background: var(--bg-subtle); border: 1px solid var(--border-default); display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <span style="font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--text-primary);">${escapeHtml(t.taskId)}</span>
                      ${renderInlineStatusBadgeHtml(t.trustState)}
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                      <a href="#/projects/${encodedProjectId}/tasks?task=${encodedTask}" class="btn btn-secondary btn-sm" style="text-decoration: none;">Task Detail</a>
                      <a href="#/projects/${encodedProjectId}/handoffs?task=${encodedTask}" class="btn btn-secondary btn-sm" style="text-decoration: none;">Handoffs (${t.handoffCount})</a>
                      <a href="#/projects/${encodedProjectId}/verifications?task=${encodedTask}" class="btn btn-secondary btn-sm" style="text-decoration: none;">Verifications (${t.verificationCount})</a>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        `
        : `
          <div style="font-size: 12.5px; color: var(--text-muted);">
            <code>ProjectFact</code> records are persisted at project scope without a dedicated <code>taskId</code> or <code>verificationId</code> foreign key, and no task identifier is explicitly referenced in this fact's key or value.
          </div>
        `;

    relatedSectionHtml = `
      ${referencedLinksHtml}
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px;">
        <a href="#/projects/${encodedProjectId}/context" class="btn btn-secondary btn-sm" style="text-decoration: none;">Inspect Context Compiler →</a>
        <a href="#/projects/${encodedProjectId}/verifications" class="btn btn-secondary btn-sm" style="text-decoration: none;">Project Verifications →</a>
        <a href="#/projects/${encodedProjectId}/handoffs" class="btn btn-secondary btn-sm" style="text-decoration: none;">Project Handoffs →</a>
      </div>
    `;
  }

  return `
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
      <h3 class="card-title" style="margin: 0;">Fact Detail</h3>
      <button type="button" class="btn btn-secondary btn-sm" disabled title="Fact mutation is not exposed by the Engine HTTP API; Project Brain facts are append-only">Edit Fact</button>
    </div>

    <div style="padding-bottom: 14px; border-bottom: 1px solid var(--border-subtle);">
      <div style="font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 4px;">
        Fact Identifier
      </div>
      <h2 id="brain-detail-heading" style="font-size: 17px; font-weight: 700; font-family: var(--font-mono); color: var(--text-primary); word-break: break-all; margin: 0;">
        ${headingText}
      </h2>
      <div style="display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap;">
        ${renderInlineStatusBadgeHtml(f.status as TrustStatus)}
        <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-secondary); padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border-default); background: var(--bg-subtle);">
          Provenance: ${escapeHtml(f.provenance)}
        </span>
        <span style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted);">
          Recorded: ${escapeHtml(formatDateLabel(f.recordedAt))}
        </span>
        <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);">
          (${item.revisionCount} ${item.revisionCount === 1 ? 'revision' : 'revisions'})
        </span>
      </div>
    </div>

    ${trustNoticeHtml}

    <div style="display: flex; flex-direction: column; gap: 10px;">
      <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
        Fact Statement &amp; Provenance Metadata
      </div>
      <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 14px; border-radius: 10px; background: var(--bg-subtle); border: 1px solid var(--border-default);">
        <div>
          <div style="font-size: 11px; color: var(--text-muted);">Fact Key</div>
          <div style="font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--text-primary); margin-top: 2px; word-break: break-all;">${escapeHtml(f.key)}</div>
        </div>
        <div>
          <div style="font-size: 11px; color: var(--text-muted);">Provenance Source</div>
          <div style="font-size: 12.5px; font-weight: 600; color: var(--text-primary); margin-top: 2px;">${escapeHtml(f.provenance)}</div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(provenanceDesc)}</div>
        </div>
        <div style="grid-column: 1 / -1;">
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">Current Value &amp; Verified Payload</div>
          ${renderDetailFactValueHtml(f.key, f.value)}
        </div>
        <div>
          <div style="font-size: 11px; color: var(--text-muted);">Trust Status</div>
          <div style="margin-top: 4px;">${renderInlineStatusBadgeHtml(f.status as TrustStatus)}</div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">
            ${
              f.status === 'VERIFIED'
                ? 'Fact status is VERIFIED in Project Brain.'
                : f.status === 'CLAIMED'
                  ? 'Fact is CLAIMED and has not been verified.'
                  : 'Fact is UNVERIFIED.'
            }
          </div>
        </div>
        <div>
          <div style="font-size: 11px; color: var(--text-muted);">Recorded Timestamp (ISO)</div>
          <div style="font-family: var(--font-mono); font-size: 12px; color: var(--text-primary); margin-top: 2px;">${escapeHtml(f.recordedAt || 'Not recorded')}</div>
        </div>
        <div>
          <div style="font-size: 11px; color: var(--text-muted);">Persisted Revisions</div>
          <div style="font-family: var(--font-mono); font-size: 12px; color: var(--text-primary); margin-top: 2px;">${item.revisionCount} ${item.revisionCount === 1 ? 'revision' : 'revisions'} (append-only)</div>
        </div>
      </div>
      <div style="font-size: 11.5px; color: var(--text-muted);">
        Persisted <code>ProjectFact</code> schema fields: <code>key</code>, <code>value</code>, <code>provenance</code>, <code>status</code>, <code>recordedAt</code> (confidence scores are not persisted in <code>ProjectFact</code>).
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: 10px; background: var(--bg-subtle); border: 1px solid var(--border-default);">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
        <span style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          Context Compiler Eligibility
        </span>
        <span style="font-family: var(--font-mono); font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; ${scopeBadgeStyle}">
          ${escapeHtml(scopeBadgeLabel)}
        </span>
      </div>
      <div style="font-size: 12.5px; color: var(--text-secondary);">
        ${escapeHtml(item.compilerScope.explanation)}
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          Fact History &amp; Lineage (${item.revisionCount})
        </span>
        <span style="font-size: 11.5px; color: var(--text-muted);">Append-only revisions for key <code>${escapeHtml(f.key)}</code></span>
      </div>
      <div id="brain-fact-history-list" style="display: flex; flex-direction: column; gap: 8px;">
        ${historyRowsHtml}
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border-subtle);">
      <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
        Related Tasks &amp; Verification Evidence
      </div>
      ${relatedSectionHtml}
    </div>
  `;
}

/**
 * 7. PROJECT BRAIN SCREEN (Exact match to Screenshot 3 + Step 6 source-of-truth invariants)
 */
export function renderBrainScreen(route: RouteMatch): HTMLElement {
  const projectId = route.projectId || '';
  const encodedId = encodeURIComponent(projectId);
  const projectTitle = escapeHtml(formatProjectTitle(projectId));

  const initialKeyParam = (route.params?.key || route.subpath || '').trim();
  const rawProvParam = (route.params?.provenance || 'ALL').trim().toUpperCase();
  const validProvenances: FactProvenanceFilter[] = [
    'ALL',
    'CODE',
    'VERIFICATION',
    'SYSTEM',
    'AGENT',
    'HUMAN',
  ];
  let activeProvenance: FactProvenanceFilter = validProvenances.includes(
    rawProvParam as FactProvenanceFilter
  )
    ? (rawProvParam as FactProvenanceFilter)
    : 'ALL';

  const rawStatusParam = (route.params?.status || 'ALL').trim().toUpperCase();
  const validStatuses: FactStatusFilter[] = ['ALL', 'VERIFIED', 'CLAIMED', 'UNVERIFIED'];
  let activeStatus: FactStatusFilter = validStatuses.includes(rawStatusParam as FactStatusFilter)
    ? (rawStatusParam as FactStatusFilter)
    : 'ALL';

  let searchQuery = (route.params?.q || '').trim();
  let selectedFactKey = initialKeyParam;

  let allFactItems: DerivedBrainFactItem[] = [];
  let currentModel: ProjectOverviewModel | null = null;

  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';

  wrapper.innerHTML = `
    <nav class="app-breadcrumbs" aria-label="Breadcrumb">
      <a href="#/projects">Projects</a>
      <span class="separator">&gt;</span>
      <a href="#/projects/${encodedId}/overview" id="brain-crumb-project">${projectTitle}</a>
      <span class="separator">&gt;</span>
      <span class="current">Project Brain</span>
    </nav>

    <div class="page-header">
      <div class="page-header-titles">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <h1 class="page-title">Project Brain</h1>
          <span class="badge-count" id="brain-project-badge" style="font-family: var(--font-mono); font-size: 11.5px;">${escapeHtml(projectId)}</span>
        </div>
        <p class="page-subtitle">Persistent, provenance-backed project facts and handoff decisions recorded in Project Brain.</p>
      </div>
      <div class="page-header-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="brain-refresh-btn">Refresh ↻</button>
        <button type="button" class="btn btn-primary btn-sm" id="brain-add-fact-btn" disabled title="Fact creation is not exposed as a standalone HTTP mutation endpoint; facts are recorded through BrainStore during project/agent workflows">+ Add Fact</button>
      </div>
    </div>

    <div class="callout-banner" id="brain-hierarchy-banner" style="margin-bottom: 12px;">
      <span>
        <strong>Source-of-Truth Hierarchy:</strong>
        <code>CODE → VERIFICATION EVIDENCE → PROJECT BRAIN → AGENT CLAIMS</code> ·
        Project Brain stores persistent project context; it does not supersede live code or independent verification evidence. Only <strong>VERIFIED</strong> facts are admitted into downstream prompts by the Context Compiler.
      </span>
    </div>

    <div id="brain-status-banner" style="display: none; margin-bottom: 12px;"></div>

    <div id="brain-workspace-body">
      <div class="projects-toolbar" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
        <div class="projects-tabs" id="brain-provenance-tabs" role="tablist" aria-label="Filter facts by provenance">
          <button type="button" class="projects-tab active" data-provenance="ALL">All Provenance</button>
          <button type="button" class="projects-tab" data-provenance="CODE">CODE</button>
          <button type="button" class="projects-tab" data-provenance="VERIFICATION">VERIFICATION</button>
          <button type="button" class="projects-tab" data-provenance="SYSTEM">SYSTEM</button>
          <button type="button" class="projects-tab" data-provenance="HUMAN">HUMAN</button>
          <button type="button" class="projects-tab" data-provenance="AGENT">AGENT</button>
        </div>

        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
          <div class="projects-tabs" id="brain-status-tabs" role="group" aria-label="Filter facts by trust status">
            <button type="button" class="projects-tab active" data-status="ALL">All Statuses</button>
            <button type="button" class="projects-tab" data-status="VERIFIED">VERIFIED</button>
            <button type="button" class="projects-tab" data-status="CLAIMED">CLAIMED</button>
            <button type="button" class="projects-tab" data-status="UNVERIFIED">UNVERIFIED</button>
          </div>
          <input
            type="search"
            id="brain-search-input"
            class="search-input"
            placeholder="Search key, value, provenance, status..."
            aria-label="Search project facts"
            value="${escapeHtml(searchQuery)}"
            style="min-width: 240px;"
          />
        </div>
      </div>

      <div class="inspector-split-grid">
        <div class="card" style="padding: 20px; display: flex; flex-direction: column; gap: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <div>
              <h3 class="card-title" style="margin: 0;">Project Facts</h3>
              <div id="brain-facts-summary-sub" style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                Loading facts from Project Brain...
              </div>
            </div>
            <span class="badge-count" id="brain-facts-count-badge">0</span>
          </div>

          <div id="brain-facts-list" style="display: flex; flex-direction: column; gap: 10px;">
            <div style="font-size: 13px; color: var(--text-muted);">Loading facts from Project Brain...</div>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div class="card" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;" id="brain-fact-detail">
            <h3 class="card-title">Fact Detail</h3>
            <p style="font-size: 13px; color: var(--text-muted);">
              Select a recorded fact from the list to inspect its provenance, trust status, and revision lineage.
            </p>
          </div>

          <div class="card" style="padding: 20px; display: flex; flex-direction: column; gap: 12px;" id="brain-decisions-card">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
              <div>
                <h3 class="card-title" style="margin: 0;">Recorded Handoff Decisions</h3>
                <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                  Architectural decisions recorded across agent handoffs (mirrors Project Overview summary).
                </div>
              </div>
              <span class="badge-count" id="brain-decisions-count-badge">0</span>
            </div>
            <div id="brain-decisions-list" style="display: flex; flex-direction: column; gap: 8px;">
              <div style="font-size: 13px; color: var(--text-muted);">Loading handoff decisions...</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const renderBrainView = () => {
    const listEl = wrapper.querySelector('#brain-facts-list') as HTMLElement | null;
    const detailEl = wrapper.querySelector('#brain-fact-detail') as HTMLElement | null;
    const summarySubEl = wrapper.querySelector('#brain-facts-summary-sub') as HTMLElement | null;
    const countBadgeEl = wrapper.querySelector('#brain-facts-count-badge') as HTMLElement | null;
    const provTabsEl = wrapper.querySelector('#brain-provenance-tabs') as HTMLElement | null;
    const statusTabsEl = wrapper.querySelector('#brain-status-tabs') as HTMLElement | null;
    const decisionsListEl = wrapper.querySelector('#brain-decisions-list') as HTMLElement | null;
    const decisionsCountEl = wrapper.querySelector(
      '#brain-decisions-count-badge'
    ) as HTMLElement | null;

    if (!listEl || !detailEl) return;

    // Provenance counts across all current facts
    const provCounts: Record<FactProvenanceFilter, number> = {
      ALL: allFactItems.length,
      CODE: 0,
      VERIFICATION: 0,
      SYSTEM: 0,
      HUMAN: 0,
      AGENT: 0,
    };
    const statusCounts: Record<FactStatusFilter, number> = {
      ALL: allFactItems.length,
      VERIFIED: 0,
      CLAIMED: 0,
      UNVERIFIED: 0,
    };
    let totalRawRevisions = 0;
    for (const item of allFactItems) {
      const pKey = item.current.provenance as FactProvenanceFilter;
      if (pKey in provCounts) {
        provCounts[pKey] = (provCounts[pKey] ?? 0) + 1;
      }
      const sKey = item.current.status as FactStatusFilter;
      if (sKey in statusCounts) {
        statusCounts[sKey] = (statusCounts[sKey] ?? 0) + 1;
      }
      totalRawRevisions += item.revisionCount;
    }

    if (provTabsEl) {
      provTabsEl.querySelectorAll('button[data-provenance]').forEach((btn) => {
        const prov = btn.getAttribute('data-provenance') as FactProvenanceFilter;
        btn.classList.toggle('active', prov === activeProvenance);
        const count = provCounts[prov] ?? 0;
        btn.textContent = prov === 'ALL' ? `All Provenance (${count})` : `${prov} (${count})`;
      });
    }

    if (statusTabsEl) {
      statusTabsEl.querySelectorAll('button[data-status]').forEach((btn) => {
        const st = btn.getAttribute('data-status') as FactStatusFilter;
        btn.classList.toggle('active', st === activeStatus);
        const count = statusCounts[st] ?? 0;
        btn.textContent = st === 'ALL' ? `All Statuses (${count})` : `${st} (${count})`;
      });
    }

    const filteredFacts = filterProjectBrainFacts(
      allFactItems,
      activeProvenance,
      activeStatus,
      searchQuery
    );

    if (countBadgeEl) {
      countBadgeEl.textContent = `${filteredFacts.length} / ${allFactItems.length}`;
    }
    if (summarySubEl) {
      const decisionsText = currentModel
        ? currentModel.handoffsAvailable
          ? `${currentModel.decisions.length} decisions`
          : 'decisions unavailable'
        : '0 decisions';
      summarySubEl.textContent = `${allFactItems.length} current facts (${totalRawRevisions} total revisions) · ${statusCounts.VERIFIED} verified · ${decisionsText}`;
    }

    // Render Decisions card so Project Brain and Project Overview remain consistent
    if (decisionsListEl && decisionsCountEl) {
      if (!currentModel || !currentModel.handoffsAvailable) {
        decisionsCountEl.textContent = 'UNAVAILABLE';
        decisionsListEl.innerHTML = `
          <div id="brain-decisions-unavailable" style="padding: 12px; border-radius: 8px; background: var(--status-claimed-bg); border: 1px solid var(--status-claimed-border); color: var(--status-claimed-text); font-size: 12.5px;">
            <strong>Decisions Status: UNAVAILABLE</strong> — Handoff records could not be loaded from Engine. Architectural decisions recorded in handoffs cannot be displayed while handoff data is unavailable.
          </div>
        `;
      } else if (currentModel.decisions.length === 0) {
        decisionsCountEl.textContent = '0';
        decisionsListEl.innerHTML = `
          <div style="font-size: 13px; color: var(--text-muted);">
            No architectural decisions recorded across project handoffs yet.
          </div>
        `;
      } else {
        decisionsCountEl.textContent = String(currentModel.decisions.length);
        decisionsListEl.innerHTML = currentModel.decisions
          .map((d) => {
            const encodedTask = encodeURIComponent(d.taskId);
            return `
              <div class="brain-decision-item" style="padding: 12px; border-radius: 8px; background: var(--bg-subtle); border: 1px solid var(--border-default); display: flex; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
                  <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">${escapeHtml(d.statement)}</div>
                  <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border-default); background: var(--bg-surface); white-space: nowrap;">
                    ${d.status === 'ACTIVE' ? 'Active decision' : escapeHtml(d.status)}
                  </span>
                </div>
                <div style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(d.rationale)}</div>
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px;">
                  <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);">
                    Decision ID: ${escapeHtml(d.id)} · Recorded in handoff for ${escapeHtml(d.taskId)} (attempt #${Number(d.attemptNumber)})
                  </span>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <a href="#/projects/${encodedId}/tasks?task=${encodedTask}&attempt=${Number(d.attemptNumber)}" class="btn btn-secondary btn-sm" style="text-decoration: none; padding: 2px 8px; font-size: 11px;">Task</a>
                    <a href="#/projects/${encodedId}/handoffs?task=${encodedTask}&attempt=${Number(d.attemptNumber)}" class="btn btn-secondary btn-sm" style="text-decoration: none; padding: 2px 8px; font-size: 11px;">Handoff</a>
                  </div>
                </div>
              </div>
            `;
          })
          .join('');
      }
    }

    // Empty state: project has 0 persisted facts
    if (allFactItems.length === 0) {
      listEl.innerHTML = `
        <div id="brain-empty-state" style="padding: 20px; border-radius: 10px; background: var(--bg-subtle); border: 1px dashed var(--border-default); text-align: center;">
          <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">No project facts recorded yet</div>
          <p style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">
            Project Brain has no persisted <code>ProjectFact</code> entries for this project. Facts are recorded with explicit provenance (<code>CODE</code>, <code>VERIFICATION</code>, <code>SYSTEM</code>, <code>HUMAN</code>, or <code>AGENT</code>) as workflows execute.
          </p>
        </div>
      `;
      detailEl.innerHTML = `
        <h3 class="card-title">Fact Detail</h3>
        <p style="font-size: 13px; color: var(--text-muted);">
          No project facts are recorded in Project Brain for this project yet.
        </p>
      `;
      return;
    }

    // Filtered empty state: project has facts, but none match current filters/search
    if (filteredFacts.length === 0) {
      listEl.innerHTML = `
        <div id="brain-no-matches-state" style="padding: 20px; border-radius: 10px; background: var(--bg-subtle); border: 1px dashed var(--border-default); text-align: center;">
          <div style="font-weight: 600; font-size: 13.5px; color: var(--text-primary);">No matching project facts</div>
          <p style="font-size: 12.5px; color: var(--text-muted); margin-top: 4px;">
            None of the ${allFactItems.length} recorded project facts match provenance <code>${escapeHtml(activeProvenance)}</code>, status <code>${escapeHtml(activeStatus)}</code>, and query <code>${escapeHtml(searchQuery || '(empty)')}</code>.
          </p>
          <button type="button" class="btn btn-secondary btn-sm" id="brain-reset-filters-btn" style="margin-top: 10px;">Reset Filters</button>
        </div>
      `;
      listEl.querySelector('#brain-reset-filters-btn')?.addEventListener('click', () => {
        activeProvenance = 'ALL';
        activeStatus = 'ALL';
        searchQuery = '';
        const searchInput = wrapper.querySelector('#brain-search-input') as HTMLInputElement | null;
        if (searchInput) searchInput.value = '';
        renderBrainView();
      });
      detailEl.innerHTML = `
        <h3 class="card-title">Fact Detail</h3>
        <p style="font-size: 13px; color: var(--text-muted);">
          No fact matches the active filter criteria. Reset filters to inspect recorded facts.
        </p>
      `;
      return;
    }

    // Ensure selectedFactKey points to a visible fact (or notice if deep-linked key was not found)
    let missingRequestedKeyNotice = '';
    const exactAllMatch = allFactItems.find((item) => item.key === selectedFactKey);
    const exactFilteredMatch = filteredFacts.find((item) => item.key === selectedFactKey);

    if (selectedFactKey && !exactAllMatch) {
      missingRequestedKeyNotice = `
        <div class="callout-banner" id="brain-missing-key-banner" style="margin-bottom: 8px; border-color: var(--status-claimed-border); background: var(--status-claimed-bg); color: var(--status-claimed-text);">
          <span>Requested fact key <code>${escapeHtml(selectedFactKey)}</code> is not recorded in this project's Brain. Showing <code>${escapeHtml(filteredFacts[0].key)}</code> instead.</span>
        </div>
      `;
      selectedFactKey = filteredFacts[0].key;
    } else if (!exactFilteredMatch) {
      selectedFactKey = filteredFacts[0].key;
    }

    const selectedItem =
      filteredFacts.find((item) => item.key === selectedFactKey) ?? filteredFacts[0];

    listEl.innerHTML =
      missingRequestedKeyNotice +
      filteredFacts
        .map((item) => {
          const f = item.current;
          const isSelected = item.key === selectedItem.key;
          const borderStyle = isSelected
            ? 'border: 1.5px solid var(--accent-primary); background: var(--accent-primary-subtle);'
            : 'border: 1px solid var(--border-default); background: var(--bg-subtle);';

          const scopeLabel =
            item.compilerScope.scopeKind === 'GLOBAL'
              ? 'scope: global'
              : item.compilerScope.scopeKind === 'TAG_SCOPED'
                ? `scope: ${item.compilerScope.scopeTag ?? 'tagged'}`
                : item.compilerScope.scopeKind === 'UNSCOPED'
                  ? 'scope: unscoped'
                  : 'excluded from prompt';

          return `
            <div
              class="brain-fact-row ${isSelected ? 'selected' : ''}"
              data-fact-key="${escapeHtml(item.key)}"
              role="button"
              tabindex="0"
              aria-selected="${isSelected ? 'true' : 'false'}"
              style="padding: 12px 14px; border-radius: 10px; ${borderStyle} display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; cursor: pointer; transition: border-color 0.15s ease;"
            >
              <div style="min-width: 0; flex: 1;">
                <div style="font-family: var(--font-mono); font-size: 11.5px; color: var(--text-muted); word-break: break-all;">
                  ${escapeHtml(f.key)}
                </div>
                <div style="margin-top: 4px;">
                  ${renderCompactFactValueHtml(f.key, f.value)}
                </div>
                <div style="display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap;">
                  <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); padding: 1px 6px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-surface);">
                    ${escapeHtml(f.provenance)}
                  </span>
                  <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); padding: 1px 6px; border: 1px solid var(--border-subtle); border-radius: 6px;">
                    ${escapeHtml(scopeLabel)}
                  </span>
                  ${
                    item.revisionCount > 1
                      ? `<span style="font-family: var(--font-mono); font-size: 10.5px; color: var(--accent-primary); padding: 1px 6px; border-radius: 6px; background: var(--bg-surface); border: 1px solid rgba(37, 99, 235, 0.25);">${item.revisionCount} revisions</span>`
                      : ''
                  }
                  <span style="font-size: 11px; color: var(--text-muted);">
                    ${escapeHtml(formatDateLabel(f.recordedAt))}
                  </span>
                </div>
              </div>
              <div style="flex-shrink: 0;">
                ${renderInlineStatusBadgeHtml(f.status as TrustStatus)}
              </div>
            </div>
          `;
        })
        .join('');

    const rowEls = Array.from(listEl.querySelectorAll<HTMLElement>('.brain-fact-row'));
    rowEls.forEach((rowEl, idx) => {
      const selectRow = () => {
        const key = rowEl.getAttribute('data-fact-key');
        if (key && key !== selectedFactKey) {
          selectedFactKey = key;
          renderBrainView();
        }
      };
      rowEl.addEventListener('click', selectRow);
      rowEl.addEventListener('keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          selectRow();
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          const next = rowEls[idx + 1];
          if (next) {
            const nextKey = next.getAttribute('data-fact-key');
            if (nextKey) {
              selectedFactKey = nextKey;
              renderBrainView();
              const updatedNext = wrapper.querySelector<HTMLElement>(
                `.brain-fact-row[data-fact-key="${CSS.escape(nextKey)}"]`
              );
              updatedNext?.focus();
            }
          }
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          const prev = rowEls[idx - 1];
          if (prev) {
            const prevKey = prev.getAttribute('data-fact-key');
            if (prevKey) {
              selectedFactKey = prevKey;
              renderBrainView();
              const updatedPrev = wrapper.querySelector<HTMLElement>(
                `.brain-fact-row[data-fact-key="${CSS.escape(prevKey)}"]`
              );
              updatedPrev?.focus();
            }
          }
        }
      });
    });

    detailEl.innerHTML = buildBrainFactDetailHtml(selectedItem, projectId, currentModel);
  };

  // Wire toolbar interactions
  const provTabsEl = wrapper.querySelector('#brain-provenance-tabs');
  provTabsEl?.querySelectorAll('button[data-provenance]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prov = btn.getAttribute('data-provenance') as FactProvenanceFilter | null;
      if (prov) {
        activeProvenance = prov;
        renderBrainView();
      }
    });
  });

  const statusTabsEl = wrapper.querySelector('#brain-status-tabs');
  statusTabsEl?.querySelectorAll('button[data-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const st = btn.getAttribute('data-status') as FactStatusFilter | null;
      if (st) {
        activeStatus = st;
        renderBrainView();
      }
    });
  });

  const searchInput = wrapper.querySelector('#brain-search-input') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderBrainView();
  });

  const refreshBtn = wrapper.querySelector('#brain-refresh-btn');
  refreshBtn?.addEventListener('click', () => {
    void loadBrainWorkspace();
  });

  const loadBrainWorkspace = async () => {
    const statusBanner = wrapper.querySelector('#brain-status-banner') as HTMLElement | null;
    const workspaceBody = wrapper.querySelector('#brain-workspace-body') as HTMLElement | null;
    if (statusBanner) {
      statusBanner.style.display = 'none';
      statusBanner.innerHTML = '';
    }
    if (workspaceBody) {
      workspaceBody.style.display = 'block';
    }

    const [projRes, handoffsRes, verifsRes, tasksRes, repoRes] = await Promise.allSettled([
      engineClient.getProject(projectId),
      engineClient.getHandoffs(projectId),
      engineClient.getVerifications(projectId),
      engineClient.listTasks(projectId),
      engineClient.getRepositoryStatus(projectId),
    ]);

    if (projRes.status === 'rejected' || !projRes.value) {
      const err = projRes.status === 'rejected' ? projRes.reason : null;
      const errMsg = err instanceof Error ? err.message : err ? String(err) : '';
      const isNotFound =
        projRes.status === 'fulfilled' ||
        errMsg.includes('404') ||
        errMsg.toLowerCase().includes('not found');

      if (workspaceBody) workspaceBody.style.display = 'none';
      const listEl = wrapper.querySelector('#brain-facts-list');
      const detailEl = wrapper.querySelector('#brain-fact-detail');
      const decisionsListEl = wrapper.querySelector('#brain-decisions-list');
      if (listEl) {
        listEl.innerHTML = `<div style="font-size: 13px; color: var(--status-failed-text);">Project Brain facts unavailable (${isNotFound ? 'project not found' : 'Engine request failed'}).</div>`;
      }
      if (detailEl) {
        detailEl.innerHTML = `<div style="font-size: 13px; color: var(--status-failed-text);">Fact history and detail unavailable (${isNotFound ? 'project not found' : 'Engine request failed'}).</div>`;
      }
      if (decisionsListEl) {
        decisionsListEl.innerHTML = `<div style="font-size: 13px; color: var(--status-failed-text);">Recorded handoff decisions unavailable.</div>`;
      }
      if (statusBanner) {
        statusBanner.style.display = 'block';
        statusBanner.innerHTML = isNotFound
          ? `
            <div class="card" id="brain-not-found-card" style="padding: 24px; border-color: var(--status-claimed-border);">
              <h3 class="card-title">Project Not Found</h3>
              <p style="font-size: 13px; color: var(--text-secondary); margin-top: 6px;">
                Project <code>${escapeHtml(projectId)}</code> was not found in the Orchestrate Engine.
              </p>
              <div style="margin-top: 12px;">
                <a href="#/projects" class="btn btn-primary btn-sm" style="text-decoration: none;">Back to Projects</a>
              </div>
            </div>
          `
          : `
            <div class="card" id="brain-error-card" style="padding: 24px; border-color: var(--status-failed-border);">
              <h3 class="card-title" style="color: var(--status-failed-text);">Unable to Load Project Brain</h3>
              <p style="font-size: 13px; color: var(--text-secondary); margin-top: 6px;">
                ${escapeHtml(errMsg)}
              </p>
              <div style="margin-top: 12px;">
                <button type="button" class="btn btn-secondary btn-sm" id="brain-error-retry-btn">Retry ↻</button>
              </div>
            </div>
          `;
        statusBanner.querySelector('#brain-error-retry-btn')?.addEventListener('click', () => {
          void loadBrainWorkspace();
        });
      }
      return;
    }

    const project: ProjectDto = projRes.value;
    const crumbProj = wrapper.querySelector('#brain-crumb-project');
    if (crumbProj && project.name) {
      crumbProj.textContent = project.name;
    }

    const partialErrors: string[] = [];
    if (handoffsRes.status === 'rejected') {
      partialErrors.push(
        `Handoffs unavailable (${handoffsRes.reason instanceof Error ? handoffsRes.reason.message : String(handoffsRes.reason)})`
      );
    }
    if (verifsRes.status === 'rejected') {
      partialErrors.push(
        `Verifications unavailable (${verifsRes.reason instanceof Error ? verifsRes.reason.message : String(verifsRes.reason)})`
      );
    }

    if (partialErrors.length > 0 && statusBanner) {
      statusBanner.style.display = 'block';
      statusBanner.innerHTML = `
        <div class="callout-banner" id="brain-partial-banner" style="justify-content: space-between; border-color: var(--status-claimed-border); background: var(--status-claimed-bg); color: var(--status-claimed-text);">
          <span><strong>Partial data loaded:</strong> ${escapeHtml(partialErrors.join(' · '))}. Persisted project facts are shown below, while unavailable handoff/verification cross-references are marked UNAVAILABLE.</span>
          <button type="button" class="btn btn-secondary btn-sm" id="brain-partial-retry-btn">Retry ↻</button>
        </div>
      `;
      statusBanner.querySelector('#brain-partial-retry-btn')?.addEventListener('click', () => {
        void loadBrainWorkspace();
      });
    }

    const handoffsAvailable = handoffsRes.status === 'fulfilled';
    const verificationsAvailable = verifsRes.status === 'fulfilled';
    const handoffs = handoffsAvailable ? handoffsRes.value : [];
    const verifications = verificationsAvailable ? verifsRes.value : [];

    allFactItems = deriveProjectBrainFacts(project.facts);
    currentModel = deriveProjectOverviewModel(project, handoffs, verifications, {
      handoffsAvailable,
      verificationsAvailable,
    });

    if (!selectedFactKey && allFactItems.length > 0) {
      selectedFactKey = allFactItems[0].key;
    }

    renderBrainView();
  };

  void loadBrainWorkspace();

  return wrapper;
}

/**
 * 8. SETTINGS & ENGINE DIAGNOSTICS SCREEN (Exact match to Screenshot 1)
 */
/**
 * 8. SETTINGS & ENGINE DIAGNOSTICS SCREEN (Exact match to Reference Screenshot)
 */

function formatDiagTimestamp(iso?: string): string {
  if (!iso) return 'Just now';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Just now';
    return d.toLocaleString('en-US', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return 'Just now';
  }
}

export function buildDiagnosticsHtml(info: EngineHealthInfo, diagnosticTimestamp?: string): string {
  const ts = formatDiagTimestamp(diagnosticTimestamp || info.lastChecked);
  const isConnected = info.state === 'connected';

  // 1. Engine Reachability
  const reachabilityBadge = isConnected ? 'verified' : 'failed';
  const reachabilityPillText = isConnected ? 'OK' : 'FAIL';
  const reachabilityDesc = isConnected
    ? `Successfully connected to engine HTTP /health endpoint (${info.latencyMs ?? 0} ms).`
    : `Failed to connect to engine at ${escapeHtml(info.url)} (${escapeHtml(info.errorMessage || 'offline')}).`;

  // 2. Authentication
  const hasKey = Boolean(info.model?.hasApiKey);
  const authBadge = !isConnected ? 'unverified' : hasKey ? 'verified' : 'unverified';
  const authPillText = !isConnected ? 'UNKNOWN' : hasKey ? 'OK' : 'WARN';
  const authDesc = !isConnected
    ? 'Cannot verify credentials while engine is unreachable.'
    : hasKey
      ? 'NEBIUS_API_KEY configured (masked).'
      : 'NEBIUS_API_KEY environment variable is not set in engine environment.';

  // 3. Model Availability
  const modelName = info.model?.defaultModel || 'meta-llama/Llama-3.3-70B-Instruct';
  const modelBadge = isConnected ? 'verified' : 'unverified';
  const modelPillText = isConnected ? 'OK' : 'UNKNOWN';
  const modelDesc = isConnected
    ? `Configured model: ${escapeHtml(modelName)}. (Inference not executed in diagnostic check)`
    : 'Engine offline.';

  // 4. Request Processing & Capabilities
  const capsBadge = isConnected ? 'verified' : 'unverified';
  const capsPillText = isConnected ? 'OK' : 'UNKNOWN';
  const capsDesc = isConnected
    ? 'Capabilities ready: 4 tools (read_file, write_file, execute_command, get_project_info), sandboxed workspace, verification engine.'
    : 'Engine offline.';

  return `
    <div style="display: flex; flex-direction: column; gap: 14px; font-size: 13px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border-subtle);">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
          <span style="font-weight: 550; color: var(--text-primary); white-space: nowrap; width: 145px;">Engine Reachability</span>
          <span class="status-badge ${reachabilityBadge}" style="font-size: 11px; padding: 2px 8px;">${reachabilityPillText}</span>
          <span style="font-size: 12.5px; color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${reachabilityDesc}</span>
        </div>
        <span style="font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(ts)}</span>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border-subtle);">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
          <span style="font-weight: 550; color: var(--text-primary); white-space: nowrap; width: 145px;">Authentication</span>
          <span class="status-badge ${authBadge}" style="font-size: 11px; padding: 2px 8px;">${authPillText}</span>
          <span style="font-size: 12.5px; color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${authDesc}</span>
        </div>
        <span style="font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(ts)}</span>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--border-subtle);">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
          <span style="font-weight: 550; color: var(--text-primary); white-space: nowrap; width: 145px;">Model Availability</span>
          <span class="status-badge ${modelBadge}" style="font-size: 11px; padding: 2px 8px;">${modelPillText}</span>
          <span style="font-size: 12.5px; color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${modelDesc}</span>
        </div>
        <span style="font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(ts)}</span>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
          <span style="font-weight: 550; color: var(--text-primary); white-space: nowrap; width: 145px;">Request Processing</span>
          <span class="status-badge ${capsBadge}" style="font-size: 11px; padding: 2px 8px;">${capsPillText}</span>
          <span style="font-size: 12.5px; color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${capsDesc}</span>
        </div>
        <span style="font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(ts)}</span>
      </div>

      <div style="margin-top: 8px; padding-top: 10px; border-top: 1px dotted var(--border-strong); font-size: 11.5px; color: var(--text-muted); line-height: 1.4;">
        Note: Connection diagnostics evaluate HTTP connectivity, environment credentials, and capability registries. Model inference was <strong>not executed</strong> during this check.
      </div>
    </div>
  `;
}

export function buildEngineConnectionHtml(info: EngineHealthInfo, settings: ApplicationSettings): string {
  const isConnected = info.state === 'connected';
  const badgeClass = isConnected ? 'verified' : info.state === 'connecting' ? 'in-progress' : 'failed';
  const badgeText = isConnected ? '● Connected' : info.state === 'connecting' ? '● Connecting' : '● Unavailable';

  const statusTitle = isConnected ? 'Connected' : info.state === 'connecting' ? 'Connecting' : 'Unavailable';
  const statusColor = isConnected ? '#15803d' : info.state === 'connecting' ? 'var(--text-primary)' : '#b91c1c';
  const statusSub = isConnected
    ? 'Engine is ready to process requests.'
    : info.state === 'connecting'
      ? 'Connecting to engine...'
      : escapeHtml(info.errorMessage || 'Engine offline or unreachable. Start engine on port 3001.');

  const modelName = info.model?.defaultModel || 'meta-llama/Llama-3.3-70B-Instruct';
  const lastCheckedText = info.lastChecked ? formatDiagTimestamp(info.lastChecked) : 'Never';
  const latencyText = info.latencyMs !== undefined ? `${Number(info.latencyMs)} ms` : '—';

  return `
    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
      <div>
        <h3 class="card-title" style="margin: 0;">Engine Connection</h3>
        <p class="card-subtitle" style="margin-top: 2px;">Connection status and configuration for the AI engine.</p>
      </div>
      <span class="status-badge ${badgeClass}" id="settings-status-badge">${badgeText}</span>
    </div>

    <div style="display: grid; grid-template-columns: 120px 1fr; row-gap: 14px; align-items: center; font-size: 13px; margin-top: 4px;">
      <span style="color: var(--text-muted);">Status</span>
      <div>
        <div style="font-weight: 600; color: ${statusColor};" id="conn-status-title">${statusTitle}</div>
        <div style="font-size: 12px; color: var(--text-muted);" id="conn-status-sub">${statusSub}</div>
      </div>

      <span style="color: var(--text-muted);">Engine</span>
      <div>
        <div style="font-weight: 550; color: var(--text-primary);">Nebius Token Factory</div>
        <div style="font-size: 11.5px; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(modelName)}</div>
      </div>

      <span style="color: var(--text-muted);">Engine URL</span>
      <div>
        <input
          type="text"
          id="settings-engine-url"
          class="input"
          value="${escapeHtml(settings.engineUrl || info.url)}"
          style="font-family: var(--font-mono); font-size: 12.5px; padding: 7px 11px;"
          placeholder="http://127.0.0.1:3001"
        />
        <div id="settings-url-error" style="display: none; color: #b91c1c; font-size: 11.5px; margin-top: 4px;"></div>
      </div>

      <span style="color: var(--text-muted);">Last Checked</span>
      <span id="settings-last-checked" style="color: var(--text-primary); font-size: 12.5px;">${escapeHtml(lastCheckedText)}</span>

      <span style="color: var(--text-muted);">Latency</span>
      <span id="settings-latency" style="font-family: var(--font-mono); font-weight: 550; color: var(--text-primary);">${latencyText}</span>
    </div>

    <div style="display: flex; gap: 10px; padding-top: 8px; align-items: center; flex-wrap: wrap;">
      <button type="button" class="btn btn-secondary" id="settings-reconnect-btn">↻ Reconnect</button>
      <button type="button" class="btn btn-secondary" id="settings-test-btn">↗ Test Connection</button>
      <div id="settings-conn-feedback" style="display: none; font-size: 12px; padding: 4px 10px; border-radius: 6px; font-weight: 500;"></div>
    </div>
  `;
}

export function buildEngineConfigHtml(info: EngineHealthInfo): string {
  const modelName = info.model?.defaultModel || 'meta-llama/Llama-3.3-70B-Instruct';
  const isTest = info.model?.provider === 'test' || info.model?.testMode;

  return `
    <div style="display: flex; align-items: flex-start; justify-content: space-between;">
      <div>
        <h3 class="card-title" style="margin: 0;">Engine Configuration</h3>
        <p class="card-subtitle" style="margin-top: 2px;">Configure engine settings for this application.</p>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 14px; font-size: 13px; margin-top: 4px;">
      <div>
        <label for="settings-provider-select" style="display: block; font-size: 12.5px; font-weight: 550; color: var(--text-primary); margin-bottom: 5px;">Engine Provider</label>
        <select class="select" id="settings-provider-select" style="width: 100%;">
          <option value="nebius" ${!isTest ? 'selected' : ''}>Nebius (Token Factory - Required Provider)</option>
          <option value="test" ${isTest ? 'selected' : ''}>Deterministic Test Mode (Offline / 0 Cost)</option>
        </select>
      </div>

      <div id="settings-api-key-container" style="${isTest ? 'display: none;' : ''}">
        <label for="settings-api-key-input" style="display: block; font-size: 12.5px; font-weight: 550; color: var(--text-primary); margin-bottom: 5px;">Nebius API Key</label>
        <div style="display: flex; gap: 8px;">
          <input
            type="password"
            class="input"
            id="settings-api-key-input"
            placeholder="${info.model?.hasApiKey ? '•••••••••••••••• (API key configured)' : 'Enter Nebius API key'}"
            style="flex: 1; font-family: var(--font-mono); font-size: 12.5px; padding: 8px 11px;"
          />
          <button type="button" class="btn btn-secondary btn-sm" id="toggle-key-visibility-btn">Show</button>
        </div>
        <span style="font-size: 11px; color: var(--text-muted); margin-top: 3px; display: block;">Saved safely to engine process in memory; never committed or logged.</span>
      </div>

      <div>
        <label for="settings-model-input" style="display: block; font-size: 12.5px; font-weight: 550; color: var(--text-primary); margin-bottom: 5px;">Model</label>
        <input
          type="text"
          class="input"
          id="settings-model-input"
          value="${escapeHtml(modelName)}"
          style="font-family: var(--font-mono); font-size: 12.5px; padding: 8px 11px;"
        />
      </div>

      <div>
        <label for="settings-tokens-input" style="display: block; font-size: 12.5px; font-weight: 550; color: var(--text-primary); margin-bottom: 5px;">Max Response Tokens</label>
        <input
          type="number"
          class="input"
          id="settings-tokens-input"
          value="4096"
          disabled
          readonly
          style="background-color: var(--bg-subtle); color: var(--text-muted); cursor: not-allowed; font-family: var(--font-mono); font-size: 12.5px; padding: 8px 11px;"
        />
      </div>

      <div>
        <label for="settings-timeout-input" style="display: block; font-size: 12.5px; font-weight: 550; color: var(--text-primary); margin-bottom: 5px;">Request Timeout (seconds)</label>
        <input
          type="number"
          class="input"
          id="settings-timeout-input"
          value="120"
          disabled
          readonly
          style="background-color: var(--bg-subtle); color: var(--text-muted); cursor: not-allowed; font-family: var(--font-mono); font-size: 12.5px; padding: 8px 11px;"
        />
      </div>
    </div>

    <div id="settings-model-feedback" style="display: none; font-size: 12px; padding: 8px 12px; border-radius: 6px; margin-top: 8px;"></div>

    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: auto; padding-top: 14px; border-top: 1px solid var(--border-subtle);">
      <div style="font-size: 11.5px; color: var(--text-muted); line-height: 1.45;">
        These settings apply to all projects in this workspace.<br/>
        <span style="color: var(--text-secondary);">Runtime server re-configuration via UI is not supported by default without active engine. Settings are loaded from environment variables (<code>NEBIUS_API_KEY</code>, <code>NEBIUS_BASE_URL</code>, <code>NEBIUS_DEFAULT_MODEL</code>) or configured dynamically below.</span>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button type="button" class="btn btn-primary" id="settings-save-engine-btn">Save Changes</button>
      </div>
    </div>
  `;
}

export function buildAppSettingsHtml(settings: ApplicationSettings): string {
  return `
    <div style="display: flex; align-items: flex-start; justify-content: space-between;">
      <div>
        <h3 class="card-title" style="margin: 0;">Application Settings</h3>
        <p class="card-subtitle" style="margin-top: 2px;">Basic preferences for your Orchestrate experience.</p>
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin-top: 4px;">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-subtle);">
        <div>
          <div style="font-weight: 550; font-size: 13.5px; color: var(--text-primary);">Theme</div>
        </div>
        <select class="select" id="setting-theme" style="width: 140px; padding: 6px 28px 6px 10px; font-size: 12.5px;">
          <option value="light" selected>Light</option>
        </select>
      </div>

      <div class="toggle-switch-wrapper">
        <div class="toggle-switch-label">
          <span class="toggle-switch-title">Auto-refresh data</span>
          <span class="toggle-switch-desc">Automatically refresh task and verification data.</span>
        </div>
        <label class="toggle-switch" aria-label="Auto-refresh data">
          <input type="checkbox" id="setting-auto-refresh" ${settings.autoRefresh ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="toggle-switch-wrapper">
        <div class="toggle-switch-label">
          <span class="toggle-switch-title">Open links in new tab</span>
          <span class="toggle-switch-desc">Open project files and external links in a new tab.</span>
        </div>
        <label class="toggle-switch" aria-label="Open links in new tab">
          <input type="checkbox" id="setting-open-links-new-tab" ${settings.openLinksInNewTab ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="toggle-switch-wrapper">
        <div class="toggle-switch-label">
          <span class="toggle-switch-title">Confirm before running tasks</span>
          <span class="toggle-switch-desc">Show a confirmation dialog before starting a new task.</span>
        </div>
        <label class="toggle-switch" aria-label="Confirm before running tasks">
          <input type="checkbox" id="setting-confirm-tasks" ${settings.confirmBeforeRunningTasks ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="toggle-switch-wrapper">
        <div class="toggle-switch-label">
          <span class="toggle-switch-title">Show relative timestamps</span>
          <span class="toggle-switch-desc">Show times like &quot;2 hours ago&quot; instead of full timestamps.</span>
        </div>
        <label class="toggle-switch" aria-label="Show relative timestamps">
          <input type="checkbox" id="setting-relative-timestamps" ${settings.showRelativeTimestamps ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div id="settings-app-feedback" style="display: none; font-size: 12px; color: #15803d; padding-top: 10px; font-weight: 550;">
      Preferences saved to browser storage ✓
    </div>
  `;
}

export function buildAppInfoHtml(info: EngineHealthInfo): string {
  const pid = info.process?.pid ? String(info.process.pid) : '—';
  const nodeVer = info.process?.nodeVersion || '>=22.8.0';

  return `
    <h3 class="card-title" style="margin: 0;">Application Information</h3>
    <p class="card-subtitle" style="margin-top: 2px; margin-bottom: 14px;">Version and environment information about Orchestrate.</p>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; font-size: 12.5px;">
      <div><span style="color: var(--text-muted); display: block; font-size: 11.5px;">Application</span> <strong style="color: var(--text-primary);">Orchestrate</strong></div>
      <div><span style="color: var(--text-muted); display: block; font-size: 11.5px;">Version</span> <strong style="color: var(--text-primary); font-family: var(--font-mono);">0.1.0</strong></div>
      <div><span style="color: var(--text-muted); display: block; font-size: 11.5px;">Environment</span> <strong style="color: var(--text-primary);">Development</strong></div>
      <div><span style="color: var(--text-muted); display: block; font-size: 11.5px;">Build</span> <strong style="color: var(--text-primary); font-family: var(--font-mono);">Hackathon MVP</strong></div>
      <div><span style="color: var(--text-muted); display: block; font-size: 11.5px;">Engine PID</span> <strong style="color: var(--text-primary); font-family: var(--font-mono);">${escapeHtml(pid)}</strong></div>
      <div><span style="color: var(--text-muted); display: block; font-size: 11.5px;">Engine Node</span> <strong style="color: var(--text-primary); font-family: var(--font-mono);">${escapeHtml(nodeVer)}</strong></div>
    </div>
  `;
}

export function renderSettingsScreen(): HTMLElement {
  let settings = loadApplicationSettings();
  let info = engineClient.getInfo();

  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';

  wrapper.innerHTML = `
    <nav class="app-breadcrumbs" aria-label="Breadcrumb">
      <a href="#/projects">Settings</a>
      <span class="separator">&gt;</span>
      <span class="current">Engine</span>
    </nav>

    <div class="page-header">
      <div class="page-header-titles">
        <h1 class="page-title">Engine Diagnostics and Settings</h1>
        <p class="page-subtitle">Manage your engine connection, view diagnostics, and configure application settings.</p>
      </div>
    </div>

    <div class="hero-dual-grid" style="grid-template-columns: 1fr 1fr; gap: 22px;">
      <!-- Top Left: Engine Connection -->
      <div class="card" id="card-engine-conn" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;">
        ${buildEngineConnectionHtml(info, settings)}
      </div>

      <!-- Top Right: Connection Diagnostics -->
      <div class="card" id="card-diagnostics" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
          <div>
            <h3 class="card-title" style="margin: 0;">Connection Diagnostics</h3>
            <p class="card-subtitle" style="margin-top: 2px;">Check the health and availability of the engine.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="run-diag-btn">▷ Run Diagnostics</button>
        </div>

        <div id="diag-results-container">
          ${buildDiagnosticsHtml(info)}
        </div>
      </div>

      <!-- Middle Left: Engine Configuration -->
      <div class="card" id="card-engine-config" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;">
        ${buildEngineConfigHtml(info)}
      </div>

      <!-- Middle Right: Application Settings -->
      <div class="card" id="card-app-settings" style="padding: 24px; display: flex; flex-direction: column; gap: 16px;">
        ${buildAppSettingsHtml(settings)}
      </div>
    </div>

    <!-- Bottom: Application Information -->
    <div class="card" id="card-app-info" style="padding: 20px 24px; margin-top: 22px;">
      ${buildAppInfoHtml(info)}
    </div>
  `;

  const refreshUI = () => {
    info = engineClient.getInfo();
    settings = loadApplicationSettings();

    const connCard = wrapper.querySelector('#card-engine-conn');
    if (connCard) {
      connCard.innerHTML = buildEngineConnectionHtml(info, settings);
      wireConnectionControls();
  wireEngineConfigControls();
    }

    const diagContainer = wrapper.querySelector('#diag-results-container');
    if (diagContainer) {
      diagContainer.innerHTML = buildDiagnosticsHtml(info);
    }

    const configCard = wrapper.querySelector('#card-engine-config');
    if (configCard) {
      configCard.innerHTML = buildEngineConfigHtml(info);
      wireEngineConfigControls();
    }

    const infoCard = wrapper.querySelector('#card-app-info');
    if (infoCard) {
      infoCard.innerHTML = buildAppInfoHtml(info);
    }
  };

  const wireEngineConfigControls = () => {
    const providerSelect = wrapper.querySelector('#settings-provider-select') as HTMLSelectElement | null;
    const apiKeyContainer = wrapper.querySelector('#settings-api-key-container') as HTMLElement | null;
    const apiKeyInput = wrapper.querySelector('#settings-api-key-input') as HTMLInputElement | null;
    const toggleKeyBtn = wrapper.querySelector('#toggle-key-visibility-btn') as HTMLButtonElement | null;
    const modelInput = wrapper.querySelector('#settings-model-input') as HTMLInputElement | null;
    const saveEngineBtn = wrapper.querySelector('#settings-save-engine-btn') as HTMLButtonElement | null;
    const feedbackEl = wrapper.querySelector('#settings-model-feedback') as HTMLElement | null;

    providerSelect?.addEventListener('change', () => {
      if (apiKeyContainer) {
        apiKeyContainer.style.display = providerSelect.value === 'test' ? 'none' : 'block';
      }
    });

    toggleKeyBtn?.addEventListener('click', () => {
      if (!apiKeyInput) return;
      if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleKeyBtn.textContent = 'Hide';
      } else {
        apiKeyInput.type = 'password';
        toggleKeyBtn.textContent = 'Show';
      }
    });

    saveEngineBtn?.addEventListener('click', async () => {
      if (!saveEngineBtn) return;
      saveEngineBtn.disabled = true;
      saveEngineBtn.textContent = 'Saving...';
      const isTest = providerSelect?.value === 'test';
      const model = modelInput?.value.trim();
      const apiKey = apiKeyInput?.value.trim();

      try {
        await engineClient.saveModelConfig({
          testMode: isTest,
          model: model || undefined,
          apiKey: apiKey || undefined,
        });
        await engineClient.checkHealth();
        refreshUI();

        const newFeedback = wrapper.querySelector('#settings-model-feedback') as HTMLElement | null;
        if (newFeedback) {
          newFeedback.style.display = 'block';
          newFeedback.style.backgroundColor = 'var(--status-verified-bg)';
          newFeedback.style.color = 'var(--status-verified-text)';
          newFeedback.textContent = '✓ Engine model configuration updated successfully.';
          setTimeout(() => {
            newFeedback.style.display = 'none';
          }, 3500);
        }
      } catch (err) {
        if (feedbackEl) {
          feedbackEl.style.display = 'block';
          feedbackEl.style.backgroundColor = 'var(--status-failed-bg)';
          feedbackEl.style.color = 'var(--status-failed-text)';
          feedbackEl.textContent = `✕ Failed to save config: ${(err as Error).message}`;
        }
      } finally {
        if (saveEngineBtn) {
          saveEngineBtn.disabled = false;
          saveEngineBtn.textContent = 'Save Changes';
        }
      }
    });
  };

  const wireConnectionControls = () => {
    const reconnectBtn = wrapper.querySelector('#settings-reconnect-btn') as HTMLButtonElement | null;
    const testBtn = wrapper.querySelector('#settings-test-btn') as HTMLButtonElement | null;
    const urlInput = wrapper.querySelector('#settings-engine-url') as HTMLInputElement | null;
    const urlError = wrapper.querySelector('#settings-url-error') as HTMLElement | null;
    const feedback = wrapper.querySelector('#settings-conn-feedback') as HTMLElement | null;

    const handleReconnect = async () => {
      const rawUrl = (urlInput?.value || urlInput?.getAttribute('value') || engineClient.getInfo().url || '').trim();
      const validation = validateEngineUrl(rawUrl);

      if (!validation.valid) {
        if (urlError) {
          urlError.style.display = 'block';
          urlError.textContent = validation.error || 'Invalid URL.';
        }
        return;
      }

      if (urlError) {
        urlError.style.display = 'none';
        urlError.textContent = '';
      }

      saveApplicationSettings({ engineUrl: rawUrl });
      engineClient.setBaseUrl(rawUrl);

      if (reconnectBtn) {
        reconnectBtn.disabled = true;
        reconnectBtn.textContent = 'Connecting...';
      }

      try {
        const result = await engineClient.checkHealth();
        refreshUI();

        const newFeedback = wrapper.querySelector('#settings-conn-feedback') as HTMLElement | null;
        if (newFeedback) {
          newFeedback.style.display = 'inline-block';
          if (result.state === 'connected') {
            newFeedback.style.background = 'var(--status-verified-bg)';
            newFeedback.style.color = 'var(--status-verified-text)';
            newFeedback.textContent = `Connected successfully (${result.latencyMs ?? 0} ms) ✓`;
          } else {
            newFeedback.style.background = 'var(--status-failed-bg)';
            newFeedback.style.color = 'var(--status-failed-text)';
            newFeedback.textContent = `Connection failed (${result.errorMessage || 'offline'})`;
          }
          setTimeout(() => {
            newFeedback.style.display = 'none';
          }, 3500);
        }
      } finally {
        if (reconnectBtn) {
          reconnectBtn.disabled = false;
          reconnectBtn.textContent = '↻ Reconnect';
        }
      }
    };

    const handleTest = async () => {
      if (testBtn) {
        testBtn.disabled = true;
        testBtn.textContent = 'Testing...';
      }

      try {
        const result = await engineClient.checkHealth();
        refreshUI();

        const newFeedback = wrapper.querySelector('#settings-conn-feedback') as HTMLElement | null;
        if (newFeedback) {
          newFeedback.style.display = 'inline-block';
          if (result.state === 'connected') {
            newFeedback.style.background = 'var(--status-verified-bg)';
            newFeedback.style.color = 'var(--status-verified-text)';
            newFeedback.textContent = `Test passed: HTTP 200 (${result.latencyMs ?? 0} ms) ✓`;
          } else {
            newFeedback.style.background = 'var(--status-failed-bg)';
            newFeedback.style.color = 'var(--status-failed-text)';
            newFeedback.textContent = `Test failed: ${result.errorMessage || 'offline'}`;
          }
          setTimeout(() => {
            newFeedback.style.display = 'none';
          }, 3500);
        }
      } finally {
        if (testBtn) {
          testBtn.disabled = false;
          testBtn.textContent = '↗ Test Connection';
        }
      }
    };

    reconnectBtn?.addEventListener('click', () => {
      void handleReconnect();
    });

    testBtn?.addEventListener('click', () => {
      void handleTest();
    });
  };

  wireConnectionControls();
  wireEngineConfigControls();

  // Diagnostics runner
  const diagBtn = wrapper.querySelector('#run-diag-btn') as HTMLButtonElement | null;
  diagBtn?.addEventListener('click', async () => {
    if (diagBtn) {
      diagBtn.disabled = true;
      diagBtn.textContent = 'Running...';
    }

    try {
      await engineClient.checkHealth();
      const diagContainer = wrapper.querySelector('#diag-results-container');
      if (diagContainer) {
        diagContainer.innerHTML = buildDiagnosticsHtml(engineClient.getInfo(), new Date().toISOString());
      }
      refreshUI();
    } finally {
      if (diagBtn) {
        diagBtn.disabled = false;
        diagBtn.textContent = '▷ Run Diagnostics';
      }
    }
  });

  // Wire application preferences switches
  const wireAppSwitches = () => {
    const autoRefreshCb = wrapper.querySelector('#setting-auto-refresh') as HTMLInputElement | null;
    const openLinksCb = wrapper.querySelector('#setting-open-links-new-tab') as HTMLInputElement | null;
    const confirmTasksCb = wrapper.querySelector('#setting-confirm-tasks') as HTMLInputElement | null;
    const relativeTimeCb = wrapper.querySelector('#setting-relative-timestamps') as HTMLInputElement | null;
    const feedbackEl = wrapper.querySelector('#settings-app-feedback') as HTMLElement | null;

    const handleSwitchChange = () => {
      const updatedPatch: Partial<ApplicationSettings> = {
        autoRefresh: autoRefreshCb ? autoRefreshCb.checked : true,
        openLinksInNewTab: openLinksCb ? openLinksCb.checked : true,
        confirmBeforeRunningTasks: confirmTasksCb ? confirmTasksCb.checked : false,
        showRelativeTimestamps: relativeTimeCb ? relativeTimeCb.checked : true,
      };

      saveApplicationSettings(updatedPatch);

      if (updatedPatch.autoRefresh) {
        engineClient.startPolling();
      } else {
        engineClient.stopPolling();
      }

      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        setTimeout(() => {
          feedbackEl.style.display = 'none';
        }, 2500);
      }
    };

    autoRefreshCb?.addEventListener('change', handleSwitchChange);
    openLinksCb?.addEventListener('change', handleSwitchChange);
    confirmTasksCb?.addEventListener('change', handleSwitchChange);
    relativeTimeCb?.addEventListener('change', handleSwitchChange);
  };

  wireAppSwitches();

  return wrapper;
}

export function renderPlaceholderPage(route: RouteMatch): HTMLElement {
  switch (route.destination) {
    case 'projects':
      return renderProjectsScreen();
    case 'overview':
      return renderOverviewScreen(route);
    case 'context':
      return renderContextScreen(route);
    case 'verifications':
      return renderVerificationsScreen(route);
    case 'handoffs':
      return renderHandoffsScreen(route);
    case 'tasks':
      if (route.params.taskId && route.params.taskId.trim()) {
        return renderTaskWorkspaceScreen(route);
      }
      return renderTasksScreen(route);
    case 'brain':
      return renderBrainScreen(route);
    case 'settings':
      return renderSettingsScreen();
    default:
      return renderProjectsScreen();
  }
}
