import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSourceSnapshot } from '@orchestrate/verification';
import { describe, expect, it } from 'vitest';
import { MemoryProjectBrain } from '../src/memory.js';
import { SqliteProjectBrain } from '../src/sqlite.js';
import {
  PromotionError,
  SourceFreshnessError,
  type VerificationRecord,
} from '../src/types.js';

describe('Standard-Workflow Source Freshness & Promotion Guard', () => {
  async function createWorkspace(): Promise<string> {
    const dir = join(tmpdir(), `freshness-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
    await writeFile(join(dir, 'package.json'), '{"name":"fresh-test"}\n', 'utf8');
    return dir;
  }

  const backends = [
    { name: 'MemoryProjectBrain', factory: () => new MemoryProjectBrain() },
    {
      name: 'SqliteProjectBrain',
      factory: () => new SqliteProjectBrain({ databasePath: ':memory:' }),
    },
  ];

  for (const { name, factory } of backends) {
    describe(`${name}`, () => {
      it('1. verification passes and source remains unchanged: promotion succeeds', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const snapshot = await computeSourceSnapshot(ws);

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'done',
            changes: 'none',
            filesAffected: [],
            decisionsCreated: [],
            assumptions: [],
            limitations: [],
            recommendedFollowUp: [],
            createdAt: new Date().toISOString(),
          });

          const verifRecord: VerificationRecord = {
            id: 'v-1',
            taskId: 'task-1',
            attemptNumber: 1,
            handoffId: 'h-1',
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
              executedAt: new Date().toISOString(),
              totalDurationMs: 10,
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: snapshot,
          };
          await brain.addVerificationRecord(verifRecord);

          // Promotion succeeds
          const promotion = await brain.promoteTask('task-1', { workspaceRoot: ws });
          expect(promotion.status).toBe('VERIFIED');
          expect(promotion.attemptNumber).toBe(1);
          expect(promotion.sourceSnapshot.fingerprint).toBe(snapshot.fingerprint);

          // deriveTaskTrustState with workspaceRoot also confirms VERIFIED
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('VERIFIED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('2. tracked source file changes after verification: promotion is rejected', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const snapshot = await computeSourceSnapshot(ws);

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'done',
            changes: '',
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
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: snapshot,
          });

          // Modify tracked file
          await writeFile(join(ws, 'src', 'index.ts'), 'export const answer = 999;\n', 'utf8');

          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            SourceFreshnessError
          );
          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            /Source freshness violation/i
          );

          // deriveTaskTrustState with workspaceRoot fails closed to FAILED
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('FAILED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('3. untracked source file is added after verification: promotion is rejected', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const snapshot = await computeSourceSnapshot(ws);

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'done',
            changes: '',
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
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: snapshot,
          });

          // Add new untracked file
          await writeFile(join(ws, 'src', 'untracked.ts'), 'export const backdoor = true;\n', 'utf8');

          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            SourceFreshnessError
          );
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('FAILED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('4. verified source file is deleted or renamed: promotion is rejected', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const snapshot = await computeSourceSnapshot(ws);

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'done',
            changes: '',
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
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: snapshot,
          });

          // Delete file
          await rm(join(ws, 'src', 'index.ts'));

          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            SourceFreshnessError
          );
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('FAILED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('5. configuration file changes after verification: promotion is rejected', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const snapshot = await computeSourceSnapshot(ws);

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'done',
            changes: '',
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
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: snapshot,
          });

          // Modify package.json
          await writeFile(join(ws, 'package.json'), '{"name":"fresh-test","version":"2.0.0"}\n', 'utf8');

          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            SourceFreshnessError
          );
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('FAILED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('6. file changes and reverts to identical content: promotion succeeds', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const originalContent = 'export const answer = 42;\n';
          const snapshot = await computeSourceSnapshot(ws);

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'done',
            changes: '',
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
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: snapshot,
          });

          // Temporarily modify
          await writeFile(join(ws, 'src', 'index.ts'), 'export const answer = 0;\n', 'utf8');
          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            SourceFreshnessError
          );

          // Revert back
          await writeFile(join(ws, 'src', 'index.ts'), originalContent, 'utf8');
          const promotion = await brain.promoteTask('task-1', { workspaceRoot: ws });
          expect(promotion.status).toBe('VERIFIED');
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('VERIFIED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('7. previous attempt passes but a newer attempt is created: old evidence cannot authorize promotion', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const snapshot = await computeSourceSnapshot(ws);

          // Attempt 1 passes
          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'attempt 1',
            changes: '',
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
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: snapshot,
          });

          // Attempt 2 started by agent
          await brain.addHandoff({
            id: 'h-2',
            taskId: 'task-1',
            attemptNumber: 2,
            status: 'CLAIMED',
            summary: 'attempt 2 start',
            changes: '',
            filesAffected: [],
            decisionsCreated: [],
            assumptions: [],
            limitations: [],
            recommendedFollowUp: [],
            createdAt: new Date().toISOString(),
          });

          // Attempt 2 has not passed verification yet: promotion MUST be rejected!
          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            PromotionError
          );
          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            /latest attempt 2 is not verified/i
          );

          // Attempt state resets to CLAIMED
          expect(await brain.deriveTaskTrustState('task-1')).toBe('CLAIMED');
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('CLAIMED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('8. source fingerprint is unavailable or errors: promotion fails closed', async () => {
        const brain = factory();
        await brain.createProject({ id: 'proj-1', name: 'P1' });
        await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

        await brain.addHandoff({
          id: 'h-1',
          taskId: 'task-1',
          attemptNumber: 1,
          status: 'CLAIMED',
          summary: 'done',
          changes: '',
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
          result: {
            status: 'VERIFIED',
            checks: [
              {
                checkId: 'c-1',
                name: 'test',
                command: 'npm',
                args: ['test'],
                exitCode: 0,
                signal: null,
                stdout: 'ok',
                stderr: '',
                timedOut: false,
                durationMs: 10,
                verifiedAt: new Date().toISOString(),
                passed: true,
              },
            ],
          },
          recordedAt: new Date().toISOString(),
          sourceSnapshot: {
            fingerprint: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            capturedAt: new Date().toISOString(),
            fileCount: 2,
          },
        });

        // Pass an invalid non-existent path
        await expect(
          brain.promoteTask('task-1', { workspaceRoot: 'C:/totally-invalid-workspace-path-does-not-exist' })
        ).rejects.toThrow(SourceFreshnessError);
        expect(
          await brain.deriveTaskTrustState('task-1', {
            workspaceRoot: 'C:/totally-invalid-workspace-path-does-not-exist',
          })
        ).toBe('FAILED');
      });

      it('9. legacy verification record lacking snapshot identity: cannot silently authorize fresh promotion', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'legacy attempt',
            changes: '',
            filesAffected: [],
            decisionsCreated: [],
            assumptions: [],
            limitations: [],
            recommendedFollowUp: [],
            createdAt: new Date().toISOString(),
          });

          // Legacy record: sourceSnapshot is intentionally omitted / undefined
          await brain.addVerificationRecord({
            id: 'v-1',
            taskId: 'task-1',
            attemptNumber: 1,
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
          });

          // Promotion fails closed because legacy record has no bound snapshot identity
          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            SourceFreshnessError
          );
          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            /lacks source snapshot identity/i
          );

          // deriveTaskTrustState with workspaceRoot or requireFreshness returns FAILED
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('FAILED');
          expect(await brain.deriveTaskTrustState('task-1', { requireFreshness: true })).toBe('FAILED');
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });

      it('10. interleaved filesystem modification race: consumption-time re-derivation catches mutations', async () => {
        const brain = factory();
        const ws = await createWorkspace();
        try {
          await brain.createProject({ id: 'proj-1', name: 'P1' });
          await brain.createTask({ id: 'task-1', projectId: 'proj-1', title: 'T1', description: 'D1' });

          const initialSnapshot = await computeSourceSnapshot(ws);

          await brain.addHandoff({
            id: 'h-1',
            taskId: 'task-1',
            attemptNumber: 1,
            status: 'CLAIMED',
            summary: 'done',
            changes: '',
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
            result: {
              status: 'VERIFIED',
              checks: [
                {
                  checkId: 'c-1',
                  name: 'test',
                  command: 'npm',
                  args: ['test'],
                  exitCode: 0,
                  signal: null,
                  stdout: 'ok',
                  stderr: '',
                  timedOut: false,
                  durationMs: 10,
                  verifiedAt: new Date().toISOString(),
                  passed: true,
                },
              ],
            },
            recordedAt: new Date().toISOString(),
            sourceSnapshot: initialSnapshot,
          });

          // Simulate concurrent race: file is mutated during or immediately after snapshot computation
          const racingComputeFn = async (root: string) => {
            const snap = await computeSourceSnapshot(root);
            // Simulate interleaved asynchronous modification by external OS process
            await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 999999;\n', 'utf8');
            return snap;
          };

          // promoteTask with racingComputeFn succeeds based on the captured pre-write snapshot
          const promotion = await brain.promoteTask('task-1', {
            workspaceRoot: ws,
            computeSnapshotFn: racingComputeFn,
          });
          expect(promotion.status).toBe('VERIFIED');
          expect(promotion.sourceSnapshot.fingerprint).toBe(initialSnapshot.fingerprint);

          // However, the workspace on disk was mutated!
          // Consumption-time trust derivation must NOT trust the stale promotion result.
          // deriveTaskTrustState re-checks the live workspace and evaluates fail-closed to FAILED.
          expect(await brain.deriveTaskTrustState('task-1', { workspaceRoot: ws })).toBe('FAILED');

          // Subsequent promotion attempts without mock immediately fail with SourceFreshnessError
          await expect(brain.promoteTask('task-1', { workspaceRoot: ws })).rejects.toThrow(
            SourceFreshnessError
          );
        } finally {
          await rm(ws, { recursive: true, force: true });
        }
      });
    });
  }
});
