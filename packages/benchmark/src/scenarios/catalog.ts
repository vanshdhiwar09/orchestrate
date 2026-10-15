import type { ScenarioDefinition } from './types.js';

export const SCENARIO_CATALOG: Record<string, ScenarioDefinition> = {
  'auth-protected-api': {
    scenarioId: 'auth-protected-api',
    alias: 'sc-auth-api',
    title: 'Protected API Route with Authentication Middleware',
    description:
      'Task A implements JWT authentication middleware. Task B implements a protected /api/profile endpoint consuming that middleware.',
    taskAId: 'task-auth-middleware',
    taskBId: 'task-profile-endpoint',
    baseCommitMessage: 'feat(sc-auth-api): initial repository setup with user fixture and server',
    taskACommitMessage: 'feat(sc-auth-api): implement jwt authentication middleware (Task A)',
    baseCommitSha: '2da044cec926af73289acc19a68d65b6d29240c9',
    canonicalSnapshotCommitSha: '69ab5f6921b6240a125626be3afb705bb378d5b9',
    baseFiles: [
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'auth-protected-api',
            version: '1.0.0',
            type: 'module',
            scripts: {
              test: 'node --test',
            },
          },
          null,
          2
        ) + '\n',
      },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              allowImportingTsExtensions: true,
              noEmit: true,
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
            },
            include: ['src/**/*', 'test/**/*'],
          },
          null,
          2
        ) + '\n',
      },
      {
        path: 'src/types.ts',
        content: `export interface UserPayload {
  id: string;
  email: string;
  role: string;
}

export interface User {
  id: string;
  email: string;
  role: string;
  displayName: string;
}
`,
      },
      {
        path: 'src/users.ts',
        content: `import type { User } from './types.ts';

export const USERS: Record<string, User> = {
  'usr-alice': {
    id: 'usr-alice',
    email: 'alice@example.com',
    role: 'admin',
    displayName: 'Alice Admin',
  },
  'usr-bob': {
    id: 'usr-bob',
    email: 'bob@example.com',
    role: 'member',
    displayName: 'Bob Member',
  },
};
`,
      },
      {
        path: 'src/server.ts',
        content: `import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export function createTestServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  return createServer(handler);
}
`,
      },
    ],
    taskAFiles: [
      {
        path: 'src/middleware/auth.ts',
        content: `import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserPayload } from '../types.ts';
import { USERS } from '../users.ts';

export interface AuthRequest extends IncomingMessage {
  user?: UserPayload;
}

export function authenticateToken(
  req: AuthRequest,
  res: ServerResponse,
  next: () => void
): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || typeof authHeader !== 'string') {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing authorization header' }));
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid authorization format' }));
    return;
  }

  const token = parts[1];
  // Deterministic token resolution for benchmark environment
  const user = Object.values(USERS).find((u) => \`token-\${u.id}\` === token);
  if (!user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    return;
  }

  req.user = {
    id: user.id,
    email: user.email,
    role: user.role,
  };
  next();
}
`,
      },
      {
        path: 'test/auth.test.ts',
        content: `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateToken, type AuthRequest } from '../src/middleware/auth.ts';
import type { ServerResponse } from 'node:http';

describe('Auth Middleware (Task A)', () => {
  it('accepts valid Bearer token and attaches user payload', () => {
    let nextCalled = false;
    let endCalled = false;
    const req = {
      headers: { authorization: 'Bearer token-usr-alice' },
    } as unknown as AuthRequest;
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: () => { endCalled = true; },
    } as unknown as ServerResponse;

    authenticateToken(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(endCalled, false);
    assert.equal(req.user?.id, 'usr-alice');
    assert.equal(req.user?.role, 'admin');
  });

  it('rejects missing authorization header with 401', () => {
    let nextCalled = false;
    let capturedBody = '';
    const req = { headers: {} } as unknown as AuthRequest;
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: (chunk: string) => { capturedBody = chunk; },
    } as unknown as ServerResponse;

    authenticateToken(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.ok(capturedBody.includes('Missing authorization header'));
  });

  it('rejects invalid token with 401', () => {
    let nextCalled = false;
    let capturedBody = '';
    const req = {
      headers: { authorization: 'Bearer invalid-token' },
    } as unknown as AuthRequest;
    const res = {
      statusCode: 200,
      setHeader: () => {},
      end: (chunk: string) => { capturedBody = chunk; },
    } as unknown as ServerResponse;

    authenticateToken(req, res, () => { nextCalled = true; });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.ok(capturedBody.includes('Invalid or expired token'));
  });
});
`,
      },
    ],
    manifest: {
      taskId: 'task-auth-middleware',
      attemptNumber: 1,
      createdAt: '2026-10-01T14:00:00.000Z',
      files: [
        {
          path: 'src/middleware/auth.ts',
          status: 'ADDED',
          symbols: [
            {
              name: 'AuthRequest',
              kind: 'interface',
              signature: 'export interface AuthRequest extends IncomingMessage { user?: UserPayload; }',
            },
            {
              name: 'authenticateToken',
              kind: 'function',
              signature: 'export function authenticateToken(req: AuthRequest, res: ServerResponse, next: () => void): void',
            },
          ],
        },
      ],
    },
    taskBPrompt:
      'Implement the protected profile route in src/routes/profile.ts. The handler must use the authentication middleware from src/middleware/auth.ts to verify the user and return their full profile from src/users.ts. Handle invalid/missing tokens with 401.',
    armBUnverifiedHandoff: JSON.stringify({
      summary: 'Task A completed: implemented JWT Bearer authentication middleware.',
      filesAffected: ['src/middleware/auth.ts'],
      symbols: ['authenticateToken', 'AuthRequest'],
      decisionsCreated: ['Use Bearer token format with USERS table lookup'],
    }),
    armCCompiledContext: `<orchestrate_context>
  <upstream_work task_id="task-auth-middleware" trust_state="VERIFIED" attempt="1">
    <files_affected>
      <file>src/middleware/auth.ts</file>
    </files_affected>
    <symbols>
      <symbol>authenticateToken</symbol>
      <symbol>AuthRequest</symbol>
    </symbols>
  </upstream_work>
  <architectural_decisions>
    <decision id="dec-auth-bearer">
      <statement>Authenticate via Bearer token format; attach authenticated user to req.user.</statement>
    </decision>
  </architectural_decisions>
</orchestrate_context>`,
    verificationChecksTaskA: [
      {
        id: 'check-auth-middleware-unit',
        name: 'unit_tests_auth_middleware',
        command: 'node',
        args: ['--test', 'test/auth.test.ts'],
        timeoutMs: 30000,
      },
    ],
    verificationChecksTaskB: [
      {
        id: 'check-profile-endpoint-integration',
        name: 'integration_tests_profile_endpoint',
        command: 'node',
        args: ['--test', 'test/profile.test.ts'],
        timeoutMs: 30000,
      },
    ],
  },

  'auth-password-reset': {
    scenarioId: 'auth-password-reset',
    alias: 'sc-pass-reset',
    title: 'Password Reset Service and Confirmation Endpoint',
    description:
      'Task A implements password reset token generator and storage schema. Task B implements the confirmation endpoint consuming that service.',
    taskAId: 'task-password-reset',
    taskBId: 'task-confirm-reset',
    baseCommitMessage: 'feat(sc-pass-reset): initial user entity and in-memory store',
    taskACommitMessage: 'feat(sc-pass-reset): implement password reset service and token expiry (Task A)',
    baseCommitSha: 'c9cba9965dc6b6ccd23e25637bbd70a9aa99616e',
    canonicalSnapshotCommitSha: '8c1e35910cf565433a0e8d67b5ebf3a960977f99',
    baseFiles: [
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'auth-password-reset',
            version: '1.0.0',
            type: 'module',
            scripts: {
              test: 'node --test',
            },
          },
          null,
          2
        ) + '\n',
      },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              allowImportingTsExtensions: true,
              noEmit: true,
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
            },
            include: ['src/**/*', 'test/**/*'],
          },
          null,
          2
        ) + '\n',
      },
      {
        path: 'src/types.ts',
        content: `export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
}
`,
      },
      {
        path: 'src/config/env.ts',
        content: `export const BASE_URL: string = 'http://localhost:3000';
`,
      },
      {
        path: 'src/db.ts',
        content: `import type { UserRecord } from './types.ts';

export const USERS_DB = new Map<string, UserRecord>([
  ['usr-1', { id: 'usr-1', email: 'alice@example.com', passwordHash: 'hash-old-alice' }],
  ['usr-2', { id: 'usr-2', email: 'bob@example.com', passwordHash: 'hash-old-bob' }],
]);

export function findUserByEmail(email: string): UserRecord | undefined {
  for (const user of USERS_DB.values()) {
    if (user.email === email) return user;
  }
  return undefined;
}

export function updateUserPassword(userId: string, newPasswordHash: string): boolean {
  const user = USERS_DB.get(userId);
  if (!user) return false;
  user.passwordHash = newPasswordHash;
  return true;
}
`,
      },
    ],
    taskAFiles: [
      {
        path: 'src/config/env.ts',
        content: `export const BASE_URL: string = 'http://localhost:3000';
export const PASSWORD_RESET_EXPIRY_MS: number = 3600000;
`,
      },
      {
        path: 'src/services/password-reset.ts',
        content: `import { PASSWORD_RESET_EXPIRY_MS } from '../config/env.ts';

export interface ResetTokenRecord {
  token: string;
  userId: string;
  expiresAt: number;
}

const RESET_TOKENS = new Map<string, ResetTokenRecord>();

export function generateResetToken(userId: string, ttlMs: number = PASSWORD_RESET_EXPIRY_MS): string {
  const token = \`rst-\${userId}-\${Date.now()}-\${Math.random().toString(36).slice(2, 8)}\`;
  RESET_TOKENS.set(token, {
    token,
    userId,
    expiresAt: Date.now() + ttlMs,
  });
  return token;
}

export function validateResetToken(token: string): { valid: boolean; userId?: string } {
  const record = RESET_TOKENS.get(token);
  if (!record) {
    return { valid: false };
  }
  if (Date.now() > record.expiresAt) {
    RESET_TOKENS.delete(token);
    return { valid: false };
  }
  return { valid: true, userId: record.userId };
}

export function consumeResetToken(token: string): boolean {
  const validation = validateResetToken(token);
  if (!validation.valid) {
    return false;
  }
  RESET_TOKENS.delete(token);
  return true;
}
`,
      },
      {
        path: 'test/password-reset.test.ts',
        content: `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateResetToken,
  validateResetToken,
  consumeResetToken,
} from '../src/services/password-reset.ts';

describe('Password Reset Service (Task A)', () => {
  it('generates a valid reset token and validates it', () => {
    const token = generateResetToken('usr-1');
    const result = validateResetToken(token);
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'usr-1');
  });

  it('rejects expired tokens', () => {
    // Generate token with negative TTL (already expired)
    const token = generateResetToken('usr-1', -1000);
    const result = validateResetToken(token);
    assert.equal(result.valid, false);
  });

  it('consumes token so it cannot be used a second time', () => {
    const token = generateResetToken('usr-2');
    const consumed = consumeResetToken(token);
    assert.equal(consumed, true);

    const recheck = validateResetToken(token);
    assert.equal(recheck.valid, false);
  });
});
`,
      },
    ],
    manifest: {
      taskId: 'task-password-reset',
      attemptNumber: 1,
      createdAt: '2026-10-01T14:10:00.000Z',
      files: [
        {
          path: 'src/config/env.ts',
          status: 'MODIFIED',
          symbols: [
            {
              name: 'PASSWORD_RESET_EXPIRY_MS',
              kind: 'variable',
              signature: 'export const PASSWORD_RESET_EXPIRY_MS: number = 3600000;',
            },
          ],
        },
        {
          path: 'src/services/password-reset.ts',
          status: 'ADDED',
          symbols: [
            {
              name: 'generateResetToken',
              kind: 'function',
              signature: 'export function generateResetToken(userId: string, ttlMs?: number): string',
            },
            {
              name: 'validateResetToken',
              kind: 'function',
              signature: 'export function validateResetToken(token: string): { valid: boolean; userId?: string }',
            },
            {
              name: 'consumeResetToken',
              kind: 'function',
              signature: 'export function consumeResetToken(token: string): boolean',
            },
          ],
        },
      ],
    },
    taskBPrompt:
      'Implement the password reset confirmation endpoint POST /api/auth/reset-password in src/routes/reset.ts. It must accept token and newPassword, validate and consume the token via src/services/password-reset.ts, and update the user password in src/db.ts.',
    armBUnverifiedHandoff: JSON.stringify({
      summary: 'Task A completed: implemented password reset token generation and validation service.',
      filesAffected: ['src/config/env.ts', 'src/services/password-reset.ts'],
      symbols: ['PASSWORD_RESET_EXPIRY_MS', 'generateResetToken', 'validateResetToken', 'consumeResetToken'],
    }),
    armCCompiledContext: `<orchestrate_context>
  <upstream_work task_id="task-password-reset" trust_state="VERIFIED" attempt="1">
    <files_affected>
      <file>src/config/env.ts</file>
      <file>src/services/password-reset.ts</file>
    </files_affected>
    <symbols>
      <symbol>PASSWORD_RESET_EXPIRY_MS</symbol>
      <symbol>generateResetToken</symbol>
      <symbol>validateResetToken</symbol>
      <symbol>consumeResetToken</symbol>
    </symbols>
  </upstream_work>
</orchestrate_context>`,
    verificationChecksTaskA: [
      {
        id: 'check-password-reset-unit',
        name: 'unit_tests_password_reset',
        command: 'node',
        args: ['--test', 'test/password-reset.test.ts'],
        timeoutMs: 30000,
      },
    ],
    verificationChecksTaskB: [
      {
        id: 'check-reset-endpoint-integration',
        name: 'integration_tests_reset_endpoint',
        command: 'node',
        args: ['--test', 'test/reset.test.ts'],
        timeoutMs: 30000,
      },
    ],
  },

  'data-model-feature': {
    scenarioId: 'data-model-feature',
    alias: 'sc-data-model',
    title: 'Project Entity Repository and Summary Service',
    description:
      'Task A defines Project entity and database repository interface. Task B implements ProjectSummaryService consuming the repository.',
    taskAId: 'task-project-repository',
    taskBId: 'task-project-summary',
    baseCommitMessage: 'feat(sc-data-model): initial repository schema and server structure',
    taskACommitMessage: 'feat(sc-data-model): implement project entity and repository (Task A)',
    baseCommitSha: '132d6dd5c728cc19879a840efc7bc71e89d0a5f2',
    canonicalSnapshotCommitSha: 'd31c602081146f7b68a156f1f81b64e0fc75ab61',
    baseFiles: [
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'data-model-feature',
            version: '1.0.0',
            type: 'module',
            scripts: {
              test: 'node --test',
            },
          },
          null,
          2
        ) + '\n',
      },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              allowImportingTsExtensions: true,
              noEmit: true,
              strict: true,
              esModuleInterop: true,
              skipLibCheck: true,
            },
            include: ['src/**/*', 'test/**/*'],
          },
          null,
          2
        ) + '\n',
      },
      {
        path: 'src/data/schema.ts',
        content: `export interface BaseEntity {
  id: string;
  createdAt: string;
}
`,
      },
      {
        path: 'src/server.ts',
        content: `export function registerDataRoutes(): void {
  // Routes registered here
}
`,
      },
    ],
    taskAFiles: [
      {
        path: 'src/data/schema.ts',
        content: `export interface BaseEntity {
  id: string;
  createdAt: string;
}

export interface ProjectEntity extends BaseEntity {
  name: string;
  status: 'PLANNED' | 'ACTIVE' | 'COMPLETED';
  tasksTotal: number;
  tasksDone: number;
}

export const projectsTable = new Map<string, ProjectEntity>();
`,
      },
      {
        path: 'src/data/project-repository.ts',
        content: `import { projectsTable, type ProjectEntity } from './schema.ts';

export class ProjectRepository {
  async findById(id: string): Promise<ProjectEntity | null> {
    const project = projectsTable.get(id);
    return project ? { ...project } : null;
  }

  async create(data: Omit<ProjectEntity, 'id' | 'createdAt'>): Promise<ProjectEntity> {
    const id = \`prj-\${Date.now()}-\${Math.random().toString(36).slice(2, 7)}\`;
    const entity: ProjectEntity = {
      ...data,
      id,
      createdAt: new Date().toISOString(),
    };
    projectsTable.set(id, entity);
    return { ...entity };
  }

  async update(id: string, updates: Partial<Omit<ProjectEntity, 'id' | 'createdAt'>>): Promise<ProjectEntity | null> {
    const existing = projectsTable.get(id);
    if (!existing) return null;
    const updated: ProjectEntity = {
      ...existing,
      ...updates,
    };
    projectsTable.set(id, updated);
    return { ...updated };
  }

  async listAll(): Promise<ProjectEntity[]> {
    return Array.from(projectsTable.values()).map((p) => ({ ...p }));
  }
}
`,
      },
      {
        path: 'test/project-repository.test.ts',
        content: `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectRepository } from '../src/data/project-repository.ts';
import { projectsTable } from '../src/data/schema.ts';

describe('ProjectRepository (Task A)', () => {
  it('creates a project entity and stores it in the database', async () => {
    projectsTable.clear();
    const repo = new ProjectRepository();
    const created = await repo.create({
      name: 'Alpha Project',
      status: 'ACTIVE',
      tasksTotal: 10,
      tasksDone: 4,
    });

    assert.ok(created.id.startsWith('prj-'));
    assert.equal(created.name, 'Alpha Project');
    assert.equal(created.tasksDone, 4);

    const found = await repo.findById(created.id);
    assert.ok(found);
    assert.equal(found?.name, 'Alpha Project');
  });

  it('updates project fields and returns updated entity', async () => {
    projectsTable.clear();
    const repo = new ProjectRepository();
    const created = await repo.create({
      name: 'Beta Project',
      status: 'PLANNED',
      tasksTotal: 5,
      tasksDone: 0,
    });

    const updated = await repo.update(created.id, {
      status: 'ACTIVE',
      tasksDone: 2,
    });

    assert.ok(updated);
    assert.equal(updated?.status, 'ACTIVE');
    assert.equal(updated?.tasksDone, 2);
  });

  it('returns null when project is not found', async () => {
    const repo = new ProjectRepository();
    const found = await repo.findById('non-existent');
    assert.equal(found, null);
  });
});
`,
      },
    ],
    manifest: {
      taskId: 'task-project-repository',
      attemptNumber: 1,
      createdAt: '2026-10-01T14:05:00.000Z',
      files: [
        {
          path: 'src/data/schema.ts',
          status: 'MODIFIED',
          symbols: [
            {
              name: 'ProjectEntity',
              kind: 'interface',
              signature: 'export interface ProjectEntity extends BaseEntity { name: string; status: "PLANNED" | "ACTIVE" | "COMPLETED"; tasksTotal: number; tasksDone: number; }',
            },
            {
              name: 'projectsTable',
              kind: 'variable',
              signature: 'export const projectsTable: Map<string, ProjectEntity>',
            },
          ],
        },
        {
          path: 'src/data/project-repository.ts',
          status: 'ADDED',
          symbols: [
            {
              name: 'ProjectRepository',
              kind: 'class',
              signature: 'export class ProjectRepository',
            },
          ],
        },
      ],
    },
    taskBPrompt:
      'Implement ProjectSummaryService in src/services/project-summary.ts consuming ProjectRepository. Calculate completion percentages and assign status badges (PLANNED, IN_PROGRESS, COMPLETED).',
    armBUnverifiedHandoff: JSON.stringify({
      summary: 'Task A completed: defined ProjectEntity schema and implemented ProjectRepository CRUD operations.',
      filesAffected: ['src/data/schema.ts', 'src/data/project-repository.ts'],
      symbols: ['ProjectEntity', 'projectsTable', 'ProjectRepository'],
    }),
    armCCompiledContext: `<orchestrate_context>
  <upstream_work task_id="task-project-repository" trust_state="VERIFIED" attempt="1">
    <files_affected>
      <file>src/data/schema.ts</file>
      <file>src/data/project-repository.ts</file>
    </files_affected>
    <symbols>
      <symbol>ProjectEntity</symbol>
      <symbol>projectsTable</symbol>
      <symbol>ProjectRepository</symbol>
    </symbols>
  </upstream_work>
</orchestrate_context>`,
    verificationChecksTaskA: [
      {
        id: 'check-project-repo-unit',
        name: 'unit_tests_project_repository',
        command: 'node',
        args: ['--test', 'test/project-repository.test.ts'],
        timeoutMs: 30000,
      },
    ],
    verificationChecksTaskB: [
      {
        id: 'check-project-summary-integration',
        name: 'integration_tests_project_summary',
        command: 'node',
        args: ['--test', 'test/project-summary.test.ts'],
        timeoutMs: 30000,
      },
    ],
  },
};
