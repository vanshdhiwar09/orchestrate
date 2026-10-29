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

describe('Scenario Acceptance: profile-validation', () => {
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
    const scenarioId = 'profile-validation';
    const materialized = await ensureCanonicalScenarioRepo(scenarioId);
    const scenario = getScenarioDefinition(scenarioId);

    const factory = new LocalWorkspaceFactory({
      sourceRepoPath: materialized.repoPath,
    });

    const workspace = await factory.create(materialized.snapshotCommitSha);
    workspacesToClean.push(workspace);

    // Inject evaluator files (test/profile-validation.test.ts)
    for (const ef of scenario.evaluatorFilesTaskB ?? []) {
      const fullPath = join(workspace.path, ef.path);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, ef.content, 'utf8');
    }

    const executor = new LocalCommandExecutor({ workspaceRoot: workspace.path });
    return { workspace, executor, workspacePath: workspace.path };
  }

  it('1. resolves scenario definition by id and alias', () => {
    const byId = getScenarioDefinition('profile-validation');
    const byAlias = getScenarioDefinition('sc-profile-val');
    expect(byId.scenarioId).toBe('profile-validation');
    expect(byAlias.scenarioId).toBe('profile-validation');
    expect(byId.canonicalSnapshotCommitSha).toBe('3ffc98a6c81c3452925b26021032714c6ebf233d');
  });

  it('2. passes independent verification with compliant profile validator reference implementation', async () => {
    const { executor, workspacePath } = await setupWorkspace();

    const compliantImplementation = `import { isValidEmail } from './email-validator.ts';
import type { ValidationResult } from './types.ts';

export function validateProfile(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      valid: false,
      errors: ['Input must be a non-null object'],
    };
  }

  const errors: string[] = [];
  const rec = input as Record<string, unknown>;

  if (typeof rec.name !== 'string' || rec.name.trim() === '') {
    errors.push('Name is required and cannot be empty');
  }

  if (typeof rec.email !== 'string') {
    errors.push('Email is required');
  } else if (!isValidEmail(rec.email)) {
    errors.push('Invalid email format');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
`;
    await writeFile(join(workspacePath, 'src', 'validate-profile.ts'), compliantImplementation, 'utf8');

    // Verify module resolution passes
    const staticReport = await verifyModuleResolution(
      async (p) => (p === 'src/validate-profile.ts' ? compliantImplementation : null),
      ['src/validate-profile.ts'],
      { enforceEsmExtensions: true, allowTsExtensions: true }
    );
    expect(staticReport.passed).toBe(true);

    // Run existing tests
    const existingTestResult = await executor.execute('node', ['--test', 'test/email.test.ts'], {
      timeoutMs: 30000,
    });
    expect(existingTestResult.exitCode).toBe(0);

    // Run independent acceptance tests
    const acceptanceResult = await executor.execute('node', ['--test', 'test/profile-validation.test.ts'], {
      timeoutMs: 30000,
    });
    expect(acceptanceResult.exitCode).toBe(0);
    expect(acceptanceResult.stdout).toContain('pass 9');
    expect(acceptanceResult.stdout).toContain('fail 0');
  });

  it('3. fails verification when deliverable src/validate-profile.ts is missing', async () => {
    const { executor } = await setupWorkspace();

    const acceptanceResult = await executor.execute('node', ['--test', 'test/profile-validation.test.ts'], {
      timeoutMs: 30000,
    });
    expect(acceptanceResult.exitCode).not.toBe(0);
  });

  it('4. fails verification when implementation rejects valid extra fields', async () => {
    const { executor, workspacePath } = await setupWorkspace();

    // Defective: rejects extra fields
    const defectiveImplementation = `import { isValidEmail } from './email-validator.ts';
import type { ValidationResult } from './types.ts';

export function validateProfile(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object'] };
  }
  const keys = Object.keys(input);
  if (keys.some(k => k !== 'name' && k !== 'email')) {
    return { valid: false, errors: ['Extra fields not permitted'] };
  }
  return { valid: true, errors: [] };
}
`;
    await writeFile(join(workspacePath, 'src', 'validate-profile.ts'), defectiveImplementation, 'utf8');

    const acceptanceResult = await executor.execute('node', ['--test', 'test/profile-validation.test.ts'], {
      timeoutMs: 30000,
    });
    expect(acceptanceResult.exitCode).not.toBe(0);
    expect(acceptanceResult.stdout).toContain('permits extra fields following open schema policy');
  });

  it('5. fails verification when relative imports omit explicit extensions', async () => {
    const { executor, workspacePath } = await setupWorkspace();

    // Defective: relative import missing extension
    const extensionlessImplementation = `import { isValidEmail } from './email-validator';
import type { ValidationResult } from './types';

export function validateProfile(input: unknown): ValidationResult {
  return { valid: true, errors: [] };
}
`;
    await writeFile(join(workspacePath, 'src', 'validate-profile.ts'), extensionlessImplementation, 'utf8');

    const staticReport = await verifyModuleResolution(
      async (p) => (p === 'src/validate-profile.ts' ? extensionlessImplementation : null),
      ['src/validate-profile.ts'],
      { enforceEsmExtensions: true, allowTsExtensions: true }
    );
    expect(staticReport.passed).toBe(false);
    expect(staticReport.issues.length).toBeGreaterThan(0);
  });
});
