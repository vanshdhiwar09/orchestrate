import { DatabaseSync } from 'node:sqlite';
import { computeSourceSnapshot } from '@orchestrate/verification';
import type {
  AddProjectFactInput,
  BrainStore,
  CreateProjectInput,
  CreateTaskInput,
} from './brain.js';
import {
  type Decision,
  type DeriveTrustStateOptions,
  type Handoff,
  type Project,
  type ProjectFact,
  PromotionError,
  type PromoteTaskOptions,
  type PromotionResult,
  SourceFreshnessError,
  type SourceSnapshotIdentity,
  type Task,
  type TaskAttempt,
  type TaskMetrics,
  type TaskTrustState,
  type VerificationRecord,
} from './types.js';

export interface SqliteProjectBrainOptions {
  /**
   * Path to the SQLite database file or ':memory:' for in-memory testing.
   */
  databasePath: string;
}

export class SqliteProjectBrain implements BrainStore {
  private readonly db: DatabaseSync;
  public readonly databasePath: string;

  constructor(options: SqliteProjectBrainOptions) {
    if (!options?.databasePath || typeof options.databasePath !== 'string' || options.databasePath.trim() === '') {
      throw new Error('SqliteProjectBrain: databasePath must be a non-empty string.');
    }
    this.databasePath = options.databasePath.trim();
    this.db = new DatabaseSync(this.databasePath);
    this.initDatabase();
  }

  /**
   * Closes the underlying SQLite database connection.
   */
  close(): void {
    this.db.close();
  }

  private initDatabase(): void {
    // 1. Configure pragmas
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.databasePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }

