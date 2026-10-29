import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryProjectBrain,
  SqliteProjectBrain,
} from '../../../packages/brain/src/index.js';
import {
  ContextCompiler,
  ContextCompilerCore,
} from '../../../packages/compiler/src/index.js';
import {
  buildBrainFactDetailHtml,
  deriveProjectBrainFacts,
  deriveProjectOverviewModel,
  filterProjectBrainFacts,
  renderPlaceholderPage,
} from '../src/components/placeholder-page.js';
import {
  engineClient,
  type HandoffDto,
  type ProjectDto,
  type ProjectFactDto,
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

describe('Project Brain Screen (Step 6)', () => {
  const sampleFacts: ProjectFactDto[] = [
    {
      key: 'global.runtime',
      value: 'Node.js 20',
      provenance: 'SYSTEM',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T08:00:00.000Z',
    },
    {
      key: 'global.runtime',
      value: 'Node.js 22 LTS',
      provenance: 'CODE',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T09:30:00.000Z',
    },
    {
      key: 'auth.session_store',
      value: 'SQLite WAL store used by task-auth-1',
      provenance: 'VERIFICATION',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T10:15:00.000Z',
    },
    {
      key: 'cache.strategy',
      value: 'In-memory LRU cache proposed by agent',
      provenance: 'AGENT',
      status: 'CLAIMED',
      recordedAt: '2026-10-22T11:00:00.000Z',
    },
    {
      key: 'legacy_notes',
      value: 'Unscoped note pending review',
      provenance: 'HUMAN',
      status: 'UNVERIFIED',
      recordedAt: '2026-10-22T11:30:00.000Z',
    },
  ];

  const sampleProject: ProjectDto = {
    id: 'orchestrate-step6',
    name: 'Orchestrate Step 6',
    createdAt: '2026-10-22T08:00:00.000Z',
    facts: sampleFacts,
  };

  const sampleHandoffs: HandoffDto[] = [
    {
      id: 'ho-auth-1',
      projectId: 'orchestrate-step6',
      taskId: 'task-auth-1',
      attemptNumber: 1,
      agentId: 'coder-1',
      summary: 'Implemented SQLite WAL session persistence',
      filesChanged: [{ path: 'src/session.ts', changeType: 'CREATE' }],
      decisionsCreated: [
        {
          id: 'dec-wal-1',
          statement: 'Use SQLite WAL mode for concurrent read access',
          rationale: 'Prevents reader blocking during single-writer transactions',
          status: 'ACTIVE',
        },
      ],
      assumptions: [],
       unresolvedQuestions: [],
      status: 'CLAIMED',
      createdAt: '2026-10-22T10:00:00.000Z',
    } as unknown as HandoffDto,
  ];

  const sampleVerifications: VerificationRecordDto[] = [
    {
      id: 'verif-auth-1',
      taskId: 'task-auth-1',
      attemptNumber: 1,
      handoffId: 'ho-auth-1',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T10:10:00.000Z',
      result: {
        verificationId: 'verif-auth-1',
        taskId: 'task-auth-1',
        attemptNumber: 1,
        status: 'VERIFIED',
        summary: 'All session tests passed',
        executedAt: '2026-10-22T10:10:00.000Z',
        durationMs: 240,
        checks: [
          {
            checkId: 'chk-1',
            name: 'vitest',
            command: 'npx',
            args: ['vitest', 'run'],
            status: 'PASSED',
            passed: true,
            exitCode: 0,
            stdout: '1 passed',
            stderr: '',
            durationMs: 240,
          },
        ],
      },
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('document', {
      createElement: (tag: string) => new MockElement(tag),
    });
    vi.spyOn(engineClient, 'listTasks').mockResolvedValue([]);
    vi.spyOn(engineClient, 'getRepositoryStatus').mockResolvedValue({ connected: false });
    vi.stubGlobal('CSS', {
      escape: (str: string) => str,
    });
  });

  describe('1. Derivation from actual MemoryProjectBrain and SqliteProjectBrain models', () => {
    it('derives identical current facts and revision lineage from MemoryProjectBrain and SqliteProjectBrain', async () => {
      const memBrain = new MemoryProjectBrain();
      const sqlBrain = new SqliteProjectBrain({ databasePath: ':memory:' });

      try {
        await memBrain.createProject({ id: 'p-1', name: 'Brain Parity Test' });
        await sqlBrain.createProject({ id: 'p-1', name: 'Brain Parity Test' });

        for (const fact of sampleFacts) {
          await memBrain.addProjectFact('p-1', {
            key: fact.key,
            value: fact.value,
            provenance: fact.provenance as any,
            status: fact.status as any,
            recordedAt: fact.recordedAt,
          });
          await sqlBrain.addProjectFact('p-1', {
            key: fact.key,
            value: fact.value,
            provenance: fact.provenance as any,
            status: fact.status as any,
            recordedAt: fact.recordedAt,
          });
        }

        const memProject = (await memBrain.getProject('p-1'))!;
        const sqlProject = (await sqlBrain.getProject('p-1'))!;

        const memDerived = deriveProjectBrainFacts(memProject.facts);
        const sqlDerived = deriveProjectBrainFacts(sqlProject.facts);

        expect(memDerived).toEqual(sqlDerived);
        expect(memDerived).toHaveLength(4); // 5 raw entries across 4 unique keys

        // Verify append-only revision history for 'global.runtime' matches BrainStore.getCurrentFact / getFactHistory
        const runtimeItem = memDerived.find((i) => i.key === 'global.runtime')!;
        expect(runtimeItem.current).toEqual(
          await memBrain.getCurrentFact('p-1', 'global.runtime')
        );
        expect(runtimeItem.current).toEqual(
          await sqlBrain.getCurrentFact('p-1', 'global.runtime')
        );
        expect(runtimeItem.current.value).toBe('Node.js 22 LTS');
        expect(runtimeItem.revisionCount).toBe(2);

        // History is ordered newest-first with accurate revisionIndex and isCurrent flags
        expect(runtimeItem.history).toHaveLength(2);
        expect(runtimeItem.history[0].isCurrent).toBe(true);
        expect(runtimeItem.history[0].revisionIndex).toBe(2);
        expect(runtimeItem.history[0].fact.value).toBe('Node.js 22 LTS');
        expect(runtimeItem.history[1].isCurrent).toBe(false);
        expect(runtimeItem.history[1].revisionIndex).toBe(1);
        expect(runtimeItem.history[1].fact.value).toBe('Node.js 20');
      } finally {
        sqlBrain.close();
      }
    });

    it('computes ContextCompiler scope eligibility matching ContextCompilerCore rules', () => {
      const derived = deriveProjectBrainFacts(sampleFacts);

      const globalRuntime = derived.find((i) => i.key === 'global.runtime')!;
      expect(globalRuntime.compilerScope.admittedToContext).toBe(true);
      expect(globalRuntime.compilerScope.scopeKind).toBe('GLOBAL');

      const tagScoped = derived.find((i) => i.key === 'auth.session_store')!;
      expect(tagScoped.compilerScope.admittedToContext).toBe(true);
      expect(tagScoped.compilerScope.scopeKind).toBe('TAG_SCOPED');
      expect(tagScoped.compilerScope.scopeTag).toBe('auth');

      const claimedAgentFact = derived.find((i) => i.key === 'cache.strategy')!;
      expect(claimedAgentFact.compilerScope.admittedToContext).toBe(false);
      expect(claimedAgentFact.compilerScope.scopeKind).toBe('EXCLUDED_NOT_VERIFIED');

      const unscopedVerified = deriveProjectBrainFacts([
        {
          key: 'unscoped_key',
          value: 'true',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T12:00:00.000Z',
        },
      ])[0];
      expect(unscopedVerified.compilerScope.admittedToContext).toBe(false);
      expect(unscopedVerified.compilerScope.scopeKind).toBe('UNSCOPED');
    });
  });

  describe('2. Search and filtering across persisted fields and revision history', () => {
    it('filters by current provenance, current status, and current search query without matching superseded revisions as current', () => {
      const derived = deriveProjectBrainFacts(sampleFacts);

      // Filter by provenance (only current revision provenance counts)
      expect(filterProjectBrainFacts(derived, 'CODE', 'ALL', '')).toHaveLength(1);
      expect(filterProjectBrainFacts(derived, 'VERIFICATION', 'ALL', '')).toHaveLength(1);
      expect(filterProjectBrainFacts(derived, 'AGENT', 'ALL', '')).toHaveLength(1);
      expect(filterProjectBrainFacts(derived, 'HUMAN', 'ALL', '')).toHaveLength(1);
      expect(filterProjectBrainFacts(derived, 'SYSTEM', 'ALL', '')).toHaveLength(0); // superseded by CODE

      // Filter by status (only current revision status counts)
      expect(filterProjectBrainFacts(derived, 'ALL', 'VERIFIED', '')).toHaveLength(2);
      expect(filterProjectBrainFacts(derived, 'ALL', 'CLAIMED', '')).toHaveLength(1);
      expect(filterProjectBrainFacts(derived, 'ALL', 'UNVERIFIED', '')).toHaveLength(1);

      // Search by current value
      const walMatches = filterProjectBrainFacts(derived, 'ALL', 'ALL', 'sqlite wal');
      expect(walMatches.map((m) => m.key)).toEqual(['auth.session_store']);

      // Superseded revision value ('Node.js 20') is not represented as a current fact match
      const supersededMatches = filterProjectBrainFacts(derived, 'ALL', 'ALL', 'Node.js 20');
      expect(supersededMatches).toHaveLength(0);
    });
  });

  describe('3. Source-of-truth hierarchy & Fact Detail inspector', () => {
    it('never promotes CLAIMED or UNVERIFIED facts to VERIFIED and never fabricates confidence scores', () => {
      const derived = deriveProjectBrainFacts(sampleFacts);
      const model = deriveProjectOverviewModel(sampleProject, sampleHandoffs, sampleVerifications);

      const claimedItem = derived.find((i) => i.key === 'cache.strategy')!;
      const claimedHtml = buildBrainFactDetailHtml(claimedItem, sampleProject.id, model);

      expect(claimedHtml).toContain('CLAIMED');
      expect(claimedHtml).not.toContain('status-badge verified');
      expect(claimedHtml).toContain('Source-of-Truth Notice:');
      expect(claimedHtml).toContain('EXCLUDED (NOT VERIFIED)');
      expect(claimedHtml).toContain('confidence scores are not persisted');
      expect(claimedHtml).not.toContain('99.8%');

      const unverifiedItem = derived.find((i) => i.key === 'legacy_notes')!;
      const unverifiedHtml = buildBrainFactDetailHtml(unverifiedItem, sampleProject.id, model);
      expect(unverifiedHtml).toContain('UNVERIFIED');
      expect(unverifiedHtml).not.toContain('status-badge verified');
    });

    it('renders multi-revision lineage and project-scoped task/evidence links when a taskId is referenced', () => {
      const derived = deriveProjectBrainFacts(sampleFacts);
      const model = deriveProjectOverviewModel(sampleProject, sampleHandoffs, sampleVerifications);

      const runtimeItem = derived.find((i) => i.key === 'global.runtime')!;
      const runtimeHtml = buildBrainFactDetailHtml(runtimeItem, sampleProject.id, model);
      expect(runtimeHtml).toContain('Current (Rev #2)');
      expect(runtimeHtml).toContain('Superseded (Rev #1)');
      expect(runtimeHtml).toContain('Node.js 22 LTS');
      expect(runtimeHtml).toContain('Node.js 20');

      const authItem = derived.find((i) => i.key === 'auth.session_store')!;
      const authHtml = buildBrainFactDetailHtml(authItem, sampleProject.id, model);
      expect(authHtml).toContain(
        '#/projects/orchestrate-step6/tasks?task=task-auth-1'
      );
      expect(authHtml).toContain(
        '#/projects/orchestrate-step6/handoffs?task=task-auth-1'
      );
      expect(authHtml).toContain(
        '#/projects/orchestrate-step6/verifications?task=task-auth-1'
      );
    });

    it('escapes untrusted HTML in fact keys and values and URL-encodes navigation parameters', () => {
      const xssFacts: ProjectFactDto[] = [
        {
          key: 'global.<script>alert(1)</script>',
          value: '<img src=x onerror="alert(2)">',
          provenance: 'AGENT',
          status: 'CLAIMED',
          recordedAt: '2026-10-22T12:00:00.000Z',
        },
      ];
      const item = deriveProjectBrainFacts(xssFacts)[0];
      const html = buildBrainFactDetailHtml(item, 'proj/unsafe id', null);

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;');
      expect(html).toContain('#/projects/proj%2Funsafe%20id/context');
    });
  });

  describe('4. Screen rendering: empty, error, partial-data, deep-link, and Overview consistency', () => {
    it('maintains 100% consistency between Project Brain facts/decisions and Project Overview', () => {
      const brainItems = deriveProjectBrainFacts(sampleProject.facts);
      const overviewModel = deriveProjectOverviewModel(
        sampleProject,
        sampleHandoffs,
        sampleVerifications
      );

      expect(brainItems.map((i) => i.current)).toEqual(overviewModel.currentFacts);
      expect(overviewModel.decisions).toHaveLength(1);
      expect(overviewModel.decisions[0].id).toBe('dec-wal-1');
    });

    it('renders facts, deep-linked ?key=... selection, and recorded handoff decisions without promoting CLAIMED facts', async () => {
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
      vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue(sampleHandoffs);
      vi.spyOn(engineClient, 'getVerifications').mockResolvedValue(sampleVerifications);

      const route = router.parseRoute(
        '#/projects/orchestrate-step6/brain?key=cache.strategy'
      );
      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 10));

      const combined = page.combinedHtml;
      expect(combined).toContain('cache.strategy: In-memory LRU cache proposed by agent');
      expect(combined).toContain('Use SQLite WAL mode for concurrent read access');
      expect(combined).toContain('4 / 4');
    });

    it('renders an empty state when project has zero persisted facts', async () => {
      vi.spyOn(engineClient, 'getProject').mockResolvedValue({
        ...sampleProject,
        facts: [],
      });
      vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue([]);
      vi.spyOn(engineClient, 'getVerifications').mockResolvedValue([]);

      const route = router.parseRoute('#/projects/orchestrate-step6/brain');
      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 10));

      expect(page.combinedHtml).toContain('No project facts recorded yet');
    });

    it('surfaces partial-data banner and marks decisions/related evidence as UNAVAILABLE when handoffs fail to load', async () => {
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);
      vi.spyOn(engineClient, 'getHandoffs').mockRejectedValue(
        new Error('Engine 503 handoffs store offline')
      );
      vi.spyOn(engineClient, 'getVerifications').mockResolvedValue(sampleVerifications);

      const route = router.parseRoute('#/projects/orchestrate-step6/brain');
      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 10));

      const combined = page.combinedHtml;
      expect(combined).toContain('Partial data loaded:');
      expect(combined).toContain('Handoffs unavailable');
      expect(combined).toContain('Decisions Status: UNAVAILABLE');
      expect(combined).toContain('Related Evidence Status: UNAVAILABLE');
    });

    it('renders Project Not Found card on 404 and Error card on 500', async () => {
      vi.spyOn(engineClient, 'getProject').mockRejectedValueOnce(
        new Error('HTTP 404: Project not found')
      );
      vi.spyOn(engineClient, 'getHandoffs').mockResolvedValue([]);
      vi.spyOn(engineClient, 'getVerifications').mockResolvedValue([]);

      const route404 = router.parseRoute('#/projects/missing-proj/brain');
      const page404 = renderPlaceholderPage(route404) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 10));
      expect(page404.combinedHtml).toContain('Project Not Found');

      vi.spyOn(engineClient, 'getProject').mockRejectedValueOnce(
        new Error('HTTP 500: SQLite busy')
      );
      const route500 = router.parseRoute('#/projects/orchestrate-step6/brain');
      const page500 = renderPlaceholderPage(route500) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 10));
      expect(page500.combinedHtml).toContain('Unable to Load Project Brain');
      expect(page500.combinedHtml).toContain('HTTP 500: SQLite busy');
    });
  });

  describe('5. Step 6.1 Regression Suite: Revision Lineage & Compiler Admission Invariants', () => {
    it('older VERIFIED revision followed by newer CLAIMED revision never inherits VERIFIED status or compiles as current verified context', async () => {
      const memBrain = new MemoryProjectBrain();
      const sqlBrain = new SqliteProjectBrain({ databasePath: ':memory:' });

      try {
        await memBrain.createProject({ id: 'p-claimed', name: 'Verified then Claimed' });
        await sqlBrain.createProject({ id: 'p-claimed', name: 'Verified then Claimed' });
        await memBrain.createTask({
          id: 't-1',
          projectId: 'p-claimed',
          title: 'Task 1',
          description: 'Desc',
        });
        await sqlBrain.createTask({
          id: 't-1',
          projectId: 'p-claimed',
          title: 'Task 1',
          description: 'Desc',
        });

        // Rev 1: VERIFIED
        await memBrain.addProjectFact('p-claimed', {
          key: 'global.db_port',
          value: '5432',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        });
        await sqlBrain.addProjectFact('p-claimed', {
          key: 'global.db_port',
          value: '5432',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        });

        // Rev 2: CLAIMED
        await memBrain.addProjectFact('p-claimed', {
          key: 'global.db_port',
          value: '6432',
          provenance: 'AGENT',
          status: 'CLAIMED',
          recordedAt: '2026-10-22T09:00:00.000Z',
        });
        await sqlBrain.addProjectFact('p-claimed', {
          key: 'global.db_port',
          value: '6432',
          provenance: 'AGENT',
          status: 'CLAIMED',
          recordedAt: '2026-10-22T09:00:00.000Z',
        });

        const memProject = (await memBrain.getProject('p-claimed'))!;
        const sqlProject = (await sqlBrain.getProject('p-claimed'))!;

        const memDerived = deriveProjectBrainFacts(memProject.facts);
        const sqlDerived = deriveProjectBrainFacts(sqlProject.facts);
        expect(memDerived).toEqual(sqlDerived);
        expect(memDerived).toHaveLength(1);

        const item = memDerived[0];
        expect(item.current.value).toBe('6432');
        expect(item.current.status).toBe('CLAIMED');
        expect(item.current.provenance).toBe('AGENT');
        expect(item.compilerScope.admittedToContext).toBe(false);
        expect(item.compilerScope.scopeKind).toBe('EXCLUDED_NOT_VERIFIED');

        // Verify filter by VERIFIED excludes this item even though Rev #1 was VERIFIED
        expect(filterProjectBrainFacts(memDerived, 'ALL', 'VERIFIED', '')).toHaveLength(0);
        expect(filterProjectBrainFacts(memDerived, 'ALL', 'ALL', 'VERIFIED')).toHaveLength(0);

        // Verify real ContextCompiler excludes the superseded VERIFIED revision
        const compiler = new ContextCompiler({ brain: sqlBrain });
        const compiled = await compiler.compile({
          projectId: 'p-claimed',
          targetTaskId: 't-1',
        });
        expect(compiled.facts).toHaveLength(0);
      } finally {
        sqlBrain.close();
      }
    });

    it('older VERIFIED revision followed by newer UNVERIFIED revision never inherits VERIFIED status or compiles as current verified context', async () => {
      const sqlBrain = new SqliteProjectBrain({ databasePath: ':memory:' });

      try {
        await sqlBrain.createProject({ id: 'p-unverif', name: 'Verified then Unverified' });
        await sqlBrain.createTask({
          id: 't-1',
          projectId: 'p-unverif',
          title: 'Task 1',
          description: 'Desc',
        });

        // Rev 1: VERIFIED
        await sqlBrain.addProjectFact('p-unverif', {
          key: 'auth.provider',
          value: 'oauth2',
          provenance: 'VERIFICATION',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        });

        // Rev 2: UNVERIFIED
        await sqlBrain.addProjectFact('p-unverif', {
          key: 'auth.provider',
          value: 'saml',
          provenance: 'HUMAN',
          status: 'UNVERIFIED',
          recordedAt: '2026-10-22T09:00:00.000Z',
        });

        const project = (await sqlBrain.getProject('p-unverif'))!;
        const derived = deriveProjectBrainFacts(project.facts);
        expect(derived).toHaveLength(1);

        const item = derived[0];
        expect(item.current.value).toBe('saml');
        expect(item.current.status).toBe('UNVERIFIED');
        expect(item.current.provenance).toBe('HUMAN');
        expect(item.compilerScope.admittedToContext).toBe(false);
        expect(item.compilerScope.scopeKind).toBe('EXCLUDED_NOT_VERIFIED');

        const detailHtml = buildBrainFactDetailHtml(item, 'p-unverif', null);
        expect(detailHtml).toContain('Current (Rev #2)');
        expect(detailHtml).toContain('Superseded (Rev #1)');
        expect(detailHtml).toContain('EXCLUDED (NOT VERIFIED)');

        // Real ContextCompiler with tags: ['auth'] must NOT admit the superseded VERIFIED revision
        const compiler = new ContextCompiler({ brain: sqlBrain });
        const compiled = await compiler.compile({
          projectId: 'p-unverif',
          targetTaskId: 't-1',
          tags: ['auth'],
        });
        expect(compiled.facts).toHaveLength(0);
      } finally {
        sqlBrain.close();
      }
    });

    it('multiple revisions for one key deterministically select the latest persisted revision and agree across Project Overview, Project Brain, and ContextCompilerCore', async () => {
      const sqlBrain = new SqliteProjectBrain({ databasePath: ':memory:' });

      try {
        await sqlBrain.createProject({ id: 'p-multi', name: 'Multi Revision' });

        await sqlBrain.addProjectFact('p-multi', {
          key: 'global.node',
          value: '18.0.0',
          provenance: 'SYSTEM',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        });
        await sqlBrain.addProjectFact('p-multi', {
          key: 'global.node',
          value: '20.0.0',
          provenance: 'AGENT',
          status: 'CLAIMED',
          recordedAt: '2026-10-22T09:00:00.000Z',
        });
        await sqlBrain.addProjectFact('p-multi', {
          key: 'global.node',
          value: '22.4.0',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T10:00:00.000Z',
        });

        const project = (await sqlBrain.getProject('p-multi'))!;
        const brainCurrent = await sqlBrain.getCurrentFact('p-multi', 'global.node');
        const derivedBrain = deriveProjectBrainFacts(project.facts);
        const overviewModel = deriveProjectOverviewModel(project, [], []);

        // 1. BrainStore.getCurrentFact, deriveProjectBrainFacts, and deriveProjectOverviewModel all agree
        expect(derivedBrain).toHaveLength(1);
        expect(derivedBrain[0].current).toEqual(brainCurrent);
        expect(overviewModel.currentFacts).toEqual([brainCurrent]);
        expect(derivedBrain[0].revisionCount).toBe(3);
        expect(derivedBrain[0].history.map((h) => h.fact.value)).toEqual([
          '22.4.0',
          '20.0.0',
          '18.0.0',
        ]);

        // 2. ContextCompilerCore admits only the current VERIFIED revision ('22.4.0'), never '18.0.0'
        const compiled = ContextCompilerCore.compile({
          request: { projectId: 'p-multi', targetTaskId: 't-1' },
          targetTask: null,
          upstreamTask: null,
          upstreamAttempts: [],
          activeDecisions: [],
          projectFacts: project.facts as any,
          git: null,
        });
        expect(compiled.facts).toEqual([
          {
            key: 'global.node',
            value: '22.4.0',
            provenance: 'CODE',
            status: 'VERIFIED',
          },
        ]);
      } finally {
        sqlBrain.close();
      }
    });

    it('keeps empty fact history strictly distinct from unavailable Engine data', async () => {
      // Case A: Genuinely empty facts (Engine succeeded with facts: [])
      vi.spyOn(engineClient, 'getProject').mockResolvedValueOnce({
        id: 'proj-empty',
        name: 'Empty Project',
        createdAt: '2026-10-22T08:00:00.000Z',
        facts: [],
      });
      vi.spyOn(engineClient, 'getHandoffs').mockResolvedValueOnce([]);
      vi.spyOn(engineClient, 'getVerifications').mockResolvedValueOnce([]);

      const emptyPage = renderPlaceholderPage(
        router.parseRoute('#/projects/proj-empty/brain')
      ) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 10));

      expect(emptyPage.combinedHtml).toContain('No project facts recorded yet');
      expect(emptyPage.combinedHtml).not.toContain('Unable to Load Project Brain');
      expect(emptyPage.combinedHtml).not.toContain('Project Brain facts unavailable');

      // Case B: Unavailable project facts (Engine 500 error) -> never says "No project facts recorded yet"
      vi.spyOn(engineClient, 'getProject').mockRejectedValueOnce(
        new Error('Engine 500 database unreachable')
      );
      vi.spyOn(engineClient, 'getHandoffs').mockResolvedValueOnce([]);
      vi.spyOn(engineClient, 'getVerifications').mockResolvedValueOnce([]);

      const errorPage = renderPlaceholderPage(
        router.parseRoute('#/projects/proj-empty/brain')
      ) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 10));

      expect(errorPage.combinedHtml).toContain('Unable to Load Project Brain');
      expect(errorPage.combinedHtml).toContain('Project Brain facts unavailable');
      expect(errorPage.combinedHtml).not.toContain('No project facts recorded yet');
    });
  });
});
