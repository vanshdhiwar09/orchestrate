import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EngineClient, escapeHtml } from '../src/services/engine-client.js';
import { slugifyProjectId } from '../src/components/placeholder-page.js';

describe('EngineClient', () => {
  let client: EngineClient;

  beforeEach(() => {
    client = new EngineClient('http://127.0.0.1:3001');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    client.stopPolling();
  });

  it('initializes in connecting state with configured base URL', () => {
    const info = client.getInfo();
    expect(info.state).toBe('connecting');
    expect(info.url).toBe('http://127.0.0.1:3001');
  });

  it('notifies subscribers of status changes', () => {
    const subscriber = vi.fn();
    const unsubscribe = client.subscribe(subscriber);

    // Initial notification on subscribe
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(expect.objectContaining({ state: 'connecting' }));

    unsubscribe();
  });

  it('transitions to connected when engine responds with status ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
      }),
    });

    const info = await client.checkHealth();
    expect(info.state).toBe('connected');
    expect(info.version).toBe('0.1.0');
    expect(typeof info.latencyMs).toBe('number');
    expect(info.lastChecked).toBeDefined();
  });

  it('transitions to unavailable when engine cannot be reached', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const info = await client.checkHealth();
    expect(info.state).toBe('unavailable');
    expect(info.errorMessage).toMatch(/ECONNREFUSED/);
  });

  it('transitions to error when engine returns non-200 HTTP response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Service Unavailable' }),
    });

    const info = await client.checkHealth();
    expect(info.state).toBe('error');
    expect(info.errorMessage).toContain('503');
  });

  it('starts and stops polling cleanly', () => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', version: '0.1.0' }),
    });

    client.startPolling(5000);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    client.stopPolling();
    vi.advanceTimersByTime(10000);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('creates a project with exact { id, name } payload and caches response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'demo-proj',
        name: 'Demo Project',
        createdAt: '2026-10-22T00:00:00.000Z',
        facts: [],
      }),
    });

    const created = await client.createProject({ id: 'demo-proj', name: 'Demo Project' });
    expect(created).toEqual({
      id: 'demo-proj',
      name: 'Demo Project',
      createdAt: '2026-10-22T00:00:00.000Z',
      facts: [],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 'demo-proj', name: 'Demo Project' }),
      })
    );
    expect(client.getKnownProjects()).toHaveLength(1);
  });

  it('escapes HTML special characters in escapeHtml', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('lists persisted projects from GET /projects and updates knownProjects', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        projects: [
          {
            id: 'alpha',
            name: 'Alpha App',
            createdAt: '2026-10-22T09:00:00.000Z',
            facts: [],
          },
          {
            id: 'beta',
            name: 'Beta App',
            createdAt: '2026-10-22T10:00:00.000Z',
            facts: [],
          },
        ],
      }),
    });

    const list = await client.listProjects();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(client.getKnownProjects().map((p) => p.id)).toEqual(['alpha', 'beta']);
  });

  it('surfaces clear error when GET /projects fails or engine is unreachable', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(client.listProjects()).rejects.toThrow(/Unable to reach Orchestrate Engine/);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Server Error' }),
    });
    await expect(client.listProjects()).rejects.toThrow(/Internal Server Error/);
  });

  it('surfaces duplicate ID conflict (409) and network errors on createProject', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Project "demo-proj" already exists.' }),
    });
    await expect(client.createProject({ id: 'demo-proj', name: 'Demo' })).rejects.toThrow(
      /already exists/
    );

    global.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    await expect(client.createProject({ id: 'demo-proj', name: 'Demo' })).rejects.toThrow(
      /Unable to reach Orchestrate Engine/
    );
  });

  it('generates clean lowercase slug identifiers via slugifyProjectId', () => {
    expect(slugifyProjectId('My Awesome App!')).toBe('my-awesome-app');
    expect(slugifyProjectId('  Orchestrate_Benchmark 2026  ')).toBe('orchestrate-benchmark-2026');
    expect(slugifyProjectId('---')).toBe('');
  });

  it('fetches project via getProject, returns null on 404, and throws on 500 or network error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'proj-1',
        name: 'Project One',
        createdAt: '2026-10-22T00:00:00.000Z',
        facts: [],
      }),
    });
    const proj = await client.getProject('proj-1');
    expect(proj?.name).toBe('Project One');

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    });
    expect(await client.getProject('missing')).toBeNull();

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Database failure' }),
    });
    await expect(client.getProject('proj-1')).rejects.toThrow(/Database failure/);
  });

  it('fetches handoffs and verifications and surfaces errors on failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ handoffs: [{ id: 'h1', taskId: 't1', attemptNumber: 1 }] }),
    });
    const handoffs = await client.getHandoffs('proj-1');
    expect(handoffs).toHaveLength(1);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Engine busy' }),
    });
    await expect(client.getHandoffs('proj-1')).rejects.toThrow(/Engine busy/);
    await expect(client.getVerifications('proj-1')).rejects.toThrow(/Engine busy/);
  });
});
