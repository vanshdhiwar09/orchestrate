import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryProjectBrain } from '@orchestrate/brain';
import { ContextCompiler } from '@orchestrate/compiler';
import {
  computeSourceSnapshot,
  VerificationEngine,
  type VerificationPlan,
  type VerificationResult,
} from '@orchestrate/verification';
import { LocalCommandExecutor } from '@orchestrate/workspace';
import { describe, expect, it } from 'vitest';
import {
  Orchestrator,
  type TaskAgentRunner,
} from '../src/orchestrator.js';

describe('Orchestrator Source Freshness Guard & Promotion Boundary', () => {
  async function createWorkspace(): Promise<string> {
    const dir = join(tmpdir(), `orch-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const greeting = "hello";\n', 'utf8');
    await writeFile(join(dir, 'package.json'), '{"name":"test-project"}\n', 'utf8');
    return dir;
  }

  it('11. captures source snapshot and promotes cleanly when workspace remains unchanged', async () => {
    const ws = await createWorkspace();
    try {
      const brain = new MemoryProjectBrain();
      await brain.createProject({ id: 'p-1', name: 'Project 1' });
      await brain.createTask({ id: 't-1', projectId: 'p-1', title: 'Task 1', description: 'Desc' });

      const mockRunner: TaskAgentRunner = {
        run: async () => ({
          messages: [],
          response: {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: 'Implemented greeting',
                changes: 'Added greeting constant',
                filesAffected: ['src/index.ts'],
              }),
            },
          },
        }),
      };

      const mockEngine = {
        workspaceRoot: ws,
        verify: async (): Promise<VerificationResult> => ({
          status: 'VERIFIED',
          checks: [
            {
              checkId: 'c1',
              name: 'typecheck',
              command: 'npm',
              args: ['test'],
              exitCode: 0,
              signal: null,
              stdout: 'tests pass',
              stderr: '',
              timedOut: false,
              durationMs: 10,
              verifiedAt: new Date().toISOString(),
              passed: true,
            },
          ],
          executedAt: new Date().toISOString(),
          totalDurationMs: 10,
        }),
      };

      const orchestrator = new Orchestrator({
        brain,
        runner: mockRunner,
        verificationEngine: mockEngine,
        workspaceRoot: ws,
      });

      const plan: VerificationPlan = { checks: [] };
      const result = await orchestrator.executeTask({
        projectId: 'p-1',
        taskId: 't-1',
        verificationPlan: plan,
      });

      expect(result.status).toBe('VERIFIED');

      // Verification record in Brain has bound source snapshot
      const record = await brain.getVerificationRecord('t-1', 1);
      expect(record).not.toBeNull();
      expect(record?.sourceSnapshot).toBeDefined();
      expect(record?.sourceSnapshot?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      // Promotion succeeds
      const promotion = await brain.promoteTask('t-1', { workspaceRoot: ws });
      expect(promotion.status).toBe('VERIFIED');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('11b. detects concurrent or late source modifications during verification execution (TOCTOU race mitigation)', async () => {
    const ws = await createWorkspace();
    try {
      const brain = new MemoryProjectBrain();
      await brain.createProject({ id: 'p-1', name: 'Project 1' });
      await brain.createTask({ id: 't-1', projectId: 'p-1', title: 'Task 1', description: 'Desc' });

      const mockRunner: TaskAgentRunner = {
        run: async () => ({
          messages: [],
          response: {
            message: {
              role: 'assistant',
              content: JSON.stringify({ summary: 'Done' }),
            },
          },
        }),
      };

      // Engine simulates a background process or check modifying the source file during verification!
      const mockEngine = {
        workspaceRoot: ws,
        verify: async (): Promise<VerificationResult> => {
          // Mutate source while checks are running!
          await writeFile(join(ws, 'src', 'index.ts'), 'export const greeting = "MODIFIED_DURING_VERIFICATION";\n', 'utf8');

          return {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'c1',
                name: 'test',
                command: 'npm',
                args: ['test'],
                exitCode: 0,
                signal: null,
                stdout: 'all good',
                stderr: '',
                timedOut: false,
                durationMs: 10,
                verifiedAt: new Date().toISOString(),
                passed: true,
              },
            ],
            executedAt: new Date().toISOString(),
            totalDurationMs: 10,
          };
        },
      };

      const orchestrator = new Orchestrator({
        brain,
        runner: mockRunner,
        verificationEngine: mockEngine,
        workspaceRoot: ws,
      });

      const plan: VerificationPlan = { checks: [] };
      const result = await orchestrator.executeTask({
        projectId: 'p-1',
        taskId: 't-1',
        verificationPlan: plan,
      });

      // Orchestrator detected the TOCTOU modification and flipped status to FAILED!
      expect(result.status).toBe('FAILED');
      const failCheck = result.verificationResult.checks.find((c) => c.checkId === 'source-freshness-guard');
      expect(failCheck).toBeDefined();
      expect(failCheck?.passed).toBe(false);
      expect(failCheck?.stderr).toMatch(/Source freshness violation/i);

      // Task trust state in Brain is FAILED, not VERIFIED!
      expect(await brain.deriveTaskTrustState('t-1')).toBe('FAILED');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('11c. ContextCompiler quarantines upstream work when workspace source has changed', async () => {
    const ws = await createWorkspace();
    try {
      const brain = new MemoryProjectBrain();
      await brain.createProject({ id: 'p-1', name: 'Project 1' });
      await brain.createTask({ id: 'task-upstream', projectId: 'p-1', title: 'Upstream Task', description: 'Base feature' });
      await brain.createTask({ id: 'task-downstream', projectId: 'p-1', title: 'Downstream Task', description: 'Next feature' });

      // Run and verify upstream task
      const snapshot = await computeSourceSnapshot(ws);
      await brain.addHandoff({
        id: 'h-up',
        taskId: 'task-upstream',
        attemptNumber: 1,
        status: 'CLAIMED',
        summary: 'Upstream finished',
        changes: 'Added base feature',
        filesAffected: ['src/index.ts'],
        decisionsCreated: [],
        assumptions: [],
        limitations: [],
        recommendedFollowUp: [],
        createdAt: new Date().toISOString(),
      });
      await brain.addVerificationRecord({
        id: 'v-up',
        taskId: 'task-upstream',
        attemptNumber: 1,
        result: {
          status: 'VERIFIED',
          checks: [
            {
              checkId: 'chk',
              name: 'test',
              command: 'npm',
              args: ['test'],
              exitCode: 0,
              signal: null,
              stdout: 'ok',
              stderr: '',
              timedOut: false,
              durationMs: 5,
              verifiedAt: new Date().toISOString(),
              passed: true,
            },
          ],
        },
        recordedAt: new Date().toISOString(),
        sourceSnapshot: snapshot,
      });

      // 1. When workspace is fresh: ContextCompiler sees VERIFIED upstream
      const compilerFresh = new ContextCompiler({ brain, workspaceRoot: ws });
      const compiledFresh = await compilerFresh.compile({
        projectId: 'p-1',
        targetTaskId: 'task-downstream',
        upstreamTaskId: 'task-upstream',
      });
      expect(compiledFresh.upstreamWork?.trustState).toBe('VERIFIED');

      // 2. Modify workspace source file
      await writeFile(join(ws, 'src', 'index.ts'), 'export const greeting = "TAMPERED";\n', 'utf8');

      // 3. Downstream ContextCompiler compilation now sees unverified upstream work and quarantines it!
      const compilerStale = new ContextCompiler({ brain, workspaceRoot: ws });
      const compiledStale = await compilerStale.compile({
        projectId: 'p-1',
        targetTaskId: 'task-downstream',
        upstreamTaskId: 'task-upstream',
      });
      expect(compiledStale.upstreamWork?.trustState).toBe('FAILED');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('12. existing ESM import verification and required-check enforcement continue to work', async () => {
    const ws = await createWorkspace();
    try {
      // Create a NodeNext TypeScript file with missing extension
      await writeFile(
        join(ws, 'package.json'),
        JSON.stringify({ name: 'esm-project', type: 'module' }),
        'utf8'
      );
      await writeFile(
        join(ws, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { moduleResolution: 'NodeNext', module: 'NodeNext' } }),
        'utf8'
      );
      await writeFile(join(ws, 'src', 'helper.ts'), 'export const h = 1;\n', 'utf8');
      await writeFile(join(ws, 'src', 'main.ts'), 'import { h } from "./helper";\n', 'utf8');

      const executor = new LocalCommandExecutor({ workspaceRoot: ws });
      await executor.execute('git', ['init']);
      const engine = new VerificationEngine({ executor, workspaceRoot: ws });

      const plan: VerificationPlan = {
        checks: [
          {
            id: 'build',
            name: 'build check',
            command: 'node',
            args: ['--version'],
          },
        ],
      };

      const result = await engine.verify(plan);
      expect(result.status).toBe('FAILED');
      const esmCheck = result.checks.find((c) => c.checkId === 'check-node-next-module-resolution');
      expect(esmCheck).toBeDefined();
      expect(esmCheck?.passed).toBe(false);
      expect(esmCheck?.stderr).toMatch(/missing an explicit file extension/i);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
