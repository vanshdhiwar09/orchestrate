import './styles/main.css';
import './styles/landing.css';
import { renderAppShell } from './components/app-shell.js';
import { renderLandingPage } from './components/landing-page.js';
import { engineClient } from './services/engine-client.js';
import { router, type RouteMatch } from './services/router.js';

export function initializeApp(rootElementId: string = 'app'): void {
  const root = document.getElementById(rootElementId);
  if (!root) {
    console.error(`Root element #${rootElementId} not found in DOM.`);
    return;
  }

  root.innerHTML = '';

  // Public marketing homepage (route: #/) and the existing application shell
  // share one router. Exactly one surface is visible at a time.
  const landing = renderLandingPage();
  const shell = renderAppShell();
  root.appendChild(landing);
  root.appendChild(shell);

  let lastSurface: 'home' | 'app' | null = null;
  router.subscribe((route: RouteMatch) => {
    const surface = route.destination === 'home' ? 'home' : 'app';
    landing.hidden = surface !== 'home';
    shell.hidden = surface !== 'app';
    document.body.classList.toggle('is-landing', surface === 'home');
    document.title =
      surface === 'home'
        ? 'Orchestrate — From Ideas to Shipped Software'
        : 'Orchestrate — Evidence-Backed AI Engineering';
    if (lastSurface !== null && lastSurface !== surface) {
      window.scrollTo(0, 0);
    }
    lastSurface = surface;
  });

  // Start background health check against engine
  engineClient.startPolling(10000);

  // Initialize router state. Empty hash → public homepage; existing deep links are preserved.
  router.navigate(window.location.hash || '#/', true);
}

// Auto-boot if running in browser
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initializeApp('app');
  });
}
