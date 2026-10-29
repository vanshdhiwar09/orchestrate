import { describe, it, expect, vi } from 'vitest';
import { InterruptionHandler } from '../../src/harness/interruption-handler.js';

describe('InterruptionHandler', () => {
  it('registers and executes workspace cleanup callbacks on signal', async () => {
    let cleanedUp1 = false;
    let cleanedUp2 = false;

    const handler = new InterruptionHandler({ exitOnSignal: false });

    handler.registerWorkspaceCleanup('ws-1', async () => {
      cleanedUp1 = true;
    });

    const unregister2 = handler.registerWorkspaceCleanup('ws-2', async () => {
      cleanedUp2 = true;
    });

    // Unregister ws-2 before signal
    unregister2();

    await handler.handleSignal('SIGINT');

    expect(handler.interrupted).toBe(true);
    expect(handler.signal).toBe('SIGINT');
    expect(cleanedUp1).toBe(true);
    expect(cleanedUp2).toBe(false);
    expect(handler.errors).toHaveLength(0);
  });

  it('surfaces cleanup errors visibly and records them', async () => {
    const handler = new InterruptionHandler({ exitOnSignal: false });

    handler.registerWorkspaceCleanup('failing-ws', async () => {
      throw new Error('EPERM: Permission denied removing workspace directory');
    });

    await handler.handleSignal('SIGTERM');

    expect(handler.interrupted).toBe(true);
    expect(handler.errors).toHaveLength(1);
    expect(handler.errors[0].message).toContain('EPERM: Permission denied removing workspace directory');
  });

  it('is idempotent on duplicate signal dispatch', async () => {
    let callCount = 0;
    const handler = new InterruptionHandler({ exitOnSignal: false });

    handler.registerWorkspaceCleanup('ws-single', async () => {
      callCount++;
    });

    await handler.handleSignal('SIGINT');
    await handler.handleSignal('SIGINT');

    expect(callCount).toBe(1);
  });
});
