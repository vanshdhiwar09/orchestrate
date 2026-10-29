import { createEngineServer } from '@orchestrate/engine';
import { SqliteProjectBrain } from '@orchestrate/brain';
import fs from 'node:fs';
import path from 'node:path';

interface CheckResult {
  name: string;
  endpoint: string;
  status: 'PASS' | 'FAILED';
  httpStatus: number;
  durationMs: number;
  details?: string;
}

async function runSmokeTests(): Promise<void> {
  console.log('===============================================================');
  console.log(' Orchestrate Engine Automated Smoke Test');
  console.log('===============================================================');

  const targetUrl = process.env.ORCHESTRATE_ENGINE_URL || 'http://127.0.0.1:3001';
  let ephemeralServer: any = null;
  let ephemeralBrain: any = null;
  let testDbPath: string | null = null;
  let activeUrl = targetUrl;

  // Check if a server is already running at targetUrl
  let isRunning = false;
  try {
    const res = await fetch(`${targetUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      isRunning = true;
      console.log(`[Target] Connected to running Engine at ${targetUrl}`);
    }
  } catch {
    // No server running on targetUrl
  }

  if (!isRunning) {
    console.log(`[Target] No running server detected at ${targetUrl}. Spawning ephemeral engine...`);
    testDbPath = path.resolve(process.cwd(), `./smoke-test-temp-${Date.now()}.sqlite`);
    ephemeralBrain = new SqliteProjectBrain({ databasePath: testDbPath });
    ephemeralServer = createEngineServer({
      brain: ephemeralBrain,
      port: 3999,
      host: '127.0.0.1',
      corsOrigin: '*',
    });
    const info = await ephemeralServer.start();
    activeUrl = info.url;
    console.log(`[Target] Ephemeral Engine started at ${activeUrl}`);
  }

  const results: CheckResult[] = [];
  const testProjectId = `smoke-proj-${Date.now()}`;
  const testTaskId = `smoke-task-${Date.now()}`;

  async function check(
    name: string,
    endpoint: string,
    fn: () => Promise<{ ok: boolean; httpStatus: number; details?: string }>
  ) {
    const start = performance.now();
    try {
      const res = await fn();
      const durationMs = Math.round(performance.now() - start);
      const status = res.ok ? 'PASS' : 'FAILED';
      results.push({
        name,
        endpoint,
        status,
        httpStatus: res.httpStatus,
        durationMs,
        details: res.details,
      });
      const icon = res.ok ? '✔' : '✖';
      console.log(`  ${icon} [${status}] ${name} (${endpoint}) - HTTP ${res.httpStatus} [${durationMs}ms]`);
      if (!res.ok && res.details) {
        console.error(`      Error details: ${res.details}`);
      }
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      results.push({
        name,
        endpoint,
        status: 'FAILED',
        httpStatus: 0,
        durationMs,
        details: (err as Error).message,
      });
      console.error(`  ✖ [FAILED] ${name} (${endpoint}) - Exception: ${(err as Error).message}`);
    }
  }

  try {
    // 1. GET /health
    await check('Engine Health Diagnostics', 'GET /health', async () => {
      const res = await fetch(`${activeUrl}/health`);
      const body = (await res.json()) as any;
      const ok = res.status === 200 && body.status === 'ok' && typeof body.version === 'string';
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 2. POST /projects
    await check('Project Registration', 'POST /projects', async () => {
      const res = await fetch(`${activeUrl}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: testProjectId, name: 'Smoke Test Project' }),
      });
      const body = (await res.json()) as any;
      const ok = res.status === 201 && body.id === testProjectId;
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 3. GET /projects
    await check('List Projects', 'GET /projects', async () => {
      const res = await fetch(`${activeUrl}/projects`);
      const body = (await res.json()) as any;
      const ok = res.status === 200 && Array.isArray(body.projects) && body.projects.some((p: any) => p.id === testProjectId);
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 4. GET /projects/:id
    await check('Fetch Project by ID', `GET /projects/${testProjectId}`, async () => {
      const res = await fetch(`${activeUrl}/projects/${testProjectId}`);
      const body = (await res.json()) as any;
      const ok = res.status === 200 && body.id === testProjectId && Array.isArray(body.facts);
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 5. GET /projects/:id/handoffs
    await check('Fetch Handoffs', `GET /projects/${testProjectId}/handoffs`, async () => {
      const res = await fetch(`${activeUrl}/projects/${testProjectId}/handoffs`);
      const body = (await res.json()) as any;
      const ok = res.status === 200 && Array.isArray(body.handoffs);
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 6. GET /projects/:id/verifications
    await check('Fetch Verifications', `GET /projects/${testProjectId}/verifications`, async () => {
      const res = await fetch(`${activeUrl}/projects/${testProjectId}/verifications`);
      const body = (await res.json()) as any;
      const ok = res.status === 200 && Array.isArray(body.verifications);
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 7. GET /projects/:id/context validation
    await check('Context Compilation Parameter Validation', `GET /projects/${testProjectId}/context`, async () => {
      // Missing targetTaskId should return 400 Bad Request
      const res = await fetch(`${activeUrl}/projects/${testProjectId}/context`);
      const body = (await res.json()) as any;
      const ok = res.status === 400 && typeof body.error === 'string';
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 8. Unsupported Route Rejection (404 Not Found)
    await check('Unsupported Route 404 Rejection', 'GET /unsupported-experimental-endpoint', async () => {
      const res = await fetch(`${activeUrl}/unsupported-experimental-endpoint`);
      const body = (await res.json()) as any;
      const ok = res.status === 404 && body.statusCode === 404 && body.error === 'Not Found';
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

    // 9. Method Not Allowed (405)
    await check('Disallowed Method 405 Rejection', 'POST /health', async () => {
      const res = await fetch(`${activeUrl}/health`, { method: 'POST' });
      const body = (await res.json()) as any;
      const ok = res.status === 405 && body.statusCode === 405;
      return { ok, httpStatus: res.status, details: ok ? undefined : JSON.stringify(body) };
    });

  } finally {
    if (ephemeralServer) {
      console.log('\n[Teardown] Stopping ephemeral engine...');
      await new Promise((r) => setTimeout(r, 100));
      await ephemeralServer.stop();
      ephemeralBrain?.close();
      if (testDbPath && fs.existsSync(testDbPath)) {
        try {
          fs.unlinkSync(testDbPath);
          const wal = `${testDbPath}-wal`;
          const shm = `${testDbPath}-shm`;
          if (fs.existsSync(wal)) fs.unlinkSync(wal);
          if (fs.existsSync(shm)) fs.unlinkSync(shm);
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  console.log('===============================================================');
  const allPassed = results.every((r) => r.status === 'PASS');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  console.log(` Results: ${passCount}/${results.length} checks passed.`);
  if (allPassed) {
    console.log(' OVERALL STATUS: ALL CHECKS PASSED (VERIFIED)');
    console.log('===============================================================');
    process.exit(0);
  } else {
    console.error(' OVERALL STATUS: SMOKE TEST FAILED');
    console.log('===============================================================');
    process.exit(1);
  }
}

runSmokeTests().catch((err) => {
  console.error('Fatal smoke test error:', err);
  process.exit(1);
});
