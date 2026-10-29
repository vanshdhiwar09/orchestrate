import { router, type RouteMatch } from '../services/router.js';
import { renderEngineIndicator } from './engine-indicator.js';

export function renderTopBar(): HTMLElement {
  const topbar = document.createElement('header');
  topbar.className = 'app-topbar';

  const left = document.createElement('div');
  left.className = 'app-topbar-left';

  // Brand Logo in Top-Left (matching reference screenshots)
  const brand = document.createElement('div');
  brand.className = 'app-brand-logo';
  brand.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#141413" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9.5"/>
      <circle cx="12" cy="12" r="5.5"/>
      <circle cx="12" cy="12" r="1.8" fill="#141413"/>
    </svg>
    <span>Orchestrate</span>
  `;
  brand.title = 'Back to the Orchestrate homepage';
  brand.addEventListener('click', () => {
    router.navigate('#/');
  });
  left.appendChild(brand);

  const right = document.createElement('div');
  right.className = 'app-topbar-right';

  // Global Search Pill
  const searchWrapper = document.createElement('div');
  searchWrapper.className = 'search-input-wrapper';
  searchWrapper.innerHTML = `
    <span class="search-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
    </span>
    <input type="text" class="search-input" placeholder="Search projects..." aria-label="Global search" />
    <span class="search-shortcut-badge">⌘ K</span>
  `;

  const searchInput = searchWrapper.querySelector('input');

  router.subscribe((route: RouteMatch) => {
    if (searchInput) {
      searchInput.placeholder =
        route.destination === 'projects'
          ? 'Search projects...'
          : 'Search projects, tasks, handoffs...';
    }
  });

  // Engine Status Pill
  const engineIndicator = renderEngineIndicator({ variant: 'pill' });

  // User Avatar
  const avatar = document.createElement('div');
  avatar.className = 'user-avatar-badge';
  avatar.title = 'Vansh Dhiwar (VD)';
  avatar.textContent = 'VD';

  right.appendChild(searchWrapper);
  right.appendChild(engineIndicator);
  right.appendChild(avatar);

  topbar.appendChild(left);
  topbar.appendChild(right);

  return topbar;
}
