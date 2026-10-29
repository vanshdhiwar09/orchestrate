export type CleanupCallback = () => Promise<void>;

export interface InterruptionHandlerOptions {
  /**
   * Optional custom hook invoked immediately when a termination signal arrives.
   */
  onInterrupted?: (signal: NodeJS.Signals) => void | Promise<void>;

  /**
   * Whether to call process.exit() after signal processing.
   * Defaults to true in live harness execution; set to false in unit tests.
   */
  exitOnSignal?: boolean;
}

/**
 * Controlled SIGINT/SIGTERM handler ensuring in-flight trial execution is stopped,
 * partial evidence is preserved, and temporary workspaces are cleaned up safely.
 *
 * Invariants:
 * - Only cleans up runner-owned workspaces registered with registerWorkspaceCleanup.
 * - Cleanup errors are surfaced visibly and never suppressed.
 * - Signal handling is idempotent.
 */
export class InterruptionHandler {
  private isInterrupted = false;
  private receivedSignal: NodeJS.Signals | null = null;
  private readonly cleanupTasks = new Map<string, CleanupCallback>();
  private readonly cleanupErrors: Error[] = [];
  private attached = false;
  private readonly sigintListener: () => void;
  private readonly sigtermListener: () => void;

  constructor(private readonly options?: InterruptionHandlerOptions) {
    this.sigintListener = () => {
      void this.handleSignal('SIGINT');
    };
    this.sigtermListener = () => {
      void this.handleSignal('SIGTERM');
    };
  }

  attach(): this {
    if (this.attached) return this;
    process.on('SIGINT', this.sigintListener);
    process.on('SIGTERM', this.sigtermListener);
    this.attached = true;
    return this;
  }

  detach(): void {
    if (!this.attached) return;
    process.off('SIGINT', this.sigintListener);
    process.off('SIGTERM', this.sigtermListener);
    this.attached = false;
  }

  get interrupted(): boolean {
    return this.isInterrupted;
  }

  get signal(): NodeJS.Signals | null {
    return this.receivedSignal;
  }

  get errors(): readonly Error[] {
    return [...this.cleanupErrors];
  }

  /**
   * Registers a cleanup task bound to an ephemeral workspace.
   * Returns an unregister function to remove the task when work finishes cleanly.
   */
  registerWorkspaceCleanup(id: string, cleanup: CleanupCallback): () => void {
    this.cleanupTasks.set(id, cleanup);
    return () => {
      this.cleanupTasks.delete(id);
    };
  }

  /**
   * Processes a termination signal.
   */
  async handleSignal(signal: NodeJS.Signals): Promise<void> {
    if (this.isInterrupted) return;
    this.isInterrupted = true;
    this.receivedSignal = signal;

    try {
      await this.options?.onInterrupted?.(signal);
    } catch (err: unknown) {
      this.cleanupErrors.push(
        err instanceof Error ? err : new Error(String(err))
      );
    }

    // Execute registered runner workspace cleanups
    for (const [id, cleanup] of this.cleanupTasks) {
      try {
        await cleanup();
      } catch (err: unknown) {
        this.cleanupErrors.push(
          new Error(
            `Interruption cleanup failed for workspace "${id}": ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
      }
    }

    this.cleanupTasks.clear();

    if (this.options?.exitOnSignal !== false) {
      this.detach();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
  }
}
