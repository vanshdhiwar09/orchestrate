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
  buildCompiledContextTreeHtml,
  buildFactAdmissionViewHtml,
  buildSerializedEnvelopeWrappedHtml,
  deriveFactAdmissions,
  deriveProjectBrainFacts,
  renderPlaceholderPage,
} from '../src/components/placeholder-page.js';
import {
  engineClient,
  type CompiledContextResponseDto,
  type ProjectDto,
  type ProjectFactDto,
} from '../src/services/engine-client.js';
import { router } from '../src/services/router.js';

class MockElement {
  public tagName: string;
  public id = '';
  public className = '';
  public textContent = '';
  public value = '';
  public disabled = false;
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

describe('Context Compiler Screen & Logic (Step 7)', () => {
  const sampleFacts: ProjectFactDto[] = [
    // 1. Current VERIFIED global fact
    {
      key: 'global.runtime',
      value: 'Node.js 22 LTS',
      provenance: 'CODE',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T09:30:00.000Z',
    },
    // 2. Tag-scoped VERIFIED fact
    {
      key: 'auth.session_store',
      value: 'SQLite WAL store',
      provenance: 'VERIFICATION',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T10:15:00.000Z',
    },
    // 3. Superseded fact: old VERIFIED superseded by newer CLAIMED
    {
      key: 'cache.strategy',
      value: 'Redis v6',
      provenance: 'CODE',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T08:00:00.000Z',
    },
    {
      key: 'cache.strategy',
      value: 'In-memory LRU proposed by agent',
      provenance: 'AGENT',
      status: 'CLAIMED',
      recordedAt: '2026-10-22T11:00:00.000Z',
    },
    // 4. Unscoped VERIFIED fact
    {
      key: 'legacy_setting',
      value: 'enabled',
      provenance: 'HUMAN',
      status: 'VERIFIED',
      recordedAt: '2026-10-22T11:30:00.000Z',
    },
  ];

  const sampleProject: ProjectDto = {
    id: 'orchestrate-step7',
    name: 'Orchestrate Step 7',
    createdAt: '2026-10-22T08:00:00.000Z',
    facts: sampleFacts,
  };

  const sampleCompiledContextResponse: CompiledContextResponseDto = {
    context: {
      metadata: {
        projectId: 'orchestrate-step7',
        targetTaskId: 'task-b',
        upstreamTaskId: 'task-a',
        totalDecisionsCount: 1,
        totalFactsCount: 1,
        truncatedDecisions: false,
        truncatedFacts: false,
        redactionCount: 0,
      },
      decisions: [
        {
          id: 'dec-1',
          statement: 'Use SQLite WAL mode',
          rationale: 'Concurrent readers',
          status: 'ACTIVE',
        },
      ],
      facts: [
        {
          key: 'global.runtime',
          value: 'Node.js 22 LTS',
          provenance: 'CODE',
          status: 'VERIFIED',
        },
      ],
      upstreamWork: {
        taskId: 'task-a',
        attemptNumber: 1,
        trustState: 'VERIFIED',
        filesAffected: ['src/index.ts'],
        verificationChecks: [
          {
            checkId: 'c1',
            name: 'vitest',
            command: 'npm test',
            passed: true,
            exitCode: 0,
            durationMs: 120,
          },
        ],
        unverifiedAgentNotes: {
          summary: 'Implemented basic greeting module',
        },
      },
      gitState: {
        branch: 'main',
        headCommit: {
          hash: 'a1b2c3d4e5f6',
          subject: 'Initial commit',
          author: 'Engineer',
        },
        stagedFiles: [],
        unstagedFiles: [],
        untrackedFiles: [],
      },
    },
    serialized:
      '<orchestrate_context>\n  <fact key="global.runtime" provenance="CODE">Node.js 22 LTS</fact>\n</orchestrate_context>',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('document', {
      createElement: (tag: string) => new MockElement(tag),
      body: new MockElement('body'),
    });
  });

  describe('1. Fact Admission Derivation & Compiler Scope Rules', () => {
    it('correctly partitions admitted facts from excluded facts with precise reasons', () => {
      const compiledFacts = [
        {
          key: 'global.runtime',
          value: 'Node.js 22 LTS',
          provenance: 'CODE',
          status: 'VERIFIED',
        },
      ];

      const admissions = deriveFactAdmissions(sampleFacts, compiledFacts);

      expect(admissions.admittedCount).toBe(1);
      expect(admissions.excludedCount).toBe(3); // auth.session_store (untagged), cache.strategy (CLAIMED), legacy_setting (unscoped)
      expect(admissions.totalCurrentFacts).toBe(4);
      expect(admissions.supersededRevisionsCount).toBe(1); // older cache.strategy Redis v6

      const runtimeFact = admissions.items.find((i) => i.key === 'global.runtime' && i.isCurrent)!;
      expect(runtimeFact.admitted).toBe(true);
      expect(runtimeFact.reason).toContain('global prefix');

      const cacheFact = admissions.items.find((i) => i.key === 'cache.strategy' && i.isCurrent)!;
      expect(cacheFact.admitted).toBe(false);
      expect(cacheFact.reason).toContain('fact status is "CLAIMED"');

      const supersededCache = admissions.items.find(
        (i) => i.key === 'cache.strategy' && !i.isCurrent
      )!;
      expect(supersededCache.admitted).toBe(false);
      expect(supersededCache.reason).toContain('superseded revision');

      const unscopedFact = admissions.items.find((i) => i.key === 'legacy_setting' && i.isCurrent)!;
      expect(unscopedFact.admitted).toBe(false);
      expect(unscopedFact.reason).toContain('unscoped');
    });

    it('matches ContextCompilerCore admission of current vs superseded revisions', () => {
      const snapshot = {
        request: { projectId: 'orchestrate-step7', targetTaskId: 'task-b' },
        targetTask: null,
        upstreamTask: null,
        upstreamAttempts: [],
        activeDecisions: [],
        projectFacts: sampleFacts as any,
        git: null,
      };

      const compiled = ContextCompilerCore.compile(snapshot);
      expect(compiled.facts).toHaveLength(1);
      expect(compiled.facts[0].key).toBe('global.runtime');
      expect(compiled.facts[0].value).toBe('Node.js 22 LTS');

      // The superseded VERIFIED revision 'Redis v6' for cache.strategy must NOT be compiled
      expect(compiled.facts.some((f) => f.key === 'cache.strategy')).toBe(false);
    });

    it('handles requested tags admission and distinguishes missing tags from budget truncation', () => {
      const facts: ProjectFactDto[] = [
        {
          key: 'auth.jwt_secret',
          value: 'configured',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        },
        {
          key: 'db.connection_pool',
          value: 'max 10',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        },
        {
          key: 'global.env',
          value: 'production',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        },
      ];

      // Case A: request tags = ['auth']; compiled facts includes auth.jwt_secret and global.env
      const compiledA = [
        { key: 'global.env', value: 'production', provenance: 'CODE', status: 'VERIFIED' },
        { key: 'auth.jwt_secret', value: 'configured', provenance: 'CODE', status: 'VERIFIED' },
      ];
      const admissionsA = deriveFactAdmissions(facts, compiledA, ['auth']);
      expect(admissionsA.admittedCount).toBe(2);
      expect(admissionsA.excludedCount).toBe(1);

      const dbFactA = admissionsA.items.find((i) => i.key === 'db.connection_pool')!;
      expect(dbFactA.admitted).toBe(false);
      expect(dbFactA.reason).toContain('was not included in requested compilation tags');

      // Case B: request tags = ['auth', 'db'], but db was omitted due to budget limit (truncatedFacts: true)
      const admissionsB = deriveFactAdmissions(facts, compiledA, ['auth', 'db'], {
        truncatedFacts: true,
        totalFactsCount: 3,
      });
      const dbFactB = admissionsB.items.find((i) => i.key === 'db.connection_pool')!;
      expect(dbFactB.admitted).toBe(false);
      expect(dbFactB.reason).toContain('context budget limit reached');

      // Case C: request tags = ['auth', 'db'], omitted without confirmed compiler truncation metadata
      const admissionsC = deriveFactAdmissions(facts, compiledA, ['auth', 'db'], {
        truncatedFacts: false,
        totalFactsCount: 2,
      });
      const dbFactC = admissionsC.items.find((i) => i.key === 'db.connection_pool')!;
      expect(dbFactC.admitted).toBe(false);
      expect(dbFactC.reason).toContain('omitted from compiled context (reason unconfirmed by compiler metadata)');
    });

    it('handles key trimming, tag case-insensitivity, and older VERIFIED superseded by newer UNVERIFIED revision', () => {
      const factsWithWhitespace: ProjectFactDto[] = [
        {
          key: '  GLOBAL.Environment  ',
          value: 'staging',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        },
        {
          key: 'db.port',
          value: '5432',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-10-22T08:00:00.000Z',
        },
        {
          key: 'db.port',
          value: '5433 (unconfirmed)',
          provenance: 'AGENT',
          status: 'UNVERIFIED',
          recordedAt: '2026-10-22T09:00:00.000Z',
        },
      ];

      const compiled = [
        {
          key: 'global.environment',
          value: 'staging',
          provenance: 'CODE',
          status: 'VERIFIED',
        },
      ];

      const admissions = deriveFactAdmissions(factsWithWhitespace, compiled);
      expect(admissions.admittedCount).toBe(1);

      // Trimming and case matching
      const globalFact = admissions.items.find((i) => i.key === 'GLOBAL.Environment' && i.isCurrent)!;
      expect(globalFact.admitted).toBe(true);

      // Current revision of db.port is UNVERIFIED (superseded older VERIFIED revision)
      const currentDbPort = admissions.items.find((i) => i.key === 'db.port' && i.isCurrent)!;
      expect(currentDbPort.admitted).toBe(false);
      expect(currentDbPort.status).toBe('UNVERIFIED');
      expect(currentDbPort.reason).toContain('fact status is "UNVERIFIED"');

      // Older revision of db.port is marked as superseded
      const olderDbPort = admissions.items.find((i) => i.key === 'db.port' && !i.isCurrent)!;
      expect(olderDbPort.admitted).toBe(false);
      expect(olderDbPort.reason).toContain('superseded revision');
    });
  });

  describe('2. Tree View & Serialized Envelope Formatters', () => {
    it('builds readable structured tree view partitioning verification evidence from quarantined claims', () => {
      const treeHtml = buildCompiledContextTreeHtml(sampleCompiledContextResponse.context);

      expect(treeHtml).toContain('Target Task: <strong>task-b</strong>');
      expect(treeHtml).toContain('Upstream Task: <strong>task-a</strong>');
      expect(treeHtml).toContain('global.runtime');
      expect(treeHtml).toContain('Node.js 22 LTS');
      expect(treeHtml).toContain('Independent Verification Evidence:');
      expect(treeHtml).toContain('vitest');
      expect(treeHtml).toContain('PASSED');
      expect(treeHtml).toContain('Quarantined Agent Claims (Level 4):');
      expect(treeHtml).toContain('Implemented basic greeting module');
      expect(treeHtml).toContain('Branch: main');
    });

    it('builds wrapped serialized envelope view safely escaping tags', () => {
      const wrappedHtml = buildSerializedEnvelopeWrappedHtml(
        sampleCompiledContextResponse.serialized
      );

      expect(wrappedHtml).toContain('&lt;orchestrate_context&gt;');
      expect(wrappedHtml).toContain('&lt;fact key=&quot;global.runtime&quot;');
      expect(wrappedHtml).not.toContain('<orchestrate_context>');
    });

    it('builds fact admission breakdown with explicit source-of-truth non-proof notice', () => {
      const admissions = deriveFactAdmissions(sampleFacts, [
        {
          key: 'global.runtime',
          value: 'Node.js 22 LTS',
          provenance: 'CODE',
          status: 'VERIFIED',
        },
      ]);
      const html = buildFactAdmissionViewHtml(admissions, true);

      expect(html).toContain('Fact Admission Breakdown');
      expect(html).toContain('1 Admitted');
      expect(html).toContain('3 Excluded');
      expect(html).toContain(
        'not proof that the underlying implementation is universally or formally correct.'
      );
      expect(html).toContain('✓ ADMITTED');
      expect(html).toContain('✕ EXCLUDED');
    });
  });

  describe('3. Screen Interaction & Route Query Handling', () => {
    it('validates missing targetTaskId and prevents request', async () => {
      const spy = vi.spyOn(engineClient, 'compileContext');
      const route = router.parseRoute('#/projects/orchestrate-step7/context');

      const page = renderPlaceholderPage(route) as unknown as MockElement;
      const compileBtn = page.querySelector('#compile-ctx-btn')!;
      compileBtn.eventListeners['click']?.[0]?.();
      await new Promise((r) => setTimeout(r, 10));

      expect(spy).not.toHaveBeenCalled();
      expect(page.combinedHtml).toContain('Query parameter "targetTaskId" is required');
    });

    it('auto-compiles when targetTaskId is supplied in route parameters', async () => {
      vi.spyOn(engineClient, 'compileContext').mockResolvedValue(sampleCompiledContextResponse);
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);

      const route = router.parseRoute(
        '#/projects/orchestrate-step7/context?targetTaskId=task-b&upstreamTaskId=task-a'
      );

      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 20));

      const combined = page.combinedHtml;
      expect(combined).toContain('Back to Task #task-b');
      expect(combined).toContain('Node.js 22 LTS');
      expect(combined).toContain('Fact Admission Breakdown');
      expect(combined).toContain('Compiled for task');
      expect(combined).toContain('task-b');
    });

