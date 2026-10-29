import { beforeEach, describe, expect, it } from 'vitest';
import type { VerificationResult } from '@orchestrate/verification';
import {
  type Decision,
  type Handoff,
  MemoryProjectBrain,
  type VerificationRecord,
} from '../src/index.js';

describe('Project Brain (MemoryProjectBrain)', () => {
  let brain: MemoryProjectBrain;

  beforeEach(() => {
    brain = new MemoryProjectBrain();
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

    it('lists projects in deterministic createdAt order with facts', async () => {
      expect(await brain.listProjects()).toEqual([]);

      await brain.createProject({
        id: 'proj-b',
        name: 'Project B',
        createdAt: '2026-10-22T12:00:00.000Z',
      });
      await brain.createProject({
        id: 'proj-a',
        name: 'Project A',
        createdAt: '2026-10-22T10:00:00.000Z',
      });
      await brain.addProjectFact('proj-a', {
        key: 'lang',
        value: 'TypeScript',
        provenance: 'CODE',
        status: 'VERIFIED',
      });

      const list = await brain.listProjects();
      expect(list.map((p) => p.id)).toEqual(['proj-a', 'proj-b']);
      expect(list[0].facts).toHaveLength(1);
      expect(list[0].facts[0].key).toBe('lang');
      expect(list[1].facts).toEqual([]);
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
      expect(fact.recordedAt).toBeDefined();

      const current = await brain.getCurrentFact('proj-1', 'framework');
      expect(current?.value).toBe('Next.js');
      expect(current?.provenance).toBe('CODE');
      expect(current?.status).toBe('VERIFIED');
    });

    it('appends facts with the same key without overwriting history', async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });

      const fact1 = await brain.addProjectFact('proj-1', {
        key: 'port',
        value: '3000',
        provenance: 'AGENT',
        status: 'CLAIMED',
      });

      const fact2 = await brain.addProjectFact('proj-1', {
        key: 'port',
        value: '8080',
        provenance: 'HUMAN',
        status: 'VERIFIED',
      });

      // Latest fact is returned as current
      const current = await brain.getCurrentFact('proj-1', 'port');
      expect(current?.value).toBe('8080');
      expect(current?.provenance).toBe('HUMAN');
      expect(current?.status).toBe('VERIFIED');

      // Previous facts remain available in fact history
      const history = await brain.getFactHistory('proj-1', 'port');
      expect(history.length).toBe(2);
      expect(history[0].value).toBe('3000');
      expect(history[0].status).toBe('CLAIMED');
      expect(history[1].value).toBe('8080');
      expect(history[1].status).toBe('VERIFIED');

      // Project entity facts collection has both facts in order
      const project = await brain.getProject('proj-1');
      expect(project?.facts.length).toBe(2);
    });

    it('rejects adding facts to non-existent projects or invalid fact values', async () => {
      await expect(
        brain.addProjectFact('non-existent', {
          key: 'foo',
          value: 'bar',
          provenance: 'SYSTEM',
          status: 'UNVERIFIED',
        }),
      ).rejects.toThrow(/Project "non-existent" not found/);

      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });

      await expect(
        brain.addProjectFact('proj-1', {
          key: '',
          value: 'bar',
          provenance: 'SYSTEM',
          status: 'UNVERIFIED',
        }),
      ).rejects.toThrow(/key must be a non-empty string/);

      await expect(
        brain.addProjectFact('proj-1', {
          key: 'foo',
          value: 'bar',
          // @ts-expect-error test runtime validation of provenance
          provenance: 'INVALID_PROV',
          status: 'UNVERIFIED',
        }),
      ).rejects.toThrow(/Invalid fact provenance/);

      await expect(
        brain.addProjectFact('proj-1', {
          key: 'foo',
          value: 'bar',
          provenance: 'CODE',
          // @ts-expect-error test runtime validation of status
          status: 'INVALID_STATUS',
        }),
      ).rejects.toThrow(/Invalid fact status/);
    });
  });

  // ==========================================================================
  // TASK
  // ==========================================================================

  describe('Task', () => {
    it('creates and retrieves a task scoped to a project', async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });

      const task = await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Build Feature',
        description: 'Implement milestone 6',
      });

      expect(task.id).toBe('task-1');
      expect(task.projectId).toBe('proj-1');
      expect(task.title).toBe('Build Feature');
      expect(task.description).toBe('Implement milestone 6');
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();

      const retrieved = await brain.getTask('task-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe('Build Feature');

      const projectTasks = await brain.listTasks('proj-1');
      expect(projectTasks.length).toBe(1);
      expect(projectTasks[0].id).toBe('task-1');
    });

    it('rejects invalid task parameters and duplicate task IDs', async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });

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

    const createHandoff = (attemptNumber: number, id = `handoff-${attemptNumber}`): Handoff => ({
      id,
      taskId: 'task-1',
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

    it('creates attempt 1 and attempt 2 sequentially', async () => {
      const h1 = await brain.addHandoff(createHandoff(1));
      expect(h1.attemptNumber).toBe(1);
      expect(h1.status).toBe('CLAIMED');

      const h2 = await brain.addHandoff(createHandoff(2));
      expect(h2.attemptNumber).toBe(2);

      const retrieved1 = await brain.getHandoff('task-1', 1);
      expect(retrieved1?.id).toBe('handoff-1');

      const retrieved2 = await brain.getHandoff('task-1', 2);
      expect(retrieved2?.id).toBe('handoff-2');

      const byId = await brain.getHandoffById('handoff-1');
      expect(byId?.attemptNumber).toBe(1);
    });

    it('rejects duplicate attempt numbers for the same task', async () => {
      await brain.addHandoff(createHandoff(1));
      await expect(brain.addHandoff(createHandoff(1, 'handoff-dup'))).rejects.toThrow(
        /Handoff for task "task-1" attempt 1 already exists/,
      );
    });

    it('rejects skipped attempt numbers', async () => {
      // Attempt 2 before attempt 1
      await expect(brain.addHandoff(createHandoff(2))).rejects.toThrow(
        /Cannot skip attempt numbers/i,
      );

      // Attempt 1 added, then attempt 3 attempted
      await brain.addHandoff(createHandoff(1));
      await expect(brain.addHandoff(createHandoff(3))).rejects.toThrow(
        /Cannot skip attempt numbers/i,
      );
    });

    it('rejects invalid attempt numbers (non-positive, zero, non-integer)', async () => {
      await expect(brain.addHandoff(createHandoff(0))).rejects.toThrow(
        /strictly positive integer/i,
      );
      await expect(brain.addHandoff(createHandoff(-1))).rejects.toThrow(
        /strictly positive integer/i,
      );
      await expect(brain.addHandoff(createHandoff(1.5))).rejects.toThrow(
        /strictly positive integer/i,
      );
    });

    it('enforces immutable history and rejects duplicate handoff IDs', async () => {
      await brain.addHandoff(createHandoff(1, 'handoff-fixed'));
      await expect(
        brain.addHandoff({
          ...createHandoff(2, 'handoff-fixed'),
        }),
      ).rejects.toThrow(/Handoff with ID "handoff-fixed" already exists/);
    });
  });

  // ==========================================================================
  // VERIFICATION RECORD
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

    it('rejects duplicate verification attempts and duplicate record IDs', async () => {
      const record1: VerificationRecord = {
        id: 'verif-1',
        taskId: 'task-1',
        attemptNumber: 1,
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      };
      await brain.addVerificationRecord(record1);

      // Same attempt number
      await expect(
        brain.addVerificationRecord({
          id: 'verif-2',
          taskId: 'task-1',
          attemptNumber: 1,
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/VerificationRecord for task "task-1" attempt 1 already exists/);

      // Same record ID
      await expect(
        brain.addVerificationRecord({
          id: 'verif-1',
          taskId: 'task-1',
          attemptNumber: 2,
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/VerificationRecord with ID "verif-1" already exists/);
    });

    it('validates handoff linkage and rejects mismatched task or attempt', async () => {
      // Create second task
      await brain.createTask({
        id: 'task-2',
        projectId: 'proj-1',
        title: 'Task 2',
        description: 'Desc',
      });

      // Create handoffs for task-1
      await brain.addHandoff({
        id: 'handoff-t1-a1',
        taskId: 'task-1',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Done 1',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

      await brain.addHandoff({
        id: 'handoff-t1-a2',
        taskId: 'task-1',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Done 2',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

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

      // Mismatched attempt: handoff-t1-a2 belongs to attempt 2, but recording for attempt 2 with handoff-t1-a1
      await expect(
        brain.addVerificationRecord({
          id: 'verif-2',
          taskId: 'task-1',
          attemptNumber: 2,
          handoffId: 'handoff-t1-a1', // belongs to attempt 1!
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/record specifies attempt 2/);

      // Non-existent handoffId
      await expect(
        brain.addVerificationRecord({
          id: 'verif-non-existent',
          taskId: 'task-1',
          attemptNumber: 2,
          handoffId: 'does-not-exist',
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/does not exist/i);

      // Mismatched task: attempt on task-2 linking to handoff on task-1
      await expect(
        brain.addVerificationRecord({
          id: 'verif-t2',
          taskId: 'task-2',
          attemptNumber: 1,
          handoffId: 'handoff-t1-a2',
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/record belongs to task "task-2"/);
    });

    it('enforces sequential attempt numbers for verification records', async () => {
      await expect(
        brain.addVerificationRecord({
          id: 'verif-skip',
          taskId: 'task-1',
          attemptNumber: 2,
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/Cannot skip verification attempts/);
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
      await brain.addHandoff({
        id: 'h-1',
        taskId: 'task-1',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Attempt 1',
        changes: 'code',
        filesAffected: ['a.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
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
      await brain.addHandoff({
        id: 'h-2',
        taskId: 'task-1',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Repair attempt 2',
        changes: 'fixed test',
        filesAffected: ['a.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
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

      // 6. History remains intact and retrievable in chronological order
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
      await brain.addHandoff({
        id: 'h-1',
        taskId: 'task-1',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Attempt 1',
        changes: 'code',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        handoffId: 'h-1',
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      expect(await brain.deriveTaskTrustState('task-1')).toBe('FAILED');

      // Mark blocked by orchestrator repair policy
      await brain.markTaskBlocked('task-1', 'Max repair attempts exhausted');
      expect(await brain.deriveTaskTrustState('task-1')).toBe('BLOCKED_NEEDS_HUMAN');

      // Unblock after human intervention
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

    it('creates decisions and retrieves active decisions', async () => {
      const d1: Decision = {
        id: 'dec-1',
        projectId: 'proj-1',
        statement: 'Use Fastify for HTTP',
        rationale: 'High throughput, low overhead',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      };

      await brain.addDecision(d1);

      const active = await brain.getActiveDecisions('proj-1');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('dec-1');
      expect(active[0].status).toBe('ACTIVE');
    });

    it('supersedes a previous decision, preserving history and updating status', async () => {
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

      // d1 must now be SUPERSEDED
      const updatedD1 = await brain.getDecision('dec-1');
      expect(updatedD1?.status).toBe('SUPERSEDED');

      // d2 is ACTIVE
      const retrievedD2 = await brain.getDecision('dec-2');
      expect(retrievedD2?.status).toBe('ACTIVE');
      expect(retrievedD2?.supersedes).toBe('dec-1');

      // Only d2 is returned in active decisions
      const active = await brain.getActiveDecisions('proj-1');
      expect(active.length).toBe(1);
      expect(active[0].id).toBe('dec-2');

      // All decisions are queryable
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

    it('rejects cross-project superseding', async () => {
      await brain.addDecision({
        id: 'dec-proj-1',
        projectId: 'proj-1',
        statement: 'Proj 1 Decision',
        rationale: 'r',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      });

      // Attempt to supersede decision from proj-1 in proj-2
      await expect(
        brain.addDecision({
          id: 'dec-proj-2',
          projectId: 'proj-2',
          statement: 'Proj 2 Decision',
          rationale: 'r',
          status: 'ACTIVE',
          supersedes: 'dec-proj-1',
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/Cross-project supersede rejected/);
    });

    it('rejects decision referencing task in a different project', async () => {
      await brain.createTask({
        id: 'task-other',
        projectId: 'proj-2',
        title: 'Task Other',
        description: 'd',
      });

      await expect(
        brain.addDecision({
          id: 'dec-mismatch',
          projectId: 'proj-1',
          taskId: 'task-other', // belongs to proj-2
          statement: 'Decision with cross-project task',
          rationale: 'r',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/Cross-project reference rejected/);
    });
  });

  // ==========================================================================
  // EVALUATION & METRIC DERIVATION
  // ==========================================================================

  describe('Evaluation Metric Derivation', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-1', name: 'Orchestrate' });
      await brain.createTask({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Task 1',
        description: 'Desc',
      });
    });

    it('derives correct metrics for single attempt success', async () => {
      await brain.addHandoff({
        id: 'h-1',
        taskId: 'task-1',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Done',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

      await brain.addVerificationRecord({
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });

      const metrics = await brain.getTaskMetrics('task-1');
      expect(metrics.verification_attempts).toBe(1);
      expect(metrics.verification_failures).toBe(0);
      expect(metrics.repair_attempts).toBe(0);
      expect(metrics.repaired_successfully).toBe(false); // First attempt success is not a repair
    });

    it('derives correct metrics for failure followed by successful repair', async () => {
      // Attempt 1: fail
      await brain.addHandoff({
        id: 'h-1',
        taskId: 'task-1',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Done 1',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      // Attempt 2: fail
      await brain.addHandoff({
        id: 'h-2',
        taskId: 'task-1',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Done 2',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-2',
        taskId: 'task-1',
        attemptNumber: 2,
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      // Attempt 3: pass
      await brain.addHandoff({
        id: 'h-3',
        taskId: 'task-1',
        attemptNumber: 3,
        status: 'CLAIMED',
        summary: 'Done 3',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-3',
        taskId: 'task-1',
        attemptNumber: 3,
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });

      const metrics = await brain.getTaskMetrics('task-1');
      expect(metrics.verification_attempts).toBe(3);
      expect(metrics.verification_failures).toBe(2);
      expect(metrics.repair_attempts).toBe(2); // highestAttempt (3) - 1
      expect(metrics.repaired_successfully).toBe(true);
    });

    it('derives correct metrics when repair fails', async () => {
      // Attempt 1: fail
      await brain.addHandoff({
        id: 'h-1',
        taskId: 'task-1',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Done 1',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-1',
        taskId: 'task-1',
        attemptNumber: 1,
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      // Attempt 2: fail
      await brain.addHandoff({
        id: 'h-2',
        taskId: 'task-1',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Done 2',
        changes: 'c',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-2',
        taskId: 'task-1',
        attemptNumber: 2,
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      const metrics = await brain.getTaskMetrics('task-1');
      expect(metrics.verification_attempts).toBe(2);
      expect(metrics.verification_failures).toBe(2);
      expect(metrics.repair_attempts).toBe(1);
      expect(metrics.repaired_successfully).toBe(false);
    });
  });

  // ==========================================================================
  // PROJECT ISOLATION & BOUNDARY ENFORCEMENT
  // ==========================================================================

  describe('Project Isolation & Boundary Enforcement', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-A', name: 'Project A' });
      await brain.createProject({ id: 'proj-B', name: 'Project B' });
      await brain.createTask({
        id: 'task-A',
        projectId: 'proj-A',
        title: 'Task A',
        description: 'Desc A',
      });
    });

    it('rejects task creation referencing non-existent project', async () => {
      await expect(
        brain.createTask({
          id: 'task-X',
          projectId: 'non-existent',
          title: 'Title',
          description: 'Desc',
        }),
      ).rejects.toThrow(/Project "non-existent" not found/);
    });

    it('isolates tasks by project in listings', async () => {
      await brain.createTask({
        id: 'task-B',
        projectId: 'proj-B',
        title: 'Task B',
        description: 'Desc B',
      });

      const tasksA = await brain.listTasks('proj-A');
      expect(tasksA.map((t) => t.id)).toEqual(['task-A']);

      const tasksB = await brain.listTasks('proj-B');
      expect(tasksB.map((t) => t.id)).toEqual(['task-B']);
    });

    it('rejects handoff referencing non-existent task', async () => {
      await expect(
        brain.addHandoff({
          id: 'h-invalid',
          taskId: 'task-non-existent',
          attemptNumber: 1,
          status: 'CLAIMED',
          summary: 'sum',
          changes: 'chg',
          filesAffected: [],
          decisionsCreated: [],
          assumptions: [],
          limitations: [],
          recommendedFollowUp: [],
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/Task "task-non-existent" not found/);
    });

    it('rejects verification record referencing non-existent task', async () => {
      await expect(
        brain.addVerificationRecord({
          id: 'v-invalid',
          taskId: 'task-non-existent',
          attemptNumber: 1,
          result: createPassingResult(),
          recordedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/Task "task-non-existent" not found/);
    });

    it('rejects decision referencing non-existent project', async () => {
      await expect(
        brain.addDecision({
          id: 'dec-invalid',
          projectId: 'proj-non-existent',
          statement: 's',
          rationale: 'r',
          status: 'ACTIVE',
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/Project "proj-non-existent" not found/);
    });
  });

  // ==========================================================================
  // ADVERSARIAL TRUST-STATE & EVIDENCE INTEGRITY AUDIT (STEP 10.14)
  // ==========================================================================

  describe('Adversarial Trust-State & Evidence Integrity Audit', () => {
    beforeEach(async () => {
      await brain.createProject({ id: 'proj-adv', name: 'Adversarial Project' });
      await brain.createTask({
        id: 'task-adv',
        projectId: 'proj-adv',
        title: 'Adversarial Task',
        description: 'Testing verification boundaries',
      });
    });

    it('1. rejects addVerificationRecord claiming VERIFIED when checks array is empty', async () => {
      await expect(
        brain.addVerificationRecord({
          id: 'verif-empty',
          taskId: 'task-adv',
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
          id: 'verif-failing-check',
          taskId: 'task-adv',
          attemptNumber: 1,
          result: {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'check-required-fail',
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

    it('3. rejects addVerificationRecord claiming VERIFIED when a required check timed out', async () => {
      await expect(
        brain.addVerificationRecord({
          id: 'verif-timeout-check',
          taskId: 'task-adv',
          attemptNumber: 1,
          result: {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'check-timeout',
                name: 'Timeout Check',
                command: 'node',
                args: ['--test'],
                passed: false,
                exitCode: 0,
                signal: null,
                stdout: '',
                stderr: 'Timed out',
                timedOut: true,
                durationMs: 30000,
                verifiedAt: new Date().toISOString(),
              },
            ],
            executedAt: new Date().toISOString(),
            totalDurationMs: 30000,
          },
          recordedAt: new Date().toISOString(),
        })
      ).rejects.toThrow(/Cannot record verification status "VERIFIED" when required check .* failed or is invalid/);
    });

    it('4. rejects addVerificationRecord claiming VERIFIED when only optional checks exist', async () => {
      await expect(
        brain.addVerificationRecord({
          id: 'verif-only-optional',
          taskId: 'task-adv',
          attemptNumber: 1,
          result: {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'check-opt',
                name: 'Optional Check',
                command: 'node',
                args: ['--lint'],
                passed: true,
                exitCode: 0,
                signal: null,
                stdout: 'clean',
                stderr: '',
                timedOut: false,
                durationMs: 20,
                verifiedAt: new Date().toISOString(),
                optional: true,
              },
            ],
            executedAt: new Date().toISOString(),
            totalDurationMs: 20,
          },
          recordedAt: new Date().toISOString(),
        })
      ).rejects.toThrow(/Cannot record verification status "VERIFIED" without at least one required check/);
    });

    it('5. allows VERIFIED when optional check fails but required check passes', async () => {
      const record = await brain.addVerificationRecord({
        id: 'verif-opt-fail-req-pass',
        taskId: 'task-adv',
        attemptNumber: 1,
        result: {
          status: 'VERIFIED',
          checks: [
            {
              checkId: 'check-req',
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
              checkId: 'check-opt-warn',
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
      const trustState = await brain.deriveTaskTrustState('task-adv');
      expect(trustState).toBe('VERIFIED');
    });

    it('6. deriveTaskTrustState fails closed if database contains corrupted record claiming VERIFIED with empty checks', async () => {
      // Simulate raw corrupted record inserted into storage
      (brain as any).verificationRecords.set('task-adv:1', {
        id: 'corrupt-1',
        taskId: 'task-adv',
        attemptNumber: 1,
        result: { status: 'VERIFIED', checks: [] },
        recordedAt: new Date().toISOString(),
      });

      const trustState = await brain.deriveTaskTrustState('task-adv');
      expect(trustState).toBe('FAILED');
    });

    it('7. deriveTaskTrustState fails closed if database contains corrupted record with failing check marked VERIFIED', async () => {
      (brain as any).verificationRecords.set('task-adv:1', {
        id: 'corrupt-2',
        taskId: 'task-adv',
        attemptNumber: 1,
        result: {
          status: 'VERIFIED',
          checks: [
            { checkId: 'c1', passed: false, exitCode: 1, timedOut: false, signal: null },
          ],
        },
        recordedAt: new Date().toISOString(),
      });

      const trustState = await brain.deriveTaskTrustState('task-adv');
      expect(trustState).toBe('FAILED');
    });

    it('8. freshness: Attempt 1 passes; Attempt 2 creates handoff -> trust state transitions to CLAIMED (not VERIFIED)', async () => {
      // Attempt 1: Handoff and Verification pass
      await brain.addHandoff({
        id: 'h-a1',
        taskId: 'task-adv',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Attempt 1 completed',
        changes: 'impl',
        filesAffected: ['src/app.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

      await brain.addVerificationRecord({
        id: 'v-a1',
        taskId: 'task-adv',
        attemptNumber: 1,
        handoffId: 'h-a1',
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });

      expect(await brain.deriveTaskTrustState('task-adv')).toBe('VERIFIED');

      // Attempt 2: Modifies source code, creating a new handoff
      await brain.addHandoff({
        id: 'h-a2',
        taskId: 'task-adv',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Attempt 2 started changes',
        changes: 'more code',
        filesAffected: ['src/app.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });

      // Trust state must immediately revert to CLAIMED because Attempt 2 has not been verified!
      expect(await brain.deriveTaskTrustState('task-adv')).toBe('CLAIMED');
    });

    it('9. freshness: Attempt 1 passes; Attempt 2 fails verification -> trust state is FAILED (not VERIFIED)', async () => {
      await brain.addHandoff({
        id: 'h-a1',
        taskId: 'task-adv',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Attempt 1',
        changes: '',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-a1',
        taskId: 'task-adv',
        attemptNumber: 1,
        handoffId: 'h-a1',
        result: createPassingResult(),
        recordedAt: new Date().toISOString(),
      });

      await brain.addHandoff({
        id: 'h-a2',
        taskId: 'task-adv',
        attemptNumber: 2,
        status: 'CLAIMED',
        summary: 'Attempt 2',
        changes: '',
        filesAffected: [],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-a2',
        taskId: 'task-adv',
        attemptNumber: 2,
        handoffId: 'h-a2',
        result: createFailingResult(),
        recordedAt: new Date().toISOString(),
      });

      // Trust state must be FAILED, cannot promote using attempt 1
      expect(await brain.deriveTaskTrustState('task-adv')).toBe('FAILED');
    });
  });
});