    // 2. Schema migrations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _brain_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    // 3. Run versioned migrations
    this.runMigrations();
  }

  private runMigrations(): void {
    const row = this.db
      .prepare('SELECT MAX(version) as current_version FROM _brain_migrations')
      .get() as { current_version: number | null } | undefined;

    const currentVersion = row?.current_version ?? 0;

    if (currentVersion < 1) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(`
          CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE project_facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            fact_key TEXT NOT NULL,
            fact_value TEXT NOT NULL,
            provenance TEXT NOT NULL,
            status TEXT NOT NULL,
            recorded_at TEXT NOT NULL
          );
          CREATE INDEX idx_project_facts_project_key ON project_facts(project_id, fact_key);

          CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX idx_tasks_project ON tasks(project_id);

          CREATE TABLE handoffs (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            attempt_number INTEGER NOT NULL,
            agent_id TEXT,
            model TEXT,
            status TEXT NOT NULL,
            summary TEXT NOT NULL,
            changes TEXT NOT NULL,
            files_affected_json TEXT NOT NULL,
            decisions_created_json TEXT NOT NULL,
            assumptions_json TEXT NOT NULL,
            limitations_json TEXT NOT NULL,
            recommended_follow_up_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(task_id, attempt_number)
          );
          CREATE INDEX idx_handoffs_task_attempt ON handoffs(task_id, attempt_number);

          CREATE TABLE verification_records (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            attempt_number INTEGER NOT NULL,
            handoff_id TEXT REFERENCES handoffs(id) ON DELETE SET NULL,
            result_status TEXT NOT NULL,
            result_json TEXT NOT NULL,
            recorded_at TEXT NOT NULL,
            UNIQUE(task_id, attempt_number)
          );
          CREATE INDEX idx_verif_task_attempt ON verification_records(task_id, attempt_number);

          CREATE TABLE decisions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
            attempt_number INTEGER,
            statement TEXT NOT NULL,
            rationale TEXT NOT NULL,
            status TEXT NOT NULL,
            supersedes TEXT REFERENCES decisions(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX idx_decisions_project_status ON decisions(project_id, status);

          CREATE TABLE blocked_tasks (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            blocked_at TEXT NOT NULL,
            reason TEXT
          );

          INSERT INTO _brain_migrations (version, applied_at) VALUES (1, datetime('now'));
        `);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }

    if (currentVersion < 2) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(`
          ALTER TABLE verification_records ADD COLUMN source_snapshot_json TEXT;
          INSERT INTO _brain_migrations (version, applied_at) VALUES (2, datetime('now'));
        `);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }

    if (currentVersion < 3) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(`
          ALTER TABLE projects ADD COLUMN owner_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
          INSERT INTO _brain_migrations (version, applied_at) VALUES (3, datetime('now'));
        `);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }
  }

  // ── Project operations ──────────────────────────────────────────────────────

  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!input || typeof input !== 'object') {
      throw new Error('Project input must be a non-null object.');
    }
    if (typeof input.id !== 'string' || input.id.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const id = input.id.trim();

    // Check existing
    const existing = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
    if (existing) {
      throw new Error(`Project "${id}" already exists.`);
    }

    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new Error('Project name must be a non-empty string.');
    }
    const name = input.name.trim();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const ownerId = typeof input.ownerId === 'string' && input.ownerId.trim() ? input.ownerId.trim() : null;

    this.db
      .prepare('INSERT INTO projects (id, name, created_at, owner_id) VALUES (?, ?, ?, ?)')
      .run(id, name, createdAt, ownerId);

    return {
      id,
      name,
      facts: [],
      createdAt,
      ...(ownerId ? { ownerId } : {}),
    };
  }

  async getProject(id: string): Promise<Project | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = id.trim();
    const row = this.db.prepare('SELECT id, name, created_at, owner_id FROM projects WHERE id = ?').get(pid) as
      | { id: string; name: string; created_at: string; owner_id: string | null }
      | undefined;

    if (!row) return null;

    const facts = await this.getProjectFacts(pid);

    return {
      id: row.id,
      name: row.name,
      facts,
      createdAt: row.created_at,
      ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    };
  }

  async listProjects(ownerId?: string): Promise<Project[]> {
    let rows: Array<{ id: string; name: string; created_at: string; owner_id: string | null }>;
    if (ownerId && typeof ownerId === 'string' && ownerId.trim()) {
      rows = this.db
        .prepare('SELECT id, name, created_at, owner_id FROM projects WHERE owner_id = ? ORDER BY created_at ASC, id ASC')
        .all(ownerId.trim()) as Array<{ id: string; name: string; created_at: string; owner_id: string | null }>;
    } else {
      rows = this.db
        .prepare('SELECT id, name, created_at, owner_id FROM projects ORDER BY created_at ASC, id ASC')
        .all() as Array<{ id: string; name: string; created_at: string; owner_id: string | null }>;
    }

    const result: Project[] = [];
    for (const row of rows) {
      const facts = await this.getProjectFacts(row.id);
      result.push({
        id: row.id,
        name: row.name,
        facts,
        createdAt: row.created_at,
        ...(row.owner_id ? { ownerId: row.owner_id } : {}),
      });
    }
    return result;
  }

  // ── Fact operations ─────────────────────────────────────────────────────────

  async addProjectFact(projectId: string, input: AddProjectFactInput): Promise<ProjectFact> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) {
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

    this.db
      .prepare(
        'INSERT INTO project_facts (project_id, fact_key, fact_value, provenance, status, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(pid, fact.key, fact.value, fact.provenance, fact.status, fact.recordedAt);

    return fact;
  }

  async getProjectFacts(projectId: string): Promise<ProjectFact[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) {
      throw new Error(`Project "${pid}" not found.`);
    }

    const rows = this.db
      .prepare(
        'SELECT fact_key, fact_value, provenance, status, recorded_at FROM project_facts WHERE project_id = ? ORDER BY id ASC'
      )
      .all(pid) as Array<{
      fact_key: string;
      fact_value: string;
      provenance: ProjectFact['provenance'];
      status: ProjectFact['status'];
      recorded_at: string;
    }>;

    return rows.map((r) => ({
      key: r.fact_key,
      value: r.fact_value,
      provenance: r.provenance,
      status: r.status,
      recordedAt: r.recorded_at,
    }));
  }

  async getCurrentFact(projectId: string, key: string): Promise<ProjectFact | null> {
    const history = await this.getFactHistory(projectId, key);
    if (history.length === 0) return null;
    return history[history.length - 1];
  }

  async getFactHistory(projectId: string, key: string): Promise<ProjectFact[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) {
      throw new Error(`Project "${pid}" not found.`);
    }
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error('Fact key must be a non-empty string.');
    }
    const k = key.trim();

    const rows = this.db
      .prepare(
        'SELECT fact_key, fact_value, provenance, status, recorded_at FROM project_facts WHERE project_id = ? AND fact_key = ? ORDER BY id ASC'
      )
      .all(pid, k) as Array<{
      fact_key: string;
      fact_value: string;
      provenance: ProjectFact['provenance'];
      status: ProjectFact['status'];
      recorded_at: string;
    }>;

    return rows.map((r) => ({
      key: r.fact_key,
      value: r.fact_value,
      provenance: r.provenance,
      status: r.status,
      recordedAt: r.recorded_at,
    }));
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

    const existing = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (existing) {
      throw new Error(`Task "${id}" already exists.`);
    }

    if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = input.projectId.trim();
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) {
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

    this.db
      .prepare(
        'INSERT INTO tasks (id, project_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(task.id, task.projectId, task.title, task.description, task.createdAt, task.updatedAt);

    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const row = this.db
      .prepare('SELECT id, project_id, title, description, created_at, updated_at FROM tasks WHERE id = ?')
      .get(id.trim()) as
      | {
          id: string;
          project_id: string;
          title: string;
          description: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listTasks(projectId: string): Promise<Task[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) {
      throw new Error(`Project "${pid}" not found.`);
    }

    const rows = this.db
      .prepare(
        'SELECT id, project_id, title, description, created_at, updated_at FROM tasks WHERE project_id = ? ORDER BY created_at ASC'
      )
      .all(pid) as Array<{
      id: string;
      project_id: string;
      title: string;
      description: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
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

    const existingById = this.db.prepare('SELECT id FROM handoffs WHERE id = ?').get(hid);
    if (existingById) {
      throw new Error(`Handoff with ID "${hid}" already exists.`);
    }

    if (typeof handoff.taskId !== 'string' || handoff.taskId.trim() === '') {
      throw new Error('Handoff taskId must be a non-empty string.');
    }
    const tid = handoff.taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
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
    const maxRow = this.db
      .prepare('SELECT MAX(attempt_number) as max_attempt FROM handoffs WHERE task_id = ?')
      .get(tid) as { max_attempt: number | null } | undefined;
    const highestAttempt = maxRow?.max_attempt ?? 0;

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

    const now = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(`
          INSERT INTO handoffs (
            id, task_id, attempt_number, agent_id, model, status,
            summary, changes, files_affected_json, decisions_created_json,
            assumptions_json, limitations_json, recommended_follow_up_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          cleanHandoff.id,
          cleanHandoff.taskId,
          cleanHandoff.attemptNumber,
          cleanHandoff.agentId ?? null,
          cleanHandoff.model ?? null,
          cleanHandoff.status,
          cleanHandoff.summary,
          cleanHandoff.changes,
          JSON.stringify(cleanHandoff.filesAffected),
          JSON.stringify(cleanHandoff.decisionsCreated),
          JSON.stringify(cleanHandoff.assumptions),
          JSON.stringify(cleanHandoff.limitations),
          JSON.stringify(cleanHandoff.recommendedFollowUp),
          cleanHandoff.createdAt
        );

      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, tid);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return cleanHandoff;
  }

  async getHandoff(taskId: string, attemptNumber: number): Promise<Handoff | null> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    if (
      typeof attemptNumber !== 'number' ||
      !Number.isInteger(attemptNumber) ||
      attemptNumber <= 0
    ) {
      throw new Error(
        `Invalid attemptNumber: ${attemptNumber}. Must be a strictly positive integer.`
      );
    }
    const tid = taskId.trim();
    const row = this.db
      .prepare('SELECT * FROM handoffs WHERE task_id = ? AND attempt_number = ?')
      .get(tid, attemptNumber) as any;

    if (!row) return null;
    return this.mapHandoffRow(row);
  }

  async getHandoffById(id: string): Promise<Handoff | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Handoff ID must be a non-empty string.');
    }
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id.trim()) as any;
    if (!row) return null;
    return this.mapHandoffRow(row);
  }

  private mapHandoffRow(row: any): Handoff {
    return {
      id: row.id,
      taskId: row.task_id,
      attemptNumber: Number(row.attempt_number),
      agentId: row.agent_id ?? undefined,
      model: row.model ?? undefined,
      status: row.status,
      summary: row.summary,
      changes: row.changes,
      filesAffected: JSON.parse(row.files_affected_json),
      decisionsCreated: JSON.parse(row.decisions_created_json),
      assumptions: JSON.parse(row.assumptions_json),
      limitations: JSON.parse(row.limitations_json),
      recommendedFollowUp: JSON.parse(row.recommended_follow_up_json),
      createdAt: row.created_at,
    };
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

    const existingById = this.db.prepare('SELECT id FROM verification_records WHERE id = ?').get(rid);
    if (existingById) {
      throw new Error(`VerificationRecord with ID "${rid}" already exists.`);
    }

    if (typeof record.taskId !== 'string' || record.taskId.trim() === '') {
      throw new Error('VerificationRecord taskId must be a non-empty string.');
    }
    const tid = record.taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
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

    const existingByAttempt = this.db
      .prepare('SELECT id FROM verification_records WHERE task_id = ? AND attempt_number = ?')
      .get(tid, record.attemptNumber);
    if (existingByAttempt) {
      throw new Error(
        `VerificationRecord for task "${tid}" attempt ${record.attemptNumber} already exists. Verification records are append-only and cannot be overwritten.`
      );
    }

    // Verify handoff linkage if handoffId is supplied
    if (record.handoffId !== undefined) {
      if (typeof record.handoffId !== 'string' || record.handoffId.trim() === '') {
        throw new Error('VerificationRecord handoffId, if provided, must be a non-empty string.');
      }
      const hid = record.handoffId.trim();
      const linkedHandoff = await this.getHandoffById(hid);
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
    const maxRow = this.db
      .prepare('SELECT MAX(attempt_number) as max_attempt FROM verification_records WHERE task_id = ?')
      .get(tid) as { max_attempt: number | null } | undefined;
    const highestVerAttempt = maxRow?.max_attempt ?? 0;

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

    // Invariant: VERIFIED status strictly requires valid, passing required checks
    if (record.result.status === 'VERIFIED') {
      if (!Array.isArray(record.result.checks) || record.result.checks.length === 0) {
        throw new Error(
          'Cannot record verification status "VERIFIED" without verification checks.'
        );
      }
      const requiredChecks = record.result.checks.filter(
        (c) => (c as any)?.optional !== true
      );
      if (requiredChecks.length === 0) {
        throw new Error(
          'Cannot record verification status "VERIFIED" without at least one required check.'
        );
      }
      for (const c of requiredChecks) {
        if (
          !c ||
          typeof c !== 'object' ||
          c.passed !== true ||
          c.exitCode !== 0 ||
          c.timedOut ||
          c.signal !== null
        ) {
          throw new Error(
            `Cannot record verification status "VERIFIED" when required check "${c?.checkId ?? 'unknown'}" failed or is invalid.`
          );
        }
      }
    }

    if (record.sourceSnapshot !== undefined) {
      if (
        !record.sourceSnapshot ||
        typeof record.sourceSnapshot !== 'object' ||
        typeof record.sourceSnapshot.fingerprint !== 'string' ||
        record.sourceSnapshot.fingerprint.trim() === '' ||
        typeof record.sourceSnapshot.capturedAt !== 'string' ||
        record.sourceSnapshot.capturedAt.trim() === ''
      ) {
        throw new Error(
          'VerificationRecord sourceSnapshot must be a valid object with non-empty "fingerprint" and "capturedAt".'
        );
      }
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
      sourceSnapshot: record.sourceSnapshot
        ? {
            fingerprint: record.sourceSnapshot.fingerprint,
            capturedAt: record.sourceSnapshot.capturedAt,
            fileCount: record.sourceSnapshot.fileCount,
            commitSha: record.sourceSnapshot.commitSha,
            dirty: record.sourceSnapshot.dirty,
          }
        : undefined,
    };

    const now = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db
        .prepare(`
          INSERT INTO verification_records (
            id, task_id, attempt_number, handoff_id, result_status, result_json, source_snapshot_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          cleanRecord.id,
          cleanRecord.taskId,
          cleanRecord.attemptNumber,
          cleanRecord.handoffId ?? null,
          cleanRecord.result.status,
          JSON.stringify(cleanRecord.result),
          cleanRecord.sourceSnapshot ? JSON.stringify(cleanRecord.sourceSnapshot) : null,
          cleanRecord.recordedAt
        );

      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now, tid);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return cleanRecord;
  }

  async getVerificationRecord(taskId: string, attemptNumber: number): Promise<VerificationRecord | null> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    if (
      typeof attemptNumber !== 'number' ||
      !Number.isInteger(attemptNumber) ||
      attemptNumber <= 0
    ) {
      throw new Error(
        `Invalid attemptNumber: ${attemptNumber}. Must be a strictly positive integer.`
      );
    }
    const tid = taskId.trim();
    const row = this.db
      .prepare('SELECT * FROM verification_records WHERE task_id = ? AND attempt_number = ?')
      .get(tid, attemptNumber) as any;

    if (!row) return null;
    return this.mapVerificationRecordRow(row);
  }

  async getVerificationRecordById(id: string): Promise<VerificationRecord | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('VerificationRecord ID must be a non-empty string.');
    }
    const row = this.db.prepare('SELECT * FROM verification_records WHERE id = ?').get(id.trim()) as any;
    if (!row) return null;
    return this.mapVerificationRecordRow(row);
  }

  private mapVerificationRecordRow(row: any): VerificationRecord {
    let sourceSnapshot: SourceSnapshotIdentity | undefined;
    if (row.source_snapshot_json) {
      try {
        const parsed = JSON.parse(row.source_snapshot_json);
        if (
          parsed &&
          typeof parsed === 'object' &&
          typeof parsed.fingerprint === 'string' &&
          parsed.fingerprint.trim() !== ''
        ) {
          sourceSnapshot = parsed;
        }
      } catch {
        sourceSnapshot = undefined;
      }
    }

    return {
      id: row.id,
      taskId: row.task_id,
      attemptNumber: Number(row.attempt_number),
      handoffId: row.handoff_id ?? undefined,
      result: JSON.parse(row.result_json),
      recordedAt: row.recorded_at,
      sourceSnapshot,
    };
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

    const existing = this.db.prepare('SELECT id FROM decisions WHERE id = ?').get(did);
    if (existing) {
      throw new Error(`Decision "${did}" already exists.`);
    }

    if (typeof decision.projectId !== 'string' || decision.projectId.trim() === '') {
      throw new Error('Decision projectId must be a non-empty string.');
    }
    const pid = decision.projectId.trim();
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) {
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
      const task = await this.getTask(decision.taskId.trim());
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
      const oldDecision = await this.getDecision(oldDecisionId);
      if (!oldDecision) {
        throw new Error(`Superseded decision "${oldDecisionId}" does not exist.`);
      }
      if (oldDecision.projectId !== pid) {
        throw new Error(
          `Cross-project supersede rejected: new decision belongs to project "${pid}", but superseded decision belongs to project "${oldDecision.projectId}".`
        );
      }
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

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (cleanDecision.supersedes) {
        this.db
          .prepare("UPDATE decisions SET status = 'SUPERSEDED' WHERE id = ?")
          .run(cleanDecision.supersedes);
      }

      this.db
        .prepare(`
          INSERT INTO decisions (
            id, project_id, task_id, attempt_number, statement, rationale, status, supersedes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          cleanDecision.id,
          cleanDecision.projectId,
          cleanDecision.taskId ?? null,
          cleanDecision.attemptNumber ?? null,
          cleanDecision.statement,
          cleanDecision.rationale,
          cleanDecision.status,
          cleanDecision.supersedes ?? null,
          cleanDecision.createdAt
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return cleanDecision;
  }

  async getDecision(id: string): Promise<Decision | null> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('Decision ID must be a non-empty string.');
    }
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id.trim()) as any;
    if (!row) return null;
    return this.mapDecisionRow(row);
  }

  async listDecisions(projectId: string): Promise<Decision[]> {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new Error('Project ID must be a non-empty string.');
    }
    const pid = projectId.trim();
    const project = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(pid);
    if (!project) {
      throw new Error(`Project "${pid}" not found.`);
    }

    const rows = this.db
      .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at ASC')
      .all(pid) as any[];

    return rows.map((r) => this.mapDecisionRow(r));
  }

  async getActiveDecisions(projectId: string): Promise<Decision[]> {
    const all = await this.listDecisions(projectId);
    return all.filter((d) => d.status === 'ACTIVE');
  }

  private mapDecisionRow(row: any): Decision {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id ?? undefined,
      attemptNumber: row.attempt_number !== null ? Number(row.attempt_number) : undefined,
      statement: row.statement,
      rationale: row.rationale,
      status: row.status,
      supersedes: row.supersedes ?? undefined,
      createdAt: row.created_at,
    };
  }

  // ── Derived state & metrics ─────────────────────────────────────────────────

  async markTaskBlocked(taskId: string, reason?: string): Promise<void> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
    if (!task) {
      throw new Error(`Task "${tid}" not found.`);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO blocked_tasks (task_id, blocked_at, reason) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET blocked_at = excluded.blocked_at, reason = excluded.reason'
      )
      .run(tid, now, reason ?? null);
  }

  async unblockTask(taskId: string): Promise<void> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
    if (!task) {
      throw new Error(`Task "${tid}" not found.`);
    }

    this.db.prepare('DELETE FROM blocked_tasks WHERE task_id = ?').run(tid);
  }

  async deriveTaskTrustState(
    taskId: string,
    options?: DeriveTrustStateOptions
  ): Promise<TaskTrustState> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
    if (!task) {
      throw new Error(`Task "${tid}" not found.`);
    }

    const isBlocked = this.db.prepare('SELECT task_id FROM blocked_tasks WHERE task_id = ?').get(tid);
    if (isBlocked) {
      return 'BLOCKED_NEEDS_HUMAN';
    }

    // Find highest attempt number across handoffs and verifications
    const row = this.db
      .prepare(`
        SELECT MAX(attempt_number) as max_attempt FROM (
          SELECT attempt_number FROM handoffs WHERE task_id = ?
          UNION ALL
          SELECT attempt_number FROM verification_records WHERE task_id = ?
        )
      `)
      .get(tid, tid) as { max_attempt: number | null } | undefined;

    const highestAttempt = row?.max_attempt;
    if (highestAttempt === null || highestAttempt === undefined) {
      return 'UNVERIFIED';
    }

    // Check verification of the latest attempt
    const verif = await this.getVerificationRecord(tid, highestAttempt);
    if (verif) {
      if (verif.result?.status === 'VERIFIED') {
        const checks = verif.result.checks;
        if (!Array.isArray(checks) || checks.length === 0) {
          return 'FAILED'; // Fail closed: missing or empty checks
        }
        const requiredChecks = checks.filter((c) => (c as any)?.optional !== true);
        if (requiredChecks.length === 0) {
          return 'FAILED'; // Fail closed: no required checks
        }
        const allRequiredValidAndPassed = requiredChecks.every((c) => {
          if (!c || typeof c !== 'object') return false;
          if (typeof c.checkId !== 'string' || !c.checkId) return false;
          if (c.passed !== true) return false;
          if (c.exitCode !== 0) return false;
          if (c.timedOut) return false;
          if (c.signal !== null) return false;
          return true;
        });

        if (!allRequiredValidAndPassed) {
          return 'FAILED';
        }

        // Source freshness validation if requested
        if (options?.workspaceRoot || options?.currentFingerprint || options?.requireFreshness) {
          const boundFingerprint = verif.sourceSnapshot?.fingerprint;
          if (!boundFingerprint || typeof boundFingerprint !== 'string') {
            return 'FAILED'; // Legacy or missing snapshot fails closed
          }

          if (options.currentFingerprint) {
            if (options.currentFingerprint !== boundFingerprint) {
              return 'FAILED';
            }
          }

          if (options.workspaceRoot) {
            try {
              const computeFn = options.computeSnapshotFn ?? computeSourceSnapshot;
              const currentSnapshot = await computeFn(options.workspaceRoot);
              if (currentSnapshot.fingerprint !== boundFingerprint) {
                return 'FAILED';
              }
            } catch {
              return 'FAILED'; // Error computing snapshot fails closed
            }
          }
        }

        return 'VERIFIED';
      }
      return 'FAILED';
    }

    // If latest attempt has a handoff but no verification yet
    const handoff = await this.getHandoff(tid, highestAttempt);
    if (handoff) {
      return 'CLAIMED';
    }

    return 'UNVERIFIED';
  }

  async promoteTask(taskId: string, options: PromoteTaskOptions): Promise<PromotionResult> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
    if (!task) {
      throw new PromotionError('TASK_NOT_FOUND', tid, `Task "${tid}" not found.`);
    }

    const isBlocked = this.db.prepare('SELECT task_id FROM blocked_tasks WHERE task_id = ?').get(tid);
    if (isBlocked) {
      throw new PromotionError(
        'TASK_BLOCKED',
        tid,
        `Task "${tid}" is in BLOCKED_NEEDS_HUMAN state.`
      );
    }

    if (!options || typeof options !== 'object' || !options.workspaceRoot?.trim()) {
      throw new Error('PromoteTaskOptions requires a valid non-empty workspaceRoot.');
    }

    const row = this.db
      .prepare(`
        SELECT MAX(attempt_number) as max_attempt FROM (
          SELECT attempt_number FROM handoffs WHERE task_id = ?
          UNION ALL
          SELECT attempt_number FROM verification_records WHERE task_id = ?
        )
      `)
      .get(tid, tid) as { max_attempt: number | null } | undefined;

    const highestAttempt = row?.max_attempt;
    if (highestAttempt === null || highestAttempt === undefined) {
      throw new PromotionError('TASK_NOT_VERIFIED', tid, `Task "${tid}" has no attempts.`);
    }

    if (
      options.expectedAttemptNumber !== undefined &&
      options.expectedAttemptNumber !== highestAttempt
    ) {
      throw new PromotionError(
        'ATTEMPT_MISMATCH',
        tid,
        `Cannot promote task "${tid}": expected attempt ${options.expectedAttemptNumber}, but latest attempt is ${highestAttempt}.`
      );
    }

    const latestVerification = await this.getVerificationRecord(tid, highestAttempt);
    if (!latestVerification || latestVerification.result?.status !== 'VERIFIED') {
      throw new PromotionError(
        'TASK_NOT_VERIFIED',
        tid,
        `Cannot promote task "${tid}": latest attempt ${highestAttempt} is not verified.`
      );
    }

    const checks = latestVerification.result.checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      throw new PromotionError(
        'TASK_NOT_VERIFIED',
        tid,
        `Cannot promote task "${tid}": verification checks are missing.`
      );
    }
    const requiredChecks = checks.filter((c) => (c as any)?.optional !== true);
    if (requiredChecks.length === 0) {
      throw new PromotionError(
        'TASK_NOT_VERIFIED',
        tid,
        `Cannot promote task "${tid}": no required verification checks.`
      );
    }
    const allRequiredValidAndPassed = requiredChecks.every((c) => {
      if (!c || typeof c !== 'object') return false;
      if (typeof c.checkId !== 'string' || !c.checkId) return false;
      if (c.passed !== true) return false;
      if (c.exitCode !== 0) return false;
      if (c.timedOut) return false;
      if (c.signal !== null) return false;
      return true;
    });

    if (!allRequiredValidAndPassed) {
      throw new PromotionError(
        'TASK_NOT_VERIFIED',
        tid,
        `Cannot promote task "${tid}": required verification checks failed.`
      );
    }

    const boundSnapshot = latestVerification.sourceSnapshot;
    if (!boundSnapshot || !boundSnapshot.fingerprint) {
      throw new SourceFreshnessError(
        'SOURCE_SNAPSHOT_MISSING',
        tid,
        highestAttempt,
        undefined,
        undefined,
        `Cannot promote task "${tid}": verification record for attempt ${highestAttempt} lacks source snapshot identity.`
      );
    }

    let currentSnapshot: SourceSnapshotIdentity;
    try {
      const computeFn = options.computeSnapshotFn ?? computeSourceSnapshot;
      currentSnapshot = await computeFn(options.workspaceRoot);
    } catch (err: unknown) {
      throw new SourceFreshnessError(
        'SOURCE_FINGERPRINT_FAILED',
        tid,
        highestAttempt,
        boundSnapshot.fingerprint,
        undefined,
        `Cannot promote task "${tid}": failed to compute current workspace source snapshot: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (currentSnapshot.fingerprint !== boundSnapshot.fingerprint) {
      throw new SourceFreshnessError(
        'SOURCE_FRESHNESS_MISMATCH',
        tid,
        highestAttempt,
        boundSnapshot.fingerprint,
        currentSnapshot.fingerprint,
        `Source freshness violation: workspace source has changed since verification attempt ${highestAttempt} was completed. Expected fingerprint "${boundSnapshot.fingerprint}", got "${currentSnapshot.fingerprint}". Verification must be rerun.`
      );
    }

    return {
      taskId: tid,
      attemptNumber: highestAttempt,
      status: 'VERIFIED',
      sourceSnapshot: boundSnapshot,
      promotedAt: new Date().toISOString(),
    };
  }

  async getTaskHistory(taskId: string): Promise<TaskAttempt[]> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
    if (!task) {
      throw new Error(`Task "${tid}" not found.`);
    }

    // Get all distinct attempt numbers
    const rows = this.db
      .prepare(`
        SELECT DISTINCT attempt_number FROM (
          SELECT attempt_number FROM handoffs WHERE task_id = ?
          UNION ALL
          SELECT attempt_number FROM verification_records WHERE task_id = ?
        ) ORDER BY attempt_number ASC
      `)
      .all(tid, tid) as Array<{ attempt_number: number }>;

    const attempts: TaskAttempt[] = [];
    for (const r of rows) {
      const num = Number(r.attempt_number);
      const handoff = await this.getHandoff(tid, num);
      const verification = await this.getVerificationRecord(tid, num);

      attempts.push({
        attemptNumber: num,
        handoff: handoff ?? undefined,
        verification: verification ?? undefined,
        verificationRecord: verification ?? undefined,
      });
    }

    return attempts;
  }

  async getTaskMetrics(taskId: string): Promise<TaskMetrics> {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new Error('Task ID must be a non-empty string.');
    }
    const tid = taskId.trim();
    const task = this.db.prepare('SELECT id FROM tasks WHERE id = ?').get(tid);
    if (!task) {
      throw new Error(`Task "${tid}" not found.`);
    }

    const verifStats = this.db
      .prepare(`
        SELECT
          COUNT(*) as total_verif,
          SUM(CASE WHEN result_status = 'FAILED' THEN 1 ELSE 0 END) as failed_verif
        FROM verification_records
        WHERE task_id = ?
      `)
      .get(tid) as { total_verif: number; failed_verif: number };

    const verificationAttempts = Number(verifStats.total_verif ?? 0);
    const verificationFailures = Number(verifStats.failed_verif ?? 0);

    const maxRow = this.db
      .prepare(`
        SELECT MAX(attempt_number) as max_attempt FROM (
          SELECT attempt_number FROM handoffs WHERE task_id = ?
          UNION ALL
          SELECT attempt_number FROM verification_records WHERE task_id = ?
        )
      `)
      .get(tid, tid) as { max_attempt: number | null } | undefined;

    const highestAttempt = maxRow?.max_attempt ?? 0;
    const repairAttempts = Math.max(0, highestAttempt - 1);

    const latestVerification = highestAttempt > 0 ? await this.getVerificationRecord(tid, highestAttempt) : null;
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
