import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHandoffDetailHtml,
  buildVerificationDetailHtml,
  deriveHandoffItems,
  deriveProjectOverviewModel,
  deriveVerificationItems,
  filterHandoffItems,
  filterVerificationItems,
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
  public id = '';
  public className = '';
  public textContent = '';
  public value = '';
  public style: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public eventListeners: Record<string, Array<(e?: any) => void>> = {};
  private _innerHTML = '';
  public children: MockElement[] = [];
  private queriedChildren: Map<string, MockElement> = new Map();

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
    if (!this.queriedChildren.has(selector)) {
      this.queriedChildren.set(selector, new MockElement('div'));
    }
    return this.queriedChildren.get(selector)!;
  }

  public querySelectorAll(_selector: string): MockElement[] {
    return [];
  }

  public get combinedHtml(): string {
    const childHtml = Array.from(this.queriedChildren.values())
      .map((c) => c.innerHTML || c.textContent)
      .join('\n');
    return `${this._innerHTML}\n${childHtml}`;
  }
}

describe('Handoffs & Verifications Screens (Step 5)', () => {
  const sampleProject: ProjectDto = {
    id: 'orchestrate-step5',
    name: 'Orchestrate Step 5',
    createdAt: '2026-10-22T08:00:00.000Z',
    facts: [],
  };

  const sampleHandoffs: HandoffDto[] = [
    {
      id: 'h-task1-att1',
      taskId: 'task_001',
      attemptNumber: 1,
      agentId: 'agent-alpha',
      model: 'nebius-qwen-32b',
      status: 'CLAIMED',
      summary: 'Initial greeting module implementation.',
      changes: 'Created src/greeting.ts with createGreeting helper.',
      filesAffected: ['src/greeting.ts', 'test/greeting.test.ts'],
      decisionsCreated: [
        {
          id: 'dec-greeting-pure',
          statement: 'Keep greeting module pure and side-effect free',
          rationale: 'Deterministic testing',
          status: 'ACTIVE',
        },
      ],
      assumptions: ['Inputs are non-empty UTF-8 strings'],
      limitations: ['Does not localize salutations yet'],
      recommendedFollowUp: ['Add CLI consumer in Task 2'],
      createdAt: '2026-10-22T10:00:00.000Z',
    },
    {
      id: 'h-task2-att1',
      taskId: 'task_002',
      attemptNumber: 1,
      agentId: 'agent-beta',
      model: 'nebius-qwen-32b',
      status: 'CLAIMED',
      summary: 'First attempt at CLI consumer failed lint check.',
      changes: 'Added src/cli.ts importing createGreeting.',
      filesAffected: ['src/cli.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: ['Missing return type annotation'],
      recommendedFollowUp: ['Fix lint error on src/cli.ts'],
      createdAt: '2026-10-22T11:00:00.000Z',
    },
    {
      id: 'h-task2-att2',
      taskId: 'task_002',
      attemptNumber: 2,
      agentId: 'agent-beta',
      model: 'nebius-qwen-32b',
      status: 'CLAIMED',
      summary: 'Fixed lint error in CLI consumer; awaiting verification.',
      changes: 'Added explicit return type in src/cli.ts.',
      filesAffected: ['src/cli.ts'],
      decisionsCreated: [],
      assumptions: [],
      limitations: [],
      recommendedFollowUp: [],
      createdAt: '2026-10-22T12:00:00.000Z',
    },
  ];

  const sampleVerifications: VerificationRecordDto[] = [
    {
      id: 'v-task1-att1',
      taskId: 'task_001',
      attemptNumber: 1,
      handoffId: 'h-task1-att1',
      result: {
        status: 'VERIFIED',
        executedAt: '2026-10-22T10:05:00.000Z',
        totalDurationMs: 1450,
        checks: [
          {
            checkId: 'chk-tsc',
            name: 'Typecheck',
            command: 'npx',
            args: ['tsc', '--noEmit'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 650,
          },
          {
            checkId: 'chk-vitest',
            name: 'Unit Tests',
            command: 'npx',
            args: ['vitest', 'run'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: '2 passed',
            stderr: '',
            durationMs: 800,
          },
        ],
      },
      recordedAt: '2026-10-22T10:05:01.000Z',
    },
    {
      id: 'v-task2-att1',
      taskId: 'task_002',
      attemptNumber: 1,
      handoffId: 'h-task2-att1',
      result: {
        status: 'FAILED',
        executedAt: '2026-10-22T11:04:00.000Z',
        totalDurationMs: 920,
        checks: [
          {
            checkId: 'chk-tsc',
            name: 'Typecheck',
            command: 'npx',
            args: ['tsc', '--noEmit'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 500,
          },
          {
            checkId: 'chk-lint',
            name: 'ESLint',
            command: 'npm',
            args: ['run', 'lint'],
            status: 'FAILED',
            passed: false,
            exitCode: 1,
            stdout: 'Checking formatting...',
            stderr: 'src/cli.ts:12:1 - error TS7006: Missing return type on function.',
            durationMs: 420,
          },
        ],
      },
      recordedAt: '2026-10-22T11:04:01.000Z',
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('document', {
      createElement: (tag: string) => new MockElement(tag),
    });
    vi.spyOn(engineClient, 'listTasks').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getRepositoryStatus').mockResolvedValue({ connected: false });
  });

  // ── 1 & 2. HANDOFFS DERIVATION, FILTERING, AND DETAIL BUILDER ─────────────

  it('derives handoffs newest-first, pairs valid verifications, and never labels a handoff itself as VERIFIED', () => {
    const items = deriveHandoffItems(sampleProject.id, sampleHandoffs, sampleVerifications, true);
    expect(items).toHaveLength(3);

    // Ordered newest first: task_002 attempt 2, task_002 attempt 1, task_001 attempt 1
    expect(items[0].handoff.id).toBe('h-task2-att2');
    expect(items[0].attemptTrustState).toBe('CLAIMED');
    expect(items[0].relatedVerification).toBeUndefined();

    expect(items[1].handoff.id).toBe('h-task2-att1');
    expect(items[1].attemptTrustState).toBe('FAILED');
    expect(items[1].relatedVerification?.id).toBe('v-task2-att1');

    expect(items[2].handoff.id).toBe('h-task1-att1');
    expect(items[2].attemptTrustState).toBe('VERIFIED');
    expect(items[2].relatedVerification?.id).toBe('v-task1-att1');

    // Filter by outcome, task, attempt, file, decision, and agent
    expect(filterHandoffItems(items, '', 'VERIFIED').map((i) => i.handoff.id)).toEqual([
      'h-task1-att1',
    ]);
    expect(filterHandoffItems(items, '', 'FAILED').map((i) => i.handoff.id)).toEqual([
      'h-task2-att1',
    ]);
    expect(filterHandoffItems(items, '', 'UNVERIFIED').map((i) => i.handoff.id)).toEqual([
      'h-task2-att2',
    ]);
    expect(filterHandoffItems(items, 'src/greeting.ts', 'ALL').map((i) => i.handoff.id)).toEqual([
      'h-task1-att1',
    ]);
    expect(filterHandoffItems(items, 'dec-greeting-pure', 'ALL').map((i) => i.handoff.id)).toEqual([
      'h-task1-att1',
    ]);
    expect(filterHandoffItems(items, 'attempt 2', 'ALL').map((i) => i.handoff.id)).toEqual([
      'h-task2-att2',
    ]);
  });

  it('renders actual handoff fields, provenance callout, CLAIMED badge, and related verification link in buildHandoffDetailHtml', () => {
    const items = deriveHandoffItems(sampleProject.id, sampleHandoffs, sampleVerifications, true);
    const verifiedAttemptItem = items.find((i) => i.handoff.id === 'h-task1-att1')!;

    const html = buildHandoffDetailHtml(sampleProject.id, verifiedAttemptItem);

    // Must always badge the handoff itself as CLAIMED, even when its attempt has a passing verification
    expect(html).toContain('id="handoff-detail-claim-badge">◔ CLAIMED</span>');
    expect(html).toContain('Claim, not evidence.');
    expect(html).toContain('Only an independent verification record can establish it as verified.');

    // Actual handoff fields
    expect(html).toContain('Initial greeting module implementation.');
    expect(html).toContain('Created src/greeting.ts with createGreeting helper.');
    expect(html).toContain('src/greeting.ts');
    expect(html).toContain('test/greeting.test.ts');
    expect(html).toContain('[dec-greeting-pure] Keep greeting module pure and side-effect free');
    expect(html).toContain('Inputs are non-empty UTF-8 strings');
    expect(html).toContain('Does not localize salutations yet');
    expect(html).toContain('Add CLI consumer in Task 2');
    expect(html).toContain('agent-alpha');
    expect(html).toContain('nebius-qwen-32b');

    // Related verification record section shows independent verification result and link
    expect(html).toContain('v-task1-att1');
    expect(html).toContain('2/2 configured checks passed');
    expect(html).toContain(
      'href="#/projects/orchestrate-step5/verifications?taskId=task_001&attempt=1"'
    );
  });

  // ── 3 & 4. VERIFICATIONS DERIVATION, FILTERING, AND DETAIL BUILDER ────────

  it('derives verifications newest-first, filters by status/check/command, and renders check details + failure stdout/stderr', () => {
    const items = deriveVerificationItems(
      sampleProject.id,
      sampleVerifications,
      sampleHandoffs,
      true
    );
    expect(items).toHaveLength(2);
    expect(items[0].verification.id).toBe('v-task2-att1');
    expect(items[0].handoffLinkStatus).toBe('MATCHED');
    expect(items[0].relatedHandoff?.id).toBe('h-task2-att1');

    expect(items[1].verification.id).toBe('v-task1-att1');
    expect(items[1].handoffLinkStatus).toBe('MATCHED');
    expect(items[1].relatedHandoff?.id).toBe('h-task1-att1');

    // Search by check name, command, and stderr content
    expect(filterVerificationItems(items, 'ESLint', 'ALL').map((i) => i.verification.id)).toEqual([
      'v-task2-att1',
    ]);
    expect(filterVerificationItems(items, 'TS7006', 'ALL').map((i) => i.verification.id)).toEqual([
      'v-task2-att1',
    ]);
    expect(filterVerificationItems(items, '', 'VERIFIED').map((i) => i.verification.id)).toEqual([
      'v-task1-att1',
    ]);
    expect(filterVerificationItems(items, '', 'FAILED').map((i) => i.verification.id)).toEqual([
      'v-task2-att1',
    ]);

    // Detail HTML for failed verification
    const failedHtml = buildVerificationDetailHtml(sampleProject.id, items[0]);
    expect(failedHtml).toContain('v-task2-att1');
    expect(failedHtml).toContain('h-task2-att1');
    expect(failedHtml).toContain('First attempt at CLI consumer failed lint check.');
    expect(failedHtml).toContain('ESLint');
    expect(failedHtml).toContain('npm run lint');
    expect(failedHtml).toContain('FAILED (exit 1)');
    expect(failedHtml).toContain('[stderr]');
    expect(failedHtml).toContain('src/cli.ts:12:1 - error TS7006: Missing return type on function.');
    expect(failedHtml).toContain('[stdout]');
    expect(failedHtml).toContain('Checking formatting...');
    expect(failedHtml).toContain('code revision SHA is not persisted in schema');
    expect(failedHtml).toContain(
      'href="#/projects/orchestrate-step5/handoffs?taskId=task_002&attempt=1"'
    );
  });

  // ── 7 & 10. STALE / MISMATCHED / MISSING RECORDS & OVERVIEW/TASK AGREEMENT ─

  it('distinguishes MISMATCHED (handoffId mismatch) from STALE (timestamp older than handoff) and keeps states consistent across Overview, Task Explorer, Handoffs, and Verifications', () => {
    const mismatchedVerif: VerificationRecordDto = {
      id: 'v-mismatch-att2',
      taskId: 'task_002',
      attemptNumber: 2,
      handoffId: 'h-task2-att1', // points to attempt 1's handoff instead of attempt 2's h-task2-att2!
      result: {
        status: 'VERIFIED',
        executedAt: '2026-10-22T12:10:00.000Z',
        totalDurationMs: 500,
        checks: [],
      },
      recordedAt: '2026-10-22T12:10:01.000Z',
    };

    const staleHandoff: HandoffDto = {
      ...sampleHandoffs[0],
      id: 'h-task3-att1',
      taskId: 'task_003',
      attemptNumber: 1,
      summary: 'Newer handoff recorded after an earlier verification run.',
      createdAt: '2026-10-22T14:00:00.000Z',
    };

    const staleVerif: VerificationRecordDto = {
      id: 'v-stale-att1',
      taskId: 'task_003',
      attemptNumber: 1,
      handoffId: 'h-task3-att1',
      result: {
        status: 'VERIFIED',
        executedAt: '2026-10-22T13:00:00.000Z', // 1 hour BEFORE staleHandoff.createdAt!
        totalDurationMs: 400,
        checks: [],
      },
      recordedAt: '2026-10-22T13:00:01.000Z',
    };

    const handoffsAll = [...sampleHandoffs, staleHandoff];
    const verifsAll = [...sampleVerifications, mismatchedVerif, staleVerif];

    const overview = deriveProjectOverviewModel(sampleProject, handoffsAll, verifsAll);
    const handoffItems = deriveHandoffItems(sampleProject.id, handoffsAll, verifsAll, true);
    const verifItems = deriveVerificationItems(sampleProject.id, verifsAll, handoffsAll, true);

    // 1. MISMATCHED case (task_002 attempt 2):
    const task2 = overview.derivedTasks.find((t) => t.taskId === 'task_002')!;
    expect(task2.trustState).toBe('CLAIMED');
    const att2 = task2.attempts.find((a) => a.attemptNumber === 2)!;
    expect(att2.trustState).toBe('CLAIMED');
    expect(att2.verificationRejectedKind).toBe('MISMATCHED');
    expect(att2.verificationRejectedReason).toContain('does not match');

    const handoffAtt2 = handoffItems.find((i) => i.handoff.id === 'h-task2-att2')!;
    expect(handoffAtt2.attemptTrustState).toBe('CLAIMED');
    expect(handoffAtt2.relatedVerification).toBeUndefined();
    expect(handoffAtt2.verificationRejectedKind).toBe('MISMATCHED');
    expect(handoffAtt2.verificationRejectedReason).toBe(att2.verificationRejectedReason);

    const handoffMismatchHtml = buildHandoffDetailHtml(sampleProject.id, handoffAtt2);
    expect(handoffMismatchHtml).toContain('rejected as mismatched');
    expect(handoffMismatchHtml).toContain('>MISMATCHED<');
    expect(handoffMismatchHtml).toContain('does not match');

    const verifMismatch = verifItems.find((i) => i.verification.id === 'v-mismatch-att2')!;
    expect(verifMismatch.handoffLinkStatus).toBe('MISMATCHED');
    expect(verifMismatch.mismatchReason).toBe(att2.verificationRejectedReason);

    const verifMismatchHtml = buildVerificationDetailHtml(sampleProject.id, verifMismatch);
    expect(verifMismatchHtml).toContain('Mismatched verification record:');
    expect(verifMismatchHtml).toContain('>MISMATCHED<');
    expect(verifMismatchHtml).toContain('does not match');

    // 2. STALE case (task_003 attempt 1):
    const task3 = overview.derivedTasks.find((t) => t.taskId === 'task_003')!;
    expect(task3.trustState).toBe('CLAIMED');
    const task3Att1 = task3.attempts.find((a) => a.attemptNumber === 1)!;
    expect(task3Att1.trustState).toBe('CLAIMED');
    expect(task3Att1.verificationRejectedKind).toBe('STALE');
    expect(task3Att1.verificationRejectedReason).toContain('stale');

    const handoffTask3 = handoffItems.find((i) => i.handoff.id === 'h-task3-att1')!;
    expect(handoffTask3.attemptTrustState).toBe('CLAIMED');
    expect(handoffTask3.relatedVerification).toBeUndefined();
    expect(handoffTask3.verificationRejectedKind).toBe('STALE');
    expect(handoffTask3.verificationRejectedReason).toBe(task3Att1.verificationRejectedReason);

    const handoffStaleHtml = buildHandoffDetailHtml(sampleProject.id, handoffTask3);
    expect(handoffStaleHtml).toContain('rejected as stale');
    expect(handoffStaleHtml).toContain('>STALE<');

    const verifStale = verifItems.find((i) => i.verification.id === 'v-stale-att1')!;
    expect(verifStale.handoffLinkStatus).toBe('STALE');
    expect(verifStale.mismatchReason).toBe(task3Att1.verificationRejectedReason);

    const verifStaleHtml = buildVerificationDetailHtml(sampleProject.id, verifStale);
    expect(verifStaleHtml).toContain('Stale verification record:');
    expect(verifStaleHtml).toContain('>STALE<');

    // Filter helpers distinguish MISMATCHED vs STALE vs UNVERIFIED
    expect(filterHandoffItems(handoffItems, '', 'MISMATCHED').map((i) => i.handoff.id)).toEqual([
      'h-task2-att2',
    ]);
    expect(filterHandoffItems(handoffItems, '', 'STALE').map((i) => i.handoff.id)).toEqual([
      'h-task3-att1',
    ]);
    expect(filterVerificationItems(verifItems, '', 'MISMATCHED').map((i) => i.verification.id)).toEqual([
      'v-mismatch-att2',
    ]);
    expect(filterVerificationItems(verifItems, '', 'STALE').map((i) => i.verification.id)).toEqual([
      'v-stale-att1',
    ]);
  });

  it('handles a genuine orphan verification (NO HANDOFF) when handoffs loaded successfully and a handoff with no verification (UNVERIFIED) when verifications loaded successfully', () => {
    const orphanVerif: VerificationRecordDto = {
      id: 'v-orphan',
      taskId: 'task_999',
      attemptNumber: 1,
      handoffId: '',
      result: {
        status: 'VERIFIED',
        executedAt: '2026-10-22T15:00:00.000Z',
        totalDurationMs: 300,
        checks: [],
      },
      recordedAt: '2026-10-22T15:00:00.000Z',
    };

    const vItems = deriveVerificationItems(sampleProject.id, [orphanVerif], sampleHandoffs, true);
    expect(vItems[0].handoffLinkStatus).toBe('NO_HANDOFF');
    expect(filterVerificationItems(vItems, '', 'NO_HANDOFF')).toHaveLength(1);
    const vHtml = buildVerificationDetailHtml(sampleProject.id, vItems[0]);
    expect(vHtml).toContain('NO HANDOFF');
    expect(vHtml).toContain('No agent handoff claim was recorded for Task #task_999 attempt #1.');

    // Handoff with no matching verification when verifications loaded successfully -> UNVERIFIED
    const hItems = deriveHandoffItems(sampleProject.id, sampleHandoffs, sampleVerifications, true);
    const unverifiedHandoff = hItems.find((i) => i.handoff.id === 'h-task2-att2')!;
    expect(unverifiedHandoff.verificationsAvailable).toBe(true);
    expect(unverifiedHandoff.relatedVerification).toBeUndefined();
    expect(unverifiedHandoff.verificationRejectedReason).toBeUndefined();
    const hHtml = buildHandoffDetailHtml(sampleProject.id, unverifiedHandoff);
    expect(hHtml).toContain('○ UNVERIFIED');
    expect(hHtml).toContain('None recorded for Task #task_002 attempt #2 yet.');
  });

  // ── 5, 6 & 9. DEEP LINKS, ENCODED IDS, AND RETURN-TO-TASK NAVIGATION ──────

  it('supports deep links (?taskId=...&attempt=...) with URL-encoded IDs and renders missing-target state when not found', async () => {
    const specialProject: ProjectDto = {
      id: 'proj/alpha 1',
      name: 'Alpha 1',
      createdAt: '2026-10-22T08:00:00.000Z',
      facts: [],
    };
    const specialHandoff: HandoffDto = {
      ...sampleHandoffs[0],
      id: 'h-special-1',
      taskId: 'task/a+b#1',
      attemptNumber: 2,
    };
    const specialVerif: VerificationRecordDto = {
      ...sampleVerifications[0],
      id: 'v-special-1',
      taskId: 'task/a+b#1',
      attemptNumber: 2,
      handoffId: 'h-special-1',
    };

    vi.spyOn(engineClient, 'getProject').mockResolvedValue(specialProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue([specialHandoff]);
    vi.spyOn(engineClient, 'getVerifications').mockResolvedValue([specialVerif]);

    // 1. Deep-link to existing handoff
    const handoffRoute = router.parseRoute(
      `#/projects/${encodeURIComponent(specialProject.id)}/handoffs?taskId=${encodeURIComponent('task/a+b#1')}&attempt=2`
    );
    const handoffEl = renderPlaceholderPage(handoffRoute) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));

    expect(handoffEl.combinedHtml).toContain('h-special-1');
    expect(handoffEl.combinedHtml).toContain(
      `#/projects/${encodeURIComponent('proj/alpha 1')}/tasks/${encodeURIComponent('task/a+b#1')}`
    );
    expect(handoffEl.combinedHtml).toContain(
      `#/projects/${encodeURIComponent('proj/alpha 1')}/verifications?taskId=${encodeURIComponent('task/a+b#1')}&attempt=2`
    );

    // 2. Deep-link to non-existent attempt shows explicit non-crashing missing state
    const missingVerifRoute = router.parseRoute(
      `#/projects/${encodeURIComponent(specialProject.id)}/verifications?taskId=${encodeURIComponent('task/a+b#1')}&attempt=99`
    );
    const missingVerifEl = renderPlaceholderPage(missingVerifRoute) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));

    expect(missingVerifEl.combinedHtml).toContain('verifications-deep-link-missing');
    expect(missingVerifEl.combinedHtml).toContain('No verification record found for Task');
  });

  // ── 8. PARTIAL API FAILURE, ENGINE ERROR, AND 404 PROJECT STATES (STEP 5.1) ──

  it('Invariant 1: when handoffs load but verifications are unavailable, does not present handoffs as UNVERIFIED or fabricate 0 outcome filter pills', async () => {
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
    vi.spyOn(engineClient, 'getVerifications').mockRejectedValue(
      new Error('Verifications endpoint timed out')
    );

    const route = router.parseRoute(`#/projects/${sampleProject.id}/handoffs`);
    const el = renderPlaceholderPage(route) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));

    const html = el.combinedHtml;
    expect(html).toContain('Partial data loaded');
    expect(html).toContain('Verifications endpoint timed out');
    expect(html).toContain('VERIFICATIONS UNAVAILABLE');
    expect(html).toContain('Verifications unavailable');
    expect(html).toContain('Verification outcomes unavailable');

    // Must NOT fabricate 0 outcome counts or label handoffs as conclusively UNVERIFIED
    expect(html).not.toContain('Verified 0');
    expect(html).not.toContain('Failed 0');
    expect(html).not.toContain('Unverified 0');
    expect(html).not.toContain('○ UNVERIFIED');
    expect(html).not.toContain('None recorded for Task');
  });

  it('Invariant 2: when verifications load but handoffs are unavailable, does not classify verifications as NO HANDOFF, MISMATCHED, or STALE', async () => {
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getVerifications').mockResolvedValue(sampleVerifications);
    vi.spyOn(engineClient, 'getHandoffs').mockRejectedValue(
      new Error('Handoffs endpoint 503')
    );

    const route = router.parseRoute(`#/projects/${sampleProject.id}/verifications`);
    const el = renderPlaceholderPage(route) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));

    const html = el.combinedHtml;
    expect(html).toContain('Partial data loaded');
    expect(html).toContain('Handoffs endpoint 503');
    expect(html).toContain('HANDOFFS UNAVAILABLE');
    expect(html).toContain('Handoffs unavailable');

    // Must NOT classify any verification as orphaned (NO HANDOFF), MISMATCHED, or STALE when handoffs failed to load
    expect(html).not.toContain('NO HANDOFF');
    expect(html).not.toContain('No agent handoff claim was recorded');
    expect(html).not.toContain('>MISMATCHED<');
    expect(html).not.toContain('>STALE<');
  });

  it('handles both evidence endpoints unavailable across Handoffs, Verifications, Project Overview, and Task Explorer without fabricating 0 counts or empty states', async () => {
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getHandoffs').mockRejectedValue(new Error('Handoffs offline'));
    vi.spyOn(engineClient, 'getVerifications').mockRejectedValue(new Error('Verifications offline'));

    // 1. Handoffs screen shows primary error state, not "No handoffs recorded"
    const handoffsEl = renderPlaceholderPage(
      router.parseRoute(`#/projects/${sampleProject.id}/handoffs`)
    ) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));
    expect(handoffsEl.combinedHtml).toContain('Unable to load Handoffs');
    expect(handoffsEl.combinedHtml).toContain('Handoffs offline');
    expect(handoffsEl.combinedHtml).not.toContain('No handoffs recorded');

    // 2. Verifications screen shows primary error state, not "No verification records"
    const verifsEl = renderPlaceholderPage(
      router.parseRoute(`#/projects/${sampleProject.id}/verifications`)
    ) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));
    expect(verifsEl.combinedHtml).toContain('Unable to load Verifications');
    expect(verifsEl.combinedHtml).toContain('Verifications offline');
    expect(verifsEl.combinedHtml).not.toContain('No verification records');

    // 3. Project Overview shows unavailable states, not "0 handoffs", "0 verifications", or fabricated 0 filter pills
    const overviewEl = renderPlaceholderPage(
      router.parseRoute(`#/projects/${sampleProject.id}/overview`)
    ) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));
    expect(overviewEl.combinedHtml).toContain('handoffs unavailable');
    expect(overviewEl.combinedHtml).toContain('verifications unavailable');
    expect(overviewEl.combinedHtml).toContain('VERIFICATIONS UNAVAILABLE');
    expect(overviewEl.combinedHtml).toContain('Verification records are currently unavailable');
    expect(overviewEl.combinedHtml).toContain('Handoff records failed to load');
    expect(overviewEl.combinedHtml).not.toContain('0 handoffs');
    expect(overviewEl.combinedHtml).not.toContain('0 verifications');
    expect(overviewEl.combinedHtml).not.toContain('Verified 0');

    // 4. Task Explorer shows derivation paused and hides fabricated 0 filter pills
    const tasksEl = renderPlaceholderPage(
      router.parseRoute(`#/projects/${sampleProject.id}/tasks`)
    ) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));
    expect(tasksEl.combinedHtml).toContain('Derivation paused (partial data)');
    expect(tasksEl.combinedHtml).toContain(
      'Task status counts unavailable until both handoffs and verifications load'
    );
    expect(tasksEl.combinedHtml).not.toContain('Verified 0');
  });

  it('maintains cross-screen trust-state consistency across Project Overview, Task Explorer, Handoffs, and Verifications (including BLOCKED_NEEDS_HUMAN)', () => {
    const blockedHandoff: HandoffDto = {
      ...sampleHandoffs[0],
      id: 'h-task4-att1',
      taskId: 'task_004',
      attemptNumber: 1,
      status: 'BLOCKED_NEEDS_HUMAN',
      summary: 'Repair loop exhausted; blocked awaiting human review.',
      createdAt: '2026-10-22T16:00:00.000Z',
    };
    const handoffs = [...sampleHandoffs, blockedHandoff];
    const verifications = [...sampleVerifications];

    const overviewModel = deriveProjectOverviewModel(sampleProject, handoffs, verifications);
    const handoffItems = deriveHandoffItems(sampleProject.id, handoffs, verifications, true);
    const verifItems = deriveVerificationItems(sampleProject.id, verifications, handoffs, true);

    for (const task of overviewModel.derivedTasks) {
      for (const att of task.attempts) {
        const hItem = handoffItems.find(
          (i) =>
            i.handoff.taskId === task.taskId &&
            Number(i.handoff.attemptNumber) === att.attemptNumber
        );
        if (hItem) {
          expect(hItem.attemptTrustState).toBe(att.trustState);
          expect(hItem.relatedVerification?.id).toBe(att.verification?.id);
          expect(hItem.verificationRejectedKind).toBe(att.verificationRejectedKind);
        }
        const vItem = verifItems.find(
          (i) =>
            i.verification.taskId === task.taskId &&
            Number(i.verification.attemptNumber) === att.attemptNumber
        );
        if (vItem && att.verification) {
          expect(vItem.verification.id).toBe(att.verification.id);
          expect(vItem.handoffLinkStatus).toBe(att.handoff ? 'MATCHED' : 'NO_HANDOFF');
        }
      }
    }

    const blockedTask = overviewModel.derivedTasks.find((t) => t.taskId === 'task_004')!;
    expect(blockedTask.trustState).toBe('BLOCKED_NEEDS_HUMAN');
    const blockedHandoffItem = handoffItems.find((i) => i.handoff.id === 'h-task4-att1')!;
    expect(blockedHandoffItem.attemptTrustState).toBe('BLOCKED_NEEDS_HUMAN');
  });

  it('renders project-not-found (404) and primary endpoint failure states cleanly', async () => {
    vi.spyOn(engineClient, 'getProject').mockResolvedValue(null);
    vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getVerifications').mockResolvedValue([]);

    const notFoundRoute = router.parseRoute('#/projects/missing-proj/verifications');
    const notFoundEl = renderPlaceholderPage(notFoundRoute) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));
    expect(notFoundEl.combinedHtml).toContain('Project not found');

    vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
    vi.spyOn(engineClient, 'getVerifications').mockRejectedValue(new Error('Engine offline'));

    const errRoute = router.parseRoute(`#/projects/${sampleProject.id}/verifications`);
    const errEl = renderPlaceholderPage(errRoute) as unknown as MockElement;
    await new Promise((r) => setTimeout(r, 10));
    expect(errEl.combinedHtml).toContain('Unable to load Verifications');
    expect(errEl.combinedHtml).toContain('Engine offline');
  });
});