    it('handles engine compile failure gracefully displaying truthful error banner', async () => {
      vi.spyOn(engineClient, 'compileContext').mockRejectedValue(
        new Error('Target task "nonexistent" not found in project "orchestrate-step7".')
      );
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);

      const route = router.parseRoute(
        '#/projects/orchestrate-step7/context?targetTaskId=nonexistent'
      );

      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 20));

      expect(page.combinedHtml).toContain(
        'Target task "nonexistent" not found in project "orchestrate-step7".'
      );
      expect(page.combinedHtml).toContain('Compilation failed');
    });

    it('safely escapes special characters and preserves URL encoding', async () => {
      vi.spyOn(engineClient, 'compileContext').mockResolvedValue({
        context: {
          metadata: {
            projectId: 'p/unsafe',
            targetTaskId: '<script>alert(1)</script>',
            totalDecisionsCount: 0,
            totalFactsCount: 0,
            truncatedDecisions: false,
            truncatedFacts: false,
            redactionCount: 0,
          },
          decisions: [],
          facts: [],
        },
        serialized: '<script>alert("xss")</script>',
      });
      vi.spyOn(engineClient, 'getProject').mockResolvedValue({
        ...sampleProject,
        id: 'p/unsafe',
      });

      const route = router.parseRoute(
        '#/projects/p%2Funsafe/context?targetTaskId=%3Cscript%3Ealert(1)%3C%2Fscript%3E'
      );

      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 20));

      const combined = page.combinedHtml;
      expect(combined).not.toContain('<script>alert(1)</script>');
      expect(combined).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(combined).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('passes requested tags from route query parameters to compileContext', async () => {
      const compileSpy = vi
        .spyOn(engineClient, 'compileContext')
        .mockResolvedValue(sampleCompiledContextResponse);
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);

      const route = router.parseRoute(
        '#/projects/orchestrate-step7/context?targetTaskId=task-b&upstreamTaskId=task-a&tags=auth,database'
      );

      renderPlaceholderPage(route);
      await new Promise((r) => setTimeout(r, 20));

      expect(compileSpy).toHaveBeenCalledWith(
        'orchestrate-step7',
        'task-b',
        'task-a',
        ['auth', 'database']
      );
    });

    it('copies structured json and serialized envelope to clipboard with truthful feedback', async () => {
      vi.spyOn(engineClient, 'compileContext').mockResolvedValue(sampleCompiledContextResponse);
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);

      const writeTextSpy = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', {
        clipboard: {
          writeText: writeTextSpy,
        },
      });

      const route = router.parseRoute(
        '#/projects/orchestrate-step7/context?targetTaskId=task-b'
      );

      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 20));

      const copyJsonBtn = page.querySelector('#copy-json-btn')!;
      expect(copyJsonBtn.disabled).toBe(false);

      // Trigger JSON copy
      await copyJsonBtn.eventListeners['click']?.[0]?.();
      expect(writeTextSpy).toHaveBeenCalledWith(
        JSON.stringify(sampleCompiledContextResponse.context, null, 2)
      );
      expect(copyJsonBtn.textContent).toBe('Copied ✓');

      // Trigger XML copy
      const copyXmlBtn = page.querySelector('#copy-xml-btn')!;
      await copyXmlBtn.eventListeners['click']?.[0]?.();
      expect(writeTextSpy).toHaveBeenCalledWith(sampleCompiledContextResponse.serialized);
      expect(copyXmlBtn.textContent).toBe('Copied ✓');
    });

    it('displays truthful "Failed to copy" and never "Copied ✓" when clipboard write fails', async () => {
      vi.spyOn(engineClient, 'compileContext').mockResolvedValue(sampleCompiledContextResponse);
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);

      const writeTextSpy = vi.fn().mockRejectedValue(new Error('Permission denied'));
      vi.stubGlobal('navigator', {
        clipboard: {
          writeText: writeTextSpy,
        },
      });

      const route = router.parseRoute(
        '#/projects/orchestrate-step7/context?targetTaskId=task-b'
      );

      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 20));

      const copyJsonBtn = page.querySelector('#copy-json-btn')!;
      await copyJsonBtn.eventListeners['click']?.[0]?.();

      expect(writeTextSpy).toHaveBeenCalled();
      expect(copyJsonBtn.textContent).toBe('Failed to copy');
      expect(copyJsonBtn.textContent).not.toBe('Copied ✓');
    });

    it('displays "Failed to copy" when navigator.clipboard is unavailable', async () => {
      vi.spyOn(engineClient, 'compileContext').mockResolvedValue(sampleCompiledContextResponse);
      vi.spyOn(engineClient, 'getProject').mockResolvedValue(sampleProject);

      vi.stubGlobal('navigator', {});

      const route = router.parseRoute(
        '#/projects/orchestrate-step7/context?targetTaskId=task-b'
      );

      const page = renderPlaceholderPage(route) as unknown as MockElement;
      await new Promise((r) => setTimeout(r, 20));

      const copyJsonBtn = page.querySelector('#copy-json-btn')!;
      await copyJsonBtn.eventListeners['click']?.[0]?.();

      expect(copyJsonBtn.textContent).toBe('Failed to copy');
    });
  });
});
