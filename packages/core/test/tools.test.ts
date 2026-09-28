import { describe, expect, it } from 'vitest';
import type { Workspace } from '@orchestrate/workspace';
import type { Tool } from '../src/tools.js';
import {
  createDefaultToolRegistry,
  createReadFileTool,
  createWriteFileTool,
  getProjectInfoTool,
  ToolRegistry,
} from '../src/tools.js';

class FakeWorkspace implements Workspace {
  private files = new Map<string, string>();

  constructor(initialFiles?: Record<string, string>) {
    if (initialFiles) {
      for (const [path, content] of Object.entries(initialFiles)) {
        this.files.set(path, content);
      }
    }
  }

  async readFile(relativePath: string): Promise<string> {
    const content = this.files.get(relativePath);
    if (content === undefined) {
      throw new Error(`File not found in workspace: "${relativePath}"`);
    }
    return content;
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    if (relativePath.includes('..')) {
      throw new Error(
        `Path traversal denied: Requested path "${relativePath}" escapes workspace root.`
      );
    }
    this.files.set(relativePath, content);
  }
}

describe('ToolRegistry, read_file & write_file Tools', () => {
  const sampleTool: Tool<{ a: number; b: number }, number> = {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    async execute(input) {
      return input.a + input.b;
    },
  };

  it('1. registers a tool successfully', () => {
    const registry = new ToolRegistry();
    registry.register(sampleTool);

    expect(registry.get('add')).toBe(sampleTool);
  });

  it('2. rejects duplicate tool registration', () => {
    const registry = new ToolRegistry();
    registry.register(sampleTool);

    expect(() => registry.register(sampleTool)).toThrowError(
      'Tool registration failed: Duplicate tool name "add".'
    );
  });

  it('3. retrieves and lists registered tools', () => {
    const registry = new ToolRegistry();
    const secondTool: Tool = {
      name: 'ping',
      description: 'Ping tool',
      inputSchema: { type: 'object' },
      async execute() {
        return 'pong';
      },
    };

    registry.register(sampleTool);
    registry.register(secondTool);

    expect(registry.get('add')).toBe(sampleTool);
    expect(registry.get('ping')).toBe(secondTool);
    expect(registry.list()).toEqual([sampleTool, secondTool]);
  });

  it('4. executes a tool with input successfully', async () => {
    const registry = new ToolRegistry();
    registry.register(sampleTool);

    const result = await registry.execute('add', { a: 10, b: 32 });
    expect(result).toBe(42);
  });

  it('5. rejects execution of an unknown tool', async () => {
    const registry = new ToolRegistry();

    await expect(registry.execute('unknown_tool', {})).rejects.toThrowError(
      'Tool execution failed: Unknown tool "unknown_tool".'
    );
  });

  it('6. propagates tool execution failure observably', async () => {
    const failingTool: Tool = {
      name: 'fail',
      description: 'Failing tool',
      inputSchema: { type: 'object' },
      async execute() {
        throw new Error('Database connection failed');
      },
    };

    const registry = new ToolRegistry();
    registry.register(failingTool);

    await expect(registry.execute('fail', {})).rejects.toThrowError(
      'Tool "fail" execution failed: Database connection failed'
    );
  });

  it('7. read_file successfully reads a normal file through a fake Workspace', async () => {
    const fakeWs = new FakeWorkspace({ 'README.md': '# Orchestrate Project' });
    const readFileTool = createReadFileTool(fakeWs);

    const result = await readFileTool.execute({ path: 'README.md' });
    expect(result).toEqual({
      path: 'README.md',
      content: '# Orchestrate Project',
    });
  });

  it('8. read_file successfully returns nested file contents', async () => {
    const fakeWs = new FakeWorkspace({
      'packages/core/src/index.ts': 'export * from "./runner.js";',
    });
    const readFileTool = createReadFileTool(fakeWs);

    const result = await readFileTool.execute({
      path: 'packages/core/src/index.ts',
    });
    expect(result).toEqual({
      path: 'packages/core/src/index.ts',
      content: 'export * from "./runner.js";',
    });
  });

  it('9. read_file rejects malformed or missing path input', async () => {
    const fakeWs = new FakeWorkspace();
    const readFileTool = createReadFileTool(fakeWs);

    await expect(readFileTool.execute({ path: '' })).rejects.toThrowError(
      'read_file requires a non-empty string "path" parameter.'
    );
    await expect(readFileTool.execute({ path: undefined as any })).rejects.toThrowError(
      'read_file requires a non-empty string "path" parameter.'
    );
  });

  it('10. Workspace errors are propagated correctly by read_file', async () => {
    const fakeWs = new FakeWorkspace();
    const readFileTool = createReadFileTool(fakeWs);

    await expect(readFileTool.execute({ path: 'missing.txt' })).rejects.toThrowError(
      'File not found in workspace: "missing.txt"'
    );
  });

  it('11. write_file successfully writes a file through a fake Workspace', async () => {
    const fakeWs = new FakeWorkspace();
    const writeFileTool = createWriteFileTool(fakeWs);

    const result = await writeFileTool.execute({
      path: 'notes.txt',
      content: 'Hello, Write File!',
    });

    expect(result).toEqual({
      path: 'notes.txt',
      success: true,
    });
    expect(await fakeWs.readFile('notes.txt')).toBe('Hello, Write File!');
  });

  it('12. write_file rejects malformed, missing, or empty path and content inputs', async () => {
    const fakeWs = new FakeWorkspace();
    const writeFileTool = createWriteFileTool(fakeWs);

    await expect(
      writeFileTool.execute({ path: '', content: 'hello' })
    ).rejects.toThrowError('write_file requires a non-empty string "path" parameter.');

    await expect(
      writeFileTool.execute({ path: undefined as any, content: 'hello' })
    ).rejects.toThrowError('write_file requires a non-empty string "path" parameter.');

    await expect(
      writeFileTool.execute({ path: 'notes.txt', content: undefined as any })
    ).rejects.toThrowError('write_file requires a string "content" parameter.');

    await expect(
      writeFileTool.execute({ path: 'notes.txt', content: 123 as any })
    ).rejects.toThrowError('write_file requires a string "content" parameter.');
  });

  it('13. Workspace.writeFile errors are propagated correctly by write_file', async () => {
    const fakeWs = new FakeWorkspace();
    const writeFileTool = createWriteFileTool(fakeWs);

    await expect(
      writeFileTool.execute({ path: '../secret.txt', content: 'bad' })
    ).rejects.toThrowError('Path traversal denied');
  });

  it('14. ToolRegistry exposes get_project_info, read_file, and write_file when workspace is passed', () => {
    const fakeWs = new FakeWorkspace();
    const registry = createDefaultToolRegistry(fakeWs);

    expect(registry.get('get_project_info')).toBe(getProjectInfoTool);
    expect(registry.get('read_file')).toBeDefined();
    expect(registry.get('write_file')).toBeDefined();

    const toolNames = registry.list().map((t) => t.name);
    expect(toolNames).toEqual(['get_project_info', 'read_file', 'write_file']);
  });
});



