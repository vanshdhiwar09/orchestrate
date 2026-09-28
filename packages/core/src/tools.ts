import type { ToolDefinition } from '@orchestrate/model';
import type { CommandExecutor, Workspace } from '@orchestrate/workspace';

export interface Tool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: TInput): Promise<TOutput>;
}

export interface ProjectInfo {
  name: string;
  phase: string;
  goal: string;
}

export const getProjectInfoTool: Tool<Record<string, unknown>, ProjectInfo> = {
  name: 'get_project_info',
  description:
    'Returns metadata about the Orchestrate system, including project name, current milestone phase, and current goal.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    return {
      name: 'Orchestrate',
      phase: 'Hackathon MVP',
      goal: 'Evidence-backed AI engineering orchestration system',
    };
  },
};

export interface ReadFileInput extends Record<string, unknown> {
  path: string;
}

export interface ReadFileResult {
  path: string;
  content: string;
}

export function createReadFileTool(
  workspace: Workspace
): Tool<ReadFileInput, ReadFileResult> {
  return {
    name: 'read_file',
    description:
      'Reads the text contents of a file from the workspace given its relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path of the file to read within the workspace.',
        },
      },
      required: ['path'],
    },
    async execute(input: ReadFileInput): Promise<ReadFileResult> {
      if (!input || typeof input.path !== 'string' || input.path.trim() === '') {
        throw new Error('read_file requires a non-empty string "path" parameter.');
      }
      const content = await workspace.readFile(input.path);
      return {
        path: input.path,
        content,
      };
    },
  };
}

export interface WriteFileInput extends Record<string, unknown> {
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
  success: boolean;
}

export function createWriteFileTool(
  workspace: Workspace
): Tool<WriteFileInput, WriteFileResult> {
  return {
    name: 'write_file',
    description:
      'Writes text content to a file in the workspace given its relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path of the file to write within the workspace.',
        },
        content: {
          type: 'string',
          description: 'Text content to write into the file.',
        },
      },
      required: ['path', 'content'],
    },
    async execute(input: WriteFileInput): Promise<WriteFileResult> {
      if (!input || typeof input.path !== 'string' || input.path.trim() === '') {
        throw new Error('write_file requires a non-empty string "path" parameter.');
      }
      if (typeof input.content !== 'string') {
        throw new Error('write_file requires a string "content" parameter.');
      }
      await workspace.writeFile(input.path, input.content);
      return {
        path: input.path,
        success: true,
      };
    },
  };
}

// ── execute_command ─────────────────────────────────────────────────────────

export interface ExecuteCommandInput extends Record<string, unknown> {
  command: string;
  args: string[];
  cwd?: string;
}

export interface ExecuteCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function createExecuteCommandTool(
  executor: CommandExecutor
): Tool<ExecuteCommandInput, ExecuteCommandResult> {
  return {
    name: 'execute_command',
    description:
      'Executes an allowed command (node, npm, npx, tsc, git) in the workspace. ' +
      'Returns exit code, stdout, stderr, and whether it timed out. ' +
      'Non-zero exit codes are returned as structured results, not exceptions.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The executable to run. Must be one of: node, npm, npx, tsc, git.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments to pass to the command.',
        },
        cwd: {
          type: 'string',
          description:
            'Optional working directory relative to the workspace root. Defaults to workspace root.',
        },
      },
      required: ['command', 'args'],
    },
    async execute(input: ExecuteCommandInput): Promise<ExecuteCommandResult> {
      // Tool-boundary validation: model-generated input is untrusted.
      if (typeof input?.command !== 'string' || input.command.trim() === '') {
        throw new Error('execute_command requires a non-empty string "command" parameter.');
      }
      if (!Array.isArray(input.args)) {
        throw new Error('execute_command requires an array "args" parameter.');
      }
      for (const arg of input.args) {
        if (typeof arg !== 'string') {
          throw new Error('execute_command: each element of "args" must be a string.');
        }
      }
      if (input.cwd !== undefined && typeof input.cwd !== 'string') {
        throw new Error('execute_command: "cwd", if provided, must be a string.');
      }

      const result = await executor.execute(input.command, input.args, {
        cwd: input.cwd,
      });

      return {
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (!tool?.name || tool.name.trim() === '') {
      throw new Error('Tool registration failed: Tool must have a non-empty name.');
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool registration failed: Duplicate tool name "${tool.name}".`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  toToolDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool execution failed: Unknown tool "${name}".`);
    }

    try {
      return await tool.execute(input as Record<string, unknown>);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Tool "${name}" execution failed: ${message}`);
    }
  }
}

export interface CreateDefaultToolRegistryOptions {
  workspace?: Workspace;
  executor?: CommandExecutor;
}

export function createDefaultToolRegistry(
  options?: CreateDefaultToolRegistryOptions | Workspace
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(getProjectInfoTool);

  const ws =
    options && 'readFile' in options
      ? (options as Workspace)
      : (options as CreateDefaultToolRegistryOptions)?.workspace;

  if (ws) {
    registry.register(createReadFileTool(ws));
    registry.register(createWriteFileTool(ws));
  }

  const executor =
    options && 'readFile' in options
      ? undefined
      : (options as CreateDefaultToolRegistryOptions)?.executor;

  if (executor) {
    registry.register(createExecuteCommandTool(executor));
  }

  return registry;
}

