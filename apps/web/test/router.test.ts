import { describe, expect, it, vi } from 'vitest';
import { Router } from '../src/services/router.js';

describe('Router', () => {
  it('parses root and empty path to the public homepage, and /app + /projects to projects', () => {
    const router = new Router();
    expect(router.parseRoute('')).toEqual(
      expect.objectContaining({ destination: 'home', path: '#/' })
    );
    expect(router.parseRoute('#/')).toEqual(
      expect.objectContaining({ destination: 'home', path: '#/' })
    );
    expect(router.parseRoute('#/app')).toEqual(
      expect.objectContaining({ destination: 'projects', path: '#/projects' })
    );
    expect(router.parseRoute('#/app/projects/demo-app/tasks/t-1')).toEqual(
      expect.objectContaining({ destination: 'tasks', projectId: 'demo-app', path: '#/projects/demo-app/tasks/t-1' })
    );
    expect(router.parseRoute('#/projects')).toEqual(
      expect.objectContaining({ destination: 'projects', path: '#/projects' })
    );
  });

  it('parses settings destination', () => {
    const router = new Router();
    const route = router.parseRoute('#/settings');
    expect(route.destination).toBe('settings');
    expect(route.projectId).toBeUndefined();
    expect(route.path).toBe('#/settings');
  });

  it('parses project-scoped destinations correctly', () => {
    const router = new Router();

    const overview = router.parseRoute('#/projects/demo-app/overview');
    expect(overview.destination).toBe('overview');
    expect(overview.projectId).toBe('demo-app');

    const tasks = router.parseRoute('#/projects/demo-app/tasks');
    expect(tasks.destination).toBe('tasks');
    expect(tasks.projectId).toBe('demo-app');

    const handoffs = router.parseRoute('#/projects/demo-app/handoffs');
    expect(handoffs.destination).toBe('handoffs');
    expect(handoffs.projectId).toBe('demo-app');

    const verifications = router.parseRoute('#/projects/demo-app/verifications');
    expect(verifications.destination).toBe('verifications');
    expect(verifications.projectId).toBe('demo-app');

    const brain = router.parseRoute('#/projects/demo-app/brain');
    expect(brain.destination).toBe('brain');
    expect(brain.projectId).toBe('demo-app');

    const context = router.parseRoute('#/projects/demo-app/context');
    expect(context.destination).toBe('context');
    expect(context.projectId).toBe('demo-app');
  });

  it('defaults to overview when section is omitted for project', () => {
    const router = new Router();
    const route = router.parseRoute('#/projects/my-project');
    expect(route.destination).toBe('overview');
    expect(route.projectId).toBe('my-project');
    expect(route.path).toBe('#/projects/my-project/overview');
  });

  it('notifies route listeners on navigation', () => {
    const router = new Router();
    const listener = vi.fn();
    router.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);

    router.navigate('#/projects/test-proj/tasks', false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        destination: 'tasks',
        projectId: 'test-proj',
      })
    );
  });

  it('helper navigateToProject constructs valid route path', () => {
    const router = new Router();
    const listener = vi.fn();
    router.subscribe(listener);

    router.navigateToProject('auth-service', 'verifications');
    expect(router.getRoute().destination).toBe('verifications');
    expect(router.getRoute().projectId).toBe('auth-service');
  });

  it('preserves task subpath and query parameters for project-scoped Task Detail and Context routes', () => {
    const router = new Router();

    const taskDetail = router.parseRoute('#/projects/orchestrate-benchmark/tasks/add-password-reset');
    expect(taskDetail.destination).toBe('tasks');
    expect(taskDetail.projectId).toBe('orchestrate-benchmark');
    expect(taskDetail.subpath).toBe('add-password-reset');
    expect(taskDetail.params.taskId).toBe('add-password-reset');
    expect(taskDetail.path).toBe('#/projects/orchestrate-benchmark/tasks/add-password-reset');

    const contextRoute = router.parseRoute(
      '#/projects/orchestrate-benchmark/context?targetTaskId=add-password-reset'
    );
    expect(contextRoute.destination).toBe('context');
    expect(contextRoute.projectId).toBe('orchestrate-benchmark');
    expect(contextRoute.params.targetTaskId).toBe('add-password-reset');

    router.navigateToProject('orchestrate-benchmark', 'tasks', 'auth-foundation');
    expect(router.getRoute().destination).toBe('tasks');
    expect(router.getRoute().projectId).toBe('orchestrate-benchmark');
    expect(router.getRoute().subpath).toBe('auth-foundation');
    expect(router.getRoute().path).toBe('#/projects/orchestrate-benchmark/tasks/auth-foundation');
  });
});
