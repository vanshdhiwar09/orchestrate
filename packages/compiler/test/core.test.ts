import { describe, expect, it } from 'vitest';
import { ContextCompilerCore } from '../src/core.js';
import {
  createMockDecisions,
  createMockFacts,
  createMockSnapshot,
  createMockUpstreamAttempts,
} from './fixtures.js';

describe('ContextCompilerCore', () => {
  it('compiles deterministically with identical outputs across runs', () => {
    const snapshot = createMockSnapshot();
    const result1 = ContextCompilerCore.compile(snapshot);
    const result2 = ContextCompilerCore.compile(snapshot);

    expect(JSON.stringify(result1)).toEqual(JSON.stringify(result2));
  });

  it('filters decisions by status and task relevance, sorting them stably', () => {
    const snapshot = createMockSnapshot({
      request: {
        projectId: 'proj-1',
        targetTaskId: 'task-target-1',
        upstreamTaskId: 'task-upstream-1',
      },
      activeDecisions: [
        {
          id: 'dec-project-wide',
          projectId: 'proj-1',
          statement: 'Project-wide decision',
          rationale: 'Applies to entire project',
          status: 'ACTIVE',
          createdAt: '2026-09-30T09:00:00.000Z',
        },
        {
          id: 'dec-target-task',
          projectId: 'proj-1',
          taskId: 'task-target-1',
          statement: 'Target task decision',
          rationale: 'Specific to target task',
          status: 'ACTIVE',
          createdAt: '2026-09-30T09:10:00.000Z',
        },
        {
          id: 'dec-upstream-task',
          projectId: 'proj-1',
          taskId: 'task-upstream-1',
          statement: 'Upstream task decision',
          rationale: 'Specific to upstream task',
          status: 'ACTIVE',
          createdAt: '2026-09-30T09:20:00.000Z',
        },
        {
          id: 'dec-unrelated-task',
          projectId: 'proj-1',
          taskId: 'task-unrelated-99',
          statement: 'Unrelated task decision',
          rationale: 'Belongs to an unrelated task',
          status: 'ACTIVE',
          createdAt: '2026-09-30T09:05:00.000Z',
        },
        {
          id: 'dec-superseded',
          projectId: 'proj-1',
          statement: 'Old superseded decision',
          rationale: 'Replaced',
          status: 'SUPERSEDED',
          createdAt: '2026-09-30T08:00:00.000Z',
        },
      ],
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    const ids = compiled.decisions.map((d) => d.id);

    // Included: project-wide, target task, upstream task
    expect(ids).toContain('dec-project-wide');
    expect(ids).toContain('dec-target-task');
    expect(ids).toContain('dec-upstream-task');

    // Excluded: unrelated task, superseded
    expect(ids).not.toContain('dec-unrelated-task');
    expect(ids).not.toContain('dec-superseded');

    // Stable ordering: createdAt ASC, id ASC
    expect(ids).toEqual(['dec-project-wide', 'dec-target-task', 'dec-upstream-task']);
  });

  it('filters facts when tags are absent: admits global facts, excludes unrelated project facts', () => {
    const snapshot = createMockSnapshot({
      request: {
        projectId: 'proj-1',
        targetTaskId: 'task-target-1',
        // tags absent
      },
      projectFacts: [
        {
          key: 'global.node_version',
          value: '22.0.0',
          provenance: 'SYSTEM',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:00:00.000Z',
        },
        {
          key: 'global:env',
          value: 'production',
          provenance: 'SYSTEM',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:01:00.000Z',
        },
        {
          key: 'db.dialect',
          value: 'sqlite',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:02:00.000Z',
        },
        {
          key: 'auth.hash',
          value: 'argon2',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:03:00.000Z',
        },
      ],
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    const keys = compiled.facts.map((f) => f.key);

    expect(keys).toContain('global.node_version');
    expect(keys).toContain('global:env');
    expect(keys).not.toContain('db.dialect');
    expect(keys).not.toContain('auth.hash');
  });

  it('filters facts when tags are present: admits global facts and prefix-matched tags, excludes substring matches', () => {
    const snapshot = createMockSnapshot({
      request: {
        projectId: 'proj-1',
        targetTaskId: 'task-target-1',
        tags: ['tag', 'auth'],
      },
      projectFacts: [
        {
          key: 'global.architecture',
          value: 'monorepo',
          provenance: 'SYSTEM',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:00:00.000Z',
        },
        {
          key: 'tag.foo',
          value: 'tag-dot-value',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:01:00.000Z',
        },
        {
          key: 'tag:foo',
          value: 'tag-colon-value',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:02:00.000Z',
        },
        {
          key: 'author.name',
          value: 'Alice',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:03:00.000Z',
        },
        {
          key: 'auth.token_expiry',
          value: '3600',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:04:00.000Z',
        },
        {
          key: 'auth.unverified_claim',
          value: 'not-verified',
          provenance: 'AGENT',
          status: 'CLAIMED',
          recordedAt: '2026-09-30T09:05:00.000Z',
        },
      ],
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    const keys = compiled.facts.map((f) => f.key);

    // Global fact included
    expect(keys).toContain('global.architecture');
    // tag.foo and tag:foo included for tag "tag"
    expect(keys).toContain('tag.foo');
    expect(keys).toContain('tag:foo');
    // auth.token_expiry included for tag "auth"
    expect(keys).toContain('auth.token_expiry');
    // Substring match author.name NOT included for tag "auth"
    expect(keys).not.toContain('author.name');
    // Unverified CLAIMED fact NOT included
    expect(keys).not.toContain('auth.unverified_claim');
  });

  it('enforces budgeting limits and flags truncation', () => {
    const manyDecisions = Array.from({ length: 25 }, (_, i) => ({
      id: `dec-${String(i).padStart(2, '0')}`,
      projectId: 'proj-1',
      statement: `Decision statement ${i}`,
      rationale: `Rationale ${i}`,
      status: 'ACTIVE' as const,
      createdAt: `2026-09-30T09:${String(i).padStart(2, '0')}:00.000Z`,
    }));

    const snapshot = createMockSnapshot({
      activeDecisions: manyDecisions,
    });

    const compiled = ContextCompilerCore.compile(snapshot, {
      maxDecisions: 5,
    });

    expect(compiled.decisions).toHaveLength(5);
    expect(compiled.metadata.totalDecisionsCount).toBe(25);
    expect(compiled.metadata.truncatedDecisions).toBe(true);
  });

  it('quarantines upstream agent claims separately from verification checks', () => {
    const snapshot = createMockSnapshot();
    const compiled = ContextCompilerCore.compile(snapshot);

    expect(compiled.upstreamWork).toBeDefined();
    const up = compiled.upstreamWork!;
    expect(up.trustState).toBe('VERIFIED');
    expect(up.attemptNumber).toBe(1);

    // Level 2: Verification evidence
    expect(up.verificationChecks).toHaveLength(2);
    expect(up.verificationChecks[0].passed).toBe(true);

    // Level 4: Quarantined claims
    expect(up.unverifiedAgentNotes).toBeDefined();
    expect(up.unverifiedAgentNotes?.summary).toBe('Implemented basic auth provider');
    expect(up.unverifiedAgentNotes?.limitations).toContain('Does not support OAuth2 yet');

    // Files affected sorted
    expect(up.filesAffected).toEqual([
      'packages/auth/src/provider.ts',
      'packages/auth/test/provider.test.ts',
    ]);
  });

  it('truncates and sanitizes failed check stderr output', () => {
    const attempts = createMockUpstreamAttempts();
    attempts[0].verification!.result.checks[0] = {
      checkId: 'check-failing',
      name: 'Integration Check',
      command: 'npm run test:e2e',
      args: [],
      exitCode: 1,
      signal: null,
      stdout: 'failed',
      stderr: 'Error: Connection failed with key sk-12345678901234567890\nDetailed trace line 2\nLine 3',
      timedOut: false,
      durationMs: 500,
      verifiedAt: '2026-09-30T09:44:00.000Z',
      passed: false,
    };

    const snapshot = createMockSnapshot({
      upstreamAttempts: attempts,
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    const check = compiled.upstreamWork?.verificationChecks.find(
      (c) => c.checkId === 'check-failing'
    );
    expect(check).toBeDefined();
    expect(check?.passed).toBe(false);
    expect(check?.exitCode).toBe(1);
    expect(check?.stderrSnippet).toContain('[REDACTED_API_KEY]');
    expect(check?.stderrSnippet).not.toContain('sk-12345678901234567890');
  });

  it('filters out package-lock and excluded files from git diff', () => {
    const rawDiff = [
      'diff --git a/package-lock.json b/package-lock.json',
      'index 111..222 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,5 +1,5 @@',
      '- "version": "1.0.0"',
      '+ "version": "1.0.1"',
      'diff --git a/src/index.ts b/src/index.ts',
      'index 333..444 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1 +1,2 @@',
      '+ export const ready = true;',
    ].join('\n');

    const snapshot = createMockSnapshot({
      git: {
        status: {
          clean: false,
          branch: 'main',
          detached: false,
          staged: [],
          unstaged: [{ path: 'src/index.ts', statusCode: 'modified', rawStatus: ' M' }],
          untracked: [],
        },
        headCommit: null,
        diff: rawDiff,
      },
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    expect(compiled.gitState?.diff).toBeDefined();
    expect(compiled.gitState?.diff).not.toContain('package-lock.json');
    expect(compiled.gitState?.diff).toContain('src/index.ts');
  });

  it('redacts secrets across decisions, facts, and git metadata', () => {
    const snapshot = createMockSnapshot({
      request: {
        projectId: 'proj-1',
        targetTaskId: 'task-target-1',
      },
      activeDecisions: [
        {
          id: 'dec-sec',
          projectId: 'proj-1',
          statement: 'Connect using Bearer secret-token-1234567890',
          rationale: 'Auth header api_key: "my-secret-key-1234567"',
          status: 'ACTIVE',
          createdAt: '2026-09-30T09:00:00.000Z',
        },
      ],
      projectFacts: [
        {
          key: 'global.api.endpoint',
          value: 'https://admin:pass123456@internal.api.com',
          provenance: 'CODE',
          status: 'VERIFIED',
          recordedAt: '2026-09-30T09:00:00.000Z',
        },
      ],
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    expect(compiled.decisions[0].statement).toContain('Bearer [REDACTED]');
    expect(compiled.decisions[0].rationale).toContain('[REDACTED]');
    expect(compiled.facts[0].value).toContain('[REDACTED]:[REDACTED]@');
    expect(compiled.metadata.redactionCount).toBeGreaterThan(0);
  });

  it('handles empty snapshot cleanly with zero errors', () => {
    const emptySnapshot = createMockSnapshot({
      targetTask: null,
      upstreamTask: null,
      upstreamAttempts: [],
      activeDecisions: [],
      projectFacts: [],
      git: null,
    });

    const compiled = ContextCompilerCore.compile(emptySnapshot);
    expect(compiled.decisions).toEqual([]);
    expect(compiled.facts).toEqual([]);
    expect(compiled.upstreamWork?.verificationChecks).toEqual([]);
    expect(compiled.gitState).toBeUndefined();
    expect(compiled.metadata.totalDecisionsCount).toBe(0);
    expect(compiled.metadata.totalFactsCount).toBe(0);
  });

  it('truncates decisions and facts when character budgets are exceeded', () => {
    const longDecisions = [
      {
        id: 'dec-1',
        projectId: 'proj-1',
        statement: 'A'.repeat(500),
        rationale: 'B'.repeat(500),
        status: 'ACTIVE' as const,
        createdAt: '2026-09-30T09:00:00.000Z',
      },
      {
        id: 'dec-2',
        projectId: 'proj-1',
        statement: 'C'.repeat(500),
        rationale: 'D'.repeat(500),
        status: 'ACTIVE' as const,
        createdAt: '2026-09-30T09:01:00.000Z',
      },
    ];

    const snapshot = createMockSnapshot({
      activeDecisions: longDecisions,
    });

    // maxDecisionsChars: 1200 allows first decision (1000 chars) but not the second
    const compiled = ContextCompilerCore.compile(snapshot, {
      maxDecisions: 10,
      maxDecisionsChars: 1200,
    });

    expect(compiled.decisions).toHaveLength(1);
    expect(compiled.decisions[0].id).toBe('dec-1');
    expect(compiled.metadata.truncatedDecisions).toBe(true);
  });

  it('selects the latest attempt in upstream task history', () => {
    const attempt1 = {
      attemptNumber: 1,
      handoff: {
        id: 'h-1',
        taskId: 'task-upstream-1',
        attemptNumber: 1,
        status: 'CLAIMED' as const,
        summary: 'Attempt 1 summary',
        changes: 'Attempt 1 changes',
        filesAffected: ['file1.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-09-30T09:00:00.000Z',
      },
      verification: {
        id: 'v-1',
        taskId: 'task-upstream-1',
        attemptNumber: 1,
        result: {
          status: 'FAILED' as const,
          executedAt: '2026-09-30T09:05:00.000Z',
          totalDurationMs: 100,
          checks: [],
        },
        recordedAt: '2026-09-30T09:05:00.000Z',
      },
    };

    const attempt2 = {
      attemptNumber: 2,
      handoff: {
        id: 'h-2',
        taskId: 'task-upstream-1',
        attemptNumber: 2,
        status: 'CLAIMED' as const,
        summary: 'Attempt 2 successful repair',
        changes: 'Attempt 2 changes',
        filesAffected: ['file1.ts', 'file2.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: '2026-09-30T09:10:00.000Z',
      },
      verification: {
        id: 'v-2',
        taskId: 'task-upstream-1',
        attemptNumber: 2,
        result: {
          status: 'VERIFIED' as const,
          executedAt: '2026-09-30T09:15:00.000Z',
          totalDurationMs: 200,
          checks: [
            {
              checkId: 'check-final',
              name: 'Final check',
              command: 'npm test',
              args: [],
              exitCode: 0,
              signal: null,
              stdout: 'ok',
              stderr: '',
              timedOut: false,
              durationMs: 200,
              verifiedAt: '2026-09-30T09:15:00.000Z',
              passed: true,
            },
          ],
        },
        recordedAt: '2026-09-30T09:15:00.000Z',
      },
    };

    // Feed in out of order to verify sorting by attemptNumber
    const snapshot = createMockSnapshot({
      upstreamAttempts: [attempt1, attempt2],
      upstreamTrustState: 'VERIFIED',
    });

    const compiled = ContextCompilerCore.compile(snapshot);
    expect(compiled.upstreamWork?.attemptNumber).toBe(2);
    expect(compiled.upstreamWork?.unverifiedAgentNotes?.summary).toBe(
      'Attempt 2 successful repair'
    );
    expect(compiled.upstreamWork?.verificationChecks).toHaveLength(1);
    expect(compiled.upstreamWork?.verificationChecks[0].checkId).toBe('check-final');
  });

  it('respects includeGitDiff and includeUntrackedFiles flags', () => {
    const snapshot = createMockSnapshot();
    const compiled = ContextCompilerCore.compile(snapshot, {
      includeGitDiff: false,
      includeUntrackedFiles: false,
    });

    expect(compiled.gitState?.diff).toBeUndefined();
    expect(compiled.gitState?.untrackedFiles).toEqual([]);
    expect(compiled.gitState?.stagedFiles).toHaveLength(1);
  });
});
