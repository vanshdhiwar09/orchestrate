import type {
  AddProjectFactInput,
  BrainStore,
  CreateProjectInput,
  CreateTaskInput,
} from './brain.js';
import type {
  Decision,
  Handoff,
  Project,
  ProjectFact,
  Task,
  TaskAttempt,
  TaskMetrics,
  TaskTrustState,
  VerificationRecord,
} from './types.js';

export class MemoryProjectBrain implements BrainStore {
  private readonly projects = new Map<string, Project>();
  private readonly facts = new Map<string, ProjectFact[]>();
  private readonly tasks = new Map<string, Task>();
  private readonly handoffs = new Map<string, Handoff>(); // key: `${taskId}:${attemptNumber}`
  private readonly handoffsById = new Map<string, Handoff>(); // key: handoffId
  private readonly verificationRecords = new Map<string, VerificationRecord>(); // key: `${taskId}:${attemptNumber}`
  private readonly verificationRecordsById = new Map<string, VerificationRecord>(); // key: recordId
  private readonly decisions = new Map<string, Decision>(); // key: decisionId
  private readonly blockedTasks = new Set<string>();

  // ── Project operations ──────────────────────────────────────────────────────

  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!input || typeof input !== 'object') {
      throw new Error('Project input must be a non-null object.');
    }
    if (typeof input.id !== 'string' || input.id.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const id = input.id.trim();
    if (this.projects.has(id)) {
      throw new Error(`Project "${id}" already exists.`);
    }
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new Error('Project name must be a non-empty string.');
    }

    const project: Project = {
      id,
      name: input.name.trim(),
      facts: [],
      createdAt: input.createdAt ?? new Date().toISOString(),
    };

    this.projects.set(id, project);
    this.facts.set(id, []);
    return { ...project, facts: [] };
  }

  async getProject(id: string): Promise<Project | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const project = this.projects.get(id.trim());
    if (!project) return null;
    const projectFacts = this.facts.get(id.trim()) ?? [];
    return {
      ...project,
      facts: projectFacts.map((f) => ({ ...f })),
    };
  }

  // ── Fact operations ─────────────────────────────────────────────────────────

  async addProjectFact(
    projectId: string,
    input: AddProjectFactInput
  ): Promise<ProjectFact> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    if (!this.projects.has(pid)) {
      throw new Error(`Project "${pid}" not found.`);
    }

    if (!input || typeof input !== 'object') {
      throw new Error('Fact input must be a non-null object.');
    }
    if (typeof input.key !== 'string' || input.key.trim() === '') {
      throw new Error('Fact key must be a non-empty string.');
    }
    if (typeof input.value !== 'string') {
      throw new Error('Fact value must be a string.');
    }

    const validProvenance = new Set(['CODE', 'VERIFICATION', 'SYSTEM', 'AGENT', 'HUMAN']);
    if (!validProvenance.has(input.provenance)) {
      throw new Error(
        `Invalid fact provenance: "${input.provenance}". Allowed: ${[...validProvenance].join(', ')}.`
      );
    }

    const validStatus = new Set(['CLAIMED', 'UNVERIFIED', 'VERIFIED']);
    if (!validStatus.has(input.status)) {
      throw new Error(
        `Invalid fact status: "${input.status}". Allowed: ${[...validStatus].join(', ')}.`
      );
    }

    const fact: ProjectFact = {
      key: input.key.trim(),
      value: input.value,
      provenance: input.provenance,
      status: input.status,
      recordedAt: input.recordedAt ?? new Date().toISOString(),
    };

    const projectFacts = this.facts.get(pid)!;
    projectFacts.push(fact);
    return { ...fact };
  }

  async getProjectFacts(projectId: string): Promise<ProjectFact[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    if (!this.projects.has(pid)) {
      throw new Error(`Project "${pid}" not found.`);
    }
    return (this.facts.get(pid) ?? []).map((f) => ({ ...f }));
  }

  async getCurrentFact(projectId: string, key: string): Promise<ProjectFact | null> {
    const history = await this.getFactHistory(projectId, key);
    if (history.length === 0) return null;
    return { ...history[history.length - 1] };
  }

  async getFactHistory(projectId: string, key: string): Promise<ProjectFact[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    if (!this.projects.has(pid)) {
      throw new Error(`Project "${pid}" not found.`);
    }
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('Fact key must be a non-empty string.');
    }
    const k = key.trim();
    return (this.facts.get(pid) ?? [])
      .filter((f) => f.key === k)
      .map((f) => ({ ...f }));
  }

  // ── Task operations ─────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<Task> {
    if (!input || typeof input !== 'object') {
      throw new Error('Task input must be a non-null object.');
    }
    if (typeof input.id !== 'string' || input.id.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const id = input.id.trim();
    if (this.tasks.has(id)) {
      throw new Error(`Task "${id}" already exists.`);
    }

    if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = input.projectId.trim();
    if (!this.projects.has(pid)) {
      throw new Error(`Project "${pid}" not found.`);
    }

    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new Error('Task title must be a non-empty string.');
    }
    if (typeof input.description !== 'string') {
      throw new Error('Task description must be a string.');
    }

    const now = new Date().toISOString();
    const task: Task = {
      id,
      projectId: pid,
      title: input.title.trim(),
      description: input.description,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    };

    this.tasks.set(id, task);
    return { ...task };
  }

  async getTask(id: string): Promise<Task | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const task = this.tasks.get(id.trim());
    return task ? { ...task } : null;
  }

  async listTasks(projectId: string): Promise<Task[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    if (!this.projects.has(pid)) {
      throw new Error(`Project "${pid}" not found.`);
    }
    return [...this.tasks.values()]
      .filter((t) => t.projectId === pid)
      .map((t) => ({ ...t }));
  }

  // ── Handoff operations ──────────────────────────────────────────────────────

  async addHandoff(handoff: Handoff): Promise<Handoff> {
    if (!handoff || typeof handoff !== 'object') {
      throw new Error('Handoff must be a non-null object.');
    }
    if (typeof handoff.id !== 'string' || handoff.id.trim() === '') {
      throw new Error('Handoff ID must be a non-empty string.');
    }
    const hid = handoff.id.trim();
    if (this.handoffsById.has(hid)) {
      throw new Error(`Handoff with ID "${hid}" already exists.`);
    }

    if (typeof handoff.taskId !== 'string' || handoff.taskId.trim() === '') {
      throw new Error('Handoff taskId must be a non-empty string.');
    }
    const tid = handoff.taskId.trim();
    const task = this.tasks.get(tid);
    if (!task) {
      throw new Error(`Task "${tid}" not found.`);
    }

    if (
      typeof handoff.attemptNumber !== 'number' ||
      !Number.isInteger(handoff.attemptNumber) ||
      handoff.attemptNumber <= 0
    ) {
      throw new Error(
        `Invalid attemptNumber: ${handoff.attemptNumber}. Must be a strictly positive integer.`
      );
    }

    // Attempt sequentiality invariant
    const existingHandoffs = this.getHandoffsForTask(tid);
    const highestAttempt =
      existingHandoffs.length === 0
        ? 0
        : Math.max(...existingHandoffs.map((h) => h.attemptNumber));

    if (handoff.attemptNumber <= highestAttempt) {
      throw new Error(
        `Handoff for task "${tid}" attempt ${handoff.attemptNumber} already exists. Handoffs are append-only and cannot be overwritten.`
      );
    }
    if (handoff.attemptNumber > highestAttempt + 1) {
      throw new Error(
        `Cannot skip attempt numbers: attempted to add attempt ${handoff.attemptNumber}, but current highest attempt is ${highestAttempt}.`
      );
    }

    if (handoff.status !== 'CLAIMED') {
      throw new Error(
        `Invalid handoff status: "${handoff.status}". Handoff status must be "CLAIMED".`
      );
    }

    if (typeof handoff.summary !== 'string') {
      throw new Error('Handoff summary must be a string.');
    }
    if (typeof handoff.changes !== 'string') {
      throw new Error('Handoff changes must be a string.');
    }

    const checkArray = (arr: unknown, name: string) => {
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) {
        throw new Error(`Handoff ${name} must be an array of strings.`);
      }
    };
    checkArray(handoff.filesAffected, 'filesAffected');
    checkArray(handoff.decisionsCreated, 'decisionsCreated');
    checkArray(handoff.assumptions, 'assumptions');
    checkArray(handoff.limitations, 'limitations');
    checkArray(handoff.recommendedFollowUp, 'recommendedFollowUp');

    const cleanHandoff: Handoff = {
      id: hid,
      taskId: tid,
      attemptNumber: handoff.attemptNumber,
      agentId: handoff.agentId,
      model: handoff.model,
      status: 'CLAIMED',
      summary: handoff.summary,
      changes: handoff.changes,
      filesAffected: [...handoff.filesAffected],
      decisionsCreated: [...handoff.decisionsCreated],
      assumptions: [...handoff.assumptions],
      limitations: [...handoff.limitations],
      recommendedFollowUp: [...handoff.recommendedFollowUp],
      createdAt: handoff.createdAt ?? new Date().toISOString(),
    };

    const attemptKey = `${tid}:${cleanHandoff.attemptNumber}`;
    this.handoffs.set(attemptKey, cleanHandoff);
    this.handoffsById.set(hid, cleanHandoff);

    task.updatedAt = new Date().toISOString();
    return { ...cleanHandoff };
  }

  async getHandoff(taskId: string, attemptNumber: number): Promise<Handoff | null> {
    const key = `${taskId.trim()}:${attemptNumber}`;
    const h = this.handoffs.get(key);
    return h ? { ...h } : null;
  }

  async getHandoffById(id: string): Promise<Handoff | null> {
    const h = this.handoffsById.get(id.trim());
    return h ? { ...h } : null;
  }

  private getHandoffsForTask(taskId: string): Handoff[] {
    const prefix = `${taskId.trim()}:`;
    const res: Handoff[] = [];
    for (const [key, val] of this.handoffs.entries()) {
      if (key.startsWith(prefix)) {
        res.push(val);
      }
    }
    return res;
  }

  // ── VerificationRecord operations ───────────────────────────────────────────

  async addVerificationRecord(record: VerificationRecord): Promise<VerificationRecord> {
    if (!record || typeof record !== 'object') {
      throw new Error('VerificationRecord must be a non-null object.');
    }
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw new Error('VerificationRecord ID must be a non-empty string.');
    }
    const rid = record.id.trim();
    if (this.verificationRecordsById.has(rid)) {
      throw new Error(`VerificationRecord with ID "${rid}" already exists.`);
    }

    if (typeof record.taskId !== 'string' || record.taskId.trim() === '') {
      throw new Error('VerificationRecord taskId must be a non-empty string.');
    }
    const tid = record.taskId.trim();
    const task = this.tasks.get(tid);
    if (!task) {
      throw new Error(`Task "${tid}" not found.`);
    }

    if (
      typeof record.attemptNumber !== 'number' ||
      !Number.isInteger(record.attemptNumber) ||
      record.attemptNumber <= 0
    ) {
      throw new Error(
        `Invalid attemptNumber: ${record.attemptNumber}. Must be a strictly positive integer.`
      );
    }

    const attemptKey = `${tid}:${record.attemptNumber}`;
    if (this.verificationRecords.has(attemptKey)) {
      throw new Error(
        `VerificationRecord for task "${tid}" attempt ${record.attemptNumber} already exists. Verification records are append-only and cannot be overwritten.`
      );
    }

    // Verify handoff linkage if handoffId is supplied
    if (record.handoffId !== undefined) {
      if (typeof record.handoffId !== 'string' || record.handoffId.trim() === '') {
        throw new Error('VerificationRecord handoffId, if provided, must be a non-empty string.');
      }
      const linkedHandoff = this.handoffsById.get(record.handoffId.trim());
      if (!linkedHandoff) {
        throw new Error(`Linked handoff "${record.handoffId}" does not exist.`);
      }
      if (linkedHandoff.taskId !== tid) {
        throw new Error(
          `Linked handoff "${record.handoffId}" belongs to task "${linkedHandoff.taskId}", but record belongs to task "${tid}".`
        );
      }
      if (linkedHandoff.attemptNumber !== record.attemptNumber) {
        throw new Error(
          `Linked handoff "${record.handoffId}" is attempt ${linkedHandoff.attemptNumber}, but record specifies attempt ${record.attemptNumber}.`
        );
      }
    }

    // Invariant: cannot skip verification attempt numbers
    const existingVerifications = this.getVerificationRecordsForTask(tid);
    const highestVerAttempt =
      existingVerifications.length === 0
        ? 0
        : Math.max(...existingVerifications.map((v) => v.attemptNumber));

    if (record.attemptNumber > highestVerAttempt + 1) {
      throw new Error(
        `Cannot skip verification attempts: attempted to record attempt ${record.attemptNumber}, but current highest verification attempt is ${highestVerAttempt}.`
      );
    }

    // Verify result payload
    if (!record.result || typeof record.result !== 'object') {
      throw new Error('VerificationRecord result must be a valid VerificationResult object.');
    }
    if (record.result.status !== 'VERIFIED' && record.result.status !== 'FAILED') {
      throw new Error(
        `Invalid verification result status: "${record.result.status}". Must be "VERIFIED" or "FAILED".`
      );
    }

    const cleanRecord: VerificationRecord = {
      id: rid,
      taskId: tid,
      attemptNumber: record.attemptNumber,
      handoffId: record.handoffId ? record.handoffId.trim() : undefined,
      result: {
        status: record.result.status,
        checks: Array.isArray(record.result.checks)
          ? record.result.checks.map((c) => ({ ...c }))
          : [],
        executedAt: record.result.executedAt,
        totalDurationMs: record.result.totalDurationMs,
      },
      recordedAt: record.recordedAt ?? new Date().toISOString(),
    };

    this.verificationRecords.set(attemptKey, cleanRecord);
    this.verificationRecordsById.set(rid, cleanRecord);

    task.updatedAt = new Date().toISOString();
    return { ...cleanRecord };
  }

  async getVerificationRecord(
    taskId: string,
    attemptNumber: number
  ): Promise<VerificationRecord | null> {
    const key = `${taskId.trim()}:${attemptNumber}`;
    const r = this.verificationRecords.get(key);
    return r ? { ...r } : null;
  }

  async getVerificationRecordById(id: string): Promise<VerificationRecord | null> {
    const r = this.verificationRecordsById.get(id.trim());
    return r ? { ...r } : null;
  }

  private getVerificationRecordsForTask(taskId: string): VerificationRecord[] {
    const prefix = `${taskId.trim()}:`;
    const res: VerificationRecord[] = [];
    for (const [key, val] of this.verificationRecords.entries()) {
      if (key.startsWith(prefix)) {
        res.push(val);
      }
    }
    return res;
  }

  // ── Decision operations ─────────────────────────────────────────────────────

  async addDecision(decision: Decision): Promise<Decision> {
    if (!decision || typeof decision !== 'object') {
      throw new Error('Decision must be a non-null object.');
    }
    if (typeof decision.id !== 'string' || decision.id.trim() === '') {
      throw new Error('Decision ID must be a non-empty string.');
    }
    const did = decision.id.trim();
    if (this.decisions.has(did)) {
      throw new Error(`Decision "${did}" already exists.`);
    }

    if (typeof decision.projectId !== 'string' || decision.projectId.trim() === '') {
      throw new Error('Decision projectId must be a non-empty string.');
    }
    const pid = decision.projectId.trim();
    if (!this.projects.has(pid)) {
      throw new Error(`Project "${pid}" not found.`);
    }

    if (typeof decision.statement !== 'string' || decision.statement.trim() === '') {
      throw new Error('Decision statement must be a non-empty string.');
    }
    if (typeof decision.rationale !== 'string') {
      throw new Error('Decision rationale must be a string.');
    }

    const validStatus = new Set(['ACTIVE', 'SUPERSEDED']);
    if (!validStatus.has(decision.status)) {
      throw new Error(
        `Invalid decision status: "${decision.status}". Allowed: ACTIVE, SUPERSEDED.`
      );
    }

    // Cross-project task reference validation
    if (decision.taskId !== undefined) {
      if (typeof decision.taskId !== 'string' || decision.taskId.trim() === '') {
        throw new Error('Decision taskId, if provided, must be a non-empty string.');
      }
      const task = this.tasks.get(decision.taskId.trim());
      if (!task) {
        throw new Error(`Referenced task "${decision.taskId}" not found.`);
      }
      if (task.projectId !== pid) {
        throw new Error(
          `Cross-project reference rejected: decision belongs to project "${pid}", but task belongs to project "${task.projectId}".`
        );
      }
    }

    // Lineage & superseding validation
    if (decision.supersedes !== undefined) {
      if (typeof decision.supersedes !== 'string' || decision.supersedes.trim() === '') {
        throw new Error('Decision supersedes, if provided, must be a non-empty string.');
      }
      const oldDecisionId = decision.supersedes.trim();
      const oldDecision = this.decisions.get(oldDecisionId);
      if (!oldDecision) {
        throw new Error(`Superseded decision "${oldDecisionId}" does not exist.`);
      }
      if (oldDecision.projectId !== pid) {
        throw new Error(
          `Cross-project supersede rejected: new decision belongs to project "${pid}", but superseded decision belongs to project "${oldDecision.projectId}".`
        );
      }

      // Mark superseded decision
      oldDecision.status = 'SUPERSEDED';
    }

    const cleanDecision: Decision = {
      id: did,
      projectId: pid,
      taskId: decision.taskId ? decision.taskId.trim() : undefined,
      attemptNumber: decision.attemptNumber,
      statement: decision.statement.trim(),
      rationale: decision.rationale,
      status: decision.status,
      supersedes: decision.supersedes ? decision.supersedes.trim() : undefined,
      createdAt: decision.createdAt ?? new Date().toISOString(),
    };

    this.decisions.set(did, cleanDecision);
    return { ...cleanDecision };
  }

  async getDecision(id: string): Promise<Decision | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Decision ID must be a non-empty string.');
    }
    const d = this.decisions.get(id.trim());
    return d ? { ...d } : null;
  }

  async listDecisions(projectId: string): Promise<Decision[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    if (!this.projects.has(pid)) {
      throw new Error(`Project "${pid}" not found.`);
    }
    return [...this.decisions.values()]
      .filter((d) => d.projectId === pid)
      .map((d) => ({ ...d }));
  }

  async getActiveDecisions(projectId: string): Promise<Decision[]> {
    const all = await this.listDecisions(projectId);
    return all.filter((d) => d.status === 'ACTIVE');
  }

  // ── Derived state & metrics ─────────────────────────────────────────────────

  async markTaskBlocked(taskId: string, _reason?: string): Promise<void> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    if (!this.tasks.has(tid)) {
      throw new Error(`Task "${tid}" not found.`);
    }
    this.blockedTasks.add(tid);
  }

  async deriveTaskTrustState(taskId: string): Promise<TaskTrustState> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    if (!this.tasks.has(tid)) {
      throw new Error(`Task "${tid}" not found.`);
    }

    if (this.blockedTasks.has(tid)) {
      return 'BLOCKED_NEEDS_HUMAN';
    }

    const handoffs = this.getHandoffsForTask(tid);
    const verifications = this.getVerificationRecordsForTask(tid);

    if (handoffs.length === 0 && verifications.length === 0) {
      return 'UNVERIFIED';
    }

    // Determine highest attempt number across all attempts
    const attemptNumbers = new Set<number>();
    for (const h of handoffs) attemptNumbers.add(h.attemptNumber);
    for (const v of verifications) attemptNumbers.add(v.attemptNumber);

    const highestAttempt = Math.max(...attemptNumbers);

    // Check verification of the latest attempt
    const latestVerification = this.verificationRecords.get(`${tid}:${highestAttempt}`);
    if (latestVerification) {
      return latestVerification.result.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED';
    }

    // If latest attempt has a handoff but no verification yet
    const latestHandoff = this.handoffs.get(`${tid}:${highestAttempt}`);
    if (latestHandoff) {
      return 'CLAIMED';
    }

    return 'UNVERIFIED';
  }

  async getTaskHistory(taskId: string): Promise<TaskAttempt[]> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    if (!this.tasks.has(tid)) {
      throw new Error(`Task "${tid}" not found.`);
    }

    const handoffs = this.getHandoffsForTask(tid);
    const verifications = this.getVerificationRecordsForTask(tid);

    const attemptNumbers = new Set<number>();
    for (const h of handoffs) attemptNumbers.add(h.attemptNumber);
    for (const v of verifications) attemptNumbers.add(v.attemptNumber);

    const sortedAttempts = [...attemptNumbers].sort((a, b) => a - b);

    return sortedAttempts.map((num) => {
      const verif = this.verificationRecords.get(`${tid}:${num}`);
      const hndf = this.handoffs.get(`${tid}:${num}`);
      return {
        attemptNumber: num,
        handoff: hndf ? { ...hndf } : undefined,
        verification: verif ? { ...verif } : undefined,
        verificationRecord: verif ? { ...verif } : undefined,
      };
    });
  }

  async getTaskMetrics(taskId: string): Promise<TaskMetrics> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    if (!this.tasks.has(tid)) {
      throw new Error(`Task "${tid}" not found.`);
    }

    const handoffs = this.getHandoffsForTask(tid);
    const verifications = this.getVerificationRecordsForTask(tid);

    const verificationAttempts = verifications.length;
    const verificationFailures = verifications.filter((v) => v.result.status === 'FAILED').length;

    const attemptNumbers = new Set<number>();
    for (const h of handoffs) attemptNumbers.add(h.attemptNumber);
    for (const v of verifications) attemptNumbers.add(v.attemptNumber);

    const highestAttempt = attemptNumbers.size === 0 ? 0 : Math.max(...attemptNumbers);
    const repairAttempts = Math.max(0, highestAttempt - 1);

    const latestVerification = this.verificationRecords.get(`${tid}:${highestAttempt}`);
    const repairedSuccessfully = Boolean(
      latestVerification &&
      latestVerification.result.status === 'VERIFIED' &&
      highestAttempt > 1
    );

    return {
      verification_attempts: verificationAttempts,
      verification_failures: verificationFailures,
      repair_attempts: repairAttempts,
      repaired_successfully: repairedSuccessfully,
      verificationAttempts,
      verificationFailures,
      repairAttempts,
      repairedSuccessfully,
    };
  }
}
