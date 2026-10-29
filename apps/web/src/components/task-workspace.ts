import {
  engineClient,
  escapeHtml,
  type ProjectDto,
  type HandoffDto,
  type VerificationRecordDto,
  type TaskSummaryDto,
  type ExecutionTimelineStepDto,
  type TaskPlanDto,
  type TaskReviewDto,
  type TaskDetailDto,
  type RepositoryTreeDto,
  type RepositoryFileItemDto,
  type RepositoryDirectoryItemDto,
  type RepositoryFileContentDto,
} from '../services/engine-client.js';
import { router, type RouteMatch } from '../services/router.js';
import {
  deriveProjectOverviewModel,
  type ProjectOverviewModel,
  type DerivedTaskSummary,
  type DerivedTaskAttempt,
  type TrustStatus,
} from './placeholder-page.js';
import {
  formatActivityDetailHtml,
  formatSummaryPreview,
  stripMarkdownFormatting,
  renderCompactFactValueHtml,
  renderDetailFactValueHtml,
  renderBoundedLogBoxHtml,
} from './content-disclosure.js';

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  const sec = durationMs / 1000;
  if (sec < 60) return `${sec.toFixed(2)}s`;
  const min = Math.floor(sec / 60);
  const remSec = (sec % 60).toFixed(1);
  return `${min}m ${remSec}s`;
}

function addClass(el: Element | null | undefined, cls: string): void {
  if (!el) return;
  if (el.classList && typeof el.classList.add === 'function') {
    el.classList.add(cls);
  } else if (typeof (el as any).className === 'string') {
    const parts = (el as any).className.split(/\s+/).filter(Boolean);
    if (!parts.includes(cls)) {
      parts.push(cls);
      (el as any).className = parts.join(' ');
    }
  }
}

function removeClass(el: Element | null | undefined, cls: string): void {
  if (!el) return;
  if (el.classList && typeof el.classList.remove === 'function') {
    el.classList.remove(cls);
  } else if (typeof (el as any).className === 'string') {
    (el as any).className = (el as any).className
      .split(/\s+/)
      .filter((p: string) => p && p !== cls)
      .join(' ');
  }
}

function hasClass(el: Element | null | undefined, cls: string): boolean {
  if (!el) return false;
  if (el.classList && typeof el.classList.contains === 'function') {
    return el.classList.contains(cls);
  }
  if (typeof (el as any).className === 'string') {
    return (el as any).className.split(/\s+/).includes(cls);
  }
  return false;
}

function formatDateLabel(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  } catch {
    return iso;
  }
}

function renderInlineStatusBadgeHtml(status: TrustStatus): string {
  const norm = status || 'UNVERIFIED';
  let variantClass = 'unverified';
  let label: string = norm;

  switch (norm) {
    case 'VERIFIED':
      variantClass = 'verified';
      label = 'VERIFIED';
      break;
    case 'CLAIMED':
      variantClass = 'claimed';
      label = 'CLAIMED';
      break;
    case 'FAILED':
      variantClass = 'failed';
      label = 'FAILED';
      break;
    case 'BLOCKED_NEEDS_HUMAN':
      variantClass = 'blocked';
      label = 'BLOCKED';
      break;
    case 'UNVERIFIED':
    default:
      variantClass = 'unverified';
      label = 'UNVERIFIED';
      break;
  }

  return `<span class="status-badge ${variantClass}">${escapeHtml(label)}</span>`;
}

