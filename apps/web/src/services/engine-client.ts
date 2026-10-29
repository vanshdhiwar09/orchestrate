export type EngineConnectionState = 'connected' | 'connecting' | 'unavailable' | 'error';

export interface EngineProcessInfo {
  pid: number;
  uptimeSeconds: number;
  nodeVersion: string;
  memoryUsageMb: number;
}

export interface EngineModelDiagnostics {
  provider: string;
  defaultModel: string;
  hasApiKey: boolean;
  baseUrl: string;
  testMode?: boolean;
}

export interface EngineCapabilities {
  tools: string[];
  workspace: string;
  verification: string;
}

export interface EngineHealthInfo {
  state: EngineConnectionState;
  version?: string;
  latencyMs?: number;
  lastChecked?: string;
  url: string;
  errorMessage?: string;
  process?: EngineProcessInfo;
  model?: EngineModelDiagnostics;
  capabilities?: EngineCapabilities;
}

export interface ProjectFactDto {
  key: string;
  value: string;
  provenance: string;
  status: string;
  recordedAt: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  createdAt: string;
  facts: ProjectFactDto[];
}

export interface HandoffDto {
  id: string;
  taskId: string;
  attemptNumber: number;
  agentId?: string;
  model?: string;
  status: string;
  summary: string;
  changes: string;
  filesAffected: string[];
  decisionsCreated: Array<{ id: string; statement: string; rationale: string; status: string }>;
  assumptions: string[];
  limitations: string[];
  recommendedFollowUp: string[];
  createdAt: string;
}

export interface VerificationCheckDto {
  checkId: string;
  name: string;
  command: string;
  args: string[];
  status: 'PASSED' | 'FAILED';
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface VerificationRecordDto {
  id: string;
  taskId: string;
  attemptNumber: number;
  handoffId: string;
  result: {
    status: 'VERIFIED' | 'FAILED';
    checks: VerificationCheckDto[];
    executedAt: string;
    totalDurationMs: number;
  };
  recordedAt: string;
}

export interface CompiledContextResponseDto {
  context: Record<string, unknown>;
  serialized: string;
}

export interface RepositoryValidationResultDto {
  valid: boolean;
  error?: string;
  repoPath?: string;
  branch?: string;
  isClean?: boolean;
  stagedCount?: number;
  unstagedCount?: number;
  untrackedCount?: number;
}

export interface RepositoryImportResultDto {
  success: boolean;
  type: string;
  repositoryPath?: string;
  repositoryUrl?: string;
  branch?: string;
  commit?: string;
  error?: string;
}

export interface RepositoryStatusDto {
  connected: boolean;
  type?: string;
  branch?: string | null;
  isClean?: boolean;
  stagedCount?: number;
  unstagedCount?: number;
  untrackedCount?: number;
  headCommit?: { hash: string; subject: string; author: string; timestamp?: string } | null;
  path?: string;
  url?: string;
  error?: string;
  isGit?: boolean;
}

export interface RepositoryFileItemDto {
  name: string;
  path: string;
  size?: number;
  extension?: string;
}

export interface RepositoryDirectoryItemDto {
  name: string;
  path: string;
  files: RepositoryFileItemDto[];
  directories: RepositoryDirectoryItemDto[];
}

export interface RepositoryTreeDto {
  connected: boolean;
  rootPath?: string;
  files: RepositoryFileItemDto[];
  directories: RepositoryDirectoryItemDto[];
}

export interface RepositoryFileContentDto {
  path: string;
  content: string;
  lines: number;
  size: number;
  extension: string;
}

export interface TaskEventsResponseDto {
  taskId: string;
  isRunning: boolean;
  events: Array<{ step: string; title: string; detail?: string; timestamp: string }>;
  timeline: ExecutionTimelineStepDto[];
}

export interface TaskSummaryDto {
  id: string;
  projectId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  trustState: string;
  attemptsCount: number;
  latestHandoff?: HandoffDto;
  latestVerification?: VerificationRecordDto;
  acceptanceCriteria?: string;
  verificationCommand?: string;
}

export interface ExecutionTimelineStepDto {
  step: string;
  title: string;
  detail: string;
  timestamp: string;
  provider?: string;
  model?: string;
}

export interface TaskExecutionInfoDto {
  model: string;
  provider: string;
  isRealInference: boolean;
  executionTimeline: ExecutionTimelineStepDto[];
  usage?: Record<string, unknown>;
}

export interface TaskDetailDto {
  task: {
    id: string;
    projectId: string;
    title: string;
    description: string;
    createdAt: string;
    updatedAt: string;
  };
  trustState: string;
  history: Array<{
    attemptNumber: number;
    handoff?: HandoffDto;
    verification?: VerificationRecordDto;
    verificationRecord?: VerificationRecordDto;
  }>;
  diff?: string;
  executionInfo?: TaskExecutionInfoDto | null;
  acceptanceCriteria?: string;
  verificationConfig?: { command: string; args?: string[] };
  upstreamTaskId?: string;
  isRunning?: boolean;
}

export interface TaskPlanDto {
  summary: string;
  targetFiles?: string[];
  acceptanceCriteria?: string[];
  implementationSteps?: string[];
  risks?: string[];
}

export interface TaskReviewDto {
  verdict: 'APPROVED' | 'REQUEST_CHANGES';
  summary: string;
  findings?: string[];
  potentialRegressions?: string[];
}

export interface TaskRunResultDto {
  success: boolean;
  taskId: string;
  attemptNumber: number;
  status: string;
  trustState?: string;
  model?: string;
  provider?: string;
  isRealInference?: boolean;
  executionTimeline?: ExecutionTimelineStepDto[];
  handoff: HandoffDto;
  verificationResult: {
    status: string;
    checks: VerificationCheckDto[];
    executedAt: string;
    totalDurationMs: number;
  };
  diff: string;
  plan?: TaskPlanDto;
  review?: TaskReviewDto;
}

export interface ModelConfigDto {
  provider: string;
  defaultModel: string;
  hasApiKey: boolean;
  testMode: boolean;
  baseUrl: string;
}

export type EngineStatusListener = (info: EngineHealthInfo) => void;

export function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Client service for monitoring reachability and communicating with the Orchestrate HTTP Engine.
 * Truthfully reflects health status and talks directly to the real Engine API endpoints.
 */
export class EngineClient {
  private baseUrl: string;
  private currentInfo: EngineHealthInfo;
  private listeners: Set<EngineStatusListener> = new Set();
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private knownProjects: Map<string, ProjectDto> = new Map();

