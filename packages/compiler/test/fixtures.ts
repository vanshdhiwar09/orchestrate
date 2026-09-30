import type {
  Decision,
  Handoff,
  ProjectFact,
  Task,
  TaskAttempt,
  VerificationRecord,
} from '@orchestrate/brain';
import type { GitRepository, GitStatus } from '@orchestrate/workspace';
import type { CompilationSnapshot } from '../src/types.js';

export function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-target-1',
    projectId: 'proj-1',
    title: 'Implement downstream feature',
    description: 'Build on upstream component',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

export function createMockDecisions(): Decision[] {
  return [
    {
      id: 'dec-1',
      projectId: 'proj-1',
      statement: 'Use SQLite for persistence',
      rationale: 'Simple and embedded, suitable for single-node MVP',
      status: 'ACTIVE',
      createdAt: '2026-09-30T09:00:00.000Z',
    },
    {
      id: 'dec-2',
      projectId: 'proj-1',
      statement: 'Use PostgreSQL',
      rationale: 'Initial idea before SQLite',
      status: 'SUPERSEDED',
      createdAt: '2026-09-30T08:00:00.000Z',
    },
    {
      id: 'dec-3',
      projectId: 'proj-1',
      statement: 'Use strict TypeScript with nodenext',
      rationale: 'Standard across all packages in monorepo',
      status: 'ACTIVE',
      createdAt: '2026-09-30T09:30:00.000Z',
    },
  ];
}

export function createMockFacts(): ProjectFact[] {
  return [
    {
      key: 'auth.hash_algorithm',
      value: 'argon2id',
      provenance: 'CODE',
      status: 'VERIFIED',
      recordedAt: '2026-09-30T09:00:00.000Z',
    },
    {
      key: 'db.engine',
      value: 'sqlite3-wal',
      provenance: 'VERIFICATION',
      status: 'VERIFIED',
      recordedAt: '2026-09-30T09:10:00.000Z',
    },
    {
      key: 'cache.ttl',
      value: '300s',
      provenance: 'AGENT',
      status: 'CLAIMED',
      recordedAt: '2026-09-30T09:15:00.000Z',
    },
    {
      key: 'global.node_version',
      value: '22.0.0',
      provenance: 'SYSTEM',
      status: 'VERIFIED',
      recordedAt: '2026-09-30T09:05:00.000Z',
    },
  ];
}

export function createMockUpstreamAttempts(): TaskAttempt[] {
  const handoff: Handoff = {
    id: 'h-1',
    taskId: 'task-upstream-1',
    attemptNumber: 1,
    status: 'CLAIMED',
    summary: 'Implemented basic auth provider',
    changes: 'Added packages/auth/src/provider.ts and tests',
    filesAffected: ['packages/auth/src/provider.ts', 'packages/auth/test/provider.test.ts'],
    decisionsCreated: ['dec-1'],
    assumptions: ['Database migrations are applied beforehand'],
    limitations: ['Does not support OAuth2 yet'],
    recommendedFollowUp: ['Add refresh tokens'],
    createdAt: '2026-09-30T09:40:00.000Z',
  };

  const verification: VerificationRecord = {
    id: 'v-1',
    taskId: 'task-upstream-1',
    attemptNumber: 1,
    result: {
      status: 'VERIFIED',
      executedAt: '2026-09-30T09:45:00.000Z',
      totalDurationMs: 1250,
      checks: [
        {
          checkId: 'check-typecheck',
          name: 'Typecheck',
          command: 'npm run typecheck',
          args: [],
          exitCode: 0,
          signal: null,
          stdout: 'Success',
          stderr: '',
          timedOut: false,
          durationMs: 400,
          verifiedAt: '2026-09-30T09:44:00.000Z',
          passed: true,
        },
        {
          checkId: 'check-test',
          name: 'Unit Tests',
          command: 'npm test',
          args: [],
          exitCode: 0,
          signal: null,
          stdout: '2 tests passed',
          stderr: '',
          timedOut: false,
          durationMs: 850,
          verifiedAt: '2026-09-30T09:45:00.000Z',
          passed: true,
        },
      ],
    },
    recordedAt: '2026-09-30T09:45:00.000Z',
  };

  return [
    {
      attemptNumber: 1,
      handoff,
      verification,
      verificationRecord: verification,
    },
  ];
}

export function createMockSnapshot(overrides: Partial<CompilationSnapshot> = {}): CompilationSnapshot {
  return {
    request: {
      projectId: 'proj-1',
      targetTaskId: 'task-target-1',
      upstreamTaskId: 'task-upstream-1',
      tags: ['auth'],
    },
    targetTask: createMockTask(),
    upstreamTask: createMockTask({
      id: 'task-upstream-1',
      title: 'Implement auth provider',
      description: 'Upstream authentication foundation',
    }),
    upstreamTrustState: 'VERIFIED',
    upstreamAttempts: createMockUpstreamAttempts(),
    activeDecisions: createMockDecisions(),
    projectFacts: createMockFacts(),
    git: {
      status: {
        clean: false,
        branch: 'main',
        detached: false,
        staged: [{ path: 'packages/auth/src/provider.ts', statusCode: 'added', rawStatus: 'A ' }],
        unstaged: [],
        untracked: ['scratch/notes.txt'],
      },
      headCommit: {
        hash: '544998f000000000000000000000000000000000',
        subject: 'feat: add git repository state',
        author: 'Orchestrator <dev@orchestrator.ai>',
        timestamp: '2026-09-30T09:00:00.000Z',
      },
      diff: 'diff --git a/packages/auth/src/provider.ts b/packages/auth/src/provider.ts\n+export const auth = true;\n',
    },
    ...overrides,
  };
}

export class MockGitRepository implements GitRepository {
  public isRepo = true;
  public status: GitStatus = {
    clean: true,
    branch: 'main',
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
  };
  public head = {
    hash: '1111111111111111111111111111111111111111',
    subject: 'initial commit',
    author: 'Dev <dev@test.org>',
    timestamp: '2026-09-30T08:00:00.000Z',
  };
  public diff = '';

  async isRepository(): Promise<boolean> {
    return this.isRepo;
  }
  async getStatus(): Promise<GitStatus> {
    return this.status;
  }
  async getCurrentBranch(): Promise<string | null> {
    return this.status.branch;
  }
  async getHeadCommit() {
    return this.head;
  }
  async getRecentCommits() {
    return [this.head];
  }
  async getDiff(): Promise<string> {
    return this.diff;
  }
}
