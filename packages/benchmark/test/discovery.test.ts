import { describe, expect, it } from 'vitest';
import {
  basename,
  DefaultDiscoveryEvaluator,
  DefaultDiscoveryMeasurementEvaluator,
  DiscoveryEvaluationError,
  evaluateDiscovery,
  evaluateDiscoveryMeasurement,
  isNonQualifyingTool,
  normalizeDir,
  normalizePath,
  unwrapQuotes,
  type DiscoveryEvent,
  type DiscoveryEvaluationInput,
  type SuppliedContextReference,
} from '../src/index.js';

describe('Milestone 5: Discovery Measurement Evaluator', () => {
  describe('Path and Directory Normalization', () => {
    it('unwraps quotes correctly', () => {
      expect(unwrapQuotes('"src/auth.ts"')).toBe('src/auth.ts');
      expect(unwrapQuotes("'src/auth.ts'")).toBe('src/auth.ts');
      expect(unwrapQuotes('  "src/auth.ts"  ')).toBe('src/auth.ts');
      expect(unwrapQuotes('src/auth.ts')).toBe('src/auth.ts');
      expect(unwrapQuotes('""')).toBe('');
      expect(unwrapQuotes("''")).toBe('');
    });

    it('normalizes file paths across platforms and formats', () => {
      expect(normalizePath('src/auth.ts')).toBe('src/auth.ts');
      expect(normalizePath('src\\auth.ts')).toBe('src/auth.ts');
      expect(normalizePath('\\src\\auth.ts')).toBe('src/auth.ts');
      expect(normalizePath('/src/auth.ts')).toBe('src/auth.ts');
      expect(normalizePath('./src/auth.ts')).toBe('src/auth.ts');
      expect(normalizePath('.\\src\\auth.ts')).toBe('src/auth.ts');
      expect(normalizePath('src/auth.ts/')).toBe('src/auth.ts');
      expect(normalizePath('"src/auth.ts"')).toBe('src/auth.ts');
      expect(normalizePath("'src/auth.ts'")).toBe('src/auth.ts');
      expect(normalizePath('  src/auth.ts  ')).toBe('src/auth.ts');
      expect(normalizePath('.')).toBe('');
      expect(normalizePath('./')).toBe('');
      expect(normalizePath('')).toBe('');
    });

    it('normalizes directory paths ensuring trailing slashes', () => {
      expect(normalizeDir('src')).toBe('src/');
      expect(normalizeDir('src/')).toBe('src/');
      expect(normalizeDir('/src/')).toBe('src/');
      expect(normalizeDir('./src')).toBe('src/');
      expect(normalizeDir('./src/')).toBe('src/');
      expect(normalizeDir('src\\middleware')).toBe('src/middleware/');
      expect(normalizeDir('src\\middleware\\')).toBe('src/middleware/');
      expect(normalizeDir('  "src/middleware"  ')).toBe('src/middleware/');
      expect(normalizeDir('')).toBe('./');
      expect(normalizeDir('.')).toBe('./');
      expect(normalizeDir('./')).toBe('./');
      expect(normalizeDir('/')).toBe('./');
    });

    it('extracts basename accurately', () => {
      expect(basename('src/auth.ts')).toBe('auth.ts');
      expect(basename('auth.ts')).toBe('auth.ts');
      expect(basename('src/middleware/auth.ts')).toBe('auth.ts');
      expect(basename('./src/middleware/auth.ts/')).toBe('auth.ts');
      expect(basename('"src/auth.ts"')).toBe('auth.ts');
      expect(basename('')).toBe('');
    });

    it('identifies non-qualifying tools', () => {
      expect(isNonQualifyingTool('write_file')).toBe(true);
      expect(isNonQualifyingTool('replace_file_content')).toBe(true);
      expect(isNonQualifyingTool('delete_file')).toBe(true);
      expect(isNonQualifyingTool('run_command')).toBe(true);
      expect(isNonQualifyingTool('run_tests')).toBe(true);
      expect(isNonQualifyingTool('build')).toBe(true);
      expect(isNonQualifyingTool('typecheck')).toBe(true);
      expect(isNonQualifyingTool('lint')).toBe(true);
      expect(isNonQualifyingTool('commit')).toBe(true);
      expect(isNonQualifyingTool('ask_question')).toBe(true);
      expect(isNonQualifyingTool('prompt_user')).toBe(true);
      expect(isNonQualifyingTool('read_file')).toBe(false);
      expect(isNonQualifyingTool('list_files')).toBe(false);
      expect(isNonQualifyingTool('search')).toBe(false);
    });
  });

  describe('The 8 Primary Frozen Benchmark Cases (docs/DISCOVERY_MEASUREMENT.md Section 7)', () => {
    // Scenario 1: Supplied file + exact read -> Context Hit, discovery_actions = 0
    it('Scenario 1: Supplied file + exact read is a context hit (discovery_actions = 0)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'read_file',
            target: 'src/auth.ts',
            category: 'FILE_READ',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.qualifyingEvents).toHaveLength(0);
      expect(report.suppliedHits).toHaveLength(1);
      expect(report.suppliedHits[0].target).toBe('src/auth.ts');
      expect(report.summary.qualifyingCount).toBe(0);
      expect(report.summary.suppliedHitCount).toBe(1);
    });

    // Scenario 2: Supplied file + different read -> Discovery Action, discovery_actions = 1
    it('Scenario 2: Supplied file + different read is a discovery action (discovery_actions = 1)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'read_file',
            target: 'src/middleware/auth.ts',
            category: 'FILE_READ',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents).toHaveLength(1);
      expect(report.suppliedHits).toHaveLength(0);
      expect(report.qualifyingEvents[0].target).toBe('src/middleware/auth.ts');
      expect(report.summary.qualifyingCount).toBe(1);
      expect(report.summary.suppliedHitCount).toBe(0);
    });

    // Scenario 3: Supplied directory + exact listing -> Context Hit, discovery_actions = 0
    it('Scenario 3: Supplied directory + exact listing is a context hit (discovery_actions = 0)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'DIRECTORY', value: 'src/' }],
        events: [
          {
            sequence: 1,
            toolName: 'list_files',
            target: 'src/',
            category: 'FILE_LIST',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.qualifyingEvents).toHaveLength(0);
      expect(report.suppliedHits).toHaveLength(1);
      expect(report.summary.qualifyingCount).toBe(0);
      expect(report.summary.suppliedHitCount).toBe(1);
    });

    // Scenario 4: Supplied file + directory listing -> Discovery Action, discovery_actions = 1
    it('Scenario 4: Supplied file + directory listing is a discovery action (discovery_actions = 1)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'list_files',
            target: 'src/',
            category: 'FILE_LIST',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents).toHaveLength(1);
      expect(report.suppliedHits).toHaveLength(0);
      expect(report.summary.qualifyingCount).toBe(1);
    });

    // Scenario 5: Supplied symbol + exact symbol query -> Context Hit, discovery_actions = 0
    it('Scenario 5: Supplied symbol + exact symbol query is a context hit (discovery_actions = 0)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'SYMBOL', value: 'requireAuth' }],
        events: [
          {
            sequence: 1,
            toolName: 'lookup_symbol',
            target: 'requireAuth',
            category: 'SYMBOL_LOOKUP',
          },
          {
            sequence: 2,
            toolName: 'search',
            target: 'requireAuth',
            category: 'SEARCH',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.qualifyingEvents).toHaveLength(0);
      expect(report.suppliedHits).toHaveLength(2);
      expect(report.summary.suppliedHitCount).toBe(2);
    });

    // Scenario 6: Supplied symbol + unrelated search -> Discovery Action, discovery_actions = 1
    it('Scenario 6: Supplied symbol + unrelated search is a discovery action (discovery_actions = 1)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'SYMBOL', value: 'requireAuth' }],
        events: [
          {
            sequence: 1,
            toolName: 'search',
            target: 'authentication middleware',
            category: 'SEARCH',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents).toHaveLength(1);
      expect(report.suppliedHits).toHaveLength(0);
    });

    // Scenario 7: Supplied file + Git diff (no Git ref) -> Discovery Action, discovery_actions = 1
    it('Scenario 7: Supplied file + Git diff is a discovery action (discovery_actions = 1)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'git_diff',
            category: 'GIT_DIFF',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents).toHaveLength(1);
      expect(report.suppliedHits).toHaveLength(0);
    });

    // Scenario 8: Exact Git context + Git retrieval -> Context Hit, discovery_actions = 0
    it('Scenario 8: Exact Git context + Git retrieval is a context hit (discovery_actions = 0)', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'GIT_DIFF', value: '' }],
        events: [
          {
            sequence: 1,
            toolName: 'git_diff',
            category: 'GIT_DIFF',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.qualifyingEvents).toHaveLength(0);
      expect(report.suppliedHits).toHaveLength(1);
    });
  });

  describe('Duplicate Invocations Semantics (Section 6)', () => {
    it('counts repeated unsupplied file reads separately', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'read_file',
            target: 'src/unsupplied.ts',
            category: 'FILE_READ',
          },
          {
            sequence: 2,
            toolName: 'read_file',
            target: 'src/unsupplied.ts',
            category: 'FILE_READ',
          },
          {
            sequence: 3,
            toolName: 'read_file',
            target: 'src/unsupplied.ts',
            category: 'FILE_READ',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(3);
      expect(report.qualifyingEvents).toHaveLength(3);
      expect(report.suppliedHits).toHaveLength(0);
      expect(report.summary.qualifyingCount).toBe(3);
    });

    it('treats repeated supplied file reads as context hits without inflating metric', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'read_file',
            target: 'src/auth.ts',
            category: 'FILE_READ',
          },
          {
            sequence: 2,
            toolName: 'read_file',
            target: 'src/auth.ts',
            category: 'FILE_READ',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.qualifyingEvents).toHaveLength(0);
      expect(report.suppliedHits).toHaveLength(2);
      expect(report.summary.suppliedHitCount).toBe(2);
    });

    it('counts repeated unsupplied searches separately', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-profile',
        suppliedContext: [],
        events: [
          { sequence: 1, toolName: 'search', target: 'getUser', category: 'SEARCH' },
          { sequence: 2, toolName: 'search', target: 'getUser', category: 'SEARCH' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(2);
      expect(report.qualifyingEvents).toHaveLength(2);
    });
  });

  describe('Strict Type-Aware Isolation & Anti-Inference (Section 5.3)', () => {
    it('supplied DIRECTORY does not exempt FILE_READ', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'DIRECTORY', value: 'src/' }],
        events: [
          {
            sequence: 1,
            toolName: 'read_file',
            target: 'src/auth.ts',
            category: 'FILE_READ',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents).toHaveLength(1);
    });

    it('supplied FILE does not exempt DIRECTORY list_files', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'list_files',
            target: 'src/',
            category: 'FILE_LIST',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
    });

    it('supplied SYMBOL does not exempt natural-language search', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'SYMBOL', value: 'authenticateToken' }],
        events: [
          {
            sequence: 1,
            toolName: 'search',
            target: 'how to authenticate',
            category: 'SEARCH',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
    });

    it('supplied FACT, DECISION, TASK, VERIFICATION, HANDOFF do not exempt file or code retrieval', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [
          { type: 'FACT', value: 'JWT uses Bearer header' },
          { type: 'DECISION', value: 'Use fastify-jwt' },
          { type: 'TASK', value: 'Implement profile route' },
          { type: 'VERIFICATION', value: 'test:profile-200' },
          { type: 'HANDOFF', value: 'auth-handoff-v1' },
        ],
        events: [
          { sequence: 1, toolName: 'read_file', target: 'src/auth.ts', category: 'FILE_READ' },
          { sequence: 2, toolName: 'list_files', target: 'src/', category: 'FILE_LIST' },
          { sequence: 3, toolName: 'lookup_symbol', target: 'User', category: 'SYMBOL_LOOKUP' },
          { sequence: 4, toolName: 'git_status', category: 'GIT_STATE' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(4);
      expect(report.qualifyingEvents).toHaveLength(4);
      expect(report.suppliedHits).toHaveLength(0);
    });

    it('supplied FILE does not exempt Git operations', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          { sequence: 1, toolName: 'git_status', category: 'GIT_STATE' },
          { sequence: 2, toolName: 'git_log', target: 'HEAD', category: 'GIT_HISTORY' },
          { sequence: 3, toolName: 'git_diff', category: 'GIT_DIFF' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(3);
    });
  });

  describe('Git Operations Context Matching', () => {
    it('matches GIT_STATE when supplied', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'GIT_STATE', value: 'status' }],
        events: [
          { sequence: 1, toolName: 'git_status', target: 'status', category: 'GIT_STATE' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.suppliedHits).toHaveLength(1);
    });

    it('matches GIT_HISTORY with empty value to any log retrieval', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'GIT_HISTORY', value: '' }],
        events: [
          { sequence: 1, toolName: 'git_log', target: 'HEAD', category: 'GIT_HISTORY' },
          { sequence: 2, toolName: 'git_log', category: 'GIT_HISTORY' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.suppliedHits).toHaveLength(2);
    });

    it('matches GIT_HISTORY with specific ref only when target ref matches', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'GIT_HISTORY', value: 'HEAD' }],
        events: [
          { sequence: 1, toolName: 'git_log', target: 'HEAD', category: 'GIT_HISTORY' },
          { sequence: 2, toolName: 'git_log', target: 'HEAD~1', category: 'GIT_HISTORY' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents).toHaveLength(1);
      expect(report.qualifyingEvents[0].target).toBe('HEAD~1');
      expect(report.suppliedHits).toHaveLength(1);
    });

    it('matches GIT_DIFF with empty value or matching ref', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'GIT_DIFF', value: 'main' }],
        events: [
          { sequence: 1, toolName: 'git_diff', target: 'main', category: 'GIT_DIFF' },
          { sequence: 2, toolName: 'git_diff', target: 'HEAD~1', category: 'GIT_DIFF' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents[0].target).toBe('HEAD~1');
      expect(report.suppliedHits[0].target).toBe('main');
    });
  });

  describe('Search Context Exemption Variants', () => {
    it('exempts search when target matches supplied FILE full path', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/middleware/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'search',
            target: 'src/middleware/auth.ts',
            category: 'SEARCH',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.suppliedHits).toHaveLength(1);
    });

    it('exempts search when target matches supplied FILE basename', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/middleware/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'search',
            target: 'auth.ts',
            category: 'SEARCH',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.suppliedHits).toHaveLength(1);
    });

    it('does not exempt search when target matches unsupplied file basename', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/middleware/auth.ts' }],
        events: [
          {
            sequence: 1,
            toolName: 'search',
            target: 'server.ts',
            category: 'SEARCH',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
    });
  });

  describe('Non-Qualifying Tools & Unknown Tools (Section 3.2 & Section 9)', () => {
    it('strictly excludes file modification, execution, build, test, and commit tools from discovery_actions', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [],
        events: [
          { sequence: 1, toolName: 'write_file', target: 'src/auth.ts', category: 'FILE_READ' },
          { sequence: 2, toolName: 'run_tests', category: 'SEARCH' },
          { sequence: 3, toolName: 'build', category: 'FILE_LIST' },
          { sequence: 4, toolName: 'typecheck', category: 'SYMBOL_LOOKUP' },
          { sequence: 5, toolName: 'commit', category: 'GIT_STATE' },
          { sequence: 6, toolName: 'delete_file', target: 'tmp.ts', category: 'FILE_READ' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.qualifyingEvents).toHaveLength(0);
      expect(report.unclassified).toHaveLength(6);
      expect(report.summary.unclassifiedCount).toBe(6);
      expect(report.summary.qualifyingCount).toBe(0);
    });

    it('excludes human intervention tools from discovery_actions', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [],
        events: [
          {
            sequence: 1,
            toolName: 'ask_question',
            target: 'What is the secret key?',
            category: 'SEARCH',
          },
          {
            sequence: 2,
            toolName: 'prompt_user',
            target: 'Need help',
            category: 'SEARCH',
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.unclassified).toHaveLength(2);
      expect(report.summary.unclassifiedCount).toBe(2);
    });

    it('records unknown categories in unclassified without inflating discovery_actions', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [],
        events: [
          {
            sequence: 1,
            toolName: 'custom_inspect',
            target: 'something',
            category: 'INVALID_CATEGORY' as any,
          },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(0);
      expect(report.unclassified).toHaveLength(1);
      expect(report.unclassified[0].reason).toContain('not a valid qualifying discovery category');
    });

    it('preserves pre-existing unclassifiedEvents in report', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [],
        events: [
          { sequence: 2, toolName: 'read_file', target: 'src/foo.ts', category: 'FILE_READ' },
        ],
        unclassifiedEvents: [
          { sequence: 1, toolName: 'complex_bash_pipe', rawInput: 'cat a | grep b', reason: 'Unparseable shell pipeline' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(1);
      expect(report.unclassified).toHaveLength(1);
      expect(report.unclassified[0].toolName).toBe('complex_bash_pipe');
      expect(report.summary.unclassifiedCount).toBe(1);
      expect(report.summary.totalEventsEvaluated).toBe(2);
    });
  });

  describe('Arm Blindness Across Benchmark Scenarios', () => {
    const events: DiscoveryEvent[] = [
      { sequence: 1, toolName: 'read_file', target: 'src/middleware/auth.ts', category: 'FILE_READ' },
      { sequence: 2, toolName: 'read_file', target: 'src/config.ts', category: 'FILE_READ' },
      { sequence: 3, toolName: 'lookup_symbol', target: 'authenticateToken', category: 'SYMBOL_LOOKUP' },
      { sequence: 4, toolName: 'list_files', target: 'src/utils/', category: 'FILE_LIST' },
    ];

    it('Arm A (Baseline): empty context envelope results in all retrievals counting as discovery', () => {
      const armAInput: DiscoveryEvaluationInput = {
        taskId: 'task-profile-arm-a',
        suppliedContext: [],
        events,
      };

      const report = evaluateDiscovery(armAInput);
      expect(report.discovery_actions).toBe(4);
      expect(report.suppliedHits).toHaveLength(0);
      expect(report.qualifyingEvents).toHaveLength(4);
    });

    it('Arm B (Unverified Handoff): only unverified references in handoff are exempt', () => {
      const armBInput: DiscoveryEvaluationInput = {
        taskId: 'task-profile-arm-b',
        suppliedContext: [
          { type: 'FILE', value: 'src/middleware/auth.ts' },
          { type: 'SYMBOL', value: 'authenticateToken' },
        ],
        events,
      };

      const report = evaluateDiscovery(armBInput);
      // auth.ts and authenticateToken match; config.ts and src/utils/ are discovery
      expect(report.discovery_actions).toBe(2);
      expect(report.suppliedHits).toHaveLength(2);
      expect(report.qualifyingEvents).toHaveLength(2);
    });

    it('Arm C (Orchestrate): verified Brain context exempts verified items and measures extra discovery', () => {
      const armCInput: DiscoveryEvaluationInput = {
        taskId: 'task-profile-arm-c',
        suppliedContext: [
          { type: 'FILE', value: 'src/middleware/auth.ts' },
          { type: 'SYMBOL', value: 'authenticateToken' },
          { type: 'DIRECTORY', value: 'src/utils/' },
          { type: 'FACT', value: 'Auth token verified' },
        ],
        events,
      };

      const report = evaluateDiscovery(armCInput);
      // auth.ts, authenticateToken, and src/utils/ are exempt; config.ts is discovery
      expect(report.discovery_actions).toBe(1);
      expect(report.qualifyingEvents[0].target).toBe('src/config.ts');
      expect(report.suppliedHits).toHaveLength(3);
    });
  });

  describe('Ordering, Determinism and Immutability', () => {
    it('sorts events by sequence index regardless of input array order', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/b.ts' }],
        events: [
          { sequence: 3, toolName: 'read_file', target: 'src/c.ts', category: 'FILE_READ' },
          { sequence: 1, toolName: 'read_file', target: 'src/a.ts', category: 'FILE_READ' },
          { sequence: 2, toolName: 'read_file', target: 'src/b.ts', category: 'FILE_READ' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(report.discovery_actions).toBe(2);
      expect(report.qualifyingEvents[0].sequence).toBe(1);
      expect(report.qualifyingEvents[1].sequence).toBe(3);
      expect(report.suppliedHits[0].sequence).toBe(2);
    });

    it('returns a deeply frozen immutable report', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          { sequence: 1, toolName: 'read_file', target: 'src/auth.ts', category: 'FILE_READ' },
        ],
      };

      const report = evaluateDiscovery(input);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.qualifyingEvents)).toBe(true);
      expect(Object.isFrozen(report.suppliedHits)).toBe(true);
      expect(Object.isFrozen(report.summary)).toBe(true);
      expect(() => {
        (report as any).discovery_actions = 99;
      }).toThrow();
    });

    it('produces identical output on repeated runs', () => {
      const input: DiscoveryEvaluationInput = {
        taskId: 'task-test',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          { sequence: 1, toolName: 'read_file', target: 'src/auth.ts', category: 'FILE_READ' },
          { sequence: 2, toolName: 'read_file', target: 'src/other.ts', category: 'FILE_READ' },
        ],
      };

      const report1 = evaluateDiscovery(input);
      const report2 = evaluateDiscovery(input);
      expect(report1).toEqual(report2);
    });
  });

  describe('Input Validation & Error Handling', () => {
    it('throws DiscoveryEvaluationError for null or non-object input', () => {
      expect(() => evaluateDiscovery(null as any)).toThrow(DiscoveryEvaluationError);
      expect(() => evaluateDiscovery(undefined as any)).toThrow(DiscoveryEvaluationError);
      expect(() => evaluateDiscovery('string' as any)).toThrow(DiscoveryEvaluationError);
    });

    it('throws DiscoveryEvaluationError for missing or empty taskId', () => {
      expect(() =>
        evaluateDiscovery({ taskId: '', suppliedContext: [], events: [] })
      ).toThrow(DiscoveryEvaluationError);
      expect(() =>
        evaluateDiscovery({ taskId: '   ', suppliedContext: [], events: [] })
      ).toThrow(DiscoveryEvaluationError);
      expect(() =>
        evaluateDiscovery({ taskId: null as any, suppliedContext: [], events: [] })
      ).toThrow(DiscoveryEvaluationError);
    });

    it('throws DiscoveryEvaluationError for non-array suppliedContext', () => {
      expect(() =>
        evaluateDiscovery({ taskId: 't1', suppliedContext: null as any, events: [] })
      ).toThrow(DiscoveryEvaluationError);
      expect(() =>
        evaluateDiscovery({ taskId: 't1', suppliedContext: {} as any, events: [] })
      ).toThrow(DiscoveryEvaluationError);
    });

    it('throws DiscoveryEvaluationError for non-array events', () => {
      expect(() =>
        evaluateDiscovery({ taskId: 't1', suppliedContext: [], events: null as any })
      ).toThrow(DiscoveryEvaluationError);
    });

    it('throws DiscoveryEvaluationError for invalid suppliedContext items', () => {
      expect(() =>
        evaluateDiscovery({
          taskId: 't1',
          suppliedContext: [{ type: 'INVALID' as any, value: 'val' }],
          events: [],
        })
      ).toThrow(DiscoveryEvaluationError);

      expect(() =>
        evaluateDiscovery({
          taskId: 't1',
          suppliedContext: [{ type: 'FILE', value: 123 as any }],
          events: [],
        })
      ).toThrow(DiscoveryEvaluationError);
    });

    it('throws DiscoveryEvaluationError for non-array unclassifiedEvents if provided', () => {
      expect(() =>
        evaluateDiscovery({
          taskId: 't1',
          suppliedContext: [],
          events: [],
          unclassifiedEvents: 'not-array' as any,
        })
      ).toThrow(DiscoveryEvaluationError);
    });
  });

  describe('Class Wrappers & Aliases', () => {
    it('DefaultDiscoveryEvaluator evaluates correctly', () => {
      const evaluator = new DefaultDiscoveryEvaluator();
      const report = evaluator.evaluate({
        taskId: 'class-test',
        suppliedContext: [{ type: 'FILE', value: 'src/auth.ts' }],
        events: [
          { sequence: 1, toolName: 'read_file', target: 'src/auth.ts', category: 'FILE_READ' },
        ],
      });

      expect(report.discovery_actions).toBe(0);
      expect(report.suppliedHits).toHaveLength(1);
    });

    it('aliases DefaultDiscoveryMeasurementEvaluator and evaluateDiscoveryMeasurement work identically', () => {
      const evaluator = new DefaultDiscoveryMeasurementEvaluator();
      const input: DiscoveryEvaluationInput = {
        taskId: 'alias-test',
        suppliedContext: [],
        events: [
          { sequence: 1, toolName: 'read_file', target: 'src/foo.ts', category: 'FILE_READ' },
        ],
      };

      const reportClass = evaluator.evaluate(input);
      const reportFunc = evaluateDiscoveryMeasurement(input);
      expect(reportClass.discovery_actions).toBe(1);
      expect(reportFunc.discovery_actions).toBe(1);
      expect(reportClass).toEqual(reportFunc);
    });
  });
});