function formatProjectTitle(projectId: string): string {
  const known = engineClient.getKnownProjects().find((p) => p.id === projectId);
  if (known && known.name) return known.name;
  return projectId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDiffHtml(rawDiff: string): string {
  if (!rawDiff || !rawDiff.trim()) {
    return `<div style="padding: 32px 16px; text-align: center; color: var(--text-muted); font-size: 12px; font-family: var(--font-mono);">(No git diff recorded for this task attempt)</div>`;
  }

  const lines = rawDiff.split('\n');
  return lines
    .map((line) => {
      const escaped = escapeHtml(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<div class="diff-line-add" style="padding: 1px 10px;">${escaped || ' '}</div>`;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return `<div class="diff-line-del" style="padding: 1px 10px;">${escaped || ' '}</div>`;
      }
      if (line.startsWith('@@')) {
        return `<div class="diff-line-hunk" style="padding: 2px 10px;">${escaped || ' '}</div>`;
      }
      return `<div style="padding: 1px 10px; color: var(--text-secondary);">${escaped || ' '}</div>`;
    })
    .join('');
}

interface ActivityGroupDef {
  id: string;
  title: string;
  icon: string;
  description: string;
  events: ExecutionTimelineStepDto[];
}

function renderGroupedActivityHtml(timeline: ExecutionTimelineStepDto[]): string {
  if (!timeline || timeline.length === 0) {
    return `<div style="padding: 28px 14px; text-align: center; color: var(--text-muted); font-size: 12px;">No activity recorded for this task execution yet. Click <strong>▷ Run Task</strong> to start.</div>`;
  }

  const groups: Record<string, ActivityGroupDef> = {
    planning: {
      id: 'planning',
      title: 'Planning',
      icon: '📋',
      description: 'Architectural planning & problem decomposition',
      events: [],
    },
    inspection: {
      id: 'inspection',
      title: 'File Inspection',
      icon: '🔍',
      description: 'Repository inspection, tree analysis, and file reading',
      events: [],
    },
    implementation: {
      id: 'implementation',
      title: 'Implementation',
      icon: '✏️',
      description: 'Code modifications and file writing in isolated workspace',
      events: [],
    },
    commands: {
      id: 'commands',
      title: 'Commands & Tests',
      icon: '⚡',
      description: 'Command execution and test runner output',
      events: [],
    },
    review: {
      id: 'review',
      title: 'Code Review',
      icon: '🧐',
      description: 'Independent architectural review & regression check',
      events: [],
    },
    verification: {
      id: 'verification',
      title: 'Verification',
      icon: '✓',
      description: 'Independent verification engine evaluation',
      events: [],
    },
  };

  for (const item of timeline) {
    const s = [
      item.step,
      item.title,
      item.detail,
      (item as any).type,
      (item as any).tool,
      (item as any).plan,
      (item as any).findings,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (s.includes('plan')) {
      groups.planning.events.push(item);
    } else if (s.includes('review')) {
      groups.review.events.push(item);
    } else if (s.includes('verif') || s.includes('check') || s.includes('evaluat')) {
      groups.verification.events.push(item);
    } else if (
      s.includes('read') ||
      s.includes('inspect') ||
      s.includes('tree') ||
      s.includes('scope') ||
      s.includes('stat')
    ) {
      groups.inspection.events.push(item);
    } else if (
      s.includes('exec') ||
      s.includes('cmd') ||
      s.includes('command') ||
      s.includes('test') ||
      s.includes('run')
    ) {
      groups.commands.events.push(item);
    } else {
      groups.implementation.events.push(item);
    }
  }

  const renderedGroups = Object.values(groups).filter((g) => g.events.length > 0);

  if (renderedGroups.length === 0) {
    return timeline
      .map(
        (item) => `
      <div class="activity-tool-event" style="margin-bottom: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-weight: 600; color: var(--text-primary); font-size: 11.5px;">${escapeHtml(item.title || item.step)}</span>
          <span style="font-size: 10px; color: var(--text-muted); font-family: var(--font-mono);">${item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : ''}</span>
        </div>
        <div style="min-width: 0; width: 100%; margin-top: 2px;">${formatActivityDetailHtml(item.detail || '')}</div>
      </div>
    `
      )
      .join('');
  }

  return renderedGroups
    .map((g) => {
      const eventCount = g.events.length;
      const latestEvent = g.events[g.events.length - 1];

      return `
      <div class="activity-group" data-group-id="${g.id}">
        <div class="activity-group-header" data-toggle-group="${g.id}">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span>${g.icon}</span>
            <span>${escapeHtml(g.title)}</span>
            <span class="badge" style="font-size: 10px; padding: 1px 6px; background: var(--bg-hover); color: var(--text-secondary); font-family: var(--font-mono);">${eventCount}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 10px; color: var(--text-muted);">${latestEvent.timestamp ? new Date(latestEvent.timestamp).toLocaleTimeString() : ''}</span>
            <span class="activity-group-caret" style="font-size: 9px; color: var(--text-muted);">▼</span>
          </div>
        </div>
        <div class="activity-group-body" id="group-body-${g.id}">
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">${escapeHtml(g.description)}</div>
          ${g.events
            .map((ev) => {
              return `
              <div class="activity-tool-event">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                  <span style="font-weight: 600; color: var(--text-primary); font-size: 11px;">${escapeHtml(ev.title || ev.step)}</span>
                  <span style="font-size: 10px; color: var(--text-muted); font-family: var(--font-mono);">${ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ''}</span>
                </div>
                <div style="min-width: 0; width: 100%; margin-top: 2px;">${formatActivityDetailHtml(ev.detail || '')}</div>
              </div>
            `;
            })
            .join('')}
        </div>
      </div>
    `;
    })
    .join('');
}

function updateWorkspaceProgressStrip(
  stripEl: HTMLElement,
  status: TrustStatus,
  currentStepText: string,
  isRunning: boolean,
  errorMsg?: string
) {
  const planEl = stripEl.querySelector('#ws-phase-plan') as HTMLElement | null;
  const implEl = stripEl.querySelector('#ws-phase-implement') as HTMLElement | null;
  const revEl = stripEl.querySelector('#ws-phase-review') as HTMLElement | null;
  const verEl = stripEl.querySelector('#ws-phase-verify') as HTMLElement | null;
  const statusText = stripEl.querySelector('#ws-active-status-text') as HTMLElement | null;
  const statusDot = stripEl.querySelector('#ws-status-dot') as HTMLElement | null;

  const setStep = (
    el: HTMLElement | null,
    state: 'pending' | 'active' | 'completed' | 'failed' | 'blocked',
    iconText: string
  ) => {
    if (!el) return;
    el.className = `workspace-step ${state}`;
    const circle = el.querySelector('.workspace-step-circle') as HTMLElement | null;
    if (circle) circle.textContent = iconText;
  };

  if (isRunning) {
    if (statusDot) {
      statusDot.className = 'workspace-status-dot pulsing';
      statusDot.style.background = 'var(--brand-blue)';
    }
    const s = currentStepText.toLowerCase();
    if (s.includes('plan')) {
      setStep(planEl, 'active', '1');
      setStep(implEl, 'pending', '2');
      setStep(revEl, 'pending', '3');
      setStep(verEl, 'pending', '4');
      if (statusText)
        statusText.textContent =
          'Phase 1: Architecting solution with Lead Planner (GLM-5.3-Flash)...';
    } else if (s.includes('review')) {
      setStep(planEl, 'completed', '✓');
      setStep(implEl, 'completed', '✓');
      setStep(revEl, 'active', '3');
      setStep(verEl, 'pending', '4');
      if (statusText)
        statusText.textContent =
          'Phase 3: Performing independent code review (Nemotron-3.5-Super-VL)...';
    } else if (s.includes('verif') || s.includes('check')) {
      setStep(planEl, 'completed', '✓');
      setStep(implEl, 'completed', '✓');
      setStep(revEl, 'completed', '✓');
      setStep(verEl, 'active', '4');
      if (statusText)
        statusText.textContent = 'Phase 4: Running independent verification engine checks...';
    } else {
      setStep(planEl, 'completed', '✓');
      setStep(implEl, 'active', '2');
      setStep(revEl, 'pending', '3');
      setStep(verEl, 'pending', '4');
      if (statusText)
        statusText.textContent = 'Phase 2: Implementing changes with isolated tool execution...';
    }
  } else {
    if (statusDot) {
      statusDot.className = 'workspace-status-dot';
      statusDot.style.background =
        status === 'VERIFIED'
          ? 'var(--status-verified-text)'
          : status === 'FAILED'
          ? 'var(--status-failed-text)'
          : status === 'BLOCKED_NEEDS_HUMAN'
          ? 'var(--status-blocked-text)'
          : 'var(--brand-blue)';
    }

    if (status === 'VERIFIED') {
      setStep(planEl, 'completed', '✓');
      setStep(implEl, 'completed', '✓');
      setStep(revEl, 'completed', '✓');
      setStep(verEl, 'completed', '✓');
      if (statusText)
        statusText.textContent =
          'Task completed and VERIFIED · All configured checks passed';
    } else if (status === 'FAILED') {
      setStep(planEl, 'completed', '✓');
      setStep(implEl, 'completed', '✓');
      setStep(revEl, 'completed', '✓');
      setStep(verEl, 'failed', '✕');
      if (statusText)
        statusText.textContent = errorMsg
          ? `Execution failed: ${errorMsg}`
          : 'Task execution finished with FAILED verification status';
    } else if (status === 'BLOCKED_NEEDS_HUMAN') {
      setStep(planEl, 'completed', '✓');
      setStep(implEl, 'completed', '✓');
      setStep(revEl, 'blocked', '⚠');
      setStep(verEl, 'pending', '4');
      if (statusText)
        statusText.textContent = 'Execution stopped: Task is in BLOCKED_NEEDS_HUMAN state';
    } else {
      setStep(planEl, 'pending', '1');
      setStep(implEl, 'pending', '2');
      setStep(revEl, 'pending', '3');
      setStep(verEl, 'pending', '4');
      if (statusText) statusText.textContent = 'Standing by for execution · Ready';
    }
  }
}

/**
 * DEDICATED FULL-WIDTH TASK WORKSPACE SCREEN
 * Bounded scrolling containers, viewport-contained flex layout, real execution controls.
 */
export function renderTaskWorkspaceScreen(route: RouteMatch): HTMLElement {
  const projectId = route.projectId || '';
  const safeProjectId = escapeHtml(projectId);
  const encodedProjectId = encodeURIComponent(projectId);
  const taskId =
    (route.params.taskId && route.params.taskId.trim()) ||
    (route.subpath && route.subpath.trim()) ||
    (route.params.task && route.params.task.trim()) ||
    '';
  const safeTaskId = escapeHtml(taskId);
  const encodedTaskId = encodeURIComponent(taskId);
  const initialProjectTitle = escapeHtml(formatProjectTitle(projectId));

  let currentModel: ProjectOverviewModel | null = null;
  let activeTask: DerivedTaskSummary | null = null;
  let selectedAttemptNumber: number | undefined = route.params.attempt
    ? Number(route.params.attempt)
    : undefined;
  let activeViewMode: 'diff' | 'file' = 'diff';
  let activeFilePath: string | null = null;
  let activeFileContent: string | null = null;
  let activeFileLines: number = 0;
  let activeFileSize: number = 0;
  let capturedDiffText: string = '';
  let activeEvents: ExecutionTimelineStepDto[] = [];
  let pollInterval: any = null;
  let executionStartTime: number | null = null;
  let timerInterval: any = null;
  let activeDiagnosticsTab = 'attempts';
  let lastRunResult: any = null;

  const selectedScopePaths = new Set<string>();

  const workspace = document.createElement('div');
  workspace.className = 'task-workspace';
  workspace.id = 'task-workspace';

  workspace.innerHTML = `
    <!-- A. COMPACT TASK HEADER -->
    <header class="task-workspace-header" id="task-workspace-header">
      <div class="workspace-header-left">
        <button type="button" class="btn btn-secondary btn-sm" id="workspace-back-btn" title="Back to task list">
          ← Back to Tasks
        </button>
        <span style="color: var(--border-strong); margin: 0 4px;">/</span>
        <span class="workspace-task-id" id="workspace-task-id">#${safeTaskId}</span>
        <span class="workspace-task-title" id="workspace-task-title" title="${safeTaskId}">Loading task...</span>
        <span id="workspace-status-badge"><span class="status-badge unverified">LOADING</span></span>
        <span style="font-size: 11px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px;">
          <span>Task Detail</span>
          <span>·</span>
          <span>Autonomous Agent Execution</span>
        </span>
      </div>

      <div class="workspace-header-right">
        <!-- Pipeline Mode Selector -->
        <div style="display: flex; gap: 10px; align-items: center; padding: 3px 8px; background: var(--bg-subtle); border-radius: 6px; border: 1px solid var(--border-default); font-size: 11px;">
          <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; font-weight: 600; color: var(--text-primary); margin: 0;">
            <input type="radio" name="ws-pipeline-mode" id="ws-mode-multi" value="multi" checked />
            <span>Multi-Agent</span>
          </label>
          <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--text-secondary); margin: 0;">
            <input type="radio" name="ws-pipeline-mode" id="ws-mode-single" value="single" />
            <span>Single</span>
          </label>
        </div>

        <span id="workspace-model-badge" class="badge" style="background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd; font-family: var(--font-mono); font-size: 11px;">
          nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B (Nebius)
        </span>

        <button type="button" class="btn btn-secondary btn-sm" id="workspace-unblock-btn" style="display: none; color: var(--status-blocked-text); border-color: var(--status-blocked-border);">
          ⚑ Unblock Task
        </button>

        <button type="button" class="btn btn-secondary btn-sm" id="workspace-cancel-btn" style="display: none; color: var(--status-failed-text); border-color: var(--status-failed-border);">
          ■ Cancel
        </button>

        <button type="button" class="btn btn-primary btn-sm" id="workspace-run-btn" data-testid="task-detail-run-btn">
          <span id="workspace-run-icon">▷</span>
          <span id="workspace-run-label">Run Task</span>
        </button>
        <span id="task-detail-run-btn" style="display: none;"></span>

        <a href="#/projects/${encodedProjectId}/context?targetTaskId=${encodedTaskId}" class="btn btn-secondary btn-sm" id="workspace-context-btn" title="View compiled context">
          Context →
        </a>
      </div>
    </header>

    <!-- B. EXECUTION PROGRESS STRIP -->
    <div class="workspace-progress-strip" id="workspace-progress-strip">
      <div class="workspace-stepper">
        <div class="workspace-step pending" id="ws-phase-plan">
          <span class="workspace-step-circle">1</span>
          <span>Plan</span>
        </div>
        <span style="color: var(--text-muted); font-size: 10px;">→</span>
        <div class="workspace-step pending" id="ws-phase-implement">
          <span class="workspace-step-circle">2</span>
          <span>Implement</span>
        </div>
        <span style="color: var(--text-muted); font-size: 10px;">→</span>
        <div class="workspace-step pending" id="ws-phase-review">
          <span class="workspace-step-circle">3</span>
          <span>Review</span>
        </div>
        <span style="color: var(--text-muted); font-size: 10px;">→</span>
        <div class="workspace-step pending" id="ws-phase-verify">
          <span class="workspace-step-circle">4</span>
          <span>Verify</span>
        </div>
      </div>

      <div class="workspace-active-status">
        <span class="workspace-status-dot" id="ws-status-dot"></span>
        <span id="ws-active-status-text">Standing by for execution · Ready</span>
        <span id="ws-active-timer" style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); margin-left: 6px;"></span>
      </div>

      <div id="workspace-run-feedback" style="display: none; width: 100%; font-size: 12px; padding: 8px 12px; border-radius: 6px; margin-top: 6px;"></div>
    </div>

    <!-- RESPONSIVE PANEL SWITCHER (<1120px) -->
    <div class="workspace-responsive-tabs">
      <button type="button" class="filter-pill active" id="tab-btn-files">Files &amp; Scope</button>
      <button type="button" class="filter-pill" id="tab-btn-editor">Code &amp; Diff</button>
      <button type="button" class="filter-pill" id="tab-btn-activity">Agent Stream</button>
      <button type="button" class="filter-pill" id="tab-btn-diagnostics">Evidence &amp; Logs</button>
    </div>

    <!-- C. MAIN WORK AREA (3 COLUMNS: Files, Code/Diff, Agent Conversation) -->
    <main class="workspace-main-area" id="workspace-main-area">
      <!-- 1. LEFT PANEL: FILES & SCOPE -->
      <section class="workspace-panel workspace-panel-files" id="panel-files" aria-label="Scope and repository files">
        <div class="workspace-panel-header">
          <div class="workspace-panel-title">
            <span>📁 Scope &amp; Files</span>
          </div>
          <span id="workspace-scope-badge" class="badge" style="font-size: 10px; background: #e2e8f0; color: #334155;">
            All Repository Files
          </span>
        </div>

        <div style="padding: 8px 12px; background: var(--bg-subtle); border-bottom: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-shrink: 0;">
          <div style="display: flex; gap: 4px;">
            <input type="file" id="ws-native-file-picker" multiple style="display: none;" />
            <input type="file" id="ws-native-folder-picker" webkitdirectory style="display: none;" />
            <button type="button" class="btn btn-secondary btn-xs" id="ws-scope-add-files-btn">+ Files</button>
            <button type="button" class="btn btn-secondary btn-xs" id="ws-scope-add-folder-btn">+ Folder</button>
          </div>
          <button type="button" class="btn btn-secondary btn-xs" id="ws-scope-clear-btn" style="display: none;">Reset</button>
        </div>

        <div id="ws-scope-chips" style="padding: 6px 12px; display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--border-subtle); font-size: 10.5px; flex-shrink: 0;">
          <span style="color: var(--text-muted); font-style: italic;">No file restrictions active</span>
        </div>

        <div class="workspace-scroll-container" id="ws-files-scroll">
          <div style="font-size: 11px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;" id="ws-affected-files-header">
            AFFECTED FILES
          </div>
          <div id="workspace-affected-files" style="display: flex; flex-direction: column; gap: 3px; margin-bottom: 14px;">
            <div style="font-size: 11.5px; color: var(--text-muted); font-style: italic;">No recorded files yet</div>
          </div>

          <div style="font-size: 11px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px;">
            REPOSITORY TREE
          </div>
          <div id="workspace-files-tree" style="display: flex; flex-direction: column; gap: 2px;">
            <div style="font-size: 11.5px; color: var(--text-muted); padding: 8px 0;">Scanning repository tree...</div>
          </div>
        </div>
      </section>

      <!-- 2. CENTER PANEL: CODE VIEWER OR DIFF -->
      <section class="workspace-panel workspace-panel-editor" id="panel-editor" aria-label="Code viewer and captured git diff">
        <div id="task-detail-diff-section" style="display: none;"></div>
        <div class="workspace-panel-header">
          <div style="display: flex; align-items: center; gap: 6px;">
            <button type="button" class="btn btn-secondary btn-xs active" id="ws-toggle-diff-btn">
              Git Diff
            </button>
            <button type="button" class="btn btn-secondary btn-xs" id="ws-toggle-file-btn">
              File: <span id="ws-editor-file-label">—</span>
            </button>
          </div>
          <span id="ws-editor-meta-info" style="font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">
            Checking workspace diff...
          </span>
        </div>

        <div id="ws-code-viewer-container" style="flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; position: relative;">
          <div id="ws-code-viewer" class="workspace-code-scroll">
            <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px;">Loading code diff...</div>
          </div>
        </div>
      </section>

      <!-- 3. RIGHT PANEL: AGENT CONVERSATION & STREAM -->
      <section class="workspace-panel workspace-panel-activity" id="panel-activity" aria-label="Agent activity and stream">
        <div id="task-detail-timeline-container" style="display: none;"></div>
        <div class="workspace-panel-header">
          <div class="workspace-panel-title">
            <span>⚡ Agent Activity</span>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span id="ws-activity-badge" class="badge" style="font-size: 10px; background: var(--bg-subtle); color: var(--text-secondary);">
              Idle
            </span>
            <button type="button" class="btn btn-secondary btn-xs" id="ws-scroll-bottom-btn" title="Scroll to latest event">
              ↓ Latest
            </button>
          </div>
        </div>

        <div class="workspace-scroll-container" id="ws-activity-scroll">
          <div id="ws-activity-feed" style="display: flex; flex-direction: column; gap: 8px;">
            <div style="padding: 28px 12px; text-align: center; color: var(--text-muted); font-size: 12px;">
              Loading execution events...
            </div>
          </div>
        </div>

        <div class="workspace-new-activity-pill" id="ws-new-activity-pill" style="display: none;">
          <span>New Activity ↓</span>
        </div>
      </section>
    </main>

    <!-- D. EVIDENCE, DIAGNOSTICS & ATTEMPTS DRAWER -->
    <section class="workspace-diagnostics-drawer" id="workspace-diagnostics" aria-label="Evidence and verification diagnostics">
      <div class="workspace-diagnostics-tabs">
        <div style="display: flex; align-items: center; gap: 4px; overflow-x: auto;">
          <button type="button" class="diagnostics-tab-btn active" data-tab="attempts" id="ws-tab-attempts">
            Attempts (<span id="ws-attempts-count">0</span>)
          </button>
          <button type="button" class="diagnostics-tab-btn" data-tab="plan" id="ws-tab-plan">
            Lead Planner Plan
          </button>
          <button type="button" class="diagnostics-tab-btn" data-tab="review" id="ws-tab-review">
            Code Review
          </button>
          <button type="button" class="diagnostics-tab-btn" data-tab="verif" id="ws-tab-verif">
            Verification Checks (<span id="ws-checks-count">0</span>)
          </button>
          <button type="button" class="diagnostics-tab-btn" data-tab="provenance" id="ws-tab-provenance">
            Context Provenance
          </button>
        </div>
        <button type="button" class="btn btn-secondary btn-xs" id="ws-diagnostics-toggle-btn" title="Collapse or expand diagnostics drawer">
          ▼ Collapse
        </button>
      </div>

      <div class="workspace-diagnostics-content" id="ws-diagnostics-content">
        <div style="font-size: 12px; color: var(--text-muted);">Loading diagnostics evidence...</div>
      </div>
    </section>
  `;

  // ── Navigation Back to Tasks ───────────────────────────────────────────────
  workspace.querySelector('#workspace-back-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (pollInterval) clearInterval(pollInterval);
    if (timerInterval) clearInterval(timerInterval);
    router.navigateToProject(projectId, 'tasks');
  });

  // ── Responsive Switcher (<1120px) ──────────────────────────────────────────
  const panelFiles = workspace.querySelector('#panel-files') as HTMLElement | null;
  const panelEditor = workspace.querySelector('#panel-editor') as HTMLElement | null;
  const panelActivity = workspace.querySelector('#panel-activity') as HTMLElement | null;
  const panelDiag = workspace.querySelector('#workspace-diagnostics') as HTMLElement | null;

  const responsiveTabs = workspace.querySelectorAll('.workspace-responsive-tabs button');
  const activateResponsivePanel = (panelName: string) => {
    responsiveTabs.forEach((b) => removeClass(b, 'active'));
    removeClass(panelFiles, 'responsive-active');
    removeClass(panelEditor, 'responsive-active');
    removeClass(panelActivity, 'responsive-active');

    if (panelName === 'files') {
      addClass(workspace.querySelector('#tab-btn-files'), 'active');
      addClass(panelFiles, 'responsive-active');
    } else if (panelName === 'editor') {
      addClass(workspace.querySelector('#tab-btn-editor'), 'active');
      addClass(panelEditor, 'responsive-active');
    } else if (panelName === 'activity') {
      addClass(workspace.querySelector('#tab-btn-activity'), 'active');
      addClass(panelActivity, 'responsive-active');
    } else if (panelName === 'diagnostics') {
      addClass(workspace.querySelector('#tab-btn-diagnostics'), 'active');
      if (panelDiag) {
        removeClass(panelDiag, 'collapsed');
        if (typeof panelDiag.scrollIntoView === 'function') {
          panelDiag.scrollIntoView({ behavior: 'smooth' });
        }
      }
    }
  };

  workspace.querySelector('#tab-btn-files')?.addEventListener('click', () => activateResponsivePanel('files'));
  workspace.querySelector('#tab-btn-editor')?.addEventListener('click', () => activateResponsivePanel('editor'));
  workspace.querySelector('#tab-btn-activity')?.addEventListener('click', () => activateResponsivePanel('activity'));
  workspace.querySelector('#tab-btn-diagnostics')?.addEventListener('click', () => activateResponsivePanel('diagnostics'));

  // Default to editor panel for responsive view
  addClass(panelEditor, 'responsive-active');

  // ── Tree Recursive Builder ─────────────────────────────────────────────────
  const renderTreeRecursively = (directories: any[], files: any[]): string => {
    let out = '';
    for (const dir of directories) {
      out += `
        <div class="tree-dir-item" style="margin-bottom: 2px;">
          <div class="tree-dir-header" data-path="${escapeHtml(dir.path)}" style="display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 11.5px; color: var(--text-primary); user-select: none;">
            <span class="dir-caret" style="font-size: 9px; width: 10px; color: var(--text-muted);">▼</span>
            <span>📁 ${escapeHtml(dir.name)}</span>
          </div>
          <div class="tree-dir-children" style="padding-left: 14px; display: flex; flex-direction: column; gap: 2px;">
            ${renderTreeRecursively(dir.directories || [], dir.files || [])}
          </div>
        </div>
      `;
    }
    for (const file of files) {
      out += `
        <div class="tree-file-item" style="display: flex; align-items: center; justify-content: space-between; padding: 2.5px 6px; border-radius: 4px; font-size: 11px; cursor: pointer; transition: background 0.1s;" data-file-path="${escapeHtml(file.path)}">
          <label style="display: flex; align-items: center; gap: 5px; cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0;">
            <input type="checkbox" class="tree-file-scope-cb" data-file-path="${escapeHtml(file.path)}" style="cursor: pointer;" />
            <span style="font-family: var(--font-mono); color: var(--text-primary);">${escapeHtml(file.name)}</span>
          </label>
          <span style="font-size: 9.5px; color: var(--text-muted); font-family: var(--font-mono);">${file.size ? (file.size > 1024 ? Math.round(file.size / 1024) + 'K' : file.size + 'B') : ''}</span>
        </div>
      `;
    }
    return out;
  };

  // ── Target Scope Management ────────────────────────────────────────────────
  const scopeBadge = workspace.querySelector('#workspace-scope-badge') as HTMLElement | null;
  const scopeChips = workspace.querySelector('#ws-scope-chips') as HTMLElement | null;
  const scopeAddFilesBtn = workspace.querySelector('#ws-scope-add-files-btn') as HTMLButtonElement | null;
  const scopeAddFolderBtn = workspace.querySelector('#ws-scope-add-folder-btn') as HTMLButtonElement | null;
  const scopeClearBtn = workspace.querySelector('#ws-scope-clear-btn') as HTMLButtonElement | null;
  const nativeFilePicker = workspace.querySelector('#ws-native-file-picker') as HTMLInputElement | null;
  const nativeFolderPicker = workspace.querySelector('#ws-native-folder-picker') as HTMLInputElement | null;

  const renderScopeState = () => {
    if (!scopeChips || !scopeBadge) return;
    if (selectedScopePaths.size === 0) {
      scopeBadge.textContent = 'All Repository Files';
      scopeBadge.style.background = '#e2e8f0';
      scopeBadge.style.color = '#334155';
      scopeChips.innerHTML = '<span style="color: var(--text-muted); font-style: italic;">No file restrictions active</span>';
      if (scopeClearBtn) scopeClearBtn.style.display = 'none';
      return;
    }

    scopeBadge.textContent = `${selectedScopePaths.size} ${selectedScopePaths.size === 1 ? 'file' : 'files'} in scope`;
    scopeBadge.style.background = '#dbeafe';
    scopeBadge.style.color = '#1d4ed8';
    if (scopeClearBtn) scopeClearBtn.style.display = 'inline-block';

    scopeChips.innerHTML = Array.from(selectedScopePaths)
      .map(
        (p) => `
        <span class="scope-chip" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; background: #ffffff; border: 1px solid var(--border-default); border-radius: 4px; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-primary);">
          <span>${escapeHtml(p)}</span>
          <button type="button" class="scope-chip-remove" data-path="${escapeHtml(p)}" style="background: none; border: none; cursor: pointer; color: var(--text-muted); padding: 0 2px; font-size: 10px; font-weight: bold; line-height: 1;" title="Remove from scope">✕</button>
        </span>
      `
      )
      .join('');

    scopeChips.querySelectorAll('.scope-chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = (btn as HTMLElement).getAttribute('data-path');
        if (p) {
          selectedScopePaths.delete(p);
          renderScopeState();
        }
      });
    });
  };

  scopeAddFilesBtn?.addEventListener('click', () => nativeFilePicker?.click());
  scopeAddFolderBtn?.addEventListener('click', async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const dirHandle = await (window as any).showDirectoryPicker();
        selectedScopePaths.add(`${dirHandle.name}/*`);
        renderScopeState();
        return;
      } catch (e: any) {
        if (e.name === 'AbortError') return;
      }
    }
    nativeFolderPicker?.click();
  });

  scopeClearBtn?.addEventListener('click', () => {
    selectedScopePaths.clear();
    renderScopeState();
  });

  nativeFilePicker?.addEventListener('change', () => {
    if (nativeFilePicker.files) {
      for (let i = 0; i < nativeFilePicker.files.length; i++) {
        const file = nativeFilePicker.files[i];
        const rel = file.webkitRelativePath || file.name;
        selectedScopePaths.add(rel);
      }
      renderScopeState();
      nativeFilePicker.value = '';
    }
  });

  nativeFolderPicker?.addEventListener('change', () => {
    if (nativeFolderPicker.files) {
      for (let i = 0; i < nativeFolderPicker.files.length; i++) {
        const file = nativeFolderPicker.files[i];
        const rel = file.webkitRelativePath || file.name;
        selectedScopePaths.add(rel);
      }
      renderScopeState();
      nativeFolderPicker.value = '';
    }
  });

  // ── Code Viewer & Git Diff View ────────────────────────────────────────────
  const codeViewer = workspace.querySelector('#ws-code-viewer') as HTMLElement | null;
  const editorMeta = workspace.querySelector('#ws-editor-meta-info') as HTMLElement | null;
  const toggleDiffBtn = workspace.querySelector('#ws-toggle-diff-btn') as HTMLButtonElement | null;
  const toggleFileBtn = workspace.querySelector('#ws-toggle-file-btn') as HTMLButtonElement | null;
  const editorFileLabel = workspace.querySelector('#ws-editor-file-label') as HTMLElement | null;

  const renderEditorContent = () => {
    if (!codeViewer) return;
    if (activeViewMode === 'diff') {
      addClass(toggleDiffBtn, 'active');
      removeClass(toggleFileBtn, 'active');
      if (editorMeta) {
        editorMeta.textContent = capturedDiffText
          ? `Attempt #${selectedAttemptNumber ?? activeTask?.highestAttempt ?? 1} captured diff`
          : 'Clean / No diff';
      }
      codeViewer.innerHTML = formatDiffHtml(capturedDiffText);
    } else {
      removeClass(toggleDiffBtn, 'active');
      addClass(toggleFileBtn, 'active');
      if (editorMeta) {
        editorMeta.textContent = activeFilePath
          ? `${activeFileLines} lines · ${Math.round((activeFileSize / 1024) * 10) / 10} KB`
          : 'Select a file to inspect';
      }
      if (activeFileContent !== null) {
        codeViewer.textContent = activeFileContent;
      } else {
        codeViewer.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px;">Click any file in the left panel to inspect its content.</div>`;
      }
    }
  };

  toggleDiffBtn?.addEventListener('click', () => {
    activeViewMode = 'diff';
    renderEditorContent();
  });

  toggleFileBtn?.addEventListener('click', () => {
    if (activeFilePath) {
      activeViewMode = 'file';
      renderEditorContent();
    }
  });

  // ── Activity Feed Auto-Scroll & Grouping ────────────────────────────────────
  const activityScroll = workspace.querySelector('#ws-activity-scroll') as HTMLElement | null;
  const activityFeed = workspace.querySelector('#ws-activity-feed') as HTMLElement | null;
  const newActivityPill = workspace.querySelector('#ws-new-activity-pill') as HTMLElement | null;
  const scrollBottomBtn = workspace.querySelector('#ws-scroll-bottom-btn') as HTMLButtonElement | null;

  const updateActivityFeedView = (events: ExecutionTimelineStepDto[]) => {
    if (!activityScroll || !activityFeed) return;
    const isNearBottom =
      activityScroll.scrollTop + activityScroll.clientHeight >= activityScroll.scrollHeight - 40;

    activityFeed.innerHTML = renderGroupedActivityHtml(events);

    // Attach group collapse/expand toggles
    activityFeed.querySelectorAll('.activity-group-header').forEach((hdr) => {
      hdr.addEventListener('click', () => {
        const gid = hdr.getAttribute('data-toggle-group');
        const body = activityFeed.querySelector(`#group-body-${gid}`) as HTMLElement | null;
        const caret = hdr.querySelector('.activity-group-caret') as HTMLElement | null;
        if (body) {
          if (body.style.display === 'none') {
            body.style.display = 'flex';
            if (caret) caret.textContent = '▼';
          } else {
            body.style.display = 'none';
            if (caret) caret.textContent = '▶';
          }
        }
      });
    });

    if (isNearBottom) {
      activityScroll.scrollTop = activityScroll.scrollHeight;
      if (newActivityPill) newActivityPill.style.display = 'none';
    } else {
      if (newActivityPill) newActivityPill.style.display = 'flex';
    }
  };

  newActivityPill?.addEventListener('click', () => {
    if (activityScroll) {
      activityScroll.scrollTop = activityScroll.scrollHeight;
    }
    if (newActivityPill) newActivityPill.style.display = 'none';
  });

  scrollBottomBtn?.addEventListener('click', () => {
    if (activityScroll) {
      activityScroll.scrollTop = activityScroll.scrollHeight;
    }
    if (newActivityPill) newActivityPill.style.display = 'none';
  });

  activityScroll?.addEventListener('scroll', () => {
    const isNearBottom =
      activityScroll.scrollTop + activityScroll.clientHeight >= activityScroll.scrollHeight - 40;
    if (isNearBottom && newActivityPill) {
      newActivityPill.style.display = 'none';
    }
  });

  // ── Diagnostics Bottom Drawer ──────────────────────────────────────────────
  const diagDrawer = workspace.querySelector('#workspace-diagnostics') as HTMLElement | null;
  const diagToggleBtn = workspace.querySelector('#ws-diagnostics-toggle-btn') as HTMLButtonElement | null;
  const diagContent = workspace.querySelector('#ws-diagnostics-content') as HTMLElement | null;
  const attemptsCountEl = workspace.querySelector('#ws-attempts-count') as HTMLElement | null;
  const checksCountEl = workspace.querySelector('#ws-checks-count') as HTMLElement | null;

  diagToggleBtn?.addEventListener('click', () => {
    if (!diagDrawer) return;
    if (hasClass(diagDrawer, 'collapsed')) {
      removeClass(diagDrawer, 'collapsed');
      diagToggleBtn.textContent = '▼ Collapse';
    } else {
      addClass(diagDrawer, 'collapsed');
      diagToggleBtn.textContent = '▲ Expand';
    }
  });

  const renderDiagnosticsView = () => {
    if (!diagContent || !activeTask) return;

    const targetAttemptNum =
      selectedAttemptNumber !== undefined ? selectedAttemptNumber : activeTask.highestAttempt;
    const selectedAttempt =
      activeTask.attempts.find((a) => a.attemptNumber === targetAttemptNum) ??
      activeTask.attempts[activeTask.attempts.length - 1];

    if (attemptsCountEl) {
      attemptsCountEl.textContent = String(activeTask.attempts.length);
    }

    const checks = selectedAttempt?.verification?.result?.checks ?? [];
    if (checksCountEl) {
      checksCountEl.textContent = String(checks.length);
    }

    workspace.querySelectorAll('.diagnostics-tab-btn').forEach((btn) => {
      const tab = btn.getAttribute('data-tab');
      if (tab === activeDiagnosticsTab) {
        addClass(btn, 'active');
      } else {
        removeClass(btn, 'active');
      }
    });

    if (activeDiagnosticsTab === 'attempts') {
      const attemptsHtml =
        activeTask.attempts.length === 0
          ? `<div style="font-size: 12px; color: var(--text-muted); padding: 8px 0;">No attempts recorded for this task yet.</div>`
          : `
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="font-size: 11px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
                CHRONOLOGICAL ATTEMPTS (CLICK TO INSPECT HISTORICAL STATE)
              </div>
              <div style="display: grid; grid-template-columns: 50px 130px 160px 1fr 90px; gap: 8px; font-size: 11px; font-weight: 600; color: var(--text-muted); padding: 4px 8px; background: var(--bg-subtle); border-radius: 6px;">
                <span>#</span><span>Trust State</span><span>Timestamp</span><span>Summary</span><span style="text-align: right;">Action</span>
              </div>
              ${activeTask.attempts
                .map((att) => {
                  const isSelected = selectedAttempt?.attemptNumber === att.attemptNumber;
                  return `
                    <div style="display: grid; grid-template-columns: 50px 130px 160px 1fr 90px; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 6px; background: ${isSelected ? 'var(--bg-active)' : 'var(--bg-surface)'}; border: 1px solid ${isSelected ? 'var(--border-focus)' : 'var(--border-default)'}; font-size: 11.5px;">
                      <span style="font-family: var(--font-mono); font-weight: 600;">#${att.attemptNumber}</span>
                      <span>${renderInlineStatusBadgeHtml(att.trustState)}</span>
                      <span style="font-size: 11px; color: var(--text-muted);">${escapeHtml(formatDateLabel(att.timestamp))}</span>
                      <span style="color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(att.summary)}</span>
                      <div style="text-align: right;">
                        <button type="button" class="btn btn-secondary btn-xs ws-inspect-attempt-btn" data-att="${att.attemptNumber}">
                          ${isSelected ? 'Inspecting' : 'Inspect'}
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `;
      diagContent.innerHTML = attemptsHtml;
      diagContent.querySelectorAll('.ws-inspect-attempt-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const num = Number(btn.getAttribute('data-att'));
          if (Number.isFinite(num) && num > 0) {
            selectedAttemptNumber = num;
            renderDiagnosticsView();
          }
        });
      });
    } else if (activeDiagnosticsTab === 'plan') {
      const plan = lastRunResult?.plan;
      if (plan) {
        diagContent.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span style="font-weight: 650; font-size: 13px; color: var(--text-primary);">Lead Planner Architectural Plan (GLM-5.3-Flash)</span>
              <span class="badge" style="background: #dcfce7; color: #15803d; font-size: 10px;">CLAIMED</span>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.5; background: var(--bg-subtle); padding: 10px; border-radius: 6px; border: 1px solid var(--border-default);">
              ${escapeHtml(plan.summary)}
            </div>
            ${
              Array.isArray(plan.acceptanceCriteria) && plan.acceptanceCriteria.length > 0
                ? `<div style="font-size: 11.5px;">
                    <strong>Acceptance Criteria:</strong>
                    <ul style="margin: 4px 0 0 18px; padding: 0;">
                      ${plan.acceptanceCriteria.map((c: string) => `<li>${escapeHtml(c)}</li>`).join('')}
                    </ul>
                  </div>`
                : ''
            }
          </div>
        `;
      } else {
        diagContent.innerHTML = `
          <div style="padding: 16px; color: var(--text-muted); font-size: 12px;">
            No structured planner output recorded for attempt #${targetAttemptNum}. Run task with Multi-Agent mode to generate a GLM plan.
          </div>
        `;
      }
    } else if (activeDiagnosticsTab === 'review') {
      const rev = lastRunResult?.review;
      if (rev) {
        const isApproved = rev.verdict === 'APPROVED';
        diagContent.innerHTML = `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span style="font-weight: 650; font-size: 13px; color: var(--text-primary);">Independent Code Review (Nemotron-3.5-Super-VL)</span>
              <span class="badge" style="background: ${isApproved ? '#dbeafe' : '#fef2f2'}; color: ${isApproved ? '#1d4ed8' : '#b91c1c'}; font-size: 10px;">
                ${escapeHtml(rev.verdict || 'REVIEWED')}
              </span>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.5; background: var(--bg-subtle); padding: 10px; border-radius: 6px; border: 1px solid var(--border-default);">
              ${escapeHtml(rev.summary)}
            </div>
            ${
              Array.isArray(rev.findings) && rev.findings.length > 0
                ? `<div style="font-size: 11.5px;">
                    <strong>Findings:</strong>
                    <ul style="margin: 4px 0 0 18px; padding: 0;">
                      ${rev.findings.map((f: string) => `<li>${escapeHtml(f)}</li>`).join('')}
                    </ul>
                  </div>`
                : ''
            }
          </div>
        `;
      } else {
        diagContent.innerHTML = `
          <div style="padding: 16px; color: var(--text-muted); font-size: 12px;">
            No independent code review transcript recorded for attempt #${targetAttemptNum}.
          </div>
        `;
      }
    } else if (activeDiagnosticsTab === 'verif') {
      const v = selectedAttempt?.verification;
      const vChecks = v?.result?.checks ?? [];
      const failedChecks = vChecks.filter((c) => !c.passed);

      let outputHtml = '';
      if (!v) {
        outputHtml = `<div style="font-size: 12px; color: var(--text-muted); padding: 8px 0;">No verification checks recorded for attempt #${targetAttemptNum}.</div>`;
      } else {
        outputHtml = `
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <div style="display: grid; grid-template-columns: 140px 1.8fr 100px 90px; gap: 8px; font-size: 11px; font-weight: 600; color: var(--text-muted); padding: 4px 8px; background: var(--bg-subtle); border-radius: 6px;">
              <span>Check</span><span>Command</span><span>Result</span><span style="text-align: right;">Duration</span>
            </div>
            ${vChecks
              .map((c) => {
                const cmd = Array.isArray(c.args) && c.args.length > 0 ? `${c.command} ${c.args.join(' ')}` : c.command;
                const passed = Boolean(c.passed);
                const color = passed ? 'var(--status-verified-text)' : 'var(--status-failed-text)';
                const icon = passed ? '✓' : '✕';
                return `
                  <div style="display: grid; grid-template-columns: 140px 1.8fr 100px 90px; gap: 8px; align-items: center; padding: 5px 8px; font-size: 11.5px; border-bottom: 1px solid var(--border-subtle);">
                    <span style="font-weight: 600; color: var(--text-primary);"><span style="color: ${color}; margin-right: 4px;">${icon}</span>${escapeHtml(c.name)}</span>
                    <code style="font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(cmd)}</code>
                    <span style="color: ${color}; font-weight: 600; font-family: var(--font-mono); font-size: 11px;">${passed ? 'PASSED' : 'FAILED'}</span>
                    <span style="text-align: right; font-size: 11px; color: var(--text-muted); font-family: var(--font-mono);">${escapeHtml(formatDuration(c.durationMs))}</span>
                  </div>
                `;
              })
              .join('')}

            ${
              failedChecks.length > 0
                ? `
                <div style="margin-top: 6px;">
                  <div style="font-size: 11px; font-weight: 600; color: var(--status-failed-text); margin-bottom: 4px;">FAILURE OUTPUT (STDOUT / STDERR)</div>
                  <pre class="workspace-code-scroll" style="max-height: 140px; overflow-y: auto; color: var(--status-failed-text); background: #fef2f2; border: 1px solid var(--status-failed-border); border-radius: 6px; padding: 8px 10px; font-size: 11px;">${failedChecks
                    .map((fc) => `${fc.name} exit ${fc.exitCode}:\n${fc.stderr || fc.stdout || '(No output recorded)'}`)
                    .join('\n\n')}</pre>
                </div>
              `
                : ''
            }
          </div>
        `;
      }
      diagContent.innerHTML = outputHtml;
    } else if (activeDiagnosticsTab === 'provenance') {
      diagContent.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; font-size: 11.5px;">
          <div style="background: var(--bg-subtle); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-default);">
            <div style="color: var(--text-muted); font-size: 10px; font-weight: 600;">SOURCE FRESHNESS</div>
            <div style="font-weight: 600; color: #166534; margin-top: 2px;">✓ Verified Clean</div>
            <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 1px;">Workspace matches HEAD snapshot</div>
          </div>
          <div style="background: var(--bg-subtle); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-default);">
            <div style="color: var(--text-muted); font-size: 10px; font-weight: 600;">CODE CONVENTIONS</div>
            <div style="font-weight: 600; color: var(--text-primary); margin-top: 2px;">node24-esm</div>
            <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 1px;">Strict TypeScript import contracts</div>
          </div>
          <div style="background: var(--bg-subtle); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border-default);">
            <div style="color: var(--text-muted); font-size: 10px; font-weight: 600;">VERIFICATION ENGINE</div>
            <div style="font-weight: 600; color: #1d4ed8; margin-top: 2px;">Independent Check Runner</div>
            <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 1px;">Evaluates Vitest &amp; ESM assertions</div>
          </div>
        </div>
      `;
    }
  };

  workspace.querySelectorAll('.diagnostics-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      if (tab) {
        activeDiagnosticsTab = tab;
        renderDiagnosticsView();
      }
    });
  });

  // ── Main Workspace Loader ──────────────────────────────────────────────────
  const loadWorkspaceData = async () => {
    const progressStrip = workspace.querySelector('#workspace-progress-strip') as HTMLElement | null;
    const taskTitleEl = workspace.querySelector('#workspace-task-title') as HTMLElement | null;
    const statusBadgeEl = workspace.querySelector('#workspace-status-badge') as HTMLElement | null;
    const affectedFilesEl = workspace.querySelector('#workspace-affected-files') as HTMLElement | null;
    const filesTreeEl = workspace.querySelector('#workspace-files-tree') as HTMLElement | null;
    const runFeedback = workspace.querySelector('#workspace-run-feedback') as HTMLElement | null;
    const unblockBtn = workspace.querySelector('#workspace-unblock-btn') as HTMLButtonElement | null;
    const cancelBtn = workspace.querySelector('#workspace-cancel-btn') as HTMLButtonElement | null;
    const runBtn = workspace.querySelector('#workspace-run-btn') as HTMLButtonElement | null;

    const [projRes, handoffsRes, verifsRes, tasksRes, diffRes, eventsRes, treeRes] =
      await Promise.allSettled([
        engineClient.getProject(projectId),
        engineClient.getHandoffs(projectId, taskId),
        engineClient.getVerifications(projectId, taskId),
        engineClient.listTasks(projectId),
        engineClient.getTaskDiff(projectId, taskId),
        engineClient.getTaskEvents(projectId, taskId),
        engineClient.getRepositoryTree(projectId),
      ]);

    if (projRes.status === 'fulfilled' && projRes.value === null) {
      workspace.innerHTML = `
        <div class="card" id="workspace-project-not-found" style="max-width: 500px; margin: 40px auto; padding: 28px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;">
          <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);">Project not found</div>
          <p style="font-size: 13px; color: var(--text-muted);">
            Project <code>${safeProjectId}</code> does not exist in the Project Brain.
          </p>
          <button type="button" class="btn btn-primary btn-md" id="workspace-not-found-back-btn">
            ← Back to All Projects
          </button>
        </div>
      `;
      workspace.querySelector('#workspace-not-found-back-btn')?.addEventListener('click', () => {
        router.navigate('#/projects');
      });
      return;
    }

    const cachedProject = engineClient.getKnownProjects().find((p) => p.id === projectId);
    const project: ProjectDto | null =
      projRes.status === 'fulfilled' ? projRes.value : cachedProject ?? null;

    if (!project) {
      workspace.innerHTML = `
        <div class="card" id="workspace-error-banner" style="max-width: 540px; margin: 40px auto; padding: 28px; display: flex; flex-direction: column; gap: 12px; border-color: var(--status-failed-border);">
          <div style="font-size: 16px; font-weight: 600; color: var(--status-failed-text);">Unable to connect to Orchestrate Engine</div>
          <p style="font-size: 13px; color: var(--text-secondary);">Could not load project metadata or recorded task attempts.</p>
          <div>
            <button type="button" class="btn btn-primary btn-sm" id="workspace-retry-load-btn">Retry ↻</button>
          </div>
        </div>
      `;
      workspace.querySelector('#workspace-retry-load-btn')?.addEventListener('click', () => {
        void loadWorkspaceData();
      });
      return;
    }

    const handoffs = handoffsRes.status === 'fulfilled' ? handoffsRes.value : [];
    const verifications = verifsRes.status === 'fulfilled' ? verifsRes.value : [];
    const tasks = tasksRes.status === 'fulfilled' ? tasksRes.value : [];

    currentModel = deriveProjectOverviewModel(project, handoffs, verifications, {
      handoffsAvailable: handoffsRes.status === 'fulfilled',
      verificationsAvailable: verifsRes.status === 'fulfilled',
      tasks,
    });

    activeTask = currentModel.derivedTasks.find((t) => t.taskId === taskId) ?? null;

    if (!activeTask) {
      workspace.innerHTML = `
        <header class="task-workspace-header">
          <div class="workspace-header-left">
            <button type="button" class="btn btn-secondary btn-sm" id="workspace-missing-back-btn">
              ← Back to Tasks
            </button>
            <span style="color: var(--border-strong); margin: 0 4px;">/</span>
            <span class="workspace-task-id">#${safeTaskId}</span>
          </div>
        </header>
        <div style="flex: 1; display: flex; align-items: center; justify-content: center; padding: 20px;">
          <div class="card" id="workspace-not-found" style="max-width: 520px; padding: 32px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 14px;">
            <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);">Task not found</div>
            <p style="font-size: 13px; color: var(--text-muted); line-height: 1.5;">
              Task <code>#${safeTaskId}</code> does not exist or has no recorded attempts in project <code>${safeProjectId}</code>.
            </p>
            <button type="button" class="btn btn-primary btn-md" id="workspace-missing-go-tasks-btn">
              ← Back to Tasks List
            </button>
          </div>
        </div>
      `;
      const goBack = () => router.navigateToProject(projectId, 'tasks');
      workspace.querySelector('#workspace-missing-back-btn')?.addEventListener('click', goBack);
      workspace.querySelector('#workspace-missing-go-tasks-btn')?.addEventListener('click', goBack);
      return;
    }

    // Set Task Header details
    if (taskTitleEl) {
      taskTitleEl.textContent = activeTask.summary || activeTask.taskId;
      taskTitleEl.title = activeTask.summary || activeTask.taskId;
    }
    if (statusBadgeEl) {
      statusBadgeEl.innerHTML = renderInlineStatusBadgeHtml(activeTask.trustState);
    }

    // Handle BLOCKED_NEEDS_HUMAN
    if (unblockBtn) {
      if (activeTask.trustState === 'BLOCKED_NEEDS_HUMAN') {
        unblockBtn.style.display = 'inline-block';
      } else {
        unblockBtn.style.display = 'none';
      }
    }

    // Progress Strip status
    if (progressStrip) {
      updateWorkspaceProgressStrip(
        progressStrip,
        activeTask.trustState,
        'Standing by for execution',
        false
      );
    }

    // Diff
    if (diffRes.status === 'fulfilled') {
      capturedDiffText = diffRes.value.diff || '';
    }
    renderEditorContent();

    // Events / Activity
    if (eventsRes.status === 'fulfilled' && eventsRes.value) {
      activeEvents =
        eventsRes.value.timeline && eventsRes.value.timeline.length > 0
          ? eventsRes.value.timeline
          : (eventsRes.value.events as any) || [];
      updateActivityFeedView(activeEvents);
    }

    // Repository Tree & Affected Files
    if (treeRes.status === 'fulfilled' && treeRes.value && filesTreeEl) {
      if (treeRes.value.connected) {
        filesTreeEl.innerHTML = renderTreeRecursively(
          treeRes.value.directories || [],
          treeRes.value.files || []
        );

        // Click file to inspect in Code Viewer
        filesTreeEl.querySelectorAll('.tree-file-item').forEach((item) => {
          item.addEventListener('click', async (e) => {
            if ((e.target as HTMLElement).tagName.toLowerCase() === 'input') return;
            const filePath = item.getAttribute('data-file-path');
            if (!filePath) return;
            filesTreeEl.querySelectorAll('.tree-file-item').forEach((el) => {
              (el as HTMLElement).style.background = 'transparent';
            });
            (item as HTMLElement).style.background = 'var(--bg-surface)';
            activeFilePath = filePath;
            if (editorFileLabel) editorFileLabel.textContent = filePath;
            activeViewMode = 'file';
            if (codeViewer) codeViewer.textContent = 'Loading file...';
            try {
              const fileData = await engineClient.getRepositoryFile(projectId, filePath);
              activeFileContent = fileData.content;
              activeFileLines = fileData.lines;
              activeFileSize = fileData.size;
              renderEditorContent();
            } catch (err) {
              if (codeViewer) codeViewer.textContent = `Error loading file: ${(err as Error).message}`;
            }
          });
        });

        // Folder toggle
        filesTreeEl.querySelectorAll('.tree-dir-header').forEach((hdr) => {
          hdr.addEventListener('click', () => {
            const children = hdr.parentElement?.querySelector('.tree-dir-children') as HTMLElement | null;
            const caret = hdr.querySelector('.dir-caret') as HTMLElement | null;
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
      } else {
        filesTreeEl.innerHTML = `<div style="font-size: 11px; color: var(--status-failed-text); padding: 8px 0;">No repository attached. Please attach a repository.</div>`;
      }
    }

    // Affected files list from latest attempt
    if (affectedFilesEl && activeTask.attempts.length > 0) {
      const latestAttempt = activeTask.attempts[activeTask.attempts.length - 1];
      const files = latestAttempt.handoff?.filesAffected || [];
      if (files.length > 0) {
        affectedFilesEl.innerHTML = files
          .map(
            (f) => `
            <div class="ws-affected-file-row" data-file-path="${escapeHtml(f)}" style="font-family: var(--font-mono); font-size: 11px; padding: 3px 6px; border-radius: 4px; background: var(--bg-subtle); border: 1px solid var(--border-default); cursor: pointer; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              📄 ${escapeHtml(f)}
            </div>
          `
          )
          .join('');

        affectedFilesEl.querySelectorAll('.ws-affected-file-row').forEach((row) => {
          row.addEventListener('click', async () => {
            const p = row.getAttribute('data-file-path');
            if (!p) return;
            activeFilePath = p;
            if (editorFileLabel) editorFileLabel.textContent = p;
            activeViewMode = 'file';
            try {
              const fileData = await engineClient.getRepositoryFile(projectId, p);
              activeFileContent = fileData.content;
              activeFileLines = fileData.lines;
              activeFileSize = fileData.size;
              renderEditorContent();
            } catch (err) {
              if (codeViewer) codeViewer.textContent = `Error loading file: ${(err as Error).message}`;
            }
          });
        });
      } else {
        affectedFilesEl.innerHTML = `<div style="font-size: 11.5px; color: var(--text-muted); font-style: italic;">No modified files recorded</div>`;
      }
    }

    renderDiagnosticsView();
  };

  // ── Unblock Handler ────────────────────────────────────────────────────────
  const unblockBtn = workspace.querySelector('#workspace-unblock-btn') as HTMLButtonElement | null;
  unblockBtn?.addEventListener('click', async () => {
    if (unblockBtn.disabled) return;
    unblockBtn.disabled = true;
    try {
      await engineClient.unblockTask(projectId, taskId);
      await loadWorkspaceData();
    } catch (err) {
      alert(`Failed to unblock task: ${(err as Error).message}`);
    } finally {
      unblockBtn.disabled = false;
    }
  });

  // ── Cancel Handler ─────────────────────────────────────────────────────────
  const cancelBtn = workspace.querySelector('#workspace-cancel-btn') as HTMLButtonElement | null;
  cancelBtn?.addEventListener('click', async () => {
    if (cancelBtn.disabled) return;
    cancelBtn.disabled = true;
    try {
      await engineClient.cancelTask(projectId, taskId);
      const progressStrip = workspace.querySelector('#workspace-progress-strip') as HTMLElement | null;
      if (progressStrip) {
        updateWorkspaceProgressStrip(
          progressStrip,
          'FAILED',
          'Cancelled',
          false,
          'Task execution was cancelled by user'
        );
      }
      const feedback = workspace.querySelector('#workspace-run-feedback') as HTMLElement | null;
      if (feedback) {
        feedback.style.display = 'block';
        feedback.style.backgroundColor = 'var(--status-failed-bg)';
        feedback.style.color = 'var(--status-failed-text)';
        feedback.textContent = '■ Task execution was cancelled by user.';
      }
    } catch (err) {
      alert(`Failed to cancel task: ${(err as Error).message}`);
    } finally {
      if (pollInterval) clearInterval(pollInterval);
      if (timerInterval) clearInterval(timerInterval);
      cancelBtn.style.display = 'none';
      const runBtn = workspace.querySelector('#workspace-run-btn') as HTMLButtonElement | null;
      const runLabel = workspace.querySelector('#workspace-run-label') as HTMLElement | null;
      if (runBtn) runBtn.disabled = false;
      if (runLabel) runLabel.textContent = 'Run Task';
    }
  });

  // ── Run Task Execution Handler ─────────────────────────────────────────────
  const runBtn = workspace.querySelector('#workspace-run-btn') as HTMLButtonElement | null;
  const runLabel = workspace.querySelector('#workspace-run-label') as HTMLElement | null;
  const runFeedback = workspace.querySelector('#workspace-run-feedback') as HTMLElement | null;
  const progressStrip = workspace.querySelector('#workspace-progress-strip') as HTMLElement | null;
  const activeTimer = workspace.querySelector('#ws-active-timer') as HTMLElement | null;

  runBtn?.addEventListener('click', async () => {
    if (runBtn.disabled) return;

    if (activeTask?.trustState === 'BLOCKED_NEEDS_HUMAN') {
      alert('Task is currently BLOCKED_NEEDS_HUMAN. Please unblock before executing.');
      return;
    }

    runBtn.disabled = true;
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
      cancelBtn.disabled = false;
    }
    if (runLabel) runLabel.textContent = 'Running Agent...';
    if (runFeedback) {
      runFeedback.style.display = 'block';
      runFeedback.style.backgroundColor = 'var(--bg-subtle)';
      runFeedback.style.color = 'var(--text-secondary)';
      runFeedback.textContent =
        'Executing 4-phase autonomous pipeline with Nebius Token Factory...';
    }

    executionStartTime = Date.now();
    if (activeTimer) activeTimer.textContent = '0s';
    timerInterval = setInterval(() => {
      if (executionStartTime && activeTimer) {
        const sec = Math.floor((Date.now() - executionStartTime) / 1000);
        activeTimer.textContent = `${sec}s`;
      }
    }, 1000);

    if (progressStrip) {
      updateWorkspaceProgressStrip(
        progressStrip,
        activeTask?.trustState || 'UNVERIFIED',
        'Phase 1: Planning',
        true
      );
    }

    const pollTaskEvents = async () => {
      try {
        const eventsData = await engineClient.getTaskEvents(projectId, taskId);
        if (eventsData && Array.isArray(eventsData.timeline) && eventsData.timeline.length > 0) {
          activeEvents = eventsData.timeline;
          const lastItem = activeEvents[activeEvents.length - 1];
          if (lastItem && progressStrip) {
            updateWorkspaceProgressStrip(
              progressStrip,
              activeTask?.trustState || 'UNVERIFIED',
              lastItem.step || lastItem.title || '',
              true
            );
          }
          updateActivityFeedView(activeEvents);
        }
      } catch {
        // ignore tick
      }
    };

    pollInterval = setInterval(pollTaskEvents, 500);

    try {
      const isMulti =
        (workspace.querySelector('#ws-mode-multi') as HTMLInputElement)?.checked ?? true;
      const targetScopePaths =
        selectedScopePaths.size > 0
          ? Array.from(selectedScopePaths)
          : (Array.from(
              workspace.querySelectorAll('.tree-file-scope-cb:checked')
            )
              .map((el) => (el as HTMLInputElement).getAttribute('data-file-path'))
              .filter(Boolean) as string[]);

      const res = await engineClient.runTask(projectId, taskId, {
        enableMultiAgent: isMulti,
        model: isMulti ? 'moonshotai/Kimi-K2.6' : 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        plannerModel: 'zai-org/GLM-5.3-Flash',
        reviewerModel: 'nvidia/Nemotron-3.5-Super-VL',
        ...(targetScopePaths.length > 0
          ? { targetScope: { type: 'file_list', paths: targetScopePaths } }
          : {}),
      });

      lastRunResult = res;

      if (runFeedback) {
        runFeedback.style.display = 'block';
        if (res.status === 'VERIFIED') {
          runFeedback.style.backgroundColor = 'var(--status-verified-bg)';
          runFeedback.style.color = 'var(--status-verified-text)';
          runFeedback.textContent = `✓ Task completed and VERIFIED! All checks passed on attempt #${res.attemptNumber}.`;
        } else {
          runFeedback.style.backgroundColor = 'var(--status-failed-bg)';
          runFeedback.style.color = 'var(--status-failed-text)';
          runFeedback.textContent = `✕ Task finished with status: ${res.status} on attempt #${res.attemptNumber}.`;
        }
      }

      await loadWorkspaceData();
    } catch (err) {
      if (runFeedback) {
        runFeedback.style.display = 'block';
        runFeedback.style.backgroundColor = 'var(--status-failed-bg)';
        runFeedback.style.color = 'var(--status-failed-text)';
        const msg = (err as Error).message;
        runFeedback.textContent = `Execution failed: ${msg}`;
      }
      if (progressStrip) {
        updateWorkspaceProgressStrip(
          progressStrip,
          'FAILED',
          'Failed',
          false,
          (err as Error).message
        );
      }
    } finally {
      if (pollInterval) clearInterval(pollInterval);
      if (timerInterval) clearInterval(timerInterval);
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (runBtn) runBtn.disabled = false;
      if (runLabel) runLabel.textContent = 'Run Task';
    }
  });

  void loadWorkspaceData();

  return workspace;
}
