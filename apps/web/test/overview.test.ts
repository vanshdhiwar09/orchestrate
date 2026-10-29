import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  deriveProjectOverviewModel,
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

  public querySelector(selector: string): MockElement | null {
    // Support basic #id selector over innerHTML by creating lightweight proxy element that updates parent innerHTML or tracks state
    return this.queryAll(selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): MockElement[] {
    return this.queryAll(selector);
  }

  private queryAll(_selector: string): MockElement[] {
    return [];
  }
}

describe('Project Overview Derivation & Rendering (Step 3)', () => {
  const sampleProject: ProjectDto = {
    id: 'orchestrate-benchmark',
    name: 'Orchestrate Benchmark',
    createdAt: '2026-10-22T08:00:00.000Z',
    facts: [
      {
        key: 'Language',
        value: 'JavaScript',
        provenance: 'AGENT',
        status: 'CLAIMED',
        recordedAt: '2026-10-22T08:05:00.000Z',
      },
      {
        key: 'Language',
        value: 'TypeScript',
        provenance: 'CODE',
        status: 'VERIFIED',
        recordedAt: '2026-10-22T08:10:00.000Z',
      },
      {
        key: 'Authentication',
        value: 'JWT stateless tokens',
        provenance: 'AGENT',
        status: 'CLAIMED',
        recordedAt: '2026-10-22T08:15:00.000Z',
      },
    ],
  };

  const sampleHandoffs: HandoffDto[] = [
    {
      id: 'h-auth-1',
      taskId: 'auth-foundation',
      attemptNumber: 1,
      agentId: 'agent-a',
      model: 'nebius',
      status: 'CLAIMED',
      summary: 'Implemented JWT verification middleware.',
      changes: 'Added src/auth.ts',
      filesAffected: ['src/auth.ts', 'test/auth.test.ts'],
      decisionsCreated: [
        {
          id: 'dec-1',
          statement: 'SQLite for V1 persistence',
          rationale: 'Zero external infrastructure dependency',
          status: 'ACTIVE',
        },
      ],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T09:00:00.000Z',
    },
    {
      id: 'h-reset-1',
      taskId: 'add-password-reset',
      attemptNumber: 1,
      status: 'CLAIMED',
      summary: 'First pass at reset request endpoint.',
      changes: 'Added src/reset.ts',
      filesAffected: ['src/reset.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T10:00:00.000Z',
    },
    {
      id: 'h-reset-2',
      taskId: 'add-password-reset',
      attemptNumber: 2,
      status: 'CLAIMED',
      summary: 'Added token expiry and one-time reset codes.',
      changes: 'Updated src/reset.ts',
      filesAffected: ['src/reset.ts', 'src/types.ts', 'test/reset.test.ts', 'src/index.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T11:00:00.000Z',
    },
    {
      id: 'h-profile-1',
      taskId: 'profile-endpoint',
      attemptNumber: 1,
      status: 'CLAIMED',
      summary: 'Profile attempt 1',
      changes: 'src/profile.ts',
      filesAffected: ['src/profile.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T09:10:00.000Z',
    },
    {
      id: 'h-profile-2',
      taskId: 'profile-endpoint',
      attemptNumber: 2,
      status: 'CLAIMED',
      summary: 'Profile attempt 2',
      changes: 'src/profile.ts',
      filesAffected: ['src/profile.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T09:20:00.000Z',
    },
    {
      id: 'h-profile-3',
      taskId: 'profile-endpoint',
      attemptNumber: 3,
      status: 'CLAIMED',
      summary: 'Profile attempt 3 after repair loop',
      changes: 'src/profile.ts',
      filesAffected: ['src/profile.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T09:30:00.000Z',
    },
    {
      id: 'h-docs-1',
      taskId: 'api-docs',
      attemptNumber: 1,
      status: 'CLAIMED',
      summary: 'Drafted OpenAPI spec, awaiting verification.',
      changes: 'docs/openapi.json',
      filesAffected: ['docs/openapi.json'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T11:30:00.000Z',
    },
  ];

  const sampleVerifications: VerificationRecordDto[] = [
    {
      id: 'v-auth-1',
      taskId: 'auth-foundation',
      attemptNumber: 1,
      handoffId: 'h-auth-1',
      result: {
        status: 'VERIFIED',
        checks: [
          {
            checkId: 'c1',
            name: 'Tests',
            command: 'npm',
            args: ['test'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            durationMs: 1200,
          },
        ],
        executedAt: '2026-10-22T09:05:00.000Z',
        totalDurationMs: 1200,
      },
      recordedAt: '2026-10-22T09:05:00.000Z',
    },
    {
      id: 'v-reset-1',
      taskId: 'add-password-reset',
      attemptNumber: 1,
      handoffId: 'h-reset-1',
      result: {
        status: 'FAILED',
        checks: [
          {
            checkId: 'c1',
            name: 'Tests',
            command: 'npm',
            args: ['test'],
            status: 'FAILED',
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'fail',
            durationMs: 900,
          },
        ],
        executedAt: '2026-10-22T10:05:00.000Z',
        totalDurationMs: 900,
      },
      recordedAt: '2026-10-22T10:05:00.000Z',
    },
    {
      id: 'v-reset-2',
      taskId: 'add-password-reset',
      attemptNumber: 2,
      handoffId: 'h-reset-2',
      result: {
        status: 'FAILED',
        checks: [
          {
            checkId: 'c1',
            name: 'Tests',
            command: 'npm',
            args: ['test'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            durationMs: 11800,
          },
          {
            checkId: 'c2',
            name: 'Typecheck',
            command: 'npm',
            args: ['run', 'typecheck'],
            status: 'FAILED',
            passed: false,
            exitCode: 2,
            stdout: '',
            stderr: 'TS2322',
            durationMs: 4100,
          },
        ],
        executedAt: '2026-10-22T11:05:00.000Z',
        totalDurationMs: 15900,
      },
      recordedAt: '2026-10-22T11:05:00.000Z',
    },
    // 3 failed attempts for profile-endpoint -> BLOCKED_NEEDS_HUMAN
    ...[1, 2, 3].map((attempt) => ({
      id: `v-profile-${attempt}`,
      taskId: 'profile-endpoint',
      attemptNumber: attempt,
      handoffId: `h-profile-${attempt}`,
      result: {
        status: 'FAILED' as const,
        checks: [
          {
            checkId: 'c-prof',
            name: 'Acceptance',
            command: 'npm',
            args: ['test'],
            status: 'FAILED' as const,
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'error',
            durationMs: 500,
          },
        ],
        executedAt: `2026-10-22T09:${attempt}5:00.000Z`,
        totalDurationMs: 500,
      },
      recordedAt: `2026-10-22T09:${attempt}5:00.000Z`,
    })),
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('derives an empty overview model cleanly when project has no facts, handoffs, or verifications', () => {
    const emptyProj: ProjectDto = {
      id: 'clean-proj',
      name: 'Clean Project',
      createdAt: '2026-10-22T12:00:00.000Z',
      facts: [],
    };

    const model = deriveProjectOverviewModel(emptyProj, [], []);

    expect(model.project.id).toBe('clean-proj');
    expect(model.currentFacts).toEqual([]);
    expect(model.decisions).toEqual([]);
    expect(model.derivedTasks).toEqual([]);
    expect(model.taskCounts).toEqual({
      all: 0,
      verified: 0,
      failed: 0,
      blocked: 0,
      claimed: 0,
      unverified: 0,
    });
    expect(model.attentionItems).toEqual([]);
    expect(model.latestVerification).toBeNull();
    expect(model.recentHandoffs).toEqual([]);
  });

  it('derives task trust states, counts, attention items, latest verification, and deduplicated facts from persisted records', () => {
    const model = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications
    );

    // 1. Append-only facts deduplicated by latest entry per key
    expect(model.currentFacts).toHaveLength(2);
    expect(model.currentFacts.find((f) => f.key === 'Language')?.value).toBe('TypeScript');
    expect(model.currentFacts.find((f) => f.key === 'Language')?.provenance).toBe('CODE');
    expect(model.currentFacts.find((f) => f.key === 'Authentication')?.status).toBe('CLAIMED');

    // 2. Decisions extracted from handoffs
    expect(model.decisions).toHaveLength(1);
    expect(model.decisions[0].statement).toBe('SQLite for V1 persistence');

    // 3. Derived task counts and trust states:
    // Without an explicit blocked_tasks signal from the backend, 3 failed attempts derive as FAILED (never inferred from count alone)
    expect(model.taskCounts).toEqual({
      all: 4,
      verified: 1, // auth-foundation
      failed: 2, // add-password-reset (2 failed attempts) + profile-endpoint (3 failed attempts, no explicit blocked flag)
      blocked: 0,
      claimed: 1, // api-docs (handoff only, no verification yet)
      unverified: 0,
    });

    const authTask = model.derivedTasks.find((t) => t.taskId === 'auth-foundation');
    expect(authTask?.trustState).toBe('VERIFIED');

    const resetTask = model.derivedTasks.find((t) => t.taskId === 'add-password-reset');
    expect(resetTask?.trustState).toBe('FAILED');
    expect(resetTask?.highestAttempt).toBe(2);
    expect(resetTask?.failedCheckNames).toEqual(['Typecheck']);

    const profileTask = model.derivedTasks.find((t) => t.taskId === 'profile-endpoint');
    expect(profileTask?.trustState).toBe('FAILED');
    expect(profileTask?.highestAttempt).toBe(3);

    const docsTask = model.derivedTasks.find((t) => t.taskId === 'api-docs');
    expect(docsTask?.trustState).toBe('CLAIMED');

    // 4. Attention items ordered by severity: FAILED -> CLAIMED
    expect(model.attentionItems.map((a) => a.taskId)).toEqual([
      'add-password-reset',
      'profile-endpoint',
      'api-docs',
    ]);
    expect(model.attentionItems[0].reason).toContain('Typecheck failed on attempt 2');
    expect(model.attentionItems[0].targetSection).toBe('verifications');
    expect(model.attentionItems[1].targetSection).toBe('verifications');
    expect(model.attentionItems[2].targetSection).toBe('handoffs');

    // 5. Latest verification is v-reset-2
    expect(model.latestVerification?.id).toBe('v-reset-2');
    expect(model.latestVerification?.result.status).toBe('FAILED');

    // 6. Recent handoffs paired with verification outcomes
    const resetAttempt2 = model.recentHandoffs.find((r) => r.handoff.id === 'h-reset-2');
    expect(resetAttempt2?.outcomeStatus).toBe('FAILED');
    const authAttempt1 = model.recentHandoffs.find((r) => r.handoff.id === 'h-auth-1');
    expect(authAttempt1?.outcomeStatus).toBe('VERIFIED');
    const docsAttempt1 = model.recentHandoffs.find((r) => r.handoff.id === 'h-docs-1');
    expect(docsAttempt1?.outcomeStatus).toBe('CLAIMED');
  });

  it('Audit 1 & 3 (Attempt identity & Verification freshness): rejects verification with mismatched handoffId or timestamp older than handoff', () => {
    const handoffs: HandoffDto[] = [
      {
        id: 'h-task-1-fresh',
        taskId: 'task-identity',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Newer handoff for attempt 1',
        changes: 'src/a.ts',
        filesAffected: ['src/a.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-10-22T12:00:00.000Z',
      },
      {
        id: 'h-task-2- stale-verif',
        taskId: 'task-freshness',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Handoff recorded after stale verification',
        changes: 'src/b.ts',
        filesAffected: ['src/b.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-10-22T12:10:00.000Z',
      },
    ];

    const verifications: VerificationRecordDto[] = [
      {
        id: 'v-wrong-handoff-id',
        taskId: 'task-identity',
        attemptNumber: 1,
        handoffId: 'h-other-handoff', // Mismatched handoffId
        result: {
          status: 'VERIFIED',
          checks: [],
          executedAt: '2026-10-22T12:05:00.000Z',
          totalDurationMs: 100,
        },
        recordedAt: '2026-10-22T12:05:00.000Z',
      },
      {
        id: 'v-stale-timestamp',
        taskId: 'task-freshness',
        attemptNumber: 1,
        handoffId: 'h-task-2- stale-verif',
        result: {
          status: 'VERIFIED',
          checks: [],
          executedAt: '2026-10-22T12:00:00.000Z', // 10 minutes older than handoff.createdAt!
          totalDurationMs: 100,
        },
        recordedAt: '2026-10-22T12:00:00.000Z',
      },
    ];

    const model = deriveProjectOverviewModel(sampleProject, handoffs, verifications);
    const identityTask = model.derivedTasks.find((t) => t.taskId === 'task-identity');
    const freshnessTask = model.derivedTasks.find((t) => t.taskId === 'task-freshness');

    // Neither should be promoted to VERIFIED
    expect(identityTask?.trustState).toBe('CLAIMED');
    expect(freshnessTask?.trustState).toBe('CLAIMED');
  });

  it('Audit 2 (Latest state): older failed attempt never overrides later VERIFIED attempt, and later unverified handoff demotes earlier VERIFIED to CLAIMED', () => {
    const handoffs: HandoffDto[] = [
      // Task A: Attempt 1 FAILED, Attempt 2 VERIFIED -> must be VERIFIED
      {
        id: 'h-a-1',
        taskId: 'task-recover',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Attempt 1',
        changes: '',
        filesAffected: ['src/a.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-10-22T09:00:00.000Z',
      },
      {
        id: 'h-a-2',
        taskId: 'task-recover',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Attempt 2 fixed bug',
        changes: '',
        filesAffected: ['src/a.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-10-22T10:00:00.000Z',
      },
      // Task B: Attempt 1 VERIFIED, Attempt 2 CLAIMED (no verification record yet) -> must be CLAIMED
      {
        id: 'h-b-1',
        taskId: 'task-new-attempt',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Attempt 1 verified',
        changes: '',
        filesAffected: ['src/b.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-10-22T09:00:00.000Z',
      },
      {
        id: 'h-b-2',
        taskId: 'task-new-attempt',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Attempt 2 new unverified changes',
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
      {
        id: 'v-a-1',
        taskId: 'task-recover',
        attemptNumber: 1,
        handoffId: 'h-a-1',
        result: {
          status: 'FAILED',
          checks: [],
          executedAt: '2026-10-22T09:05:00.000Z',
          totalDurationMs: 200,
        },
        recordedAt: '2026-10-22T09:05:00.000Z',
      },
      {
        id: 'v-a-2',
        taskId: 'task-recover',
        attemptNumber: 2,
        handoffId: 'h-a-2',
        result: {
          status: 'VERIFIED',
          checks: [],
          executedAt: '2026-10-22T10:05:00.000Z',
          totalDurationMs: 200,
        },
        recordedAt: '2026-10-22T10:05:00.000Z',
      },
      {
        id: 'v-b-1',
        taskId: 'task-new-attempt',
        attemptNumber: 1,
        handoffId: 'h-b-1',
        result: {
          status: 'VERIFIED',
          checks: [],
          executedAt: '2026-10-22T09:05:00.000Z',
          totalDurationMs: 200,
        },
        recordedAt: '2026-10-22T09:05:00.000Z',
      },
    ];

    const model = deriveProjectOverviewModel(sampleProject, handoffs, verifications);
    const recoverTask = model.derivedTasks.find((t) => t.taskId === 'task-recover');
    const newAttemptTask = model.derivedTasks.find((t) => t.taskId === 'task-new-attempt');

    expect(recoverTask?.trustState).toBe('VERIFIED');
    expect(recoverTask?.highestAttempt).toBe(2);

    expect(newAttemptTask?.trustState).toBe('CLAIMED');
    expect(newAttemptTask?.highestAttempt).toBe(2);
  });

  it('Audit 4 & 5 (Repair threshold & Status precedence): derives BLOCKED_NEEDS_HUMAN only when explicitly signaled', () => {
    const model = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      sampleVerifications,
      { blockedTaskIds: ['profile-endpoint'] }
    );

    const profileTask = model.derivedTasks.find((t) => t.taskId === 'profile-endpoint');
    expect(profileTask?.trustState).toBe('BLOCKED_NEEDS_HUMAN');
    expect(model.taskCounts.blocked).toBe(1);
    expect(model.taskCounts.failed).toBe(1);
    expect(model.attentionItems[0].taskId).toBe('profile-endpoint');
    expect(model.attentionItems[0].trustState).toBe('BLOCKED_NEEDS_HUMAN');
  });

  it('Audit 6 (Partial data): prevents misleading CLAIMED or VERIFIED task states when handoffs or verifications fail to load', () => {
    // Case A: Verifications endpoint failed (verificationsAvailable: false)
    const modelNoVerifs = deriveProjectOverviewModel(
      sampleProject,
      sampleHandoffs,
      [],
      { handoffsAvailable: true, verificationsAvailable: false }
    );
    expect(modelNoVerifs.taskDerivationComplete).toBe(false);
    expect(modelNoVerifs.derivedTasks).toEqual([]);
    expect(modelNoVerifs.attentionItems).toEqual([]);
    expect(modelNoVerifs.recentHandoffs.every((h) => h.verificationUnknown)).toBe(true);

    // Case B: Handoffs endpoint failed (handoffsAvailable: false)
    const modelNoHandoffs = deriveProjectOverviewModel(
      sampleProject,
      [],
      sampleVerifications,
      { handoffsAvailable: false, verificationsAvailable: true }
    );
    expect(modelNoHandoffs.taskDerivationComplete).toBe(false);
    expect(modelNoHandoffs.derivedTasks).toEqual([]);
    expect(modelNoHandoffs.attentionItems).toEqual([]);
  });

  it('preserves active projectId when navigating from Overview into Tasks, Handoffs, Verifications, Brain, and Context', () => {
    router.navigateToProject('orchestrate-benchmark', 'overview');
    expect(router.getRoute().projectId).toBe('orchestrate-benchmark');
    expect(router.getRoute().destination).toBe('overview');

    const sections = ['tasks', 'handoffs', 'verifications', 'brain', 'context'] as const;
    for (const section of sections) {
      router.navigateToProject('orchestrate-benchmark', section);
      expect(router.getRoute().projectId).toBe('orchestrate-benchmark');
      expect(router.getRoute().destination).toBe(section);
      expect(router.getRoute().path).toBe(`#/projects/orchestrate-benchmark/${section}`);
    }
  });

  it('renders Project Overview HTML with real project ID and handles API failure / partial data', async () => {
    (global as any).document = {
      createElement: (tag: string) => new MockElement(tag),
    };

    // Simulate partial data: getProject succeeds, getHandoffs succeeds, getVerifications rejects with 500
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
    vi.spyOn(engineClient, 'getVerifications').mockRejectedValue(
      new Error('Failed to load verifications (HTTP 500)')
    );

    const route = router.parseRoute('#/projects/orchestrate-benchmark/overview');
    const el = renderPlaceholderPage(route);

    expect(el.innerHTML).toContain('orchestrate-benchmark');
    expect(el.innerHTML).toContain('Needs attention');
    expect(el.innerHTML).toContain('Latest verification');
    expect(el.innerHTML).toContain('Recent handoffs & evidence');
    expect(el.innerHTML).toContain('Project facts');
    expect(el.innerHTML).toContain('#/projects/orchestrate-benchmark/tasks');
    expect(el.innerHTML).toContain('#/projects/orchestrate-benchmark/handoffs');
    expect(el.innerHTML).toContain('#/projects/orchestrate-benchmark/verifications');
    expect(el.innerHTML).toContain('#/projects/orchestrate-benchmark/brain');
    expect(el.innerHTML).toContain('#/projects/orchestrate-benchmark/context');
  });
});
