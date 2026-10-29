import { readFile as fsReadFile } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import type { BrainStore } from '@orchestrate/brain';
import type { GitRepository } from '@orchestrate/workspace';
import { RepositoryConventionExtractor } from './conventions.js';
import type { CompilationRequest, CompilationSnapshot, GitSnapshotData } from './types.js';

export interface ContextLoaderOptions {
  brain: BrainStore;
  git?: GitRepository;
  readFile?: (path: string) => Promise<string | null>;
  candidateFiles?: string[];
  workspaceRoot?: string;
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
  private readonly readFileFn?: (path: string) => Promise<string | null>;
  private readonly candidateFiles?: string[];
  private readonly workspaceRoot?: string;

  constructor(options: ContextLoaderOptions) {
    this.brain = options.brain;
    this.git = options.git;
    this.readFileFn = options.readFile;
    this.candidateFiles = options.candidateFiles;
    this.workspaceRoot = options.workspaceRoot;
  }

  /**
   * Assembles a CompilationSnapshot for a given CompilationRequest.
   */
  public async load(request: CompilationRequest): Promise<CompilationSnapshot> {
    const targetTask = await this.brain.getTask(request.targetTaskId);

    let upstreamTask = null;
    let upstreamTrustState = undefined;
    let upstreamAttempts: CompilationSnapshot['upstreamAttempts'] = [];

    const effectiveWorkspace = request.workspaceRoot ?? this.workspaceRoot;

    if (request.upstreamTaskId) {
      upstreamTask = await this.brain.getTask(request.upstreamTaskId);
      upstreamTrustState = await this.brain.deriveTaskTrustState(
        request.upstreamTaskId,
        effectiveWorkspace ? { workspaceRoot: effectiveWorkspace } : undefined
      );
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

    // ------------------------------------------------------------------------
    // Environment Conventions Extraction
    // ------------------------------------------------------------------------
    let reader = this.readFileFn;
    if (!reader && this.workspaceRoot) {
      const root = this.workspaceRoot;
      reader = async (relPath: string) => {
        try {
          return await fsReadFile(pathResolve(root, relPath), 'utf8');
        } catch {
          return null;
        }
      };
    }

    let candidateFiles = this.candidateFiles ?? [];
    if (candidateFiles.length === 0 && gitSnapshot) {
      candidateFiles = [
        ...gitSnapshot.status.staged.map((f: any) => (typeof f === 'string' ? f : f?.path)),
        ...gitSnapshot.status.unstaged.map((f: any) => (typeof f === 'string' ? f : f?.path)),
        ...gitSnapshot.status.untracked.map((f: any) => (typeof f === 'string' ? f : f?.path)),
      ].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    }

    const rawConventions = await RepositoryConventionExtractor.extract({
      readFile: reader ?? (async () => null),
      candidateFiles,
      existingFacts: projectFacts,
    });

    const environmentConventions =
      rawConventions && rawConventions.items.length > 0 ? rawConventions : null;

    return {
      request,
      targetTask,
      upstreamTask,
      upstreamTrustState,
      upstreamAttempts,
      activeDecisions,
      projectFacts,
      git: gitSnapshot,
      environmentConventions,
    };
  }
}
