import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ENGINE_URL = 'http://127.0.0.1:3001';

interface AuditResult {
  step: string;
  name: string;
  passed: boolean;
  evidence: string;
  details?: any;
}

const auditLog: AuditResult[] = [];

function record(step: string, name: string, passed: boolean, evidence: string, details?: any) {
  auditLog.push({ step, name, passed, evidence, details });
  const mark = passed ? '✓ [PASS]' : '✗ [FAIL]';
  console.log(`${mark} [${step}] ${name}: ${evidence}`);
}

async function runRcAudit() {
  console.log('===============================================================');
  console.log(' Orchestrate Release-Candidate Audit & End-to-End Proof');
  console.log(` Target Engine: ${ENGINE_URL}`);
  console.log('===============================================================\n');

  // ── 1. Model Registry & Regional Endpoint Validation ───────────────────────
  console.log('--- 1. Validating Multi-Model Regional Registry ---');
  try {
    const regRes = await fetch(`${ENGINE_URL}/config/model/registry`);
    if (!regRes.ok) throw new Error(`HTTP ${regRes.status}`);
    const regData = await regRes.json();
    const models: any[] = Array.isArray(regData.models)
      ? regData.models
      : Object.values(regData.registry || {});

    const planner = models.find((m: any) => m.modelId === 'zai-org/GLM-5.3-Flash');
    const implementer = models.find((m: any) => m.modelId === 'moonshotai/Kimi-K2.6');
    const reviewer = models.find((m: any) => m.modelId === 'nvidia/Nemotron-3.5-Super-VL');
    const general = models.find((m: any) => m.modelId === 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');

    record('REG-1', 'Planner Resolution', planner && planner.role === 'planner', `Resolved ${planner?.name} (${planner?.endpoint})`);
    record('REG-2', 'Implementer Resolution', implementer && implementer.role === 'implementer', `Resolved ${implementer?.name} (${implementer?.endpoint})`);
    record('REG-3', 'Reviewer Resolution', reviewer && reviewer.role === 'reviewer', `Resolved ${reviewer?.name} (${reviewer?.endpoint})`);
    record('REG-4', 'General Model Resolution', general && general.role === 'general', `Resolved ${general?.name} (${general?.endpoint})`);

    const endpointsOk =
      planner.endpoint.includes('us-north1') &&
      implementer.endpoint.includes('us-central1') &&
      reviewer.endpoint.includes('us-north1');
    record('REG-5', 'Regional Endpoints Match Console', endpointsOk, 'GLM=us-north1, Kimi=us-central1, Nemotron-Super-VL=us-north1');
  } catch (err) {
    record('REG-ERR', 'Model Registry Check', false, (err as Error).message);
  }

  // ── 2. Temporary Repository Setup (Zero Benchmark Mutating) ────────────────
  console.log('\n--- 2. Setting Up Isolated Temporary Git Repository ---');
  const tempRepoDir = path.resolve(process.cwd(), 'workspaces', 'rc-audit-temp-repo');
  if (fs.existsSync(tempRepoDir)) {
    fs.rmSync(tempRepoDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(tempRepoDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tempRepoDir, 'test'), { recursive: true });

  fs.writeFileSync(
    path.join(tempRepoDir, 'package.json'),
    JSON.stringify({ name: 'rc-audit-temp', version: '1.0.0', type: 'module' }, null, 2)
  );
  fs.writeFileSync(
    path.join(tempRepoDir, 'src', 'calculator.js'),
    'export function add(a, b) {\n  return 0; // stub\n}\n'
  );
  fs.writeFileSync(
    path.join(tempRepoDir, 'test', 'calc.test.js'),
    `import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from '../src/calculator.js';

test('add calculates sum correctly', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});
`
  );

  execSync('git init -b main', { cwd: tempRepoDir, stdio: 'pipe' });
  execSync('git config user.name "Orchestrate Test"', { cwd: tempRepoDir, stdio: 'pipe' });
  execSync('git config user.email "test@orchestrate.local"', { cwd: tempRepoDir, stdio: 'pipe' });
  execSync('git add .', { cwd: tempRepoDir, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: tempRepoDir, stdio: 'pipe' });

  record('REPO-1', 'Temporary Git Repo Initialized', fs.existsSync(path.join(tempRepoDir, '.git')), `Created at ${tempRepoDir}`);

  // ── 3. Project Onboarding & Task Creation ──────────────────────────────────
  console.log('\n--- 3. Project Onboarding & Task Creation via Engine API ---');
  const projId = `proj-rc-${Date.now()}`;
  try {
    const projRes = await fetch(`${ENGINE_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projId,
        name: 'RC Audit Project',
        repositoryType: 'local',
        repositoryPath: tempRepoDir,
      }),
    });
    record('PROJ-1', 'Project Created', projRes.status === 201, `Status ${projRes.status} for ${projId}`);

    const taskId = `task-calc-${Date.now()}`;
    const taskRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: taskId,
        title: 'Implement add function in src/calculator.js',
        description: 'Update src/calculator.js so add(a, b) returns a + b and satisfies test/calc.test.js',
        acceptanceCriteria: 'node test/calc.test.js exits 0',
        verificationCommand: 'node test/calc.test.js',
      }),
    });
    record('TASK-1', 'Task Created', taskRes.status === 201, `Status ${taskRes.status} for ${taskId}`);

    // Initial trust state must be UNVERIFIED
    const getTaskRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${taskId}`);
    const taskData = await getTaskRes.json();
    record('TASK-2', 'Initial Trust State UNVERIFIED', taskData.trustState === 'UNVERIFIED', `Trust state: ${taskData.trustState}`);

    // ── 4. Happy-path Multi-Agent Task Execution ─────────────────────────────
    console.log('\n--- 4. Executing Multi-Agent Task Run with Deterministic Client ---');
    const runRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${taskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'test',
        enableMultiAgent: true,
        model: 'deterministic-test-model',
        plannerModel: 'zai-org/GLM-5.3-Flash',
        reviewerModel: 'nvidia/Nemotron-3.5-Super-VL',
      }),
    });
    const runData = await runRes.json();
    if (!runRes.ok) {
      console.error('Run failed:', runRes.status, runData);
    }
    record('RUN-1', 'Run Task Completed', runRes.status === 200 && runData.success, `Attempt #${runData.attemptNumber}, Status: ${runData.status}`);
    record('RUN-2', 'Planner Executed', Boolean(runData.plan?.summary), `Plan summary: "${runData.plan?.summary?.slice(0, 50)}..."`);
    record('RUN-3', 'Reviewer Executed', Boolean(runData.review?.verdict), `Review verdict: ${runData.review?.verdict}`);
    record('RUN-4', 'Independent Verification Passed', runData.verificationResult?.status === 'VERIFIED', `Verification status: ${runData.verificationResult?.status}`);

    // Check captured diff
    const diffRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${taskId}/diff`);
    const diffData = await diffRes.json();
    record('RUN-5', 'Diff Captured & Available', Boolean(diffData.diff && diffData.diff.length > 0), `Diff length: ${diffData.diff?.length} chars`);

    // Verify workspace isolation: base repo was NOT modified directly
    const baseGitStatus = execSync('git status --porcelain', { cwd: tempRepoDir, encoding: 'utf8' }).trim();
    record('SEC-1', 'Workspace Isolation Preserved', baseGitStatus === '', `Base repo working tree clean: "${baseGitStatus}"`);

    // ── 5. Browser Refresh & Persistence Proof ───────────────────────────────
    console.log('\n--- 5. Verifying State Persistence across Engine Queries ---');
    const persistedTaskRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${taskId}`);
    const persistedTask = await persistedTaskRes.json();
    record('PERSIST-1', 'Task Settled as VERIFIED in Brain', persistedTask.trustState === 'VERIFIED', `Persisted trust state: ${persistedTask.trustState}`);
    record('PERSIST-2', 'Attempt Count Recorded', (persistedTask.history?.length || persistedTask.attemptCount) === 1, `Recorded attempts: ${persistedTask.history?.length || persistedTask.attemptCount}`);

    // ── 6. Intentional Verification Failure Scenario ─────────────────────────
    console.log('\n--- 6. Testing Intentional Verification Failure & Bounded Repair ---');
    const failingTaskId = `task-failing-${Date.now()}`;
    await fetch(`${ENGINE_URL}/projects/${projId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: failingTaskId,
        title: 'Intentional Failing Task (FAIL_VERIFICATION)',
        description: 'This task intentionally fails verification check',
        verificationCommand: 'node',
        verificationArgs: ['-e', 'process.exit(1)'],
      }),
    });

    const failRun1 = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${failingTaskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'test',
        prompt: 'FAIL_VERIFICATION intentional_fail',
      }),
    });
    const failData1 = await failRun1.json();
    if (!failRun1.ok) console.error('failRun1 error:', failRun1.status, failData1);
    record('FAIL-1', 'Attempt 1 Fails Verification Cleanly', failData1.status === 'FAILED', `Status: ${failData1.status} (no fabricated success)`);

    // Attempt 2 fails verification
    const failRun2 = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${failingTaskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'test',
        prompt: 'FAIL_VERIFICATION intentional_fail',
      }),
    });
    const failData2 = await failRun2.json();
    record('FAIL-2', 'Attempt 2 Fails Verification', failData2.status === 'FAILED', `Attempt #${failData2.attemptNumber} status: ${failData2.status}`);

    // After 2 failed repairs, task must transition to BLOCKED_NEEDS_HUMAN
    const blockedTaskRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${failingTaskId}`);
    const blockedTask = await blockedTaskRes.json();
    record('FAIL-3', 'Bounded Repair Enforces BLOCKED_NEEDS_HUMAN', blockedTask.trustState === 'BLOCKED_NEEDS_HUMAN', `Trust state: ${blockedTask.trustState}`);

    // Attempting to run a blocked task without unblocking must return HTTP 400
    const runBlockedRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${failingTaskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    record('FAIL-4', 'Blocked Task Rejected (HTTP 400)', runBlockedRes.status === 400, `Status: ${runBlockedRes.status}`);

    // Unblock the task
    const unblockRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${failingTaskId}/unblock`, {
      method: 'POST',
    });
    record('FAIL-5', 'Task Successfully Unblocked', unblockRes.status === 200, `Unblock status: ${unblockRes.status}`);

    // ── 7. Security Boundary Audit ───────────────────────────────────────────
    console.log('\n--- 7. Security Boundaries & Path Traversal Protections ---');
    // Path traversal attempt in local repo onboarding
    const traversalRepoRes = await fetch(`${ENGINE_URL}/projects/${projId}/repository/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'local',
        path: '../../../../../../windows/win.ini',
      }),
    });
    record('SEC-2', 'Path Traversal in Repository Import Blocked', traversalRepoRes.status === 400, `Status: ${traversalRepoRes.status}`);

    // Target scope traversal attempt
    const taskScopeRes = await fetch(`${ENGINE_URL}/projects/${projId}/tasks/${taskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'test',
        targetScope: { type: 'file_list', paths: ['../../etc/shadow'] },
      }),
    });
    record('SEC-3', 'Path Traversal in Target Scope Blocked', taskScopeRes.status === 400, `Status: ${taskScopeRes.status}`);
  } finally {
    // Cleanup temporary repo
    if (fs.existsSync(tempRepoDir)) {
      try {
        fs.rmSync(tempRepoDir, { recursive: true, force: true });
      } catch {
        // ignore on windows lock
      }
    }
    // Cleanup audit project from DB to keep the project list pristine
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync('./orchestrate.sqlite');
      db.exec('PRAGMA foreign_keys = ON;');
      const tasks = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(projId);
      for (const t of tasks as any[]) {
        db.prepare('DELETE FROM blocked_tasks WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM verification_records WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM handoffs WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM decisions WHERE task_id = ?').run(t.id);
        db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
      }
      db.prepare('DELETE FROM decisions WHERE project_id = ?').run(projId);
      db.prepare('DELETE FROM project_facts WHERE project_id = ?').run(projId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(projId);
      db.close();

      const wsDir = path.resolve('workspaces', 'tasks', projId);
      if (fs.existsSync(wsDir)) {
        try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
      }
    } catch {
      // ignore
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n===============================================================');
  console.log(' Release-Candidate Audit Summary');
  console.log('===============================================================');
  const total = auditLog.length;
  const passed = auditLog.filter((a) => a.passed).length;
  const failed = total - passed;
  console.log(`Total Checks: ${total} | Passed: ${passed} | Failed: ${failed}`);

  if (failed > 0) {
    console.error('Audit FAILED: Some release-critical checks did not pass.');
    process.exit(1);
  } else {
    console.log('All Release-Candidate Audit Checks PASSED with 100% fidelity!');
    process.exit(0);
  }
}

runRcAudit().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
