import { describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from '@orchestrate/model';
import type { Workspace } from '@orchestrate/workspace';
import { AgentRunner } from '../src/runner.js';
import { createDefaultToolRegistry, ToolRegistry } from '../src/tools.js';

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
    this.files.set(relativePath, content);
  }
}

class FakeModelClient implements ModelClient {
  public requests: ModelRequest[] = [];
  public responses: ModelResponse[] = [];

  constructor(responses?: ModelResponse[]) {
    if (responses) {
      this.responses = [...responses];
    }
  }

  get lastRequest(): ModelRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const nextResponse = this.responses.shift();
    if (nextResponse) {
      return nextResponse;
    }
    return {
      id: 'default-id',
      model: request.model,
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'Default response',
      },
    };
  }
}

describe('AgentRunner', () => {
  it('throws error when instantiated without ModelClient', () => {
    expect(() => new AgentRunner({} as any)).toThrowError(
      'AgentRunner requires a valid ModelClient instance.'
    );
  });

  it('throws error when no model is specified and no default model exists', async () => {
    const fakeClient = new FakeModelClient();
    const runner = new AgentRunner({ modelClient: fakeClient });

    await expect(runner.run({ task: 'Do work' })).rejects.toThrowError(
      'Model identifier is required'
    );
  });

  it('runs a simple user task and returns response and conversation history', async () => {
    const fakeClient = new FakeModelClient();
    const runner = new AgentRunner({
      modelClient: fakeClient,
      defaultModel: 'nebius-default-model',
    });

    const result = await runner.run({ task: 'Refactor module structure' });

    expect(fakeClient.lastRequest).toBeDefined();
    expect(fakeClient.lastRequest?.model).toBe('nebius-default-model');
    expect(fakeClient.lastRequest?.messages).toEqual([
      { role: 'user', content: 'Refactor module structure' },
    ]);

    expect(result.response.message.content).toBe('Default response');
    expect(result.iterations).toBe(1);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: 'Refactor module structure',
    });
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: 'Default response',
    });
  });

  it('includes system prompt and prior conversation history when provided', async () => {
    const fakeClient = new FakeModelClient();
    const runner = new AgentRunner({ modelClient: fakeClient });

    const history: ChatMessage[] = [
      { role: 'user', content: 'Previous message' },
      { role: 'assistant', content: 'Previous answer' },
    ];

    const result = await runner.run({
      model: 'custom-model-id',
      systemPrompt: 'You are an orchestrator agent.',
      history,
      task: 'Current task',
      temperature: 0.2,
      maxTokens: 500,
    });

    expect(fakeClient.lastRequest?.model).toBe('custom-model-id');
    expect(fakeClient.lastRequest?.temperature).toBe(0.2);
    expect(fakeClient.lastRequest?.maxTokens).toBe(500);

    const sentMessages = fakeClient.lastRequest?.messages ?? [];
    expect(sentMessages.length).toBe(4);
    expect(sentMessages[0]).toEqual({
      role: 'system',
      content: 'You are an orchestrator agent.',
    });
    expect(sentMessages[1]).toEqual({
      role: 'user',
      content: 'Previous message',
    });
    expect(sentMessages[2]).toEqual({
      role: 'assistant',
      content: 'Previous answer',
    });
    expect(sentMessages[3]).toEqual({
      role: 'user',
      content: 'Current task',
    });

    expect(result.messages.length).toBe(5);
    expect(result.messages[4]).toEqual({
      role: 'assistant',
      content: 'Default response',
    });
  });

  it('executes tool calls and continues conversation loop until final response', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'add',
      description: 'Adds two numbers',
      inputSchema: { type: 'object' },
      async execute(input: any) {
        return input.a + input.b;
      },
    });

    const step1Response: ModelResponse = {
      id: 'step-1',
      model: 'nebius-model',
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'add',
            arguments: { a: 15, b: 27 },
          },
        ],
      },
    };

    const step2Response: ModelResponse = {
      id: 'step-2',
      model: 'nebius-model',
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'The sum is 42.',
      },
    };

    const fakeClient = new FakeModelClient([step1Response, step2Response]);
    const runner = new AgentRunner({
      modelClient: fakeClient,
      defaultModel: 'nebius-model',
      toolRegistry: registry,
    });

    const result = await runner.run({ task: 'Calculate 15 + 27' });

    expect(fakeClient.requests.length).toBe(2);
    expect(result.iterations).toBe(2);
    expect(result.response.message.content).toBe('The sum is 42.');

    expect(result.messages.length).toBe(4);
    expect(result.messages[0]).toEqual({
      role: 'user',
      content: 'Calculate 15 + 27',
    });
    expect(result.messages[1]).toEqual(step1Response.message);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      name: 'add',
      toolCallId: 'call_1',
      content: '42',
    });
    expect(result.messages[3]).toEqual(step2Response.message);
  });

  it('executes get_project_info real tool via AgentRunner execution loop', async () => {
    const registry = createDefaultToolRegistry();

    const toolCallResponse: ModelResponse = {
      id: 'step-info',
      model: 'nebius-model',
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_info_1',
            name: 'get_project_info',
            arguments: {},
          },
        ],
      },
    };

    const finalAnswerResponse: ModelResponse = {
      id: 'step-final',
      model: 'nebius-model',
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'The project name is Orchestrate and phase is Hackathon MVP.',
      },
    };

    const fakeClient = new FakeModelClient([toolCallResponse, finalAnswerResponse]);
    const runner = new AgentRunner({
      modelClient: fakeClient,
      defaultModel: 'nebius-model',
      toolRegistry: registry,
    });

    const result = await runner.run({ task: 'What is the project info?' });

    expect(result.iterations).toBe(2);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      name: 'get_project_info',
      toolCallId: 'call_info_1',
      content: JSON.stringify({
        name: 'Orchestrate',
        phase: 'Hackathon MVP',
        goal: 'Evidence-backed AI engineering orchestration system',
      }),
    });
    expect(result.response.message.content).toBe(
      'The project name is Orchestrate and phase is Hackathon MVP.'
    );
  });

  it('executes read_file tool via AgentRunner execution loop with FakeWorkspace', async () => {
    const fakeWs = new FakeWorkspace({ 'docs/readme.txt': 'Project overview content' });
    const registry = createDefaultToolRegistry(fakeWs);

    const step1Response: ModelResponse = {
      id: 'read-step-1',
      model: 'nebius-model',
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_read_1',
            name: 'read_file',
            arguments: { path: 'docs/readme.txt' },
          },
        ],
      },
    };

    const step2Response: ModelResponse = {
      id: 'read-step-2',
      model: 'nebius-model',
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'The readme content is: Project overview content',
      },
    };

    const fakeClient = new FakeModelClient([step1Response, step2Response]);
    const runner = new AgentRunner({
      modelClient: fakeClient,
      defaultModel: 'nebius-model',
      toolRegistry: registry,
    });

    const result = await runner.run({ task: 'Read docs/readme.txt' });

    expect(result.iterations).toBe(2);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      name: 'read_file',
      toolCallId: 'call_read_1',
      content: JSON.stringify({
        path: 'docs/readme.txt',
        content: 'Project overview content',
      }),
    });
    expect(result.response.message.content).toBe(
      'The readme content is: Project overview content'
    );
  });

  it('executes write_file tool via AgentRunner execution loop with FakeWorkspace', async () => {
    const fakeWs = new FakeWorkspace();
    const registry = createDefaultToolRegistry(fakeWs);

    const step1Response: ModelResponse = {
      id: 'write-step-1',
      model: 'nebius-model',
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_write_1',
            name: 'write_file',
            arguments: { path: 'docs/output.txt', content: 'Generated report' },
          },
        ],
      },
    };

    const step2Response: ModelResponse = {
      id: 'write-step-2',
      model: 'nebius-model',
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'File successfully written.',
      },
    };

    const fakeClient = new FakeModelClient([step1Response, step2Response]);
    const runner = new AgentRunner({
      modelClient: fakeClient,
      defaultModel: 'nebius-model',
      toolRegistry: registry,
    });

    const result = await runner.run({ task: 'Write report to docs/output.txt' });

    expect(result.iterations).toBe(2);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      name: 'write_file',
      toolCallId: 'call_write_1',
      content: JSON.stringify({
        path: 'docs/output.txt',
        success: true,
      }),
    });
    expect(await fakeWs.readFile('docs/output.txt')).toBe('Generated report');
    expect(result.response.message.content).toBe('File successfully written.');
  });


  it('handles tool execution failures by feeding error back to conversation', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'broken_tool',
      description: 'Fails execution',
      inputSchema: { type: 'object' },
      async execute() {
        throw new Error('Database unreachable');
      },
    });

    const step1Response: ModelResponse = {
      id: 'step-1',
      model: 'nebius-model',
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_fail',
            name: 'broken_tool',
            arguments: {},
          },
        ],
      },
    };

    const step2Response: ModelResponse = {
      id: 'step-2',
      model: 'nebius-model',
      finishReason: 'stop',
      message: {
        role: 'assistant',
        content: 'I encountered an error trying to connect to the database.',
      },
    };

    const fakeClient = new FakeModelClient([step1Response, step2Response]);
    const runner = new AgentRunner({
      modelClient: fakeClient,
      defaultModel: 'nebius-model',
      toolRegistry: registry,
    });

    const result = await runner.run({ task: 'Run query' });

    expect(result.iterations).toBe(2);
    expect(result.messages[2]).toEqual({
      role: 'tool',
      name: 'broken_tool',
      toolCallId: 'call_fail',
      content: JSON.stringify({
        error: 'Tool "broken_tool" execution failed: Database unreachable',
      }),
    });
  });

  it('enforces maximum iterations bound', async () => {
    const infiniteToolResponse: ModelResponse = {
      id: 'step-loop',
      model: 'nebius-model',
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_loop',
            name: 'ping',
            arguments: {},
          },
        ],
      },
    };

    const registry = new ToolRegistry();
    registry.register({
      name: 'ping',
      description: 'Ping',
      inputSchema: { type: 'object' },
      async execute() {
        return 'pong';
      },
    });

    const fakeClient = new FakeModelClient([
      infiniteToolResponse,
      infiniteToolResponse,
      infiniteToolResponse,
    ]);

    const runner = new AgentRunner({
      modelClient: fakeClient,
      defaultModel: 'nebius-model',
      toolRegistry: registry,
      maxIterations: 2,
    });

    await expect(runner.run({ task: 'Loop forever' })).rejects.toThrowError(
      'AgentRunner reached maximum loop iterations (2) without reaching a final response.'
    );
  });
});
