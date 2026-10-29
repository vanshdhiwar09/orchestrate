import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureCanonicalScenarioRepo,
  getScenarioDefinition,
  LocalWorkspaceFactory,
  type BenchmarkWorkspace,
} from '../../src/index.js';
import { LocalCommandExecutor } from '@orchestrate/workspace';
import { verifyModuleResolution } from '@orchestrate/verification';

describe('Scenario Acceptance: auth-protected-api', () => {
  const workspacesToClean: BenchmarkWorkspace[] = [];

  afterEach(async () => {
    while (workspacesToClean.length > 0) {
      const ws = workspacesToClean.pop();
      if (ws) {
        await ws.cleanup();
      }
    }
  });

  async function setupWorkspace(): Promise<{
    workspace: BenchmarkWorkspace;
    executor: LocalCommandExecutor;
    workspacePath: string;
  }> {
    const scenarioId = 'auth-protected-api';
    const materialized = await ensureCanonicalScenarioRepo(scenarioId);
    const scenario = getScenarioDefinition(scenarioId);

    const factory = new LocalWorkspaceFactory({
      sourceRepoPath: materialized.repoPath,
    });

    const workspace = await factory.create(materialized.snapshotCommitSha);
    workspacesToClean.push(workspace);

    // Inject evaluator files (test/profile.test.ts)
    for (const ef of scenario.evaluatorFilesTaskB ?? []) {
      const fullPath = join(workspace.path, ef.path);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, ef.content, 'utf8');
    }

    const executor = new LocalCommandExecutor({ workspaceRoot: workspace.path });
    return { workspace, executor, workspacePath: workspace.path };
  }

  it('1. passes runtime acceptance tests when compliant profile route is implemented', async () => {
    const { executor, workspacePath } = await setupWorkspace();

    const compliantProfileTs = `import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateToken, type AuthRequest } from '../middleware/auth.ts';
import { USERS } from '../users.ts';

export function handleProfile(req: IncomingMessage, res: ServerResponse): void {
  authenticateToken(req as AuthRequest, res, () => {
    const authReq = req as AuthRequest;
    if (!authReq.user) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const user = USERS[authReq.user.id];
    if (!user) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'User not found' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(user));
  });
}
`;

    const routesDir = join(workspacePath, 'src', 'routes');
    await mkdir(routesDir, { recursive: true });
    await writeFile(join(routesDir, 'profile.ts'), compliantProfileTs, 'utf8');

    // Run early verification check on the written file
    const staticReport = await verifyModuleResolution(
      async (p) => (p === 'src/routes/profile.ts' ? compliantProfileTs : null),
      ['src/routes/profile.ts'],
      { enforceEsmExtensions: true, allowTsExtensions: true }
    );
    expect(staticReport.passed).toBe(true);

    // Execute runtime acceptance test
    const result = await executor.execute('node', ['--test', 'test/profile.test.ts'], {
      timeoutMs: 30000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pass 5');
    expect(result.stdout).toContain('fail 0');
  });

  it('2. reproduces the exact Step 10.11 import-resolution failure when relative import omits extension', async () => {
    const { executor, workspacePath } = await setupWorkspace();

    // Code observed in Arm A
    const extensionlessProfileTs = `import { authenticateToken } from '../middleware/auth';
import { USERS } from '../users';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserPayload } from '../types';

export function handler(
  req: IncomingMessage & { user?: UserPayload },
  res: ServerResponse
): void {
  authenticateToken(req as any, res, () => {
    const userId = req.user?.id;
    const user = USERS[userId];
    if (!user) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'User not found' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(user));
  });
}
`;

    const routesDir = join(workspacePath, 'src', 'routes');
    await mkdir(routesDir, { recursive: true });
    await writeFile(join(routesDir, 'profile.ts'), extensionlessProfileTs, 'utf8');

    // Early verifier catches the defect immediately
    const staticReport = await verifyModuleResolution(
      async (p) => (p === 'src/routes/profile.ts' ? extensionlessProfileTs : null),
      ['src/routes/profile.ts'],
      { enforceEsmExtensions: true, allowTsExtensions: true }
    );
    expect(staticReport.passed).toBe(false);
    expect(staticReport.issues[0].specifier).toBe('../middleware/auth');

    // Runtime test reproduces the Node.js ERR_MODULE_NOT_FOUND error
    const result = await executor.execute('node', ['--test', 'test/profile.test.ts'], {
      timeoutMs: 30000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });

  it('3. reproduces Arm C logic defect (omitting authenticateToken invocation) even with valid extensions', async () => {
    const { executor, workspacePath } = await setupWorkspace();

    // Arm C logic: checks req.user directly without invoking authenticateToken
    const armCProfileTs = `import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthRequest } from '../middleware/auth.ts';
import { USERS } from '../users.ts';

export function handler(req: AuthRequest, res: ServerResponse): void {
  // Buggy logic: assumes req.user is pre-populated upstream
  if (!req.user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing or invalid token' }));
    return;
  }
  const fullProfile = USERS[req.user.id];
  if (!fullProfile) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Profile not found' }));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(fullProfile));
}
`;

    const routesDir = join(workspacePath, 'src', 'routes');
    await mkdir(routesDir, { recursive: true });
    await writeFile(join(routesDir, 'profile.ts'), armCProfileTs, 'utf8');

    // Static imports are valid
    const staticReport = await verifyModuleResolution(
      async (p) => (p === 'src/routes/profile.ts' ? armCProfileTs : null),
      ['src/routes/profile.ts'],
      { enforceEsmExtensions: true, allowTsExtensions: true }
    );
    expect(staticReport.passed).toBe(true);

    // Runtime acceptance fails because req.user is undefined when called with auth headers
    const result = await executor.execute('node', ['--test', 'test/profile.test.ts'], {
      timeoutMs: 30000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('returns full profile for valid Alice token');
    expect(result.stdout).toContain('fail 2'); // Both valid token tests fail
  });
});