  constructor(baseUrl: string = 'http://127.0.0.1:3001') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.currentInfo = {
      state: 'connecting',
      url: this.baseUrl,
    };
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
    this.currentInfo.url = this.baseUrl;
    void this.checkHealth();
  }

  public getInfo(): EngineHealthInfo {
    return { ...this.currentInfo };
  }

  public getKnownProjects(): ProjectDto[] {
    return Array.from(this.knownProjects.values());
  }

  public subscribe(listener: EngineStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getInfo());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const info = this.getInfo();
    for (const listener of this.listeners) {
      listener(info);
    }
  }

  public async checkHealth(): Promise<EngineHealthInfo> {
    const start = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const latencyMs = Math.round(performance.now() - start);

      if (response.ok) {
        const data = (await response.json()) as {
          status?: string;
          version?: string;
          process?: EngineProcessInfo;
          model?: EngineModelDiagnostics;
          capabilities?: EngineCapabilities;
        };
        if (data && data.status === 'ok') {
          this.currentInfo = {
            state: 'connected',
            version: data.version ?? '0.1.0',
            latencyMs,
            lastChecked: new Date().toISOString(),
            url: this.baseUrl,
            process: data.process,
            model: data.model,
            capabilities: data.capabilities,
          };
        } else {
          this.currentInfo = {
            state: 'error',
            latencyMs,
            lastChecked: new Date().toISOString(),
            url: this.baseUrl,
            errorMessage: 'Unrecognized engine health payload format.',
          };
        }
      } else {
        this.currentInfo = {
          state: 'error',
          latencyMs,
          lastChecked: new Date().toISOString(),
          url: this.baseUrl,
          errorMessage: `Engine responded with HTTP ${response.status}`,
        };
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);
      this.currentInfo = {
        state: 'unavailable',
        latencyMs,
        lastChecked: new Date().toISOString(),
        url: this.baseUrl,
        errorMessage: (err as Error).message || 'Failed to connect to engine',
      };
    }

    this.notify();
    return this.getInfo();
  }

  /**
   * GET /projects — Lists all persisted projects from the SQLite-backed Engine.
   */
  public async listProjects(): Promise<ProjectDto[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/projects`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw new Error(
        `Unable to reach Orchestrate Engine at ${this.baseUrl}: ${(err as Error).message || 'Network error'}`
      );
    }

    let data: { projects?: ProjectDto[]; error?: string } = {};
    try {
      data = (await response.json()) as { projects?: ProjectDto[]; error?: string };
    } catch {
      // non-JSON error payload
    }

    if (!response.ok || !Array.isArray(data.projects)) {
      throw new Error(data.error || `Failed to load projects (HTTP ${response.status})`);
    }

    this.knownProjects.clear();
    for (const proj of data.projects) {
      this.knownProjects.set(proj.id, proj);
    }
    this.notify();
    return data.projects;
  }

  /**
   * POST /projects — Creates a project on the Engine ({ id, name, repositoryType?, repositoryPath?, repositoryUrl? }).
   */
  public async createProject(input: {
    id: string;
    name: string;
    repositoryType?: 'local' | 'github' | 'none';
    repositoryPath?: string;
    repositoryUrl?: string;
  }): Promise<ProjectDto> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(input),
      });
    } catch (err) {
      throw new Error(
        `Unable to reach Orchestrate Engine at ${this.baseUrl}: ${(err as Error).message || 'Network error'}`
      );
    }

    let data: Partial<ProjectDto> & { error?: string } = {};
    try {
      data = (await response.json()) as Partial<ProjectDto> & { error?: string };
    } catch {
      // non-JSON error payload
    }

    if (!response.ok || !data.id || !data.name) {
      throw new Error(data.error || `Failed to create project (HTTP ${response.status})`);
    }

    const created: ProjectDto = {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt ?? new Date().toISOString(),
      facts: Array.isArray(data.facts) ? data.facts : [],
    };
    this.knownProjects.set(created.id, created);
    this.notify();
    return created;
  }

  /**
   * GET /projects/:projectId — Fetches a project by ID from the Engine.
   * Returns null on 404 Not Found; throws on network or server errors.
   */
  public async getProject(projectId: string): Promise<ProjectDto | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw new Error(
        `Unable to reach Orchestrate Engine at ${this.baseUrl}: ${(err as Error).message || 'Network error'}`
      );
    }

    if (response.status === 404) {
      return null;
    }

    let data: Partial<ProjectDto> & { error?: string } = {};
    try {
      data = (await response.json()) as Partial<ProjectDto> & { error?: string };
    } catch {
      // non-JSON error payload
    }

    if (!response.ok || !data.id || !data.name) {
      throw new Error(data.error || `Failed to load project (HTTP ${response.status})`);
    }

    const project: ProjectDto = {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt ?? new Date().toISOString(),
      facts: Array.isArray(data.facts) ? data.facts : [],
    };
    this.knownProjects.set(project.id, project);
    this.notify();
    return project;
  }

  /**
   * GET /projects/:projectId/handoffs — Fetches handoff records.
   */
  public async getHandoffs(projectId: string, taskId?: string): Promise<HandoffDto[]> {
    const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/handoffs${query}`,
        { headers: { Accept: 'application/json' } }
      );
    } catch (err) {
      throw new Error(
        `Unable to reach Orchestrate Engine at ${this.baseUrl}: ${(err as Error).message || 'Network error'}`
      );
    }

    let data: { handoffs?: HandoffDto[]; error?: string } = {};
    try {
      data = (await response.json()) as { handoffs?: HandoffDto[]; error?: string };
    } catch {
      // non-JSON error payload
    }

    if (!response.ok || !Array.isArray(data.handoffs)) {
      throw new Error(data.error || `Failed to load handoffs (HTTP ${response.status})`);
    }

    return data.handoffs;
  }

  /**
   * GET /projects/:projectId/verifications — Fetches independent verification records.
   */
  public async getVerifications(
    projectId: string,
    taskId?: string
  ): Promise<VerificationRecordDto[]> {
    const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/verifications${query}`,
        { headers: { Accept: 'application/json' } }
      );
    } catch (err) {
      throw new Error(
        `Unable to reach Orchestrate Engine at ${this.baseUrl}: ${(err as Error).message || 'Network error'}`
      );
    }

    let data: { verifications?: VerificationRecordDto[]; error?: string } = {};
    try {
      data = (await response.json()) as { verifications?: VerificationRecordDto[]; error?: string };
    } catch {
      // non-JSON error payload
    }

    if (!response.ok || !Array.isArray(data.verifications)) {
      throw new Error(data.error || `Failed to load verifications (HTTP ${response.status})`);
    }

    return data.verifications;
  }

  /**
   * GET /projects/:projectId/context — Compiles evidence-backed context for a target task.
   */
  public async compileContext(
    projectId: string,
    targetTaskId: string,
    upstreamTaskId?: string,
    tags?: string[]
  ): Promise<CompiledContextResponseDto> {
    const params = new URLSearchParams({ targetTaskId });
    if (upstreamTaskId && upstreamTaskId.trim() !== '') {
      params.set('upstreamTaskId', upstreamTaskId.trim());
    }
    if (tags && tags.length > 0) {
      params.set('tags', tags.join(','));
    }

    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/context?${params.toString()}`,
      { headers: { Accept: 'application/json' } }
    );

    const data = (await response.json()) as CompiledContextResponseDto & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Failed to compile context (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * POST /projects/:projectId/repository/validate
   */
  public async validateRepository(
    projectId: string,
    input: { type: 'local' | 'github' | 'none'; path?: string; url?: string }
  ): Promise<RepositoryValidationResultDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/repository/validate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(input),
      }
    );

    const data = (await response.json()) as RepositoryValidationResultDto;
    return data;
  }

  /**
   * POST /projects/:projectId/repository/import
   */
  public async importRepository(
    projectId: string,
    input: { type: 'local' | 'github' | 'none'; path?: string; url?: string }
  ): Promise<RepositoryImportResultDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/repository/import`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(input),
      }
    );

    const data = (await response.json()) as RepositoryImportResultDto;
    if (!response.ok) {
      throw new Error(data.error || `Failed to import repository (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /projects/:projectId/repository/status
   */
  public async getRepositoryStatus(projectId: string): Promise<RepositoryStatusDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/repository/status`,
      { headers: { Accept: 'application/json' } }
    );

    const data = (await response.json()) as RepositoryStatusDto;
    if (!response.ok) {
      throw new Error(data.error || `Failed to get repository status (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /projects/:projectId/tasks
   */
  public async listTasks(projectId: string): Promise<TaskSummaryDto[]> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks`,
      { headers: { Accept: 'application/json' } }
    );

    const data = (await response.json()) as { tasks?: TaskSummaryDto[]; error?: string };
    if (!response.ok || !Array.isArray(data.tasks)) {
      throw new Error(data.error || `Failed to list tasks (HTTP ${response.status})`);
    }
    return data.tasks;
  }

  /**
   * POST /projects/:projectId/tasks
   */
  public async createTask(
    projectId: string,
    input: {
      id?: string;
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      verificationCommand?: string;
      verificationArgs?: string[];
      upstreamTaskId?: string;
    }
  ): Promise<{ task: any }> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(input),
      }
    );

    const data = (await response.json()) as { task?: any; error?: string };
    if (!response.ok || !data.task) {
      throw new Error(data.error || `Failed to create task (HTTP ${response.status})`);
    }
    return { task: data.task };
  }

  /**
   * GET /projects/:projectId/tasks/:taskId
   */
  public async getTask(projectId: string, taskId: string): Promise<TaskDetailDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Accept: 'application/json' } }
    );

    const data = (await response.json()) as TaskDetailDto & { error?: string };
    if (!response.ok || !data.task) {
      throw new Error(data.error || `Failed to get task (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * POST /projects/:projectId/tasks/:taskId/run
   */
  public async runTask(
    projectId: string,
    taskId: string,
    options?: {
      model?: string;
      modelProvider?: string;
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      verificationCommand?: string;
      upstreamTaskId?: string;
      enableMultiAgent?: boolean;
      plannerModel?: string;
      reviewerModel?: string;
      targetScope?: { type: string; paths: string[] };
    }
  ): Promise<TaskRunResultDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/run`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(options ?? {}),
      }
    );

    const data = (await response.json()) as TaskRunResultDto & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Failed to run task (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /projects/:projectId/tasks/:taskId/diff
   */
  public async getTaskDiff(projectId: string, taskId: string): Promise<{ diff: string }> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/diff`,
      { headers: { Accept: 'application/json' } }
    );

    const data = (await response.json()) as { diff?: string; error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Failed to get task diff (HTTP ${response.status})`);
    }
    return { diff: data.diff ?? '' };
  }

  /**
   * POST /projects/:projectId/tasks/:taskId/unblock
   */
  public async unblockTask(
    projectId: string,
    taskId: string
  ): Promise<{ success: boolean; taskId: string; trustState: string }> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/unblock`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
      }
    );

    const data = (await response.json()) as {
      success: boolean;
      taskId: string;
      trustState: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(data.error || `Failed to unblock task (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * POST /projects/:projectId/tasks/:taskId/cancel
   */
  public async cancelTask(
    projectId: string,
    taskId: string
  ): Promise<{ success: boolean; taskId: string; cancelled: boolean; message?: string }> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({}),
      }
    );
    const data = (await response.json()) as {
      success: boolean;
      taskId: string;
      cancelled: boolean;
      message?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(data.error || `Failed to cancel task (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /projects/:projectId/repository/tree
   */
  public async getRepositoryTree(projectId: string): Promise<RepositoryTreeDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/repository/tree`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }
    );
    const data = (await response.json()) as RepositoryTreeDto & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Failed to fetch repository tree (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /projects/:projectId/repository/file?path=...
   */
  public async getRepositoryFile(projectId: string, filePath: string): Promise<RepositoryFileContentDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/repository/file?path=${encodeURIComponent(filePath)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }
    );
    const data = (await response.json()) as RepositoryFileContentDto & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Failed to fetch file content (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /projects/:projectId/tasks/:taskId/events
   */
  public async getTaskEvents(projectId: string, taskId: string): Promise<TaskEventsResponseDto> {
    const response = await fetch(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/events`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }
    );
    const data = (await response.json()) as TaskEventsResponseDto & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Failed to fetch task events (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /config/model
   */
  public async getModelConfig(): Promise<ModelConfigDto> {
    const response = await fetch(`${this.baseUrl}/config/model`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    const data = (await response.json()) as ModelConfigDto & { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Failed to get model config (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * GET /config/model/registry
   */
  public async getModelRegistry(): Promise<{
    registry: Record<string, { routingKey: string; baseUrl: string; region: string; pricing: any }>;
    defaultModel: string;
    roles: { planner: string; implementer: string; reviewer: string; fallback: string };
  }> {
    const response = await fetch(`${this.baseUrl}/config/model/registry`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Failed to get model registry (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * POST /projects/open-folder
   */
  public async openFolder(options: { path: string; name?: string; id?: string }): Promise<{
    success: boolean;
    project: ProjectDto;
    repository: { type: string; path: string; branch: string };
  }> {
    const response = await fetch(`${this.baseUrl}/projects/open-folder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(options),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Failed to open folder (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * POST /config/model
   */
  public async saveModelConfig(config: {
    apiKey?: string;
    model?: string;
    testMode?: boolean;
  }): Promise<{ success: boolean; provider: string; defaultModel: string; hasApiKey: boolean; testMode: boolean }> {
    const response = await fetch(`${this.baseUrl}/config/model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(config),
    });

    const data = (await response.json()) as {
      success: boolean;
      provider: string;
      defaultModel: string;
      hasApiKey: boolean;
      testMode: boolean;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(data.error || `Failed to update model config (HTTP ${response.status})`);
    }
    return data;
  }

  public startPolling(intervalMs: number = 10000): void {
    if (this.pollIntervalId) return;
    void this.checkHealth();
    this.pollIntervalId = setInterval(() => {
      void this.checkHealth();
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }
}

function resolveInitialEngineUrl(): string {
  if (typeof window !== 'undefined') {
    const win = window as unknown as { __ORCHESTRATE_ENGINE_URL__?: string };
    if (win.__ORCHESTRATE_ENGINE_URL__) return win.__ORCHESTRATE_ENGINE_URL__;
    try {
      const meta = import.meta as unknown as { env?: { VITE_ENGINE_URL?: string } };
      if (meta?.env?.VITE_ENGINE_URL && meta.env.VITE_ENGINE_URL.trim()) {
        return meta.env.VITE_ENGINE_URL.trim().replace(/\/+$/, '');
      }
    } catch {
      // ignore
    }
    try {
      const raw = window.localStorage?.getItem('orchestrate.settings.app');
      if (raw) {
        const parsed = JSON.parse(raw) as { engineUrl?: string };
        if (typeof parsed.engineUrl === 'string' && parsed.engineUrl.trim()) {
          return parsed.engineUrl.trim().replace(/\/+$/, '');
        }
      }
    } catch {
      // fallback
    }
  }
  return 'http://127.0.0.1:3001';
}

export const engineClient = new EngineClient(resolveInitialEngineUrl());
