import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAppInfoHtml,
  buildAppSettingsHtml,
  buildDiagnosticsHtml,
  buildEngineConfigHtml,
  buildEngineConnectionHtml,
  renderPlaceholderPage,
} from '../src/components/placeholder-page.js';
import {
  engineClient,
  type EngineHealthInfo,
} from '../src/services/engine-client.js';
import { router } from '../src/services/router.js';
import {
  DEFAULT_APP_SETTINGS,
  loadApplicationSettings,
  saveApplicationSettings,
  validateEngineUrl,
  type ApplicationSettings,
} from '../src/services/settings-store.js';

class MockElement {
  public tagName: string;
  public id = '';
  public className = '';
  public textContent = '';
  public value = '';
  public disabled = false;
  public checked = false;
  public style: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public eventListeners: Record<string, Array<(e?: any) => void>> = {};
  private _innerHTML = '';
  public children: MockElement[] = [];
  private queriedChildren: Map<string, MockElement> = new Map();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  public get innerHTML(): string {
    return this._innerHTML;
  }

  public set innerHTML(val: string) {
    this._innerHTML = val;
    this.textContent = val.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  public appendChild(child: MockElement): MockElement {
    this.children.push(child);
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public addEventListener(event: string, fn: (e?: any) => void): void {
    if (!this.eventListeners[event]) this.eventListeners[event] = [];
    this.eventListeners[event].push(fn);
  }

  public querySelector(selector: string): MockElement | null {
    if (!this.queriedChildren.has(selector)) {
      this.queriedChildren.set(selector, new MockElement('div'));
    }
    return this.queriedChildren.get(selector)!;
  }

  public querySelectorAll(_selector: string): MockElement[] {
    return [];
  }

  public get combinedHtml(): string {
    const childHtml = Array.from(this.queriedChildren.values())
      .map((c) => c.innerHTML || c.textContent)
      .join('\n');
    return `${this._innerHTML}\n${childHtml}`;
  }
}

describe('Settings & Engine Diagnostics (Step 8)', () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    mockStorage = {};

    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        mockStorage[key] = val;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        mockStorage = {};
      },
    });

    vi.stubGlobal('document', {
      createElement: (tag: string) => new MockElement(tag),
      body: new MockElement('body'),
    });
  });

  // ==========================================================================
  // 1. Settings Store & Validation
  // ==========================================================================
  describe('1. Settings Store & Validation', () => {
    it('validates engine URLs properly', () => {
      expect(validateEngineUrl('http://127.0.0.1:3001').valid).toBe(true);
      expect(validateEngineUrl('https://engine.orchestrate.local:4000').valid).toBe(true);
      expect(validateEngineUrl('   https://engine.example.com/api  ').valid).toBe(true);

      expect(validateEngineUrl('').valid).toBe(false);
      expect(validateEngineUrl('not-a-url').valid).toBe(false);
      expect(validateEngineUrl('ftp://example.com').valid).toBe(false);
      expect(validateEngineUrl('ws://example.com').valid).toBe(false);
    });

    it('loads default settings when storage is empty', () => {
      const settings = loadApplicationSettings();
      expect(settings).toEqual(DEFAULT_APP_SETTINGS);
      expect(settings.theme).toBe('light');
      expect(settings.autoRefresh).toBe(true);
      expect(settings.engineUrl).toBe('http://127.0.0.1:3001');
    });

    it('persists preferences and retrieves them from storage', () => {
      const res = saveApplicationSettings({
        engineUrl: 'http://localhost:3002',
        autoRefresh: false,
        openLinksInNewTab: false,
      });

      expect(res.success).toBe(true);
      expect(res.settings.engineUrl).toBe('http://localhost:3002');
      expect(res.settings.autoRefresh).toBe(false);
      expect(res.settings.openLinksInNewTab).toBe(false);

      const reloaded = loadApplicationSettings();
      expect(reloaded.engineUrl).toBe('http://localhost:3002');
      expect(reloaded.autoRefresh).toBe(false);
      expect(reloaded.openLinksInNewTab).toBe(false);
      expect(reloaded.theme).toBe('light'); // default preserved
    });

    it('rejects invalid engine URL and does not mutate storage', () => {
      const initial = loadApplicationSettings();
      const res = saveApplicationSettings({ engineUrl: 'invalid://url' });

      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();

      const reloaded = loadApplicationSettings();
      expect(reloaded.engineUrl).toBe(initial.engineUrl);
    });
  });

  // ==========================================================================
  // 2. Diagnostics View Derivation & Truthfulness
  // ==========================================================================
  describe('2. Diagnostics View Derivation & Truthfulness', () => {
    const connectedHealthyInfo: EngineHealthInfo = {
      state: 'connected',
      version: '0.1.0',
      latencyMs: 14,
      lastChecked: '2026-10-23T10:00:00.000Z',
      url: 'http://127.0.0.1:3001',
      process: {
        pid: 12345,
        uptimeSeconds: 360,
        nodeVersion: 'v22.8.0',
        memoryUsageMb: 42,
      },
      model: {
        provider: 'nebius',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
        hasApiKey: true,
        baseUrl: 'https://api.tokenfactory.nebius.com/v1',
      },
      capabilities: {
        tools: ['get_project_info', 'read_file', 'write_file', 'execute_command'],
        workspace: 'local-sandboxed',
        verification: 'verification-engine',
      },
    };

    it('renders truthful diagnostics when engine is connected with API key present', () => {
      const html = buildDiagnosticsHtml(connectedHealthyInfo);

      expect(html).toContain('Engine Reachability');
      expect(html).toContain('OK');
      expect(html).toContain('14 ms');
      expect(html).toContain('Authentication');
      expect(html).toContain('NEBIUS_API_KEY configured (masked)');
      expect(html).toContain('Model Availability');
      expect(html).toContain('meta-llama/Llama-3.3-70B-Instruct');
      expect(html).toContain('Request Processing');
      expect(html).toContain('Capabilities ready: 4 tools');

      // Offline diagnostic disclaimer
      expect(html).toContain('Model inference was <strong>not executed</strong> during this check');

      // Must not leak secret keys or credentials
      expect(html).not.toContain('secret');
      expect(html).not.toContain('apiKey:');
    });

    it('renders WARN when engine is connected but NEBIUS_API_KEY is not configured', () => {
      const infoWithoutKey: EngineHealthInfo = {
        ...connectedHealthyInfo,
        model: {
          ...connectedHealthyInfo.model!,
          hasApiKey: false,
        },
      };

      const html = buildDiagnosticsHtml(infoWithoutKey);
      expect(html).toContain('WARN');
      expect(html).toContain('NEBIUS_API_KEY environment variable is not set');
    });

    it('renders FAIL and UNKNOWN states truthfully when engine is offline', () => {
      const offlineInfo: EngineHealthInfo = {
        state: 'unavailable',
        url: 'http://127.0.0.1:3001',
        errorMessage: 'ECONNREFUSED 127.0.0.1:3001',
      };

      const html = buildDiagnosticsHtml(offlineInfo);
      expect(html).toContain('FAIL');
      expect(html).toContain('Failed to connect to engine at http://127.0.0.1:3001');
      expect(html).toContain('UNKNOWN');
      expect(html).toContain('Cannot verify credentials while engine is unreachable');
      expect(html).toContain('Engine offline');
    });
  });

  // ==========================================================================
  // 3. Engine Configuration & Application Settings
  // ==========================================================================
  describe('3. Engine Configuration & Application Settings', () => {
    it('renders Engine Configuration with Nebius provider and disabled mutation', () => {
      const info: EngineHealthInfo = {
        state: 'connected',
        url: 'http://127.0.0.1:3001',
        model: {
          provider: 'nebius',
          defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
          hasApiKey: true,
          baseUrl: 'https://api.tokenfactory.nebius.com/v1',
        },
      };

      const html = buildEngineConfigHtml(info);
      expect(html).toContain('Nebius (Token Factory - Required Provider)');
      expect(html).toContain('meta-llama/Llama-3.3-70B-Instruct');
      expect(html).toContain('Max Response Tokens');
      expect(html).toContain('4096');
      expect(html).toContain('Request Timeout');
      expect(html).toContain('120');

      // Truthful explanation of runtime server re-configuration limitation
      expect(html).toContain('Runtime server re-configuration via UI is not supported');
      expect(html).toContain('disabled');
      expect(html).toContain('Save Changes');
    });

    it('renders Application Settings toggles reflecting persisted preferences', () => {
      const settings: ApplicationSettings = {
        engineUrl: 'http://127.0.0.1:3001',
        theme: 'light',
        autoRefresh: false,
        openLinksInNewTab: true,
        confirmBeforeRunningTasks: true,
        showRelativeTimestamps: false,
      };

      const html = buildAppSettingsHtml(settings);
      expect(html).toContain('Theme');
      expect(html).toContain('Light');
      expect(html).toContain('Auto-refresh data');
      expect(html).toContain('Open links in new tab');
      expect(html).toContain('Confirm before running tasks');
      expect(html).toContain('Show relative timestamps');

      // Checked states
      expect(html).toContain('id="setting-open-links-new-tab" checked');
      expect(html).toContain('id="setting-confirm-tasks" checked');
      expect(html).not.toContain('id="setting-auto-refresh" checked');
      expect(html).not.toContain('id="setting-relative-timestamps" checked');
    });

    it('renders Application Information with process PID and Node version', () => {
      const info: EngineHealthInfo = {
        state: 'connected',
        url: 'http://127.0.0.1:3001',
        process: {
          pid: 9876,
          uptimeSeconds: 120,
          nodeVersion: 'v22.8.0',
          memoryUsageMb: 35,
        },
      };

      const html = buildAppInfoHtml(info);
      expect(html).toContain('Orchestrate');
      expect(html).toContain('0.1.0');
      expect(html).toContain('Development');
      expect(html).toContain('9876');
      expect(html).toContain('v22.8.0');
    });
  });

  // ==========================================================================
  // 4. Interactive Diagnostics Screen Handling
  // ==========================================================================
  describe('4. Interactive Diagnostics Screen Handling', () => {
    it('renders full settings screen through router', () => {
      const route = router.parseRoute('#/settings');
      const page = renderPlaceholderPage(route) as unknown as MockElement;

      const combined = page.combinedHtml;
      expect(combined).toContain('Engine Diagnostics and Settings');
      expect(combined).toContain('Engine Connection');
      expect(combined).toContain('Connection Diagnostics');
      expect(combined).toContain('Engine Configuration');
      expect(combined).toContain('Application Settings');
      expect(combined).toContain('Application Information');
    });

    it('triggers health check on reconnect button click', async () => {
      const checkSpy = vi.spyOn(engineClient, 'checkHealth').mockResolvedValue({
        state: 'connected',
        url: 'http://127.0.0.1:3001',
        latencyMs: 12,
      });

      const route = router.parseRoute('#/settings');
      const page = renderPlaceholderPage(route) as unknown as MockElement;

      const reconnectBtn = page.querySelector('#settings-reconnect-btn')!;
      reconnectBtn.eventListeners['click']?.[0]?.();
      await new Promise((r) => setTimeout(r, 20));

      expect(checkSpy).toHaveBeenCalled();
    });

    it('triggers health check on run diagnostics button click', async () => {
      const checkSpy = vi.spyOn(engineClient, 'checkHealth').mockResolvedValue({
        state: 'connected',
        url: 'http://127.0.0.1:3001',
        latencyMs: 15,
        model: {
          provider: 'nebius',
          defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
          hasApiKey: true,
          baseUrl: 'https://api.tokenfactory.nebius.com/v1',
        },
      });

      const route = router.parseRoute('#/settings');
      const page = renderPlaceholderPage(route) as unknown as MockElement;

      const diagBtn = page.querySelector('#run-diag-btn')!;
      diagBtn.eventListeners['click']?.[0]?.();
      await new Promise((r) => setTimeout(r, 20));

      expect(checkSpy).toHaveBeenCalled();
    });

    it('updates application preferences on toggle switch change', async () => {
      const route = router.parseRoute('#/settings');
      const page = renderPlaceholderPage(route) as unknown as MockElement;

      const autoRefreshCb = page.querySelector('#setting-auto-refresh')!;
      autoRefreshCb.checked = false; // toggle off
      autoRefreshCb.eventListeners['change']?.[0]?.();

      const stored = loadApplicationSettings();
      expect(stored.autoRefresh).toBe(false);
    });
  });
});
