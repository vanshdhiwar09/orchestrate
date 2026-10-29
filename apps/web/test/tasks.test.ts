import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildTaskDetailHtml,
  deriveProjectOverviewModel,
  filterDerivedTasks,
  renderPlaceholderPage,
} from '../src/components/placeholder-page.js';
import {
  engineClient,
  type HandoffDto,
  type ProjectDto,
  type VerificationRecordDto,
} from '../src/services/engine-client.js';
import { router } from '../src/services/router.js';

class MockElement {
  public tagName: string;
  public id: string = '';
  public className: string = '';
  public textContent: string = '';
  public value: string = '';
  public style: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public eventListeners: Record<string, Array<(e?: any) => void>> = {};
  private _innerHTML: string = '';
  public children: MockElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public get innerHTML(): string {
    return this._innerHTML;
  }

  public set innerHTML(val: string) {
    this._innerHTML = val;
    this.textContent = val.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  public appendChild(child: MockElement): MockElement {
    this.children.push(child);
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public addEventListener(event: string, fn: (e?: any) => void): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(fn);
  }

  public scrollIntoView(_arg?: any): void {}

  public classList = {
    add: (cls: string) => {
      const parts = this.className.split(/\s+/).filter(Boolean);
      if (!parts.includes(cls)) parts.push(cls);
      this.className = parts.join(' ');
    },
    remove: (cls: string) => {
      this.className = this.className.split(/\s+/).filter((c) => c && c !== cls).join(' ');
    },
    contains: (cls: string) => {
      return this.className.split(/\s+/).includes(cls);
    },
    toggle: (cls: string, force?: boolean) => {
      const has = this.classList.contains(cls);
      const shouldHave = force !== undefined ? force : !has;
      if (shouldHave) this.classList.add(cls);
      else this.classList.remove(cls);
      return shouldHave;
    },
  };

  private queriedChildren: Map<string, MockElement> = new Map();

  public querySelector(selector: string): MockElement | null {
    if (!this.queriedChildren.has(selector)) {
      const el = new MockElement('div');
      if (selector.startsWith('#')) {
        el.id = selector.slice(1);
      } else if (selector.startsWith('.')) {
        el.className = selector.slice(1);
      }
      this.queriedChildren.set(selector, el);
    }
    return this.queriedChildren.get(selector)!;
  }

  public querySelectorAll(selector: string): MockElement[] {
    const el = this.querySelector(selector);
    return el ? [el] : [];
  }
}

describe('Task Explorer & Task Detail (Step 4)', () => {
  const sampleProject: ProjectDto = {
    id: 'orchestrate-benchmark',
    name: 'Orchestrate Benchmark',
    createdAt: '2026-10-22T08:00:00.000Z',
    facts: [],
  };

  const sampleHandoffs: HandoffDto[] = [
    // Task 1: Older FAILED attempt 1 -> Later VERIFIED attempt 2
    {
      id: 'h-task001-1',
      taskId: 'task_001',
      attemptNumber: 1,
      agentId: 'agent-init',
      model: 'nebius-qwen',
      status: 'CLAIMED',
      summary: 'Repository init failed due to existing files.',
      changes: 'Created package.json',
      filesAffected: ['package.json'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-20T15:44:00.000Z',
    },
    {
      id: 'h-task001-2',
      taskId: 'task_001',
      attemptNumber: 2,
      agentId: 'agent-init',
      model: 'nebius-qwen',
      status: 'CLAIMED',
      summary: 'Initialized repository successfully.',
      changes: 'Cleaned workspace and created base config files.',
      filesAffected: ['package.json', 'tsconfig.json', 'README.md'],
      decisionsCreated: [
        {
          id: 'dec-ts',
          statement: 'Use strict TypeScript project references',
          rationale: 'Preserve package boundaries',
          status: 'ACTIVE',
        },
      ],
      assumptions: ['Node >= 22.8.0'],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-20T16:08:00.000Z',
    },
    // Task 2: Older VERIFIED attempt 1 -> Newer CLAIMED attempt 2 (no verification for attempt 2)
    {
      id: 'h-task002-1',
      taskId: 'task_002',
      attemptNumber: 1,
      status: 'CLAIMED',
      summary: 'Initial brain schema implementation.',
      changes: 'Added sqlite.ts',
      filesAffected: ['packages/brain/src/sqlite.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-20T12:00:00.000Z',
    },
    {
      id: 'h-task002-2',
      taskId: 'task_002',
      attemptNumber: 2,
      status: 'CLAIMED',
      summary: 'Added WAL pragma and foreign keys; awaiting verification.',
      changes: 'Updated sqlite.ts with WAL mode',
      filesAffected: ['packages/brain/src/sqlite.ts', 'packages/brain/test/sqlite.test.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-20T14:32:00.000Z',
    },
    // Task 3: 3 failed attempts (should be FAILED unless explicitly blocked)
    ...[1, 2, 3].map((attempt) => ({
      id: `h-task003-${attempt}`,
      taskId: 'task_003',
      attemptNumber: attempt,
      status: 'CLAIMED' as const,
      summary: `Setup development environment attempt ${attempt}`,
      changes: 'Updated scripts/dev.ts',
      filesAffected: ['scripts/dev.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: `2026-10-20T13:${attempt}0:00.000Z`,
    })),
  ];

  const sampleVerifications: VerificationRecordDto[] = [
    {
      id: 'v-task001-1',
      taskId: 'task_001',
      attemptNumber: 1,
      handoffId: 'h-task001-1',
      result: {
        status: 'FAILED',
        checks: [
          {
            checkId: 'c-init-1',
            name: 'Init Check',
            command: 'npm',
            args: ['run', 'verify-init'],
            status: 'FAILED',
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'Error: EEXIST: file already exists, mkdir',
            durationMs: 420,
          },
        ],
        executedAt: '2026-10-20T15:48:00.000Z',
        totalDurationMs: 420,
      },
      recordedAt: '2026-10-20T15:48:00.000Z',
    },
    {
      id: 'v-task001-2',
      taskId: 'task_001',
      attemptNumber: 2,
      handoffId: 'h-task001-2',
      result: {
        status: 'VERIFIED',
        checks: [
          {
            checkId: 'c-init-2',
            name: 'Init Check',
            command: 'npm',
            args: ['run', 'verify-init'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: 'Workspace initialized cleanly',
            stderr: '',
            durationMs: 650,
          },
          {
            checkId: 'c-tsc-2',
            name: 'Typecheck',
            command: 'npx',
            args: ['tsc', '-b'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1150,
          },
        ],
        executedAt: '2026-10-20T16:10:00.000Z',
        totalDurationMs: 1800,
      },
      recordedAt: '2026-10-20T16:10:00.000Z',
    },
    {
      id: 'v-task002-1',
      taskId: 'task_002',
      attemptNumber: 1,
      handoffId: 'h-task002-1',
      result: {
        status: 'VERIFIED',
        checks: [
          {
            checkId: 'c-brain-1',
            name: 'Brain Unit Tests',
            command: 'npx',
            args: ['vitest', 'run'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: '32 passed',
            stderr: '',
            durationMs: 900,
          },
        ],
        executedAt: '2026-10-20T12:05:00.000Z',
        totalDurationMs: 900,
      },
      recordedAt: '2026-10-20T12:05:00.000Z',
    },
    ...[1, 2, 3].map((attempt) => ({
      id: `v-task003-${attempt}`,
      taskId: 'task_003',
      attemptNumber: attempt,
      handoffId: `h-task003-${attempt}`,
      result: {
        status: 'FAILED' as const,
        checks: [
          {
            checkId: `c-env-${attempt}`,
            name: 'Env Check',
            command: 'node',
            args: ['scripts/dev.ts'],
            status: 'FAILED' as const,
            passed: false,
            exitCode: 2,
            stdout: 'Starting dev check...',
            stderr: `Fatal env error on attempt ${attempt}: missing PORT binding`,
            durationMs: 800,
          },
        ],
        executedAt: `2026-10-20T13:${attempt}5:00.000Z`,
        totalDurationMs: 800,
      },
      recordedAt: `2026-10-20T13:${attempt}5:00.000Z`,
    })),
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    (global as any).document = {
      createElement: (tag: string) => new MockElement(tag),
    };
    vi.spyOn(engineClient, 'listTasks').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getRepositoryStatus').mockResolvedValue({ connected: false });
  });

  it('1. Task derivation consistency: Task Explorer shares the exact derivedTasks, chronological attempts, and counts as Project Overview', () => {
    const model = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications
    );

    expect(model.taskCounts).toEqual({
      all: 3,
      verified: 1, // task_001
      failed: 1, // task_003 (3 failed attempts, not inferred blocked without explicit flag)
      blocked: 0,
      claimed: 1, // task_002 (attempt 2 has handoff only)
      unverified: 0,
    });

    // Search and status filter consistency via filterDerivedTasks
    expect(filterDerivedTasks(model.derivedTasks, '', 'ALL')).toHaveLength(3);
    expect(filterDerivedTasks(model.derivedTasks, '', 'VERIFIED').map((t) => t.taskId)).toEqual([
      'task_001',
    ]);
    expect(filterDerivedTasks(model.derivedTasks, '', 'CLAIMED').map((t) => t.taskId)).toEqual([
      'task_002',
    ]);
    expect(filterDerivedTasks(model.derivedTasks, '', 'FAILED').map((t) => t.taskId)).toEqual([
      'task_003',
    ]);
    expect(filterDerivedTasks(model.derivedTasks, 'tsconfig.json', 'ALL').map((t) => t.taskId)).toEqual([
      'task_001',
    ]);
    expect(filterDerivedTasks(model.derivedTasks, 'WAL pragma', 'ALL').map((t) => t.taskId)).toEqual([
      'task_002',
    ]);
    expect(filterDerivedTasks(model.derivedTasks, 'nonexistent-query', 'ALL')).toEqual([]);
  });

  it('2 & 3. Multiple attempts, chronological order, and older failed attempt followed by verified attempt', () => {
    const model = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications
    );
    const task001 = model.derivedTasks.find((t) => t.taskId === 'task_001')!;

    expect(task001.trustState).toBe('VERIFIED');
    expect(task001.highestAttempt).toBe(2);
    expect(task001.attemptCount).toBe(2);
    expect(task001.attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(task001.attempts[0].trustState).toBe('FAILED');
    expect(task001.attempts[1].trustState).toBe('VERIFIED');

    // Default Task Detail renders latest attempt (#2) while listing chronological attempts (#1 then #2)
    const detailLatestHtml = buildTaskDetailHtml('orchestrate-benchmark', task001);
    expect(detailLatestHtml).toContain('#task_001');
    expect(detailLatestHtml).toContain('Attempt #2 investigation');
    expect(detailLatestHtml).toContain('Latest attempt · governs task trust state');
    expect(detailLatestHtml).toContain('h-task001-2');
    expect(detailLatestHtml).toContain('v-task001-2');
    expect(detailLatestHtml).toContain('tsconfig.json');
    expect(detailLatestHtml).toContain('All configured checks passed on attempt #2');

    // Inspecting historical Attempt #1 shows Attempt #1 failure evidence and stdout/stderr
    const detailAttempt1Html = buildTaskDetailHtml('orchestrate-benchmark', task001, 1);
    expect(detailAttempt1Html).toContain('Attempt #1 investigation');
    expect(detailAttempt1Html).toContain('Historical attempt · superseded by #2');
    expect(detailAttempt1Html).toContain('h-task001-1');
    expect(detailAttempt1Html).toContain('v-task001-1');
    expect(detailAttempt1Html).toContain('Error: EEXIST: file already exists, mkdir');
  });

  it('4. Newer claimed attempt following an older verified attempt derives as CLAIMED and never carries over old verification', () => {
    const model = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications
    );
    const task002 = model.derivedTasks.find((t) => t.taskId === 'task_002')!;

    expect(task002.trustState).toBe('CLAIMED');
    expect(task002.highestAttempt).toBe(2);
    expect(task002.attempts[0].trustState).toBe('VERIFIED');
    expect(task002.attempts[1].trustState).toBe('CLAIMED');
    expect(task002.attempts[1].verification).toBeUndefined();

    const detailHtml = buildTaskDetailHtml('orchestrate-benchmark', task002);
    expect(detailHtml).toContain('Attempt #2 investigation');
    expect(detailHtml).toContain('No independent verification record exists for attempt #2 yet');
    expect(detailHtml).toContain('Added WAL pragma and foreign keys; awaiting verification.');
  });

  it('5. Explicit blocked state: renders BLOCKED_NEEDS_HUMAN banner only when explicitly marked blocked', () => {
    const modelUnblocked = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications
    );
    const task003Unblocked = modelUnblocked.derivedTasks.find((t) => t.taskId === 'task_003')!;
    expect(task003Unblocked.trustState).toBe('FAILED');
    const htmlUnblocked = buildTaskDetailHtml('orchestrate-benchmark', task003Unblocked);
    expect(htmlUnblocked).not.toContain('id="task-detail-blocked-banner"');
    expect(htmlUnblocked).toContain('Fatal env error on attempt 3: missing PORT binding');

    const modelBlocked = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications,
      { blockedTaskIds: ['task_003'] }
    );
    const task003Blocked = modelBlocked.derivedTasks.find((t) => t.taskId === 'task_003')!;
    expect(task003Blocked.trustState).toBe('BLOCKED_NEEDS_HUMAN');
    const htmlBlocked = buildTaskDetailHtml('orchestrate-benchmark', task003Blocked);
    expect(htmlBlocked).toContain('id="task-detail-blocked-banner"');
    expect(htmlBlocked).toContain(
      'Orchestrator stopped autonomous execution for this task. Human intervention is required.'
    );
  });

  it('6 & 9. Missing handoffs/verifications, rejected stale verification, and correct attempt-to-handoff-to-verification linking', () => {
    // Verification only (no handoff recorded for attempt 1)
    const verifOnlyModel = deriveProjectOverviewModel(sampleProject, [], [sampleVerifications[1]]);
    const taskVerifOnly = verifOnlyModel.derivedTasks[0];
    expect(taskVerifOnly.trustState).toBe('VERIFIED');
    const verifOnlyHtml = buildTaskDetailHtml('orchestrate-benchmark', taskVerifOnly);
    expect(verifOnlyHtml).toContain('No agent handoff claim was recorded for attempt #2.');
    expect(verifOnlyHtml).toContain(
      '#/projects/orchestrate-benchmark/verifications?taskId=task_001&attempt=2'
    );

    // Handoff + Verification links & Compiled Context link validation
    const fullModel = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications
    );
    const task001 = fullModel.derivedTasks.find((t) => t.taskId === 'task_001')!;
    const detailHtml = buildTaskDetailHtml('orchestrate-benchmark', task001, 2);

    expect(detailHtml).toContain(
      'href="#/projects/orchestrate-benchmark/handoffs?taskId=task_001&attempt=2"'
    );
    expect(detailHtml).toContain(
      'href="#/projects/orchestrate-benchmark/verifications?taskId=task_001&attempt=2"'
    );
    expect(detailHtml).toContain(
      'href="#/projects/orchestrate-benchmark/context?targetTaskId=task_001"'
    );

    // When projectId is empty/invalid, Compiled Context link is disabled
    const noProjectHtml = buildTaskDetailHtml('', task001, 2);
    expect(noProjectHtml).not.toContain('id="task-detail-open-context-btn"');
    expect(noProjectHtml).toContain('disabled title="Valid project and task identifier required"');
  });

  it('7. Renders clean Tasks list page, handles partial data gracefully, and does not render inline task detail panel', async () => {
    // Sub-case A: Verifications endpoint unavailable -> shows warning banner without fabricating task states
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
    vi.spyOn(engineClient, 'getVerifications').mockRejectedValue(
      new Error('Verifications endpoint unavailable (HTTP 503)')
    );

    const routeTasksList = router.parseRoute('#/projects/orchestrate-benchmark/tasks');
    const elList = renderPlaceholderPage(routeTasksList);
    await new Promise((r) => setTimeout(r, 10));

    expect(elList.innerHTML).toContain('Tasks');
    expect(elList.innerHTML).toContain('Derived from recorded attempts:');
    expect(elList.querySelector('#tasks-status-banner')?.innerHTML).toContain(
      'Partial data loaded:'
    );
    // Crucial architectural requirement: No full task detail or planner transcripts rendered inline inside task list
    expect(elList.innerHTML).not.toContain('id="task-detail-panel"');
    expect(elList.innerHTML).not.toContain('id="task-workspace"');

    // Sub-case B: Successful data -> displays clean task list table linking to dedicated workspace route
    vi.restoreAllMocks();
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
    vi.spyOn(engineClient, 'getVerifications').mockResolvedValue(sampleVerifications);
    vi.spyOn(engineClient, 'listTasks').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getRepositoryStatus').mockResolvedValue({ connected: false });

    const elListSuccess = renderPlaceholderPage(routeTasksList);
    await new Promise((r) => setTimeout(r, 20));

    const listHtml = elListSuccess.querySelector('#task-explorer-list')?.innerHTML ?? '';
    expect(listHtml).toContain('data-task-id="task_001"');
    expect(listHtml).toContain('Open Workspace →');
    expect(elListSuccess.innerHTML).not.toContain('id="task-detail-panel"');
  });

  it('8. Navigating to dedicated Task Workspace renders full-width workspace, progress strip, 3 panels, and handles missing tasks', async () => {
    vi.restoreAllMocks();
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
    vi.spyOn(engineClient, 'getVerifications').mockResolvedValue(sampleVerifications);
    vi.spyOn(engineClient, 'listTasks').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getRepositoryStatus').mockResolvedValue({ connected: false });
    vi.spyOn(engineClient, 'getTaskEvents').mockResolvedValue({
      events: [
        {
          type: 'plan_created',
          step: 1,
          task_id: 'task_001',
          plan: 'Initial architecture plan',
          timestamp: '2026-10-22T08:00:00Z',
        },
      ],
      total: 1,
    });

    // 1. Direct navigation to an existing task workspace
    const routeWorkspace = router.parseRoute(
      '#/projects/orchestrate-benchmark/tasks/task_001'
    );
    const elWorkspace = renderPlaceholderPage(routeWorkspace);
    await new Promise((r) => setTimeout(r, 15));

    // Full-width task workspace container mounted
    expect(elWorkspace.id).toBe('task-workspace');
    expect(elWorkspace.className).toContain('task-workspace');

    // A. Compact task header
    expect(elWorkspace.innerHTML).toContain('id="task-workspace-header"');
    expect(elWorkspace.innerHTML).toContain('id="workspace-task-id"');
    expect(elWorkspace.innerHTML).toContain('#task_001');
    expect(elWorkspace.innerHTML).toContain('id="workspace-back-btn"');
    expect(elWorkspace.innerHTML).toContain('id="workspace-run-btn"');

    // B. Execution progress strip with 4 phases
    expect(elWorkspace.innerHTML).toContain('id="workspace-progress-strip"');
    expect(elWorkspace.innerHTML).toContain('ws-phase-plan');
    expect(elWorkspace.innerHTML).toContain('ws-phase-implement');
    expect(elWorkspace.innerHTML).toContain('ws-phase-review');
    expect(elWorkspace.innerHTML).toContain('ws-phase-verify');

    // C. 3-panel coding workspace
    expect(elWorkspace.innerHTML).toContain('id="panel-files"');
    expect(elWorkspace.innerHTML).toContain('id="panel-editor"');
    expect(elWorkspace.innerHTML).toContain('id="panel-activity"');
    expect(elWorkspace.innerHTML).toContain('id="ws-code-viewer"');
    expect(elWorkspace.innerHTML).toContain('class="workspace-code-scroll"');

    // D. Evidence & diagnostics drawer with bounded containment
    expect(elWorkspace.innerHTML).toContain('id="workspace-diagnostics"');
    expect(elWorkspace.innerHTML).toContain('id="ws-diagnostics-toggle-btn"');
    expect(elWorkspace.innerHTML).toContain('id="ws-tab-attempts"');
    expect(elWorkspace.innerHTML).toContain('id="ws-tab-plan"');
    expect(elWorkspace.innerHTML).toContain('id="ws-tab-review"');
    expect(elWorkspace.innerHTML).toContain('id="ws-tab-verif"');
    expect(elWorkspace.innerHTML).toContain('id="ws-tab-provenance"');

    // 2. Direct navigation to a missing task ID
    const routeMissing = router.parseRoute(
      '#/projects/orchestrate-benchmark/tasks/nonexistent_task_999'
    );
    const elMissing = renderPlaceholderPage(routeMissing);
    await new Promise((r) => setTimeout(r, 15));

    expect(elMissing.innerHTML).toContain('id="workspace-not-found"');
    expect(elMissing.innerHTML).toContain('Task not found');
    expect(elMissing.innerHTML).toContain('nonexistent_task_999');
    expect(elMissing.innerHTML).toContain('id="workspace-missing-go-tasks-btn"');
  });

  it('9. Task Workspace execution controls trigger real engineClient execution, cancellation, and unblock methods', async () => {
    vi.restoreAllMocks();
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
    vi.spyOn(engineClient, 'getVerifications').mockResolvedValue(sampleVerifications);
    vi.spyOn(engineClient, 'listTasks').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getRepositoryStatus').mockResolvedValue({ connected: false });
    vi.spyOn(engineClient, 'getTaskEvents').mockResolvedValue({ events: [], total: 0 });

    const runSpy = vi.spyOn(engineClient, 'runTask').mockResolvedValue({
      status: 'started',
      taskId: 'task_001',
      runId: 'run-test-123',
    });
    const cancelSpy = vi.spyOn(engineClient, 'cancelTask').mockResolvedValue({
      success: true,
      message: 'Task cancelled',
      taskId: 'task_001',
    });

    const route = router.parseRoute('#/projects/orchestrate-benchmark/tasks/task_001');
    const el = renderPlaceholderPage(route);
    await new Promise((r) => setTimeout(r, 15));

    const runBtn = el.querySelector('#workspace-run-btn');
    expect(runBtn).toBeDefined();
    // Trigger run task listener
    const runListeners = (runBtn as any)?.eventListeners?.click;
    if (runListeners && runListeners.length > 0) {
      await runListeners[0]();
      expect(runSpy).toHaveBeenCalledWith(
        'orchestrate-benchmark',
        'task_001',
        expect.objectContaining({ enableMultiAgent: true })
      );
    }

    const cancelBtn = el.querySelector('#workspace-cancel-btn');
    expect(cancelBtn).toBeDefined();
    const cancelListeners = (cancelBtn as any)?.eventListeners?.click;
    if (cancelListeners && cancelListeners.length > 0) {
      await cancelListeners[0]();
      expect(cancelSpy).toHaveBeenCalledWith('orchestrate-benchmark', 'task_001');
    }
  });

  it('10. Long content containment, grouped activity stream, independent diff scrolling, and responsive layout switching', async () => {
    vi.restoreAllMocks();
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
    vi.spyOn(engineClient, 'getVerifications').mockResolvedValue(sampleVerifications);
    vi.spyOn(engineClient, 'listTasks').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getRepositoryStatus').mockResolvedValue({ connected: true, path: '/workspace' });

    // Generate 120 realistic execution events across categories
    const longTimelineEvents: any[] = [];
    for (let i = 1; i <= 120; i++) {
      if (i <= 10) {
        longTimelineEvents.push({
          type: 'plan_created',
          step: i,
          task_id: 'task_001',
          plan: `Step ${i}: Architectural plan phase detail `.repeat(15),
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        });
      } else if (i <= 40) {
        longTimelineEvents.push({
          type: 'tool_execution',
          tool: 'read_file',
          step: i,
          input: { path: `src/module_${i}.ts` },
          output: `// Serialized file content for module ${i}\n` + 'export const x = 1;\n'.repeat(30),
          durationMs: 45,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        });
      } else if (i <= 80) {
        longTimelineEvents.push({
          type: 'tool_execution',
          tool: 'run_command',
          step: i,
          input: { command: `npm test test/spec_${i}.ts` },
          output: `PASS test/spec_${i}.ts (12 tests passed, 0 failures)\n` + 'All checks green\n'.repeat(10),
          durationMs: 320,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        });
      } else {
        longTimelineEvents.push({
          type: 'code_review',
          step: i,
          approved: true,
          findings: `Review finding item ${i}: Verified boundaries and invariants pass clean.`,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
        });
      }
    }

    vi.spyOn(engineClient, 'getTaskEvents').mockResolvedValue({
      taskId: 'task_001',
      isRunning: false,
      events: longTimelineEvents,
      timeline: longTimelineEvents,
    });

    const route = router.parseRoute('#/projects/orchestrate-benchmark/tasks/task_001');
    const el = renderPlaceholderPage(route);
    await new Promise((r) => setTimeout(r, 20));

    // 1. Verify responsive tabs are mounted for switching panels
    expect(el.innerHTML).toContain('id="tab-btn-files"');
    expect(el.innerHTML).toContain('id="tab-btn-editor"');
    expect(el.innerHTML).toContain('id="tab-btn-activity"');
    expect(el.innerHTML).toContain('id="tab-btn-diagnostics"');

    // 2. Verify independent scroll container for code viewer and git diff
    expect(el.innerHTML).toContain('id="ws-code-viewer"');
    expect(el.innerHTML).toContain('class="workspace-code-scroll"');

    // 3. Verify activity feed container and scroll controls
    expect(el.innerHTML).toContain('id="ws-activity-scroll"');
    expect(el.innerHTML).toContain('id="ws-scroll-bottom-btn"');
    expect(el.innerHTML).toContain('id="ws-new-activity-pill"');

    // 4. Verify activity feed groups are rendered
    const activityFeedHtml = el.querySelector('#ws-activity-feed')?.innerHTML ?? '';
    expect(activityFeedHtml).toContain('Planning');
    expect(activityFeedHtml).toContain('File Inspection');
    expect(activityFeedHtml).toContain('Commands &amp; Tests');
    expect(activityFeedHtml).toContain('Code Review');

    // 5. Verify diagnostic tabs and drawer toggle
    expect(el.innerHTML).toContain('id="ws-diagnostics-toggle-btn"');
    expect(el.innerHTML).toContain('id="ws-tab-plan"');
    expect(el.innerHTML).toContain('id="ws-tab-review"');
    expect(el.innerHTML).toContain('id="ws-tab-verif"');
  });

  it('Step 4.1 Audit — Edge Cases: cross-attempt handoffId mismatch, timestamp mismatch, and independent evidence endpoint failures', () => {
    const handoffs: HandoffDto[] = [
      {
        id: 'h-att-1',
        taskId: 'task-mismatch',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Attempt 1 handoff',
        changes: '',
        filesAffected: ['src/a.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-10-22T10:00:00.000Z',
      },
      {
        id: 'h-att-2-newer',
        taskId: 'task-stale-ts',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Handoff updated after verification ran',
        changes: '',
        filesAffected: ['src/b.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-10-22T11:00:00.000Z',
      },
    ];

    const verifications: VerificationRecordDto[] = [
      // Attempt 2 verification on task-mismatch has NO Attempt 2 handoff, but points to Attempt 1's handoffId ('h-att-1')!
      {
        id: 'v-cross-attempt',
        taskId: 'task-mismatch',
        attemptNumber: 2,
        handoffId: 'h-att-1',
        result: {
          status: 'VERIFIED',
          checks: [],
          executedAt: '2026-10-22T10:05:00.000Z',
          totalDurationMs: 100,
        },
        recordedAt: '2026-10-22T10:05:00.000Z',
      },
      // Verification on task-stale-ts has matching handoffId, but timestamp (10:30) is older than handoff createdAt (11:00)
      {
        id: 'v-older-than-handoff',
        taskId: 'task-stale-ts',
        attemptNumber: 1,
        handoffId: 'h-att-2-newer',
        result: {
          status: 'VERIFIED',
          checks: [],
          executedAt: '2026-10-22T10:30:00.000Z',
          totalDurationMs: 100,
        },
        recordedAt: '2026-10-22T10:30:00.000Z',
      },
    ];

    const model = deriveProjectOverviewModel(sampleProject, handoffs, verifications);
    const mismatchTask = model.derivedTasks.find((t) => t.taskId === 'task-mismatch')!;
    const staleTask = model.derivedTasks.find((t) => t.taskId === 'task-stale-ts')!;

    // Cross-attempt handoffId on Attempt 2 must be rejected -> UNVERIFIED (since Attempt 2 has no handoff)
    expect(mismatchTask.highestAttempt).toBe(2);
    expect(mismatchTask.trustState).toBe('UNVERIFIED');
    expect(mismatchTask.attempts[1].verification).toBeUndefined();
    expect(mismatchTask.attempts[1].verificationRejectedReason).toContain(
      'references handoff "h-att-1" from attempt #1, not attempt #2'
    );

    const mismatchHtml = buildTaskDetailHtml('orchestrate-benchmark', mismatchTask, 2);
    expect(mismatchHtml).toContain('Stale or mismatched verification ignored:');
    expect(mismatchHtml).toContain('from attempt #1, not attempt #2');

    // Timestamp mismatch on Attempt 1 must be rejected -> CLAIMED
    expect(staleTask.trustState).toBe('CLAIMED');
    expect(staleTask.attempts[0].verification).toBeUndefined();
    expect(staleTask.attempts[0].verificationRejectedReason).toContain(
      'is older than handoff "h-att-2-newer"'
    );

    const staleHtml = buildTaskDetailHtml('orchestrate-benchmark', staleTask, 1);
    expect(staleHtml).toContain('Stale or mismatched verification ignored:');
    expect(staleHtml).toContain('is older than handoff &quot;h-att-2-newer&quot;');

    // Independent evidence endpoint failures never fabricate trust states or counts
    const noHandoffsModel = deriveProjectOverviewModel(
      sampleProject,
      [],
      sampleVerifications,
      { handoffsAvailable: false, verificationsAvailable: true }
    );
    expect(noHandoffsModel.taskDerivationComplete).toBe(false);
    expect(noHandoffsModel.derivedTasks).toEqual([]);
    expect(noHandoffsModel.taskCounts.all).toBe(0);

    const noVerifsModel = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      [],
      { handoffsAvailable: true, verificationsAvailable: false }
    );
    expect(noVerifsModel.taskDerivationComplete).toBe(false);
    expect(noVerifsModel.derivedTasks).toEqual([]);
    expect(noVerifsModel.taskCounts.all).toBe(0);
  });

  it('Step 4.1 Audit — Edge Cases: URL-sensitive & HTML-sensitive task IDs and returning from Context, Handoffs, and Verifications to Task Detail', () => {
    const specialTaskId = 'feature/auth & reset#v1?<script>';
    const encodedSpecialId = encodeURIComponent(specialTaskId);

    // 1. Router round-trip with URL-sensitive task ID
    router.navigateToProject('orchestrate-benchmark', 'tasks', specialTaskId);
    const taskRoute = router.getRoute();
    expect(taskRoute.destination).toBe('tasks');
    expect(taskRoute.projectId).toBe('orchestrate-benchmark');
    expect(taskRoute.subpath).toBe(specialTaskId);
    expect(taskRoute.params.taskId).toBe(specialTaskId);
    expect(taskRoute.path).toBe(`#/projects/orchestrate-benchmark/tasks/${encodedSpecialId}`);

    // 2. HTML escaping and URL encoding in Task Detail
    const model = deriveProjectOverviewModel(
      sampleProject,
      [
        {
          id: 'h-special-1',
          taskId: specialTaskId,
          attemptNumber: 1,
          status: 'CLAIMED',
          summary: 'Summary with <b>unsafe HTML</b>',
          changes: 'Updated files',
          filesAffected: ['src/weird"file<1>.ts'],
          decisionsCreated: [],
          assumptions: [],
          limitations: [],
          recommendedFollowUp: [],
          createdAt: '2026-10-22T12:00:00.000Z',
        },
      ],
      []
    );
    const specialTask = model.derivedTasks[0];
    const detailHtml = buildTaskDetailHtml('orchestrate-benchmark', specialTask, 1);

    // Unescaped <script> or <b> must never appear in rendered HTML
    expect(detailHtml).not.toContain('<script>');
    expect(detailHtml).not.toContain('<b>unsafe HTML</b>');
    expect(detailHtml).toContain('&lt;script&gt;');
    expect(detailHtml).toContain('&lt;b&gt;unsafe HTML&lt;/b&gt;');
    expect(detailHtml).toContain('src/weird&quot;file&lt;1&gt;.ts');

    // Links to Context, Handoffs, and Verifications use URL-encoded taskId
    expect(detailHtml).toContain(
      `href="#/projects/orchestrate-benchmark/context?targetTaskId=${encodedSpecialId}"`
    );
    expect(detailHtml).toContain(
      `href="#/projects/orchestrate-benchmark/handoffs?taskId=${encodedSpecialId}&attempt=1"`
    );
    expect(detailHtml).toContain(
      `href="#/projects/orchestrate-benchmark/verifications?taskId=${encodedSpecialId}"`
    );

    // 3. Returning from Context, Handoffs, and Verifications back to Task Detail preserves project and encoded task ID
    const ctxRoute = router.parseRoute(
      `#/projects/orchestrate-benchmark/context?targetTaskId=${encodedSpecialId}`
    );
    const ctxEl = renderPlaceholderPage(ctxRoute);
    expect(ctxEl.innerHTML).toContain(
      `href="#/projects/orchestrate-benchmark/tasks/${encodedSpecialId}"`
    );
    expect(ctxEl.innerHTML).toContain('id="ctx-back-to-task-link"');

    const handoffRoute = router.parseRoute(
      `#/projects/orchestrate-benchmark/handoffs?taskId=${encodedSpecialId}&attempt=1`
    );
    const handoffEl = renderPlaceholderPage(handoffRoute);
    expect(handoffEl.innerHTML).toContain(
      `href="#/projects/orchestrate-benchmark/tasks/${encodedSpecialId}"`
    );
    expect(handoffEl.innerHTML).toContain('id="handoff-back-to-task-link"');

    const verifRoute = router.parseRoute(
      `#/projects/orchestrate-benchmark/verifications?taskId=${encodedSpecialId}&attempt=1`
    );
    const verifEl = renderPlaceholderPage(verifRoute);
    expect(verifEl.innerHTML).toContain(
      `href="#/projects/orchestrate-benchmark/tasks/${encodedSpecialId}"`
    );
    expect(verifEl.innerHTML).toContain('id="verif-back-to-task-link"');
  });
});
