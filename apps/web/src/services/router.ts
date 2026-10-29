export type RouteDestination =
  | 'home'
  | 'projects'
  | 'overview'
  | 'tasks'
  | 'handoffs'
  | 'verifications'
  | 'brain'
  | 'context'
  | 'settings';

export interface RouteMatch {
  destination: RouteDestination;
  projectId?: string;
  subpath?: string;
  params: Record<string, string>;
  path: string;
}

export type RouteChangeListener = (route: RouteMatch) => void;

/**
 * Client-side hash-based router for Orchestrate developer workspace.
 * Manages active route, project selection context, and navigation events.
 */
export class Router {
  private currentRoute: RouteMatch;
  private listeners: Set<RouteChangeListener> = new Set();

  constructor() {
    this.currentRoute = this.parseRoute(
      typeof window !== 'undefined' ? window.location.hash || window.location.pathname : '/projects'
    );

    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', () => {
        this.navigate(window.location.hash, false);
      });
    }
  }

  public getActiveProjectId(): string | undefined {
    return this.currentRoute.projectId;
  }

  public getRoute(): RouteMatch {
    return { ...this.currentRoute, params: { ...this.currentRoute.params } };
  }

  public subscribe(listener: RouteChangeListener): () => void {
    this.listeners.add(listener);
    listener(this.getRoute());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public parseRoute(rawPath: string): RouteMatch {
    let clean = rawPath.replace(/^[#/]+/, '').trim();

    // Root / empty path is the public marketing homepage.
    if (!clean || clean === 'home' || clean.startsWith('?')) {
      return {
        destination: 'home',
        params: {},
        path: '#/',
      };
    }

    // /app is the application entry alias → Projects screen.
    if (clean === 'app' || clean.startsWith('app?') || clean.startsWith('app/')) {
      const rest = clean.slice('app'.length).replace(/^\/+/, '');
      clean = rest && !rest.startsWith('?') ? rest : 'projects';
    }

    const qIndex = clean.indexOf('?');
    const pathPart = qIndex >= 0 ? clean.slice(0, qIndex) : clean;
    const queryPart = qIndex >= 0 ? clean.slice(qIndex + 1) : '';

    const queryParams: Record<string, string> = {};
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart);
      searchParams.forEach((value, key) => {
        queryParams[key] = value;
      });
    }

    const decodeSafe = (val: string): string => {
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    };

    const segments = pathPart.split('/').filter(Boolean);

    // /settings
    if (segments[0] === 'settings') {
      return {
        destination: 'settings',
        params: { ...queryParams },
        path: '#/settings',
      };
    }

    // /projects
    if (segments.length === 1 && segments[0] === 'projects') {
      return {
        destination: 'projects',
        params: { ...queryParams },
        path: '#/projects',
      };
    }

    // /projects/:projectId/...
    if (segments[0] === 'projects' && segments.length >= 2) {
      const rawProjectId = segments[1];
      const projectId = decodeSafe(rawProjectId);
      const section = segments[2] || 'overview';

      let destination: RouteDestination = 'overview';
      let knownSection = true;
      switch (section) {
        case 'overview':
          destination = 'overview';
          break;
        case 'tasks':
          destination = 'tasks';
          break;
        case 'handoffs':
          destination = 'handoffs';
          break;
        case 'verifications':
          destination = 'verifications';
          break;
        case 'brain':
          destination = 'brain';
          break;
        case 'context':
          destination = 'context';
          break;
        default:
          destination = 'overview';
          knownSection = false;
          break;
      }

      const rawSubpath = knownSection ? segments.slice(3).join('/') : '';
      const subpath = rawSubpath ? segments.slice(3).map(decodeSafe).join('/') : '';
      const params: Record<string, string> = {
        ...queryParams,
        projectId,
      };
      if (destination === 'tasks' && subpath && !params.taskId) {
        params.taskId = subpath;
      }

      const encodedProjectId = encodeURIComponent(projectId);
      const encodedSubpath = subpath ? encodeURIComponent(subpath) : '';
      const baseRoutePath = encodedSubpath
        ? `#/projects/${encodedProjectId}/${destination}/${encodedSubpath}`
        : `#/projects/${encodedProjectId}/${destination}`;
      const fullRoutePath = queryPart ? `${baseRoutePath}?${queryPart}` : baseRoutePath;

      return {
        destination,
        projectId,
        subpath,
        params,
        path: fullRoutePath,
      };
    }

    // Default fallback to projects
    return {
      destination: 'projects',
      params: { ...queryParams },
      path: '#/projects',
    };
  }

  public navigate(path: string, updateWindowHash: boolean = true): void {
    const route = this.parseRoute(path);
    this.currentRoute = route;

    if (updateWindowHash && typeof window !== 'undefined') {
      if (window.location.hash !== route.path) {
        window.location.hash = route.path;
      }
    }

    for (const listener of this.listeners) {
      listener(route);
    }
  }

  public navigateToProject(
    projectId: string,
    destination: RouteDestination = 'overview',
    subpath?: string
  ): void {
    const encodedProjectId = encodeURIComponent(projectId);
    if (destination === 'projects' || destination === 'settings') {
      this.navigate(`#/${destination}`);
    } else if (subpath && subpath.trim()) {
      this.navigate(
        `#/projects/${encodedProjectId}/${destination}/${encodeURIComponent(subpath.trim())}`
      );
    } else {
      this.navigate(`#/projects/${encodedProjectId}/${destination}`);
    }
  }
}

export const router = new Router();
