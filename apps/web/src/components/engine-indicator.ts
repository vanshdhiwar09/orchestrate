import { engineClient, type EngineHealthInfo } from '../services/engine-client.js';
import { router } from '../services/router.js';

export interface EngineIndicatorProps {
  variant?: 'pill' | 'sidebar';
  className?: string;
}

export function renderEngineIndicator(props: EngineIndicatorProps = {}): HTMLElement {
  const container = document.createElement('div');
  const variant = props.variant ?? 'pill';

  if (variant === 'pill') {
    container.className = `engine-indicator-pill ${props.className ?? ''}`.trim();
    container.addEventListener('click', () => {
      router.navigate('#/settings');
    });
  } else {
    container.className = `engine-indicator-sidebar ${props.className ?? ''}`.trim();
  }

  const update = (info: EngineHealthInfo) => {
    let label = 'Engine Offline';
    let sublabel = '127.0.0.1:3001';

    switch (info.state) {
      case 'connected':
        label = 'Engine Connected';
        sublabel = `Local Engine v${info.version ?? '0.1.0'}`;
        break;
      case 'connecting':
        label = 'Checking Engine...';
        sublabel = 'Connecting to 127.0.0.1:3001';
        break;
      case 'unavailable':
        label = 'Engine Offline';
        sublabel = '127.0.0.1:3001 unreachable';
        break;
      case 'error':
        label = 'Engine Error';
        sublabel = info.errorMessage ?? 'Health check failed';
        break;
    }

    if (variant === 'pill') {
      container.innerHTML = `
        <span class="status-dot ${info.state}"></span>
        <div class="engine-pill-text">
          <span class="engine-pill-title">${label}</span>
          <span class="engine-pill-subtitle">${sublabel}</span>
        </div>
        <span class="engine-pill-chevron">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      `;
      container.title = `Engine URL: ${info.url}\nStatus: ${info.state}${info.latencyMs !== undefined ? `\nLatency: ${info.latencyMs}ms` : ''}`;
    } else {
      container.innerHTML = `
        <span class="status-dot ${info.state}" style="margin-top: 4px;"></span>
        <div>
          <span style="font-weight: 500; color: var(--text-secondary);">${label}</span>
          <span> · ${sublabel}</span>
        </div>
      `;
    }
  };

  engineClient.subscribe(update);
  return container;
}
