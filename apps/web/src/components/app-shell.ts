import { renderSidebar } from './sidebar.js';
import { renderTopBar } from './top-bar.js';
import { renderPlaceholderPage } from './placeholder-page.js';
import { router, type RouteMatch } from '../services/router.js';

export function renderAppShell(): HTMLElement {
  const shell = document.createElement('div');
  shell.className = 'app-shell';

  // 1. Top Header Bar (Brand on left, Global search + Engine pill + Avatar on right)
  const topbar = renderTopBar();
  shell.appendChild(topbar);

  // 2. Body container (Left Sidebar + Main Viewport)
  const body = document.createElement('div');
  body.className = 'app-body';

  const sidebar = renderSidebar();
  body.appendChild(sidebar);

  const viewport = document.createElement('main');
  viewport.id = 'app-page-content';
  viewport.className = 'app-main-viewport';
  body.appendChild(viewport);

  shell.appendChild(body);

  // Subscribe to route changes to render the active screen
  router.subscribe((route: RouteMatch) => {
    // The public homepage is rendered outside the application shell.
    if (route.destination === 'home') return;
    viewport.innerHTML = '';
    const isTaskWorkspace =
      route.destination === 'tasks' && Boolean(route.params.taskId && route.params.taskId.trim());
    if (viewport.classList && typeof viewport.classList.add === 'function') {
      if (isTaskWorkspace) {
        viewport.classList.add('viewport-task-workspace');
      } else {
        viewport.classList.remove('viewport-task-workspace');
      }
    }
    const page = renderPlaceholderPage(route);
    viewport.appendChild(page);
  });

  return shell;
}
