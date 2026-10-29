/**
 * Application Settings Store
 *
 * Manages client-side preferences and persistent engine URL selection.
 * Adheres to the Orchestrate source-of-truth hierarchy:
 * - Truly persisted preferences are safely stored in browser localStorage.
 * - Server-side engine configuration remains owned by the Engine runtime.
 * - Unsupported mutations are never claimed as saved.
 */

export interface ApplicationSettings {
  engineUrl: string;
  theme: 'light';
  autoRefresh: boolean;
  openLinksInNewTab: boolean;
  confirmBeforeRunningTasks: boolean;
  showRelativeTimestamps: boolean;
}

export const DEFAULT_APP_SETTINGS: ApplicationSettings = {
  engineUrl: 'http://127.0.0.1:3001',
  theme: 'light',
  autoRefresh: true,
  openLinksInNewTab: true,
  confirmBeforeRunningTasks: false,
  showRelativeTimestamps: true,
};

const STORAGE_KEY = 'orchestrate.settings.app';

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // In restricted iframe or storage-disabled environments
  }
  return null;
}

/**
 * Validates an engine connection URL string.
 */
export function validateEngineUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return { valid: false, error: 'Engine URL cannot be empty.' };
  }

  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Engine URL must use http:// or https:// protocol.' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Engine URL is not a valid URL format.' };
  }
}

/**
 * Loads application settings from localStorage, falling back to defaults.
 */
export function loadApplicationSettings(): ApplicationSettings {
  const storage = getStorage();
  if (!storage) {
    return { ...DEFAULT_APP_SETTINGS };
  }

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_APP_SETTINGS };
    }

    const parsed = JSON.parse(raw) as Partial<ApplicationSettings>;
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_APP_SETTINGS };
    }

    const engineUrl =
      typeof parsed.engineUrl === 'string' && validateEngineUrl(parsed.engineUrl).valid
        ? parsed.engineUrl.trim().replace(/\/+$/, '')
        : DEFAULT_APP_SETTINGS.engineUrl;

    return {
      engineUrl,
      theme: 'light',
      autoRefresh: typeof parsed.autoRefresh === 'boolean' ? parsed.autoRefresh : DEFAULT_APP_SETTINGS.autoRefresh,
      openLinksInNewTab:
        typeof parsed.openLinksInNewTab === 'boolean'
          ? parsed.openLinksInNewTab
          : DEFAULT_APP_SETTINGS.openLinksInNewTab,
      confirmBeforeRunningTasks:
        typeof parsed.confirmBeforeRunningTasks === 'boolean'
          ? parsed.confirmBeforeRunningTasks
          : DEFAULT_APP_SETTINGS.confirmBeforeRunningTasks,
      showRelativeTimestamps:
        typeof parsed.showRelativeTimestamps === 'boolean'
          ? parsed.showRelativeTimestamps
          : DEFAULT_APP_SETTINGS.showRelativeTimestamps,
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

/**
 * Validates and saves application settings to localStorage.
 */
export function saveApplicationSettings(
  patch: Partial<ApplicationSettings>
): { success: boolean; error?: string; settings: ApplicationSettings } {
  const current = loadApplicationSettings();

  if (patch.engineUrl !== undefined) {
    const validation = validateEngineUrl(patch.engineUrl);
    if (!validation.valid) {
      return { success: false, error: validation.error, settings: current };
    }
  }

  const updated: ApplicationSettings = {
    engineUrl:
      patch.engineUrl !== undefined ? patch.engineUrl.trim().replace(/\/+$/, '') : current.engineUrl,
    theme: 'light',
    autoRefresh: patch.autoRefresh !== undefined ? Boolean(patch.autoRefresh) : current.autoRefresh,
    openLinksInNewTab:
      patch.openLinksInNewTab !== undefined
        ? Boolean(patch.openLinksInNewTab)
        : current.openLinksInNewTab,
    confirmBeforeRunningTasks:
      patch.confirmBeforeRunningTasks !== undefined
        ? Boolean(patch.confirmBeforeRunningTasks)
        : current.confirmBeforeRunningTasks,
    showRelativeTimestamps:
      patch.showRelativeTimestamps !== undefined
        ? Boolean(patch.showRelativeTimestamps)
        : current.showRelativeTimestamps,
  };

  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (err) {
      return {
        success: false,
        error: `Failed to persist to browser storage: ${(err as Error).message}`,
        settings: current,
      };
    }
  }

  return { success: true, settings: updated };
}
