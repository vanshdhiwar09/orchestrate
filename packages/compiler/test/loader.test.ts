import { MemoryProjectBrain } from '@orchestrate/brain';
import { describe, expect, it } from 'vitest';
import { ContextCompiler } from '../src/compiler.js';
import { ContextLoader } from '../src/loader.js';
import { MockGitRepository } from './fixtures.js';

describe('ContextLoader & ContextCompiler', () => {
  it('loads snapshot from BrainStore and GitRepository', async () => {
    const brain = new MemoryProjectBrain();
    await brain.createProject({ id: 'proj-test', name: 'Test Project' });
    await brain.createTask({
      id: 'task-1',
      projectId: 'proj-test',
      title: 'Task 1',
      description: 'First task',
    });
    await brain.createTask({
      id: 'task-2',
      projectId: 'proj-test',
      title: 'Task 2',
      description: 'Second task',
    });

    await brain.addProjectFact('proj-test', {
      key: 'db.dialect',
      value: 'sqlite',
      provenance: 'CODE',
      status: 'VERIFIED',
    });

    await brain.addDecision({
      id: 'dec-1',
      projectId: 'proj-test',
      statement: 'Keep architecture simple',
      rationale: 'Avoid over-engineering',
      status: 'ACTIVE',
      createdAt: '2026-09-30T10:00:00.000Z',
    });

    const mockGit = new MockGitRepository();
    mockGit.diff = 'diff --git a/test.ts b/test.ts\n+console.log(1);';
    mockGit.status.unstaged = [
      { path: 'test.ts', statusCode: 'modified', rawStatus: ' M' },
    ];

    const loader = new ContextLoader({ brain, git: mockGit });
    const snapshot = await loader.load({
      projectId: 'proj-test',
      targetTaskId: 'task-2',
      upstreamTaskId: 'task-1',
    });

    expect(snapshot.targetTask?.id).toBe('task-2');
    expect(snapshot.upstreamTask?.id).toBe('task-1');
    expect(snapshot.activeDecisions).toHaveLength(1);
    expect(snapshot.projectFacts).toHaveLength(1);
    expect(snapshot.git?.diff).toContain('console.log(1)');
  });

  it('runs end-to-end through ContextCompiler facade', async () => {
    const brain = new MemoryProjectBrain();
    await brain.createProject({ id: 'proj-facade', name: 'Facade Project' });
    await brain.createTask({
      id: 'task-target',
      projectId: 'proj-facade',
      title: 'Target Task',
      description: 'Downstream',
    });

    await brain.addProjectFact('proj-facade', {
      key: 'global.framework',
      value: 'fastify',
      provenance: 'CODE',
      status: 'VERIFIED',
    });

    const compiler = new ContextCompiler({ brain });
    const compiled = await compiler.compile({
      projectId: 'proj-facade',
      targetTaskId: 'task-target',
    });

    expect(compiled.metadata.targetTaskId).toBe('task-target');
    expect(compiled.facts).toHaveLength(1);
    expect(compiled.facts[0].key).toBe('global.framework');

    const serialized = await compiler.compileAndSerialize({
      projectId: 'proj-facade',
      targetTaskId: 'task-target',
    });

    expect(serialized).toContain('<orchestrate_context>');
    expect(serialized).toContain('<fact key="global.framework" provenance="CODE">fastify</fact>');
  });

  it('handles absent Git repository gracefully', async () => {
    const brain = new MemoryProjectBrain();
    await brain.createProject({ id: 'proj-no-git', name: 'No Git' });
    await brain.createTask({
      id: 'task-1',
      projectId: 'proj-no-git',
      title: 'Target',
      description: 'Desc',
    });

    const loader = new ContextLoader({ brain });
    const snapshot = await loader.load({
      projectId: 'proj-no-git',
      targetTaskId: 'task-1',
    });

    expect(snapshot.git).toBeNull();
  });
});
