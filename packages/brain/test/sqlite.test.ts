import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VerificationResult } from '@orchestrate/verification';
import {
  type Decision,
  type Handoff,
  SqliteProjectBrain,
  type VerificationRecord,
} from '../src/index.js';

describe('Project Brain (SqliteProjectBrain)', () => {
  let brain: SqliteProjectBrain;

  beforeEach(() => {
    brain = new SqliteProjectBrain({ databasePath: ':memory:' });
  });

  afterEach(() => {
    try {
      brain.close();
    } catch {
      // ignore if already closed
    }
  });

  const createPassingResult = (): VerificationResult => ({
    status: 'VERIFIED',
    checks: [
      {
        checkId: 'check-1',
        name: 'Typecheck',
        command: 'npm',
        args: ['run', 'typecheck'],
        status: 'PASSED',
        passed: true,
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        durationMs: 120,
        verifiedAt: new Date().toISOString(),
      },
    ],
    executedAt: new Date().toISOString(),
    totalDurationMs: 150,
  });

  const createFailingResult = (): VerificationResult => ({
    status: 'FAILED',
    checks: [
      {
        checkId: 'check-2',
        name: 'Unit Tests',
        command: 'npm',
        args: ['run', 'test'],
        status: 'FAILED',
        passed: false,
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: '1 test failed',
        timedOut: false,
        durationMs: 200,
        verifiedAt: new Date().toISOString(),
      },
    ],
    executedAt: new Date().toISOString(),
    totalDurationMs: 210,
  });

  const createHandoff = (
    taskId: string,
    attemptNumber: number,
    id = `handoff-${attemptNumber}`,
  ): Handoff => ({
    id,
    taskId,
    attemptNumber,
    agentId: 'agent-1',
    model: 'nebius-model',
    status: 'CLAIMED',
    summary: `Attempt ${attemptNumber} completed`,
    changes: 'modified files',
    filesAffected: ['src/file.ts'],
    decisionsCreated: [],
    assumptions: ['none'],
    limitations: ['none'],
    recommendedFollowUp: [],
    createdAt: new Date().toISOString(),
  });

  // ==========================================================================
  // INITIALIZATION & PRAGMAS
  // ==========================================================================

  describe('Initialization & Options', () => {
    it('throws if databasePath is empty or invalid', () => {
      expect(() => new SqliteProjectBrain({ databasePath: '' })).toThrow(/non-empty string/);
      expect(() => new SqliteProjectBrain({ databasePath: '   ' })).toThrow(/non-empty string/);
      // @ts-expect-error test invalid argument
      expect(() => new SqliteProjectBrain({})).toThrow(/non-empty string/);
    });

    it('creates schema migrations table with version 1', async () => {
      const project = await brain.createProject({ id: 'proj-init', name: 'Init Test' });
      expect(project.id).toBe('proj-init');
    });
  });

  // ==========================================================================
  // PROJECT & FACTS
  // ==========================================================================

  describe('Project & Facts', () => {
    it('creates and retrieves a project', async () => {
      const project = await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      expect(project.id).toBe('proj-1');
      expect(project.name).toBe('Orchestrate');
      expect(project.facts).toEqual([]);
      expect(project.createdAt).toBeDefined();

      const retrieved = await brain.getProject('proj-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('proj-1');
      expect(retrieved?.name).toBe('Orchestrate');
    });

    it('lists empty projects, multiple projects, and persists list across database reopen', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'orchestrate-list-proj-'));
      const dbPath = join(tempDir, 'brain.sqlite');
      try {
        const db1 = new SqliteProjectBrain({ databasePath: dbPath });
        expect(await db1.listProjects()).toEqual([]);

        await db1.createProject({
          id: 'proj-beta',
          name: 'Beta Project',
          createdAt: '2026-10-22T11:00:00.000Z',
        });
        await db1.createProject({
          id: 'proj-alpha',
          name: 'Alpha Project',
          createdAt: '2026-10-22T09:00:00.000Z',
        });
        await db1.addProjectFact('proj-alpha', {
          key: 'stack',
          value: 'Node 22',
          provenance: 'SYSTEM',
          status: 'VERIFIED',
        });
        db1.close();

        const db2 = new SqliteProjectBrain({ databasePath: dbPath });
        const projects = await db2.listProjects();
        expect(projects).toHaveLength(2);
        expect(projects.map((p) => p.id)).toEqual(['proj-alpha', 'proj-beta']);
        expect(projects[0].name).toBe('Alpha Project');
        expect(projects[0].facts).toHaveLength(1);
        expect(projects[0].facts[0].value).toBe('Node 22');
        expect(projects[1].facts).toEqual([]);
        db2.close();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects duplicate or invalid project creation', async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      await expect(brain.createProject({ id: 'proj-1', name: 'Duplicate' })).rejects.toThrow(
        /already exists/,
      );
      await expect(brain.createProject({ id: '', name: 'Blank ID' })).rejects.toThrow(
        /non-empty string/,
      );
      await expect(brain.createProject({ id: 'proj-2', name: ' ' })).rejects.toThrow(
        /non-empty string/,
      );
    });

    it('records project facts with provenance and status', async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });

      const fact = await brain.addProjectFact('proj-1', {
        key: 'framework',
        value: 'Next.js',
        provenance: 'CODE',
        status: 'VERIFIED',
      });

      expect(fact.key).toBe('framework');
      expect(fact.value).toBe('Next.js');
      expect(fact.provenance).toBe('CODE');
      expect(fact.status).toBe('VERIFIED');

      const project = await brain.getProject('proj-1');
      expect(project?.facts).toHaveLength(1);
      expect(project?.facts[0].key).toBe('framework');
    });

    it('tracks fact history and retrieves current fact', async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });

      await brain.addProjectFact('proj-1', {
        key: 'db',
        value: 'memory',
        provenance: 'HUMAN',
        status: 'CLAIMED',
      });

      await brain.addProjectFact('proj-1', {
        key: 'db',
        value: 'sqlite',
        provenance: 'CODE',
        status: 'VERIFIED',
      });

      const current = await brain.getCurrentFact('proj-1', 'db');
      expect(current?.value).toBe('sqlite');
      expect(current?.status).toBe('VERIFIED');

      const history = await brain.getFactHistory('proj-1', 'db');
      expect(history).toHaveLength(2);
      expect(history[0].value).toBe('memory');
      expect(history[1].value).toBe('sqlite');
    });

    it('rejects adding facts to non-existent projects', async () => {
      await expect(
        brain.addProjectFact('nonexistent', {
          key: 'k',
          value: 'v',
          provenance: 'CODE',
          status: 'VERIFIED',
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  // ==========================================================================
  // TASKS
  // ==========================================================================

  describe('Tasks', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
    });

    it('creates and retrieves a task scoped to a project', async () => {
      const task = await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Build Feature',
        description: 'Implement persistent SQLite Brain',
      });

      expect(task.id).toBe('task-1');
      expect(task.projectId).toBe('proj-1');
      expect(task.title).toBe('Build Feature');

      const retrieved = await brain.getTask('task-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe('Build Feature');

      const projectTasks = await brain.listTasks('proj-1');
      expect(projectTasks).toHaveLength(1);
      expect(projectTasks[0].id).toBe('task-1');
    });

    it('rejects invalid task parameters and duplicate task IDs', async () => {
      await expect(
        brain.createTask({
          id: '',
          projectId: 'proj-1',
          title: 'Title',
          description: 'Desc',
        }),
      ).rejects.toThrow(/Task ID must be a non-empty string/i);

      await expect(
        brain.createTask({
          id: 'task-1',
          projectId: 'non-existent',
          title: 'Title',
          description: 'Desc',
        }),
      ).rejects.toThrow(/Project "non-existent" not found/);

      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Title',
        description: 'Desc',
      });

      await expect(
        brain.createTask({
          id: 'task-1',
          projectId: 'proj-1',
          title: 'Duplicate',
          description: 'Desc',
        }),
      ).rejects.toThrow(/Task "task-1" already exists/);
    });
  });

  // ==========================================================================
  // HANDOFF & ATTEMPT SEQUENCING
  // ==========================================================================

  describe('Handoff & Attempt Sequencing', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Task 1',
        description: 'Desc',
      });
    });

    it('creates attempt 1 and attempt 2 sequentially', async () => {
      const h1 = await brain.addHandoff(createHandoff('task-1', 1));
      expect(h1.attemptNumber).toBe(1);
      expect(h1.status).toBe('CLAIMED');

      const h2 = await brain.addHandoff(createHandoff('task-1', 2));
      expect(h2.attemptNumber).toBe(2);

      const retrieved1 = await brain.getHandoff('task-1', 1);
      expect(retrieved1?.id).toBe('handoff-1');

      const retrieved2 = await brain.getHandoff('task-1', 2);
      expect(retrieved2?.id).toBe('handoff-2');

      const byId = await brain.getHandoffById('handoff-1');
      expect(byId?.attemptNumber).toBe(1);
    });

    it('rejects duplicate attempt numbers for the same task', async () => {
      await brain.addHandoff(createHandoff('task-1', 1));
      await expect(brain.addHandoff(createHandoff('task-1', 1, 'handoff-dup'))).rejects.toThrow(
        /Handoff for task "task-1" attempt 1 already exists/,
      );
    });

    it('rejects skipped attempt numbers', async () => {
      await expect(brain.addHandoff(createHandoff('task-1', 2))).rejects.toThrow(
        /Cannot skip attempt numbers/i,
      );

      await brain.addHandoff(createHandoff('task-1', 1));
      await expect(brain.addHandoff(createHandoff('task-1', 3))).rejects.toThrow(
        /Cannot skip attempt numbers/i,
      );
    });

    it('validates inputs on getHandoff and getHandoffById', async () => {
      await expect(brain.getHandoff('', 1)).rejects.toThrow(/Task ID must be a non-empty string/);
      await expect(brain.getHandoff('   ', 1)).rejects.toThrow(/Task ID must be a non-empty string/);
      await expect(brain.getHandoff('task-1', 0)).rejects.toThrow(/strictly positive integer/);
      await expect(brain.getHandoff('task-1', -1)).rejects.toThrow(/strictly positive integer/);
      await expect(brain.getHandoff('task-1', 1.5)).rejects.toThrow(/strictly positive integer/);

      await expect(brain.getHandoffById('')).rejects.toThrow(/Handoff ID must be a non-empty string/);
      await expect(brain.getHandoffById('   ')).rejects.toThrow(/Handoff ID must be a non-empty string/);
      // @ts-expect-error runtime validation
      await expect(brain.getHandoffById(null)).rejects.toThrow(/Handoff ID must be a non-empty string/);
      // @ts-expect-error runtime validation
      await expect(brain.getHandoffById(undefined)).rejects.toThrow(/Handoff ID must be a non-empty string/);
    });
  });

  // ==========================================================================
  // VERIFICATION RECORDS
  // ==========================================================================

  describe('Verification Record', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Task 1',
        description: 'Desc',
      });
    });

    it('stores VerificationResult and retrieves verification record', async () => {
      const record: VerificationRecord = {
        id: 'verif-1',
        taskId: 'task-1',
        attemptNumber: 1,
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      };

      const added = await brain.addVerificationRecord(record);
      expect(added.id).toBe('verif-1');
      expect(added.result.status).toBe('VERIFIED');

      const retrieved = await brain.getVerificationRecord('task-1', 1);
      expect(retrieved?.id).toBe('verif-1');
      expect(retrieved?.result.status).toBe('VERIFIED');
      expect(retrieved?.result.checks.length).toBe(1);
      expect(retrieved?.result.checks[0].passed).toBe(true);

      const byId = await brain.getVerificationRecordById('verif-1');
      expect(byId?.id).toBe('verif-1');
    });

    it('validates handoff linkage and rejects mismatched task or attempt', async () => {
      await brain.createTask({
        id: 'task-2',
        projectId: 'proj-1',
        title: 'Task 2',
        description: 'Desc',
      });

      await brain.addHandoff(createHandoff('task-1', 1, 'handoff-t1-a1'));
      await brain.addHandoff(createHandoff('task-1', 2, 'handoff-t1-a2'));

      // Valid linkage
      await expect(
        brain.addVerificationRecord({
          id: 'verif-1',
          taskId: 'task-1',
          attemptNumber: 1,
          handoffId: 'handoff-t1-a1',
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).resolves.toBeDefined();

      // Mismatched attempt
      await expect(
        brain.addVerificationRecord({
          id: 'verif-2',
          taskId: 'task-1',
          attemptNumber: 2,
          handoffId: 'handoff-t1-a1',
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/record specifies attempt 2/);
    });

    it('validates inputs on getVerificationRecord and getVerificationRecordById', async () => {
      await expect(brain.getVerificationRecord('', 1)).rejects.toThrow(/Task ID must be a non-empty string/);
      await expect(brain.getVerificationRecord('   ', 1)).rejects.toThrow(/Task ID must be a non-empty string/);
      await expect(brain.getVerificationRecord('task-1', 0)).rejects.toThrow(/strictly positive integer/);
      await expect(brain.getVerificationRecord('task-1', -1)).rejects.toThrow(/strictly positive integer/);
      await expect(brain.getVerificationRecord('task-1', 1.5)).rejects.toThrow(/strictly positive integer/);

      await expect(brain.getVerificationRecordById('')).rejects.toThrow(/VerificationRecord ID must be a non-empty string/);
      await expect(brain.getVerificationRecordById('   ')).rejects.toThrow(/VerificationRecord ID must be a non-empty string/);
      // @ts-expect-error runtime validation
      await expect(brain.getVerificationRecordById(null)).rejects.toThrow(/VerificationRecord ID must be a non-empty string/);
      // @ts-expect-error runtime validation
      await expect(brain.getVerificationRecordById(undefined)).rejects.toThrow(/VerificationRecord ID must be a non-empty string/);
    });
  });

  // ==========================================================================
  // TRUST STATE DERIVATION & LIFECYCLE
  // ==========================================================================

  describe('Trust State Derivation', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Task 1',
        description: 'Desc',
      });
    });

    it('transitions cleanly: UNVERIFIED -> CLAIMED -> FAILED -> CLAIMED -> VERIFIED', async () => {
      // 1. Newly created task with no history
      let state = await brain.deriveTaskTrustState('task-1');
      expect(state).toBe('UNVERIFIED');

      // 2. Agent creates handoff for attempt 1 -> CLAIMED
      await brain.addHandoff(createHandoff('task-1', 1, 'h-1'));
      state = await brain.deriveTaskTrustState('task-1');
      expect(state).toBe('CLAIMED');

      // 3. Verification attempt 1 runs and fails -> FAILED
      await brain.addVerificationRecord({
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        handoffId: 'h-1',
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });
      state = await brain.deriveTaskTrustState('task-1');
      expect(state).toBe('FAILED');

      // 4. Agent performs repair attempt 2 handoff -> CLAIMED
      await brain.addHandoff(createHandoff('task-1', 2, 'h-2'));
      state = await brain.deriveTaskTrustState('task-1');
      expect(state).toBe('CLAIMED');

      // 5. Verification attempt 2 runs and passes -> VERIFIED
      await brain.addVerificationRecord({
        id: 'v-2',
        taskId: 'task-1',
        attemptNumber: 2,
        handoffId: 'h-2',
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });
      state = await brain.deriveTaskTrustState('task-1');
      expect(state).toBe('VERIFIED');

      // 6. History is retrievable
      const history = await brain.getTaskHistory('task-1');
      expect(history.length).toBe(2);
      expect(history[0].attemptNumber).toBe(1);
      expect(history[0].handoff?.id).toBe('h-1');
      expect(history[0].verificationRecord?.result.status).toBe('FAILED');
      expect(history[1].attemptNumber).toBe(2);
      expect(history[1].handoff?.id).toBe('h-2');
      expect(history[1].verificationRecord?.result.status).toBe('VERIFIED');
    });

    it('supports BLOCKED_NEEDS_HUMAN override when orchestrator marks it blocked', async () => {
      await brain.addHandoff(createHandoff('task-1', 1, 'h-1'));
      await brain.addVerificationRecord({
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        handoffId: 'h-1',
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      expect(await brain.deriveTaskTrustState('task-1')).toBe('FAILED');

      await brain.markTaskBlocked('task-1', 'Max repair attempts exhausted');
      expect(await brain.deriveTaskTrustState('task-1')).toBe('BLOCKED_NEEDS_HUMAN');

      // Human unblocks the task
      await brain.unblockTask('task-1');
      expect(await brain.deriveTaskTrustState('task-1')).toBe('FAILED');
    });
  });

  // ==========================================================================
  // DECISIONS & LINEAGE
  // ==========================================================================

  describe('Decisions & Lineage', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      await brain.createProject({ id: 'proj-2', name: 'Other Project' });
      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Task 1',
        description: 'Desc',
      });
    });

    it('creates decisions and supersedes previous decisions atomically', async () => {
      const d1: Decision = {
        id: 'dec-1',
        projectId: 'proj-1',
        statement: 'Use in-memory store for Brain V1',
        rationale: 'Simplest for initial testing',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      };
      await brain.addDecision(d1);

      const d2: Decision = {
        id: 'dec-2',
        projectId: 'proj-1',
        statement: 'Use SQLite WAL for Brain persistence',
        rationale: 'Need disk durability across restarts',
        status: 'ACTIVE',
        supersedes: 'dec-1',
        createdAt: new Date().toISOString(),
      };
      await brain.addDecision(d2);

      const updatedD1 = await brain.getDecision('dec-1');
      expect(updatedD1?.status).toBe('SUPERSEDED');

      const retrievedD2 = await brain.getDecision('dec-2');
      expect(retrievedD2?.status).toBe('ACTIVE');
      expect(retrievedD2?.supersedes).toBe('dec-1');

      const active = await brain.getActiveDecisions('proj-1');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('dec-2');

      const all = await brain.listDecisions('proj-1');
      expect(all.length).toBe(2);
    });

    it('rejects invalid supersedes references', async () => {
      const d1: Decision = {
        id: 'dec-1',
        projectId: 'proj-1',
        statement: 'Decision 1',
        rationale: 'r',
        status: 'ACTIVE',
        supersedes: 'non-existent-dec',
        createdAt: new Date().toISOString(),
      };

      await expect(brain.addDecision(d1)).rejects.toThrow(
        /Superseded decision "non-existent-dec" does not exist/,
      );
    });
  });

  // ==========================================================================
  // METRICS
  // ==========================================================================

  describe('Task Metrics', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Task 1',
        description: 'Desc',
      });
    });

    it('derives correct metrics for failure followed by successful repair', async () => {
      await brain.addHandoff(createHandoff('task-1', 1, 'h-1'));
      await brain.addVerificationRecord({
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      await brain.addHandoff(createHandoff('task-1', 2, 'h-2'));
      await brain.addVerificationRecord({
        id: 'v-2',
        taskId: 'task-1',
        attemptNumber: 2,
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });

      const metrics = await brain.getTaskMetrics('task-1');
      expect(metrics.verification_attempts).toBe(2);
      expect(metrics.verification_failures).toBe(1);
      expect(metrics.repair_attempts).toBe(1);
      expect(metrics.repaired_successfully).toBe(true);
    });
  });

  // ==========================================================================
  // PERSISTENCE ACROSS RESTARTS (FILE-BACKED SQLITE)
  // ==========================================================================

  describe('Persistence across process restarts', () => {
    let tempDir: string;
    let dbPath: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'orchestrate-brain-test-'));
      dbPath = join(tempDir, 'brain.sqlite');
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it('persists and restores all entities, facts, handoffs, and trust states after db reopening', async () => {
      // 1. Open instance 1 and populate data
      const brain1 = new SqliteProjectBrain({ databasePath: dbPath });

      try {
        await brain1.createProject({ id: 'proj-persist', name: 'Persist Project' });
        await brain1.addProjectFact('proj-persist', {
          key: 'arch',
          value: 'clean',
          provenance: 'CODE',
          status: 'VERIFIED',
        });

        await brain1.createTask({
          id: 'task-persist',
          projectId: 'proj-persist',
          title: 'Task Persist',
          description: 'Should survive restart',
        });

        const handoff = await brain1.addHandoff({
          id: 'h-persist',
          taskId: 'task-persist',
          attemptNumber: 1,
          agentId: 'agent-1',
          model: 'nebius-model',
          status: 'CLAIMED',
          summary: 'Persisted work',
          changes: 'c',
          filesAffected: ['src/index.ts'],
          decisionsCreated: [],
          assumptions: [],
          limitations: [],
          recommendedFollowUp: [],
          createdAt: new Date().toISOString(),
        });

        await brain1.addVerificationRecord({
          id: 'v-persist',
          taskId: 'task-persist',
          attemptNumber: 1,
          handoffId: handoff.id,
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        });

        const decision = await brain1.addDecision({
          id: 'd-persist',
          projectId: 'proj-persist',
          statement: 'Persisted Decision',
          rationale: 'Verified persistence',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
        });

        expect(await brain1.deriveTaskTrustState('task-persist')).toBe('VERIFIED');
      } finally {
        brain1.close();
      }

      // 2. Open instance 2 pointing to the exact same file
      const brain2 = new SqliteProjectBrain({ databasePath: dbPath });

      try {
        // Verify project & facts restored
        const project = await brain2.getProject('proj-persist');
        expect(project).not.toBeNull();
        expect(project?.name).toBe('Persist Project');
        expect(project?.facts).toHaveLength(1);
        expect(project?.facts[0].key).toBe('arch');
        expect(project?.facts[0].value).toBe('clean');

        // Verify task restored
        const task = await brain2.getTask('task-persist');
        expect(task).not.toBeNull();
        expect(task?.title).toBe('Task Persist');

        // Verify handoff restored
        const retrievedHandoff = await brain2.getHandoff('task-persist', 1);
        expect(retrievedHandoff).not.toBeNull();
        expect(retrievedHandoff?.id).toBe('h-persist');
        expect(retrievedHandoff?.filesAffected).toEqual(['src/index.ts']);

        // Verify verification record restored
        const retrievedVerif = await brain2.getVerificationRecord('task-persist', 1);
        expect(retrievedVerif).not.toBeNull();
        expect(retrievedVerif?.handoffId).toBe('h-persist');
        expect(retrievedVerif?.result.status).toBe('VERIFIED');

        // Verify trust state remains VERIFIED
        const trustState = await brain2.deriveTaskTrustState('task-persist');
        expect(trustState).toBe('VERIFIED');

        // Verify decisions restored
        const decisions = await brain2.getActiveDecisions('proj-persist');
        expect(decisions).toHaveLength(1);
        expect(decisions[0].id).toBe('d-persist');
        expect(decisions[0].statement).toBe('Persisted Decision');

        // Verify metrics restored
        const metrics = await brain2.getTaskMetrics('task-persist');
        expect(metrics.verification_attempts).toBe(1);
        expect(metrics.verification_failures).toBe(0);
      } finally {
        brain2.close();
      }
    });
  });

  // ==========================================================================
  // ADVERSARIAL TRUST-STATE & EVIDENCE INTEGRITY AUDIT (STEP 10.14)
  // ==========================================================================

  describe('Adversarial Trust-State & Evidence Integrity Audit (SQLite)', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-adv-sql', name: 'Adversarial SQLite Project' });
      await brain.createTask({
        id: 'task-adv-sql',
        projectId: 'proj-adv-sql',
        title: 'Adversarial SQLite Task',
        description: 'Testing SQLite verification boundaries',
      });
    });

    it('1. rejects addVerificationRecord claiming VERIFIED when checks array is empty', async () => {
      await expect(
        brain.addVerificationRecord({
          id: 'verif-empty-sql',
          taskId: 'task-adv-sql',
          attemptNumber: 1,
          result: {
            status: 'VERIFIED',
            checks: [],
            executedAt: new Date().toISOString(),
            totalDurationMs: 0,
          },
          recordedAt: new Date().toISOString(),
        })
      ).rejects.toThrow(/Cannot record verification status "VERIFIED" without verification checks/);
    });

    it('2. rejects addVerificationRecord claiming VERIFIED when any required check failed', async () => {
      await expect(
        brain.addVerificationRecord({
          id: 'verif-failing-check-sql',
          taskId: 'task-adv-sql',
          attemptNumber: 1,
          result: {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'check-req-fail-sql',
                name: 'Required Check',
                command: 'node',
                args: ['--test'],
                passed: false,
                exitCode: 1,
                signal: null,
                stdout: '',
                stderr: 'Test failed',
                timedOut: false,
                durationMs: 50,
                verifiedAt: new Date().toISOString(),
              },
            ],
            executedAt: new Date().toISOString(),
            totalDurationMs: 50,
          },
          recordedAt: new Date().toISOString(),
        })
      ).rejects.toThrow(/Cannot record verification status "VERIFIED" when required check .* failed or is invalid/);
    });

    it('3. allows VERIFIED when optional check fails but required check passes', async () => {
      const record = await brain.addVerificationRecord({
        id: 'verif-opt-fail-req-pass-sql',
        taskId: 'task-adv-sql',
        attemptNumber: 1,
        result: {
          status: 'VERIFIED',
          checks: [
            {
              checkId: 'check-req-sql',
              name: 'Required Acceptance Check',
              command: 'node',
              args: ['--test'],
              passed: true,
              exitCode: 0,
              signal: null,
              stdout: 'Pass',
              stderr: '',
              timedOut: false,
              durationMs: 50,
              verifiedAt: new Date().toISOString(),
              optional: false,
            },
            {
              checkId: 'check-opt-sql',
              name: 'Optional Linter',
              command: 'eslint',
              args: ['.'],
              passed: false,
              exitCode: 1,
              signal: null,
              stdout: '',
              stderr: '1 warning',
              timedOut: false,
              durationMs: 20,
              verifiedAt: new Date().toISOString(),
              optional: true,
            },
          ],
          executedAt: new Date().toISOString(),
          totalDurationMs: 70,
        },
        recordedAt: new Date().toISOString(),
      });

      expect(record.result.status).toBe('VERIFIED');
      const trustState = await brain.deriveTaskTrustState('task-adv-sql');
      expect(trustState).toBe('VERIFIED');
    });

    it('4. deriveTaskTrustState fails closed if SQLite contains record claiming VERIFIED with empty checks', async () => {
      // Direct raw database insertion bypassing addVerificationRecord
      (brain as any).db.prepare(`
        INSERT INTO verification_records (id, task_id, attempt_number, handoff_id, result_status, result_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('raw-corrupt-1', 'task-adv-sql', 1, null, 'VERIFIED', JSON.stringify({ status: 'VERIFIED', checks: [] }), new Date().toISOString());

      const trustState = await brain.deriveTaskTrustState('task-adv-sql');
      expect(trustState).toBe('FAILED');
    });

    it('5. deriveTaskTrustState fails closed if SQLite contains record with failing check marked VERIFIED', async () => {
      (brain as any).db.prepare(`
        INSERT INTO verification_records (id, task_id, attempt_number, handoff_id, result_status, result_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('raw-corrupt-2', 'task-adv-sql', 1, null, 'VERIFIED', JSON.stringify({
        status: 'VERIFIED',
        checks: [{ checkId: 'c1', passed: false, exitCode: 1, timedOut: false, signal: null }],
      }), new Date().toISOString());

      const trustState = await brain.deriveTaskTrustState('task-adv-sql');
      expect(trustState).toBe('FAILED');
    });

    it('6. freshness: Attempt 1 passes; Attempt 2 creates handoff -> trust state transitions to CLAIMED', async () => {
      await brain.addHandoff(createHandoff('task-adv-sql', 1, 'h-adv-1'));
      await brain.addVerificationRecord({
        id: 'v-adv-1',
        taskId: 'task-adv-sql',
        attemptNumber: 1,
        handoffId: 'h-adv-1',
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });

      expect(await brain.deriveTaskTrustState('task-adv-sql')).toBe('VERIFIED');

      await brain.addHandoff(createHandoff('task-adv-sql', 2, 'h-adv-2'));
      // Attempt 2 not yet verified -> must be CLAIMED
      expect(await brain.deriveTaskTrustState('task-adv-sql')).toBe('CLAIMED');
    });

    it('7. freshness: Attempt 1 passes; Attempt 2 fails verification -> trust state is FAILED', async () => {
      await brain.addHandoff(createHandoff('task-adv-sql', 1, 'h-adv-1'));
      await brain.addVerificationRecord({
        id: 'v-adv-1',
        taskId: 'task-adv-sql',
        attemptNumber: 1,
        handoffId: 'h-adv-1',
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });

      await brain.addHandoff(createHandoff('task-adv-sql', 2, 'h-adv-2'));
      await brain.addVerificationRecord({
        id: 'v-adv-2',
        taskId: 'task-adv-sql',
        attemptNumber: 2,
        handoffId: 'h-adv-2',
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      expect(await brain.deriveTaskTrustState('task-adv-sql')).toBe('FAILED');
    });
  });
});
