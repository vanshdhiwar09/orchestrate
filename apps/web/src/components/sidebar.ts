import { router, type RouteMatch, type RouteDestination } from '../services/router.js';
import { engineClient, escapeHtml } from '../services/engine-client.js';
import { renderEngineIndicator } from './engine-indicator.js';

interface NavItemDef {
  id: RouteDestination;
  label: string;
  iconSvg: string;
  isProjectScoped: boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  {
    id: 'projects',
    label: 'Projects',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>`,
    isProjectScoped: false,
  },
  {
    id: 'overview',
    label: 'Overview',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/></svg>`,
    isProjectScoped: true,
  },
  {
    id: 'tasks',
    label: 'Tasks',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>`,
    isProjectScoped: true,
  },
  {
    id: 'handoffs',
    label: 'Handoffs',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
    isProjectScoped: true,
  },
  {
    id: 'verifications',
    label: 'Verifications',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`,
    isProjectScoped: true,
  },
  {
    id: 'brain',
    label: 'Project Brain',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>`,
    isProjectScoped: true,
  },
  {
    id: 'context',
    label: 'Context',
    iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>`,
    isProjectScoped: true,
  },
];

const SETTINGS_ITEM: NavItemDef = {
  id: 'settings',
  label: 'Settings',
  iconSvg: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="21" y2="21"/><line x1="4" x2="20" y1="14" y2="14"/><line x1="4" x2="20" y1="7" y2="7"/><circle cx="8" cy="21" r="2"/><circle cx="16" cy="14" r="2"/><circle cx="12" cy="7" r="2"/></svg>`,
  isProjectScoped: false,
};

function formatProjectTitle(projectId: string): string {
  const known = engineClient.getKnownProjects().find((p) => p.id === projectId);
  if (known && known.name) return known.name;
  return projectId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function renderSidebar(): HTMLElement {
  const sidebar = document.createElement('aside');
  sidebar.className = 'app-sidebar';

  const topSection = document.createElement('div');
  topSection.className = 'app-sidebar-top';

  const projectBlock = document.createElement('div');
  projectBlock.className = 'app-sidebar-project-block';
  topSection.appendChild(projectBlock);

  const nav = document.createElement('nav');
  nav.className = 'app-sidebar-nav';
  topSection.appendChild(nav);

  sidebar.appendChild(topSection);

  const bottomSection = document.createElement('div');
  bottomSection.className = 'app-sidebar-bottom';
  bottomSection.appendChild(renderEngineIndicator({ variant: 'sidebar' }));
  sidebar.appendChild(bottomSection);

  const updateSidebar = (route: RouteMatch) => {
    const activeProjectId = route.projectId || engineClient.getKnownProjects()[0]?.id;

    if (route.projectId) {
      projectBlock.style.display = 'flex';
      projectBlock.innerHTML = `
        <div class="app-sidebar-back-link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          <span>All projects</span>
        </div>
        <div class="app-sidebar-project-name">${escapeHtml(formatProjectTitle(route.projectId))}</div>
        <div class="app-sidebar-project-id">${escapeHtml(route.projectId)}</div>
      `;
      const backLink = projectBlock.querySelector('.app-sidebar-back-link');
      if (backLink) {
        backLink.addEventListener('click', () => {
          router.navigate('#/projects');
        });
      }
    } else {
      projectBlock.style.display = 'none';
    }

    nav.innerHTML = '';

    const itemsToShow = route.projectId
      ? NAV_ITEMS.filter((item) => item.id !== 'projects')
      : NAV_ITEMS.filter((item) => item.id !== 'overview');

    for (const item of itemsToShow) {
      const a = document.createElement('a');
      a.className = 'app-sidebar-nav-item';

      if (route.destination === item.id) {
        a.classList.add('active');
      }

      const isDisabled = item.isProjectScoped && !activeProjectId;
      if (isDisabled) {
        a.style.opacity = '0.5';
        a.style.cursor = 'not-allowed';
        a.title = 'Create or open a project first';
        a.href = '#/projects';
      } else {
        a.href = item.isProjectScoped
          ? `#/projects/${encodeURIComponent(activeProjectId!)}/${item.id}`
          : `#/${item.id}`;
      }

      a.innerHTML = `
        <span style="display: flex; align-items: center; color: inherit;">${item.iconSvg}</span>
        <span>${escapeHtml(item.label)}</span>
      `;

      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (isDisabled) return;
        if (item.isProjectScoped && activeProjectId) {
          router.navigateToProject(activeProjectId, item.id);
        } else {
          router.navigate(`#/${item.id}`);
        }
      });

      nav.appendChild(a);
    }

    const divider = document.createElement('div');
    divider.className = 'app-sidebar-nav-divider';
    nav.appendChild(divider);

    const settingsLink = document.createElement('a');
    settingsLink.className = `app-sidebar-nav-item ${route.destination === 'settings' ? 'active' : ''}`.trim();
    settingsLink.href = '#/settings';
    settingsLink.innerHTML = `
      <span style="display: flex; align-items: center; color: inherit;">${SETTINGS_ITEM.iconSvg}</span>
      <span>${SETTINGS_ITEM.label}</span>
    `;
    settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigate('#/settings');
    });
    nav.appendChild(settingsLink);
  };

  router.subscribe((route: RouteMatch) => {
    updateSidebar(route);
  });

  engineClient.subscribe(() => {
    updateSidebar(router.getRoute());
  });

  return sidebar;
}
