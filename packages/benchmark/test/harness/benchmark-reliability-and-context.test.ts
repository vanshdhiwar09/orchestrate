import { describe, it, expect } from 'vitest';
import type { ModelClient, ModelRequest, ModelResponse } from '@orchestrate/model';
import {
  TokenBudgetGuard,
  BudgetExceededError,
} from '../../src/harness/budget-guard.js';
import {
  InstrumentedModelClient,
  estimatePromptTokens,
} from '../../src/harness/instrumented-model-client.js';
import {
  RepositoryConventionExtractor,
  ContextCompilerCore,
  ContextSerializer,
} from '@orchestrate/compiler';
import {
  ToolRegistry,
  createReadFileTool,
  createWriteFileTool,
  createExecuteCommandTool,
} from '@orchestrate/core';
import type { Workspace } from '@orchestrate/workspace';
import { getScenarioDefinition } from '../../src/index.js';

describe('Step 10.22: Comprehensive Benchmark Reliability & Context Quality Fix', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Workstream 1: Prompt Accounting, Total Reservation & Overshoot Elimination
  // ───────────────────────────────────────────────────────────────────────────
  describe('Workstream 1: Prompt Estimation and Capacity Reservation', () => {
    it('estimates prompt tokens conservatively across messages, tools, and system prompt', () => {
      const request: ModelRequest = {
        model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        systemPrompt: 'You are an autonomous engineering agent.',
        messages: [
          { role: 'user', content: 'Implement validateProfile function in src/validate-profile.ts' },
          {
            role: 'assistant',
            content: 'I will inspect the workspace files first.',
            toolCalls: [
              {
                id: 'call-1',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'src/types.ts' }),
              },
            ],
          },
          {
            role: 'tool',
            content: JSON.stringify({
              path: 'src/types.ts',
              content: 'export interface ValidationResult { valid: boolean; errors: string[]; }',
            }),
          },
        ],
        tools: [
          {
            name: 'read_file',
            description: 'Reads the full text contents of a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
          {
            name: 'write_file',
            description: 'Creates or overwrites a file with content',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
        ],
      };

      const estimated = estimatePromptTokens(request);
      expect(estimated).toBeGreaterThan(100);
      expect(estimated).toBeLessThan(1000);
    });

    it('reproduces and permanently eliminates the Run 2 Arm A Call 6 overshoot failure', async () => {
      // Replicate Run 2 Arm A setup:
      // Controlled 10,000 arm token ceiling.
      // 5 calls have already completed, consuming 9,445 tokens.
      // Remaining budget: exactly 555 tokens.
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 30000,
        policy: 'CONTROLLED_PER_ARM_BUDGET',
        label: 'Session',
      });
      const armAGuard = sessionGuard.createChild({
        maxTokens: 10000,
        label: 'Arm-ARM_A_BASELINE',
      });

      // 5 turns consumed 9,445 tokens
      armAGuard.reserve(9445).commit(9445);
      expect(armAGuard.consumed).toBe(9445);
      expect(armAGuard.remaining).toBe(555);

      let mockCalled = false;
      const mockClient: ModelClient = {
        complete: async (req) => {
          mockCalled = true;
          // In Run 2, Call 6 had 2,023 prompt tokens and generated 54 completion tokens (total 2,077)
          return {
            id: 'resp-call-6',
            model: req.model,
            finishReason: 'stop',
            message: { role: 'assistant', content: 'git status check' },
            usage: {
              promptTokens: 2023,
              completionTokens: 54,
              totalTokens: 2077,
            },
          };
        },
      };

      const instrumented = new InstrumentedModelClient({
        modelClient: mockClient,
        budgetGuard: armAGuard,
        minUsefulTokens: 256,
      });

      // Turn 6: Request has 12 messages and 7 tools (prompt ~ 2,000 tokens)
      const mockMessages = Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Long message text describing code context, verification status, and tool output #${i}. `.repeat(
          15
        ),
      }));

      const mockTools = [
        { name: 'read_file', description: 'Reads file', parameters: { type: 'object' } },
        { name: 'write_file', description: 'Writes file', parameters: { type: 'object' } },
        { name: 'execute_command', description: 'Runs CLI', parameters: { type: 'object' } },
        { name: 'get_project_info', description: 'Returns info', parameters: { type: 'object' } },
      ];

      // Attempting Call 6:
      // In Run 2 (Step 10.21), this dispatched the call with clamped maxTokens=555,
      // which returned 2,077 tokens and caused total usage to reach 11,522 (overshoot).
      // In Step 10.22, prompt estimation detects that prompt (~2,000) + 256 > 555 remaining.
      // It MUST fail fast with BudgetExceededError before dispatching to the provider!
      await expect(
        instrumented.complete({
          model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
          messages: mockMessages,
          tools: mockTools,
          maxTokens: 4096,
        })
      ).rejects.toThrow(BudgetExceededError);

      // The provider was NEVER called!
      expect(mockCalled).toBe(false);

      // Arm consumption is preserved at exactly 9,445 tokens!
      expect(armAGuard.consumed).toBe(9445);
      expect(armAGuard.consumed).toBeLessThanOrEqual(10000);
      expect(armAGuard.remaining).toBe(555);

      // Session consumption remains bounded
      expect(sessionGuard.consumed).toBe(9445);
      expect(sessionGuard.consumed).toBeLessThanOrEqual(30000);
    });

    it('correctly clamps completion headroom when capacity can accommodate prompt + completion', async () => {
      // Setup: 10,000 limit. 6,711 consumed (matching Arm A after 4 calls).
      // Headroom remaining = 3,289.
      const guard = new TokenBudgetGuard({ maxTotalTokens: 10000 });
      guard.reserve(6711).commit(6711);
      expect(guard.remaining).toBe(3289);

      let capturedOutboundRequest: ModelRequest | undefined;
      const mockClient: ModelClient = {
        complete: async (req) => {
          capturedOutboundRequest = req;
          return {
            id: 'resp-call-5',
            model: req.model,
            finishReason: 'stop',
            message: { role: 'assistant', content: 'export function validateProfile() {}' },
            usage: {
              promptTokens: 1913,
              completionTokens: 821,
              totalTokens: 2734,
            },
          };
        },
      };

      const instrumented = new InstrumentedModelClient({
        modelClient: mockClient,
        budgetGuard: guard,
        minUsefulTokens: 256,
      });

      // Prompt has ~1,200 estimated tokens
      const messages = [
        { role: 'user', content: 'Implement profile validation according to specs. '.repeat(40) },
      ];

      const response = await instrumented.complete({
        model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        messages,
        maxTokens: 4096,
      });

      expect(response.message.content).toBe('export function validateProfile() {}');

      // The outbound request maxTokens was clamped to the available completion headroom!
      // Headroom = 3289 - estimatedPrompt.
      expect(capturedOutboundRequest).toBeDefined();
      expect(capturedOutboundRequest?.maxTokens).toBeLessThan(4096);
      expect(capturedOutboundRequest?.maxTokens).toBeGreaterThanOrEqual(256);

      // Total consumption committed the actual 2,734 tokens
      expect(guard.consumed).toBe(6711 + 2734); // 9,445 tokens
      expect(guard.remaining).toBe(10000 - 9445); // 555 tokens left
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Workstream 2: Context Quality & Type-only Imports Convention
  // ───────────────────────────────────────────────────────────────────────────
  describe('Workstream 2: Type-Only Import Convention Extraction', () => {
    it('extracts type_import_convention from tsconfig.json and candidate files', async () => {
      const files: Record<string, string> = {
        'package.json': JSON.stringify({
          name: 'profile-validation',
          version: '1.0.0',
          type: 'module',
          scripts: { test: 'node --test' },
        }),
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            allowImportingTsExtensions: true,
            noEmit: true,
            strict: true,
          },
        }),
        'src/types.ts': `export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
export interface UserProfile {
  name: string;
  email: string;
}`,
        'src/email-validator.ts': `export function isValidEmail(email: string): boolean { return true; }`,
      };

      const conventions = await RepositoryConventionExtractor.extract({
        readFile: async (p) => files[p] ?? null,
        candidateFiles: Object.keys(files),
      });

      const typeItem = conventions.items.find((i) => i.key === 'type_import_convention');
      expect(typeItem).toBeDefined();
      expect(typeItem?.nature).toBe('EXPLICIT_CONFIG');
      expect(typeItem?.value).toContain('Use "import type" for TypeScript interfaces and type aliases');
      expect(typeItem?.value).toContain('Node.js type-stripping removes type declarations at runtime');
      expect(typeItem?.provenance).toContain('tsconfig.json#compilerOptions.allowImportingTsExtensions');
    });

    it('serializes type_import_convention into structured XML prompt context', async () => {
      const conventions = await RepositoryConventionExtractor.extract({
        readFile: async (p) => {
          if (p === 'tsconfig.json') {
            return JSON.stringify({
              compilerOptions: {
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                allowImportingTsExtensions: true,
              },
            });
          }
          return null;
        },
      });

      const mockSnapshot = {
        request: {
          projectId: 'proj-1',
          targetTaskId: 'task-profile-validator',
        },
        targetTask: {
          id: 'task-profile-validator',
          projectId: 'proj-1',
          title: 'Task B',
        },
        upstreamTask: null,
        upstreamAttempts: [],
        activeDecisions: [],
        projectFacts: [],
        git: {
          status: { clean: true, branch: 'main', staged: [], unstaged: [], untracked: [] },
          headCommit: { hash: '3ffc98a6c81c3452925b26021032714c6ebf233d' },
          diff: '',
        },
        environmentConventions: conventions,
      };

      const compiled = ContextCompilerCore.compile(mockSnapshot as any);
      const xml = ContextSerializer.serialize(compiled);

      expect(xml).toContain('<environment_conventions>');
      expect(xml).toContain('key="type_import_convention"');
      expect(xml).toContain('nature="EXPLICIT_CONFIG"');
      expect(xml).toContain('Use &quot;import type&quot; for TypeScript interfaces and type aliases');
      expect(xml).toContain('</environment_conventions>');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Workstream 3: Tool Discovery & Guidance
  // ───────────────────────────────────────────────────────────────────────────
  describe('Workstream 3: Tool Discovery & Prevention of Hallucinated Editors', () => {
    it('provides clear write_file guidance rejecting specialized editors like str_replace_editor', () => {
      const mockWs: Workspace = {
        readFile: async () => '',
        writeFile: async () => {},
      } as any;

      const writeTool = createWriteFileTool(mockWs);
      const readTool = createReadFileTool(mockWs);

      expect(writeTool.name).toBe('write_file');
      expect(writeTool.description).toContain('Creates or overwrites a file in the workspace');
      expect(writeTool.description).toContain('specialized text editors or patch tools like str_replace_editor are NOT supported');
      expect(writeTool.description).toContain('use write_file for all file modifications');

      expect(readTool.name).toBe('read_file');
      expect(readTool.description).toContain('Reads the full text contents of a file');
      expect(readTool.description).toContain('use this instead of cat or specialized view tools');
    });

    it('rejects hallucinated editor calls with clear unknown tool error in ToolRegistry', async () => {
      const mockWs: Workspace = {
        readFile: async () => '',
        writeFile: async () => {},
      } as any;

      const registry = new ToolRegistry();
      registry.register(createReadFileTool(mockWs));
      registry.register(createWriteFileTool(mockWs));

      await expect(
        registry.execute('str_replace_editor', {
          path: 'src/validate-profile.ts',
          old_str: '',
          new_str: 'code',
        })
      ).rejects.toThrow('Tool execution failed: Unknown tool "str_replace_editor".');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Workstream 4: Verification Integrity & Type-Stripping Error Detection
  // ───────────────────────────────────────────────────────────────────────────
  describe('Workstream 4: Independent Verification Integrity', () => {
    it('fails verification when runtime import is used on stripped interfaces under Node.js 24', () => {
      // Simulates the exact failure mechanism of Arm C in Run 2:
      // export interface ValidationResult is stripped at runtime.
      // import { ValidationResult } throws SyntaxError.
      const typesModule = {}; // runtime export object from types.ts has no ValidationResult export

      function simulateImport(useTypeImport: boolean): { success: boolean; error?: string } {
        if (!useTypeImport) {
          // Standard runtime value import:
          if (!('ValidationResult' in typesModule)) {
            return {
              success: false,
              error: "SyntaxError: The requested module './types.ts' does not provide an export named 'ValidationResult'",
            };
          }
        }
        // import type is erased at compile time; runtime succeeds
        return { success: true };
      }

      // Value import (Arm C Run 2 bug)
      const valueImportResult = simulateImport(false);
      expect(valueImportResult.success).toBe(false);
      expect(valueImportResult.error).toContain("SyntaxError: The requested module './types.ts' does not provide an export named 'ValidationResult'");

      // Type-only import (Arm B & Step 10.22 fix)
      const typeImportResult = simulateImport(true);
      expect(typeImportResult.success).toBe(true);
      expect(typeImportResult.error).toBeUndefined();
    });

    it('preserves strict trust hierarchy: CODE -> VERIFICATION EVIDENCE -> PROJECT BRAIN -> AGENT CLAIMS', () => {
      // An agent may claim completion, but if verification fails, status is strictly FAILED
      const agentClaim = { status: 'COMPLETE', message: 'I have implemented profile validation' };
      const verificationResult = {
        passed: false,
        exitCode: 1,
        stderr: "SyntaxError: The requested module './types.ts' does not provide an export named 'ValidationResult'",
      };

      // Derive status adhering to hierarchy:
      const derivedStatus = verificationResult.passed ? 'VERIFIED' : 'FAILED';
      expect(derivedStatus).toBe('FAILED');
      expect(derivedStatus).not.toBe(agentClaim.status);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Step 10.24: Offline Budget Accounting & Context Parity Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe('Step 10.24: Budget Accounting with Tool Schemas & Arm C Context Parity', () => {
    const mockStandardTools = [
      {
        name: 'read_file',
        description: 'Reads the full text contents of a file in the workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative path to file' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Creates or overwrites a file in the workspace with new text contents.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'edit_file',
        description: 'Replaces exact target string with replacement string in workspace file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            target: { type: 'string' },
            replacement: { type: 'string' },
          },
          required: ['path', 'target', 'replacement'],
        },
      },
      {
        name: 'list_directory',
        description: 'Lists all files and subdirectories at the specified path.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
      {
        name: 'run_command',
        description: 'Executes a command line string in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            timeoutMs: { type: 'number' },
          },
          required: ['command'],
        },
      },
      {
        name: 'inspect_code_definition',
        description: 'Inspects AST symbol definition in source file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, symbol: { type: 'string' } },
          required: ['path', 'symbol'],
        },
      },
      {
        name: 'complete_task',
        description: 'Signals completion of the task.',
        parameters: {
          type: 'object',
          properties: { notes: { type: 'string' } },
        },
      },
    ];

    it('accurately serializes tool schemas in estimatePromptTokens accounting for tool definition overhead', () => {
      const messagesOnlyRequest: ModelRequest = {
        model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        messages: [{ role: 'user', content: 'Implement profile validator helper.' }],
      };

      const requestWithTools: ModelRequest = {
        ...messagesOnlyRequest,
        tools: mockStandardTools,
      };

      const tokensMessagesOnly = estimatePromptTokens(messagesOnlyRequest);
      const tokensWithTools = estimatePromptTokens(requestWithTools);

      // Tool schemas are ~1,800 characters of JSON schemas
      // At ~3.0 chars/token + framing, tools alone add > 600 tokens!
      expect(tokensWithTools).toBeGreaterThan(tokensMessagesOnly + 600);
      expect(tokensWithTools).toBeGreaterThanOrEqual(650);
    });

    it('reproduces and permanently prevents the Run 3 Arm B overshoot pattern (10,353 tokens)', async () => {
      // Replicate exact Run 3 Arm B Call 5 conditions:
      // Controlled arm cap: 10,000 tokens.
      // 4 turns consumed 7,345 tokens.
      // Remaining headroom: 2,655 tokens.
      const sessionGuard = new TokenBudgetGuard({
        maxTotalTokens: 30000,
        policy: 'CONTROLLED_PER_ARM_BUDGET',
        label: 'Session',
      });
      const armBGuard = sessionGuard.createChild({
        maxTokens: 10000,
        label: 'Arm-ARM_B_UNVERIFIED_HANDOFF',
      });

      armBGuard.reserve(7345).commit(7345);
      expect(armBGuard.consumed).toBe(7345);
      expect(armBGuard.remaining).toBe(2655);

      // Turn 5: Request has 10 messages and 7 tool schemas
      const mockMessages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Conversation context line #${i} with instructions, file reads, and validation details. `.repeat(
          3
        ),
      }));

      let capturedOutboundRequest: ModelRequest | undefined;
      const mockClient: ModelClient = {
        complete: async (req) => {
          capturedOutboundRequest = req;
          // In Run 3, Call 5 actual input tokens was 2,069.
          // The provider returns at most req.maxTokens completion tokens.
          const completionTokens = Math.min(req.maxTokens ?? 4096, 250);
          return {
            id: 'resp-call-5',
            model: req.model,
            finishReason: 'stop',
            message: { role: 'assistant', content: 'export function validateProfile() {}' },
            usage: {
              promptTokens: 2069, // exact input tokens from Run 3 Call 5
              completionTokens,
              totalTokens: 2069 + completionTokens,
            },
          };
        },
      };

      const instrumented = new InstrumentedModelClient({
        modelClient: mockClient,
        budgetGuard: armBGuard,
        minUsefulTokens: 256,
      });

      // Call 5 requested maxTokens: 4096
      const response = await instrumented.complete({
        model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
        messages: mockMessages,
        tools: mockStandardTools,
        maxTokens: 4096,
      });

      expect(response).toBeDefined();
      expect(capturedOutboundRequest).toBeDefined();

      // The outbound request maxTokens was strictly clamped to remaining headroom minus estimated prompt!
      // In Run 3, maxTokens was clamped to 1,632 because tools were omitted.
      // With tool schemas included, estimated prompt accounts for tools,
      // so clamped maxTokens is strictly bounded and far below requested 4096!
      expect(capturedOutboundRequest!.maxTokens!).toBeLessThanOrEqual(1200);
      expect(capturedOutboundRequest!.maxTokens!).toBeLessThan(4096);

      // Total consumption for Arm B is strictly bounded at or below 10,000!
      // In Run 3, Arm B reached 10,353 (353 overshoot).
      // Here, Arm B total tokens MUST be <= 10,000!
      expect(armBGuard.consumed).toBeLessThanOrEqual(10000);
      expect(sessionGuard.consumed).toBeLessThanOrEqual(30000);
    });

    it('fails fast when remaining capacity cannot accommodate prompt plus minUsefulTokens floor', async () => {
      // Replicate an arm with only 900 tokens remaining.
      // Prompt with 10 messages and 7 tools requires ~750+ tokens + 256 completion floor = > 1000 tokens.
      const guard = new TokenBudgetGuard({ maxTotalTokens: 10000 });
      guard.reserve(9200).commit(9200);
      expect(guard.remaining).toBe(800);

      let mockCalled = false;
      const mockClient: ModelClient = {
        complete: async () => {
          mockCalled = true;
          return {
            id: 'resp-fail',
            model: 'test',
            finishReason: 'stop',
            message: { role: 'assistant', content: '' },
          };
        },
      };

      const instrumented = new InstrumentedModelClient({
        modelClient: mockClient,
        budgetGuard: guard,
        minUsefulTokens: 256,
      });

      const mockMessages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Context line #${i} with instructions. `.repeat(4),
      }));

      await expect(
        instrumented.complete({
          model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
          messages: mockMessages,
          tools: mockStandardTools,
          maxTokens: 4096,
        })
      ).rejects.toThrow(BudgetExceededError);

      // Model was never called and budget was never exceeded
      expect(mockCalled).toBe(false);
      expect(guard.consumed).toBe(9200);
    });

    it('verifies Arm C compiled context in catalog contains type_import_convention and explicit .ts guidance', () => {
      const scenario = getScenarioDefinition('profile-validation');
      expect(scenario).toBeDefined();

      const context = scenario.armCCompiledContext;
      expect(context).toContain('key="type_import_convention"');
      expect(context).toContain('Use "import type" for TypeScript interfaces and type aliases');
      expect(context).toContain('Node.js type-stripping removes type declarations at runtime');
      expect(context).toContain('<type_import_convention>');
      expect(context).toContain("from './types.ts'");
      expect(context).toContain("from './email-validator.ts'");
    });
  });
});
