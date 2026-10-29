import { describe, expect, it } from 'vitest';
import {
  detectRepositoryModuleResolutionRule,
  validateRelativeImportsInContent,
  verifyModuleResolution,
} from '../src/index.js';

describe('Early NodeNext/ESM Verification Check', () => {
  it('1. reproduces the exact Step 10.11 postmortem failure on extensionless relative import', () => {
    const buggyCode = `import { authenticateToken } from '../middleware/auth';
import { USERS } from '../users';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserPayload } from '../types';

export function handler(req: any, res: any) {}`;

    const issues = validateRelativeImportsInContent('src/routes/profile.ts', buggyCode, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(3);
    expect(issues[0]).toEqual({
      file: 'src/routes/profile.ts',
      line: 1,
      specifier: '../middleware/auth',
      reason: expect.stringContaining('Relative import "../middleware/auth" is missing an explicit file extension'),
    });
    expect(issues[1]).toEqual({
      file: 'src/routes/profile.ts',
      line: 2,
      specifier: '../users',
      reason: expect.stringContaining('Relative import "../users" is missing an explicit file extension'),
    });
    expect(issues[2]).toEqual({
      file: 'src/routes/profile.ts',
      line: 4,
      specifier: '../types',
      reason: expect.stringContaining('Relative import "../types" is missing an explicit file extension'),
    });
  });

  it('2. accepts compliant relative imports with explicit .ts extension when permitted', () => {
    const compliantCode = `import { authenticateToken } from '../middleware/auth.ts';
import { USERS } from '../users.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserPayload } from '../types.ts';

export function handler(req: any, res: any) {}`;

    const issues = validateRelativeImportsInContent('src/routes/profile.ts', compliantCode, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(0);
  });

  it('3. accepts compliant relative imports with explicit .js extension', () => {
    const jsCode = `import { auth } from './auth.js';\nexport * from '../utils/math.js';`;

    const issues = validateRelativeImportsInContent('src/index.ts', jsCode, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(0);
  });

  it('4. avoids false positives for bare package imports, node: built-ins, and aliases', () => {
    const cleanCode = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import lodash from 'lodash';
import { Tool } from '@orchestrate/core';
import { helper } from '#internal/helper';`;

    const issues = validateRelativeImportsInContent('test/sample.test.ts', cleanCode, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(0);
  });

  it('5. ignores commented-out import statements in single-line and multi-line comments', () => {
    const commentedCode = `// import { old } from '../old/auth';
/*
  import { legacy } from './legacy';
*/
import { current } from './current.ts';`;

    const issues = validateRelativeImportsInContent('src/service.ts', commentedCode, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(0);
  });

  it('6. detects repository configuration and activates rule only when NodeNext ESM is specified', async () => {
    const esmFiles: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'module' }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          allowImportingTsExtensions: true,
        },
      }),
    };

    const rule = await detectRepositoryModuleResolutionRule(async (p) => esmFiles[p] ?? null);
    expect(rule).toEqual({
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    const cjsFiles: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'commonjs' }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'commonjs' } }),
    };

    const cjsRule = await detectRepositoryModuleResolutionRule(async (p) => cjsFiles[p] ?? null);
    expect(cjsRule).toBeNull();
  });

  it('7. verifies full workspace report, producing actionable summary', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'module' }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          moduleResolution: 'NodeNext',
          allowImportingTsExtensions: true,
        },
      }),
      'src/routes/profile.ts': `import { auth } from '../middleware/auth';`,
      'src/middleware/auth.ts': `import { USERS } from '../users.ts';`,
    };

    const report = await verifyModuleResolution(
      async (p) => files[p] ?? null,
      ['src/routes/profile.ts', 'src/middleware/auth.ts']
    );

    expect(report.active).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.checkedFilesCount).toBe(2);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].file).toBe('src/routes/profile.ts');
    expect(report.summary).toContain('Module-resolution check failed with 1 issue(s)');
  });

  it('8. accurately detects extensionless specifiers in multiline static imports, dynamic imports, and re-exports', () => {
    const complexCode = `
import {
  AuthRequest,
  authenticateToken
} from '../middleware/auth';

export {
  UserPayload
} from '../types';

export * from '../services/user';

export * as math from '../utils/math';

async function load() {
  const mod = await import(
    '../dynamic/loader'
  );
  return mod;
}

import '../side-effect';
`;

    const issues = validateRelativeImportsInContent('src/routes/profile.ts', complexCode, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(6);

    // Multiline static import on line 5
    expect(issues[0].specifier).toBe('../middleware/auth');
    expect(issues[0].line).toBe(5);

    // Multiline export on line 9
    expect(issues[1].specifier).toBe('../types');
    expect(issues[1].line).toBe(9);

    // export * on line 11
    expect(issues[2].specifier).toBe('../services/user');
    expect(issues[2].line).toBe(11);

    // export * as on line 13
    expect(issues[3].specifier).toBe('../utils/math');
    expect(issues[3].line).toBe(13);

    // Multiline dynamic import on line 17
    expect(issues[4].specifier).toBe('../dynamic/loader');
    expect(issues[4].line).toBe(17);

    // Side effect on line 22
    expect(issues[5].specifier).toBe('../side-effect');
    expect(issues[5].line).toBe(22);
  });

  it('9. strings containing import-like text do not generate false diagnostics', () => {
    const codeWithStrings = `
import { real } from './real.ts';

const helpText = "import { foo } from './fake';";
const sampleCode = 'export * from "./fake";';
const logMsg = "import('./dynamic-fake');";

export function getHelp() {
  return helpText + sampleCode + logMsg;
}
`;

    const issues = validateRelativeImportsInContent('src/utils.ts', codeWithStrings, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(0);
  });

  it('10. unsupported dynamic-import expressions are flagged and cannot be represented as verified coverage', () => {
    const codeWithDynamicExpr = `
import { helper } from './helper.ts';

async function loadPlugin(pluginName: string) {
  const mod1 = await import(pluginName);
  const mod2 = await import('./plugins/' + pluginName);
  return { mod1, mod2 };
}
`;

    const issues = validateRelativeImportsInContent('src/loader.ts', codeWithDynamicExpr, {
      enforceEsmExtensions: true,
      allowTsExtensions: true,
    });

    expect(issues).toHaveLength(2);
    expect(issues[0].specifier).toBe('pluginName');
    expect(issues[0].reason).toContain('Dynamic import with non-literal expression');
    expect(issues[0].reason).toContain('cannot be represented as verified coverage');

    expect(issues[1].specifier).toBe("'./plugins/' + pluginName");
    expect(issues[1].reason).toContain('Dynamic import with non-literal expression');
  });

  it('11. detectRepositoryModuleResolutionRule fails closed with error when configuration is unparseable', async () => {
    const malformedFiles: Record<string, string> = {
      'package.json': '{ "type": "module", broken json ...',
    };

    await expect(
      detectRepositoryModuleResolutionRule(async (p) => malformedFiles[p] ?? null)
    ).rejects.toThrow(/Failed to parse package\.json/);

    const malformedTsFiles: Record<string, string> = {
      'package.json': JSON.stringify({ type: 'module' }),
      'tsconfig.json': '{ "compilerOptions": { ... unclosed syntax',
    };

    await expect(
      detectRepositoryModuleResolutionRule(async (p) => malformedTsFiles[p] ?? null)
    ).rejects.toThrow(/Failed to parse tsconfig\.json/);
  });
});
