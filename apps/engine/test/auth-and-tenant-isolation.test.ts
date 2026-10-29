import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEngineServer,
  SqliteProjectBrain,
  MemoryProjectBrain,
  createAuthToken,
  DEFAULT_JWT_ISSUER,
  DEFAULT_JWT_AUDIENCE,
  type EngineServerInstance,
} from '../src/index.js';

describe('Engine Authentication, Authorization & Tenant Isolation', () => {
  const TEST_SECRET = 'super-secret-test-key-with-sufficient-entropy-32chars!';
  let tmpDir: string;
  let dbPath: string;
  let brain: SqliteProjectBrain;
  let serverInstance: EngineServerInstance;
  let baseUrl: string;

  // Helpers to generate valid and expired JWT tokens for test tenants
  const createTestToken = (
    userId: string,
    secret = TEST_SECRET,
    options?: { expiresInSeconds?: number; issuer?: string; audience?: string }
  ) => {
    return createAuthToken(
      {
        sub: userId,
        role: 'user',
        expiresInSeconds: options?.expiresInSeconds ?? 3600,
        issuer: options?.issuer ?? DEFAULT_JWT_ISSUER,
        audience: options?.audience ?? DEFAULT_JWT_AUDIENCE,
      },
      secret
    );
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'orchestrate-auth-test-'));
    dbPath = join(tmpDir, 'test-brain.sqlite');
    brain = new SqliteProjectBrain({ databasePath: dbPath });

    // Server started WITH authentication required by default
    serverInstance = createEngineServer({
      brain,
      port: 0,
      host: '127.0.0.1',
      jwtSecret: TEST_SECRET,
      authRequired: true,
      workspacesDir: join(tmpDir, 'workspaces'),
    });

    const info = await serverInstance.start();
    baseUrl = info.url;
  });

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.stop();
    }
    brain.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // 1. AUTHENTICATION ENFORCEMENT & PUBLIC ROUTES
  // ==========================================================================

  describe('1. Authentication Enforcement & Public Routes', () => {
    it('allows GET /health without authentication', async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
    });

    it('allows CORS OPTIONS preflight without authentication', async () => {
      const res = await fetch(`${baseUrl}/projects`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
    });

    it('rejects unauthenticated requests to protected endpoints with 401 Unauthorized', async () => {
      const endpoints = [
        { url: `${baseUrl}/projects`, method: 'GET' },
        { url: `${baseUrl}/projects`, method: 'POST', body: { id: 'p1', name: 'P1' } },
        { url: `${baseUrl}/config/model`, method: 'GET' },
        { url: `${baseUrl}/config/model`, method: 'POST', body: { model: 'test' } },
        { url: `${baseUrl}/config/model/registry`, method: 'GET' },
        { url: `${baseUrl}/projects/open-folder`, method: 'POST', body: { path: tmpDir } },
      ];

      for (const endpoint of endpoints) {
        const res = await fetch(endpoint.url, {
          method: endpoint.method,
          headers: endpoint.body ? { 'Content-Type': 'application/json' } : {},
          body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
        });

        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toMatch(/Unauthorized/);
      }
    });

    it('rejects malformed Authorization headers with 401', async () => {
      const malformedHeaders = [
        'Basic dXNlcjpwYXNz', // basic auth
        'Bearer', // missing token
        'Bearer ', // whitespace only
        'Bearer invalid.token', // invalid structure
        'Token abcdef', // wrong prefix
      ];

      for (const header of malformedHeaders) {
        const res = await fetch(`${baseUrl}/projects`, {
          headers: { Authorization: header },
        });
        expect(res.status).toBe(401);
      }
    });

    it('rejects tokens with invalid signature with 401', async () => {
      const forgedToken = createTestToken('user-1', 'completely-different-signing-key-32ch!');
      const res = await fetch(`${baseUrl}/projects`, {
        headers: { Authorization: `Bearer ${forgedToken}` },
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid token signature/);
    });

    it('rejects expired tokens with 401', async () => {
      const expiredToken = createTestToken('user-1', TEST_SECRET, {
        expiresInSeconds: -10, // expired 10 seconds ago
      });

      const res = await fetch(`${baseUrl}/projects`, {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toMatch(/Authentication token has expired/);
    });

    it('rejects tokens with invalid issuer or audience with 401', async () => {
      const wrongIssuer = createTestToken('user-1', TEST_SECRET, { issuer: 'rogue-issuer' });
      const res1 = await fetch(`${baseUrl}/projects`, {
        headers: { Authorization: `Bearer ${wrongIssuer}` },
      });
      expect(res1.status).toBe(401);

      const wrongAudience = createTestToken('user-1', TEST_SECRET, { audience: 'rogue-audience' });
      const res2 = await fetch(`${baseUrl}/projects`, {
        headers: { Authorization: `Bearer ${wrongAudience}` },
      });
      expect(res2.status).toBe(401);
    });

    it('accepts valid signed token and allows project creation', async () => {
      const validToken = createTestToken('user-alice');
      const res = await fetch(`${baseUrl}/projects`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'proj-alice-1', name: 'Alice Project' }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe('proj-alice-1');
      expect(data.ownerId).toBe('user-alice');
    });
  });

  // ==========================================================================
  // 2. PRODUCTION SECURITY INVARIANTS & SECRET ROTATION
  // ==========================================================================

  describe('2. Production Security Invariants', () => {
    it('fails closed at startup in production if ORCHESTRATE_JWT_SECRET is missing or insecure', () => {
      const origEnv = process.env.NODE_ENV;
      const origSecret = process.env.ORCHESTRATE_JWT_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.ORCHESTRATE_JWT_SECRET;

        // Missing secret in production
        expect(() =>
          createEngineServer({
            brain: new MemoryProjectBrain(),
            port: 0,
          })
        ).toThrow(/ORCHESTRATE_JWT_SECRET must be set in production mode/);

        // Weak secret (< 32 chars)
        expect(() =>
          createEngineServer({
            brain: new MemoryProjectBrain(),
            jwtSecret: 'short-key',
            port: 0,
          })
        ).toThrow(/Production JWT secret must be at least 32 characters/);

        // Attempting to disable auth in production
        expect(() =>
          createEngineServer({
            brain: new MemoryProjectBrain(),
            jwtSecret: 'sufficiently-long-secret-key-at-least-32-chars!',
            authRequired: false,
            port: 0,
          })
        ).toThrow(/Authentication cannot be disabled in production mode/);

        // Attempting to enable devMode in production
        expect(() =>
          createEngineServer({
            brain: new MemoryProjectBrain(),
            jwtSecret: 'sufficiently-long-secret-key-at-least-32-chars!',
            devMode: true,
            port: 0,
          })
        ).toThrow(/Development mode cannot be enabled in production mode/);
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origSecret) process.env.ORCHESTRATE_JWT_SECRET = origSecret;
        else delete process.env.ORCHESTRATE_JWT_SECRET;
      }
    });

    it('blocks local folder opening in production mode with 403 Forbidden', async () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const prodServer = createEngineServer({
          brain: new MemoryProjectBrain(),
          jwtSecret: 'production-secret-with-sufficient-length-32ch!',
          port: 0,
        });
        await prodServer.start();

        try {
          const token = createTestToken('admin', 'production-secret-with-sufficient-length-32ch!');
          const res = await fetch(`${prodServer.url}/projects/open-folder`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ path: tmpDir }),
          });

          expect(res.status).toBe(403);
          const data = await res.json();
          expect(data.error).toMatch(/Local folder opening is disabled in production/);
        } finally {
          await prodServer.stop();
        }
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });

    it('blocks local repository validate and import in production mode with 403 Forbidden', async () => {
      const origEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const prodBrain = new MemoryProjectBrain();
        await prodBrain.createProject({ id: 'prod-proj', name: 'Prod Proj', ownerId: 'prod-user' });

        const prodServer = createEngineServer({
          brain: prodBrain,
          jwtSecret: 'production-secret-with-sufficient-length-32ch!',
          port: 0,
        });
        await prodServer.start();

        try {
          const token = createTestToken('prod-user', 'production-secret-with-sufficient-length-32ch!');

          // Validate local
          const valRes = await fetch(`${prodServer.url}/projects/prod-proj/repository/validate`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ type: 'local', path: tmpDir }),
          });
          expect(valRes.status).toBe(403);
          const valData = await valRes.json();
          expect(valData.error).toMatch(/disabled in production/);

          // Import local
          const impRes = await fetch(`${prodServer.url}/projects/prod-proj/repository/import`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ type: 'local', path: tmpDir }),
          });
          expect(impRes.status).toBe(403);
          const impData = await impRes.json();
          expect(impData.error).toMatch(/disabled in production/);
        } finally {
          await prodServer.stop();
        }
      } finally {
        process.env.NODE_ENV = origEnv;
      }
    });
  });

  // ==========================================================================
  // 3. TENANT ISOLATION & IDOR PREVENTION
  // ==========================================================================

  describe('3. Multi-Tenant Isolation & IDOR Prevention', () => {
    const aliceToken = createTestToken('user-alice');
    const bobToken = createTestToken('user-bob');

    beforeEach(async () => {
      // Alice creates project-alice
      await fetch(`${baseUrl}/projects`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'project-alice', name: 'Alice Private Project' }),
      });

      // Bob creates project-bob
      await fetch(`${baseUrl}/projects`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'project-bob', name: 'Bob Private Project' }),
      });

      // Alice creates a task
      await fetch(`${baseUrl}/projects/project-alice/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'task-alice-1', title: 'Alice Secret Task' }),
      });
    });

    it('isolates project listing so User A never sees User B projects', async () => {
      // Alice lists projects
      const aliceListRes = await fetch(`${baseUrl}/projects`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      const aliceData = await aliceListRes.json();
      expect(aliceData.projects).toHaveLength(1);
      expect(aliceData.projects[0].id).toBe('project-alice');

      // Bob lists projects
      const bobListRes = await fetch(`${baseUrl}/projects`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      const bobData = await bobListRes.json();
      expect(bobData.projects).toHaveLength(1);
      expect(bobData.projects[0].id).toBe('project-bob');
    });

    it('prevents IDOR: Bob receives 404 when querying Alice project directly', async () => {
      const getRes = await fetch(`${baseUrl}/projects/project-alice`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(getRes.status).toBe(404);
      const data = await getRes.json();
      expect(data.error).toMatch(/Project not found/);
    });

    it('prevents IDOR: Bob receives 404 when querying Alice tasks', async () => {
      const getTasksRes = await fetch(`${baseUrl}/projects/project-alice/tasks`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(getTasksRes.status).toBe(404);

      const getTaskDetail = await fetch(`${baseUrl}/projects/project-alice/tasks/task-alice-1`, {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(getTaskDetail.status).toBe(404);
    });

    it('prevents IDOR: Bob cannot add tasks to Alice project', async () => {
      const res = await fetch(`${baseUrl}/projects/project-alice/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'task-bob-injected', title: 'Injected Task' }),
      });

      expect(res.status).toBe(404);
    });

    it('prevents IDOR: Bob receives 404 on Alice repository tree, file, and status', async () => {
      const endpoints = [
        `${baseUrl}/projects/project-alice/repository/status`,
        `${baseUrl}/projects/project-alice/repository/tree`,
        `${baseUrl}/projects/project-alice/repository/file?path=package.json`,
        `${baseUrl}/projects/project-alice/handoffs`,
        `${baseUrl}/projects/project-alice/verifications`,
        `${baseUrl}/projects/project-alice/context?targetTaskId=task-alice-1`,
      ];

      for (const url of endpoints) {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${bobToken}` },
        });
        expect(res.status).toBe(404);
      }
    });

    it('prevents IDOR: Bob cannot cancel, unblock, or run Alice tasks', async () => {
      // Run attempt
      const runRes = await fetch(`${baseUrl}/projects/project-alice/tasks/task-alice-1/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ testMode: true }),
      });
      expect(runRes.status).toBe(404);

      // Cancel attempt
      const cancelRes = await fetch(`${baseUrl}/projects/project-alice/tasks/task-alice-1/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(cancelRes.status).toBe(404);

      // Unblock attempt
      const unblockRes = await fetch(`${baseUrl}/projects/project-alice/tasks/task-alice-1/unblock`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(unblockRes.status).toBe(404);
    });
  });

  // ==========================================================================
  // 4. PER-USER PROVIDER CREDENTIAL & CONFIG ISOLATION
  // ==========================================================================

  describe('4. Per-User Provider Credential Isolation', () => {
    const userA = createTestToken('user-a');
    const userB = createTestToken('user-b');

    it('isolates API keys and default models per user without mutating global server environment', async () => {
      const originalEnvKey = process.env.NEBIUS_API_KEY;

      try {
        // User A configures their API key and model
        const postResA = await fetch(`${baseUrl}/config/model`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${userA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            apiKey: 'user-a-secret-nebius-key-12345',
            model: 'custom-model-for-user-a',
            testMode: true,
          }),
        });
        expect(postResA.status).toBe(200);

        // Verify global process.env.NEBIUS_API_KEY was NOT mutated
        expect(process.env.NEBIUS_API_KEY).toBe(originalEnvKey);

        // User A reads their config
        const getResA = await fetch(`${baseUrl}/config/model`, {
          headers: { Authorization: `Bearer ${userA}` },
        });
        const configA = await getResA.json();
        expect(configA.defaultModel).toBe('custom-model-for-user-a');
        expect(configA.hasApiKey).toBe(true);
        expect(configA.testMode).toBe(true);

        // User B reads config: MUST NOT see User A's API key or custom model
        const getResB = await fetch(`${baseUrl}/config/model`, {
          headers: { Authorization: `Bearer ${userB}` },
        });
        const configB = await getResB.json();
        expect(configB.defaultModel).not.toBe('custom-model-for-user-a');
        if (!originalEnvKey) {
          expect(configB.hasApiKey).toBe(false);
        }
      } finally {
        if (originalEnvKey) {
          process.env.NEBIUS_API_KEY = originalEnvKey;
        } else {
          delete process.env.NEBIUS_API_KEY;
        }
      }
    });
  });
});
