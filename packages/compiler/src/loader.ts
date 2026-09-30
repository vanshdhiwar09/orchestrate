import type { BrainStore } from '@orchestrate/brain';
import type { GitRepository } from '@orchestrate/workspace';
import type { CompilationRequest, CompilationSnapshot, GitSnapshotData } from './types.js';

export interface ContextLoaderOptions {
  brain: BrainStore;
  git?: GitRepository;
}

/**
 * ContextLoader performs the read-only I/O operations required to assemble
 * a CompilationSnapshot from Project Brain and an optional Git repository.
 *
 * It performs NO filtering, formatting, or budgeting logic.
 */
export class ContextLoader {
  private readonly brain: BrainStore;
  private readonly git?: GitRepository;

  constructor(options: ContextLoaderOptions) {
    this.brain = options.brain;
    this.git = options.git;
  }

  /**
   * Assembles a CompilationSnapshot for a given CompilationRequest.
   */
  public async load(request: CompilationRequest): Promise<CompilationSnapshot> {
    const targetTask = await this.brain.getTask(request.targetTaskId);

    let upstreamTask = null;
    let upstreamTrustState = undefined;
    let upstreamAttempts: CompilationSnapshot['upstreamAttempts'] = [];

    if (request.upstreamTaskId) {
      upstreamTask = await this.brain.getTask(request.upstreamTaskId);
      upstreamTrustState = await this.brain.deriveTaskTrustState(request.upstreamTaskId);
      upstreamAttempts = await this.brain.getTaskHistory(request.upstreamTaskId);
    }

    const activeDecisions = await this.brain.getActiveDecisions(request.projectId);
    const projectFacts = await this.brain.getProjectFacts(request.projectId);

    let gitSnapshot: GitSnapshotData | null = null;

    if (this.git) {
      try {
        const isRepo = await this.git.isRepository();
        if (isRepo) {
          const status = await this.git.getStatus();
          const headCommit = await this.git.getHeadCommit();

          // Try unstaged diff first; fallback to staged diff if unstaged is empty and staged exists
          let diff = '';
          try {
            diff = await this.git.getDiff({ staged: false });
            if (!diff && status.staged.length > 0) {
              diff = await this.git.getDiff({ staged: true });
            }
          } catch {
            diff = '';
          }

          gitSnapshot = {
            status,
            headCommit,
            diff,
          };
        }
      } catch {
        gitSnapshot = null;
      }
    }

    return {
      request,
      targetTask,
      upstreamTask,
      upstreamTrustState,
      upstreamAttempts,
      activeDecisions,
      projectFacts,
      git: gitSnapshot,
    };
  }
}
