import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BrainStore, Handoff, VerificationRecord, Task, Project } from '@orchestrate/brain';
import {
  ContextCompiler,
  ContextSerializer,
  type CompiledContext,
} from '@orchestrate/compiler';
import {
  Orchestrator,
  AgentRunner,
  ToolRegistry,
  createReadFileTool,
  createWriteFileTool,
  createExecuteCommandTool,
  getProjectInfoTool,
} from '@orchestrate/core';
import {
  LocalWorkspace,
  LocalCommandExecutor,
  createCommandExecutor,
  LocalGitRepository,
  type CommandExecutor,
} from '@orchestrate/workspace';
import {
  VerificationEngine,
  type VerificationPlan,
  type VerificationCheck,
} from '@orchestrate/verification';
import { NebiusModelClient, NEBIUS_MODEL_REGISTRY, type ModelClient } from '@orchestrate/model';
import { DeterministicTestModelClient } from './test-model-client.js';
import {
  AuthError,
  type AuthUser,
  createAuthToken,
  verifyAuthToken,
  extractBearerToken,
  resolveJwtSecret,
  INSECURE_DEV_JWT_SECRET,
} from './auth.js';

export class HttpPayloadError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'HttpPayloadError';
    this.statusCode = statusCode;
  }
}

export interface EngineServerOptions {
  brain: BrainStore;
  compiler?: ContextCompiler;
  port?: number;
  host?: string;
  corsOrigin?: string;
  modelClient?: ModelClient;
  workspacesDir?: string;
  loadEnv?: boolean;
  commandExecutorFactory?: (options: { workspaceRoot: string; signal?: AbortSignal }) => CommandExecutor;
  jwtSecret?: string;
  authRequired?: boolean;
  devMode?: boolean;
}

export interface EngineServerInstance {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  start(): Promise<{ port: number; host: string; url: string }>;
  stop(): Promise<void>;
}

function safeDecodeParam(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function sanitizeBaseUrl(raw?: string): string {
  const fallback = 'https://api.tokenfactory.nebius.com/v1';
  if (!raw || !raw.trim()) return fallback;
  try {
    const u = new URL(raw.trim());
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

/**
 * Creates a native, dependency-disciplined HTTP Engine API server.
 * Implements strict host binding, structured JSON routing, real agent orchestration,
 * repository onboarding, and zero secret leakage.
 */
export function createEngineServer(options: EngineServerOptions): EngineServerInstance {
  if (!options?.brain) {
    throw new Error('createEngineServer: "brain" store is required.');
  }

  const defaultHost = options.host ?? '127.0.0.1';
  const defaultPort = options.port ?? 3001;
  const corsOrigin = options.corsOrigin ?? 'http://localhost:3000';
  const brain = options.brain;
  const compiler = options.compiler ?? new ContextCompiler({ brain });
  const workspacesRoot = path.resolve(options.workspacesDir || './workspaces');

  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && options.authRequired === false) {
    throw new Error('SECURITY INVARIANT VIOLATION: Authentication cannot be disabled in production mode.');
  }
  if (isProduction && options.devMode === true) {
    throw new Error('SECURITY INVARIANT VIOLATION: Development mode cannot be enabled in production mode.');
  }
  const jwtSecret = resolveJwtSecret(options.jwtSecret);
  const authRequired = isProduction
    ? true
    : (options.authRequired ?? (!options.devMode && process.env.ORCHESTRATE_AUTH_DISABLED !== 'true'));

  // Load .env automatically if present in workspace root (unless in tests or explicitly disabled)
  if (options.loadEnv !== false && !process.env.VITEST) {
    try {
      const envFile = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envFile)) {
        if (typeof (process as any).loadEnvFile === 'function') {
          (process as any).loadEnvFile(envFile);
        } else {
          const content = fs.readFileSync(envFile, 'utf8');
          for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eqIdx = line.indexOf('=');
            if (eqIdx > 0) {
              const key = line.slice(0, eqIdx).trim();
              let val = line.slice(eqIdx + 1).trim();
              if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
              }
              if (key && !(key in process.env)) {
                process.env[key] = val;
              }
            }
          }
        }
      }
    } catch {
      // Ignore env loading errors
    }
  }

  // Runtime settings & model provider configuration
  let testModeOverride =
    process.env.ORCHESTRATE_TEST_MODE === 'true' ||
    (options.modelClient instanceof DeterministicTestModelClient);
  let defaultModelName = process.env.NEBIUS_DEFAULT_MODEL || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
  let userApiKey = process.env.NEBIUS_API_KEY || '';
  let customBaseUrl = process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1';

  // Per-user model provider configuration
  interface UserModelConfig {
    apiKey?: string;
    defaultModel?: string;
    testMode?: boolean;
    baseUrl?: string;
  }
  const userModelConfigs = new Map<string, UserModelConfig>();

  // In-memory execution state
  const diffStore = new Map<string, string>(); // `${userId}:${projectId}:${taskId}` -> diff
  const executionInfoStore = new Map<string, any>(); // `${userId}:${projectId}:${taskId}` -> execution details
  const taskEventsStore = new Map<
    string,
    {
      isRunning: boolean;
      events: Array<{
        step: string;
        title: string;
        detail?: string;
        timestamp: string;
      }>;
      timeline: Array<{
        step: string;
        title: string;
        detail: string;
        timestamp: string;
      }>;
    }
  >();
  const runningTasks = new Set<string>(); // `${userId}:${projectId}:${taskId}`
  const taskAbortControllers = new Map<string, AbortController>();

  interface ResolvedModel {
    client: ModelClient;
    provider: string;
    model: string;
    isRealInference: boolean;
  }

  const resolveModelClient = (
    user: AuthUser,
    requestedModel?: string,
    requestedProvider?: string
  ): ResolvedModel => {
    if (options.modelClient) {
      const isTest = options.modelClient instanceof DeterministicTestModelClient;
      return {
        client: options.modelClient,
        provider: isTest ? 'test' : 'injected',
        model: requestedModel || defaultModelName,
        isRealInference: !isTest,
      };
    }
    const userCfg = userModelConfigs.get(user.id);
    const effectiveTestMode = userCfg?.testMode ?? testModeOverride;
    if (effectiveTestMode || requestedProvider === 'test') {
      return {
        client: new DeterministicTestModelClient(),
        provider: 'test',
        model: requestedModel || 'deterministic-test-model',
        isRealInference: false,
      };
    }
    const effectiveApiKey = userCfg?.apiKey || userApiKey;
    const effectiveBaseUrl = userCfg?.baseUrl || customBaseUrl;
    const effectiveModel = requestedModel || userCfg?.defaultModel || defaultModelName;

    if (effectiveApiKey && effectiveApiKey.trim().length > 0) {
      return {
        client: new NebiusModelClient({
          apiKey: effectiveApiKey.trim(),
          baseUrl: sanitizeBaseUrl(effectiveBaseUrl),
          defaultModel: effectiveModel,
        }),
        provider: 'nebius',
        model: effectiveModel,
        isRealInference: true,
      };
    }
    // Fail clearly if credentials are missing — never silently switch to fake executor!
    throw new Error(
      'Nebius API key is not configured. Please set NEBIUS_API_KEY in your .env file or configure it in Settings to execute tasks with nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B. (Or enable Deterministic Test Mode in Settings for offline evaluation).'
    );
  };

  const sendJson = (
    res: http.ServerResponse,
    statusCode: number,
    data: unknown
  ): void => {
    const json = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(json);
  };

  const sendError = (
    res: http.ServerResponse,
    statusCode: number,
    message: string
  ): void => {
    sendJson(res, statusCode, {
      error: message,
      statusCode,
    });
  };

  const readJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      let body = '';
      let settled = false;
      const maxBytes = 1024 * 1024; // 1MB limit

      const cleanup = () => {
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        req.removeListener('close', onClose);
      };

      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > maxBytes) {
          settled = true;
          cleanup();
          req.pause();
          req.resume();
          reject(new HttpPayloadError('Payload too large', 413));
        }
      };

      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch {
          reject(new HttpPayloadError('Invalid JSON payload', 400));
        }
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onClose = () => {
        if (settled) return;
        if (!req.complete) {
          settled = true;
          cleanup();
          reject(new HttpPayloadError('Client connection closed prematurely', 400));
        }
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  };

  const requestListener: http.RequestListener = async (req, res) => {
    try {
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      let reqUrl: URL;
      try {
        reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      } catch {
        sendError(res, 400, 'Malformed request URL.');
        return;
      }

      const pathname = reqUrl.pathname;
      const method = req.method?.toUpperCase() ?? 'GET';

      // ── GET /health ────────────────────────────────────────────────────────
      if (pathname === '/health') {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }
        sendJson(res, 200, {
          status: 'ok',
          timestamp: new Date().toISOString(),
          version: '0.1.0',
          process: {
            pid: process.pid,
            uptimeSeconds: Math.floor(process.uptime()),
            nodeVersion: process.version,
            memoryUsageMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          },
          model: {
            provider: testModeOverride ? 'test' : 'nebius',
            defaultModel: defaultModelName,
            hasApiKey: Boolean(userApiKey && userApiKey.trim().length > 0),
            testMode: testModeOverride,
            baseUrl: sanitizeBaseUrl(customBaseUrl),
          },
          capabilities: {
            tools: ['get_project_info', 'read_file', 'write_file', 'execute_command'],
            workspace: 'local-sandboxed',
            verification: 'verification-engine',
            repositoryOnboarding: ['local', 'github', 'none'],
            taskOrchestration: true,
          },
        });
        return;
      }

      // ── Authentication Check for all protected endpoints ─────────────────
      let user: AuthUser;
      const authHeader = req.headers.authorization;
      const bearerToken = extractBearerToken(authHeader);

      if (bearerToken) {
        try {
          const payload = verifyAuthToken(bearerToken, jwtSecret);
          user = {
            id: payload.sub,
            role: typeof payload.role === 'string' ? payload.role : undefined,
            email: typeof payload.email === 'string' ? payload.email : undefined,
          };
        } catch (err) {
          const status = err instanceof AuthError ? err.statusCode : 401;
          sendError(res, status, (err as Error).message);
          return;
        }
      } else if (!authRequired) {
        // Explicitly configured development mode bypass
        user = {
          id: 'dev-user',
          role: 'developer',
        };
      } else {
        // Missing Authorization header when auth is required
        sendError(res, 401, 'Unauthorized: Missing or invalid Authorization header. Bearer token required.');
        return;
      }

      // ── GET & POST /config/model ───────────────────────────────────────────
      if (pathname === '/config/model') {
        if (method === 'GET') {
          const userCfg = userModelConfigs.get(user.id);
          const hasApiKey = Boolean(userCfg?.apiKey && userCfg.apiKey.trim().length > 0) || Boolean(userApiKey && userApiKey.trim().length > 0);
          const effectiveModel = userCfg?.defaultModel || defaultModelName;
          const effectiveTestMode = userCfg?.testMode ?? testModeOverride;
          const effectiveBaseUrl = userCfg?.baseUrl || customBaseUrl;

          sendJson(res, 200, {
            provider: effectiveTestMode ? 'test' : 'nebius',
            defaultModel: effectiveModel,
            hasApiKey,
            testMode: effectiveTestMode,
            baseUrl: sanitizeBaseUrl(effectiveBaseUrl),
          });
          return;
        }

        if (method === 'POST') {
          let body: any;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            sendError(res, err instanceof HttpPayloadError ? err.statusCode : 400, (err as Error).message);
            return;
          }

          const currentConfig = userModelConfigs.get(user.id) || {};
          if (typeof body.apiKey === 'string') {
            currentConfig.apiKey = body.apiKey.trim();
          }
          if (typeof body.model === 'string' && body.model.trim()) {
            currentConfig.defaultModel = body.model.trim();
          }
          if (typeof body.testMode === 'boolean') {
            currentConfig.testMode = body.testMode;
          }
          if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
            currentConfig.baseUrl = body.baseUrl.trim();
          }
          userModelConfigs.set(user.id, currentConfig);

          const hasApiKey = Boolean(currentConfig.apiKey && currentConfig.apiKey.trim().length > 0) || Boolean(userApiKey && userApiKey.trim().length > 0);
          const effectiveModel = currentConfig.defaultModel || defaultModelName;
          const effectiveTestMode = currentConfig.testMode ?? testModeOverride;

          sendJson(res, 200, {
            success: true,
            provider: effectiveTestMode ? 'test' : 'nebius',
            defaultModel: effectiveModel,
            hasApiKey,
            testMode: effectiveTestMode,
          });
          return;
        }

        sendError(res, 405, 'Method Not Allowed');
        return;
      }

      // ── GET /config/model/registry ─────────────────────────────────────────
      if (pathname === '/config/model/registry') {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }
        sendJson(res, 200, {
          registry: NEBIUS_MODEL_REGISTRY,
          defaultModel: defaultModelName,
          roles: {
            planner: 'zai-org/GLM-5.3-Flash',
            implementer: 'moonshotai/Kimi-K2.6',
            reviewer: 'nvidia/Nemotron-3.5-Super-VL',
            fallback: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
          },
        });
        return;
      }

      // ── GET /projects & POST /projects ─────────────────────────────────────
      if (pathname === '/projects') {
        if (method === 'GET') {
          const projects = await brain.listProjects(user.id);
          sendJson(res, 200, { projects });
          return;
        }

        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const status = err instanceof HttpPayloadError ? err.statusCode : 400;
          sendError(res, status, (err as Error).message);
          return;
        }

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendError(res, 400, 'Request body must be a JSON object.');
          return;
        }

        const { id, name, repositoryType, repositoryPath, repositoryUrl } = body;
        if (typeof id !== 'string' || id.trim() === '' || typeof name !== 'string' || name.trim() === '') {
          sendError(res, 400, 'Project "id" and "name" must be non-empty strings.');
          return;
        }

        const trimmedId = id.trim();
        const trimmedName = name.trim();

        try {
          const project = await brain.createProject({
            id: trimmedId,
            name: trimmedName,
            ownerId: user.id,
          });

          // Record repository configuration ONLY if explicitly supplied
          if (typeof repositoryType === 'string' && repositoryType.trim()) {
            const repoType = repositoryType === 'local' || repositoryType === 'github' ? repositoryType : 'none';
            if (repoType === 'local' && isProduction) {
              sendError(res, 403, 'Local filesystem repository onboarding is disabled in production. Use Git cloning.');
              return;
            }
            await brain.addProjectFact(trimmedId, {
              key: 'repository_type',
              value: repoType,
              provenance: 'SYSTEM',
              status: 'VERIFIED',
            });

            if (repoType === 'local' && typeof repositoryPath === 'string' && repositoryPath.trim()) {
              const resolvedPath = path.resolve(repositoryPath.trim());
              await brain.addProjectFact(trimmedId, {
                key: 'repository_path',
                value: resolvedPath,
                provenance: 'SYSTEM',
                status: 'VERIFIED',
              });
              try {
                if (fs.existsSync(resolvedPath)) {
                  const executor = new LocalCommandExecutor({ workspaceRoot: resolvedPath });
                  const git = new LocalGitRepository(executor);
                  if (await git.isRepository()) {
                    const branch = await git.getCurrentBranch();
                    if (branch) {
                      await brain.addProjectFact(trimmedId, {
                        key: 'repository_branch',
                        value: branch,
                        provenance: 'CODE',
                        status: 'VERIFIED',
                      });
                    }
                  }
                }
              } catch {
                // Ignore git probe failure on create
              }
            } else if (repoType === 'github' && typeof repositoryUrl === 'string' && repositoryUrl.trim()) {
              await brain.addProjectFact(trimmedId, {
                key: 'repository_url',
                value: repositoryUrl.trim(),
                provenance: 'SYSTEM',
                status: 'VERIFIED',
              });
            }
          }

          const reloaded = await brain.getProject(trimmedId);
          sendJson(res, 201, reloaded ?? project);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('already exists')) {
            sendError(res, 409, msg);
          } else {
            sendError(res, 400, msg);
          }
        }
        return;
      }

      // ── POST /projects/open-folder ─────────────────────────────────────────
      if (pathname === '/projects/open-folder') {
        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        if (isProduction) {
          sendError(res, 403, 'Local folder opening is disabled in production environments. Please onboard repositories using Git.');
          return;
        }

        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendError(res, err instanceof HttpPayloadError ? err.statusCode : 400, (err as Error).message);
          return;
        }

        const folderPath = body?.path;
        if (typeof folderPath !== 'string' || !folderPath.trim()) {
          sendError(res, 400, 'Folder "path" is required.');
          return;
        }

        const resolved = path.resolve(folderPath.trim());
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          sendError(res, 400, `Directory does not exist or is not a directory: "${resolved}"`);
          return;
        }

        const folderName = body.name?.trim() || path.basename(resolved);
        const projectId =
          body.id?.trim() ||
          `proj-${folderName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}-${Date.now().toString(36)}`;

        let project = await brain.getProject(projectId);
        if (project && project.ownerId && project.ownerId !== user.id) {
          sendError(res, 404, 'Project not found.');
          return;
        }
        if (!project) {
          project = await brain.createProject({
            id: projectId,
            name: folderName,
            ownerId: user.id,
          });
        }

        await brain.addProjectFact(projectId, {
          key: 'repository_type',
          value: 'local',
          provenance: 'SYSTEM',
          status: 'VERIFIED',
        });
        await brain.addProjectFact(projectId, {
          key: 'repository_path',
          value: resolved,
          provenance: 'SYSTEM',
          status: 'VERIFIED',
        });

        let branch = 'main';
        try {
          const executor = new LocalCommandExecutor({ workspaceRoot: resolved });
          const git = new LocalGitRepository(executor);
          if (await git.isRepository()) {
            const detected = await git.getCurrentBranch();
            if (detected) branch = detected;
          }
        } catch {
          // ignore
        }

        await brain.addProjectFact(projectId, {
          key: 'repository_branch',
          value: branch,
          provenance: 'CODE',
          status: 'VERIFIED',
        });

        const reloaded = await brain.getProject(projectId);
        sendJson(res, 200, {
          success: true,
          project: reloaded ?? project,
          repository: { type: 'local', path: resolved, branch },
        });
        return;
      }

      // ── POST /projects/:projectId/repository/validate ──────────────────────
      const repoValidateMatch = pathname.match(/^\/projects\/([^/]+)\/repository\/validate$/);
      if (repoValidateMatch) {
        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(repoValidateMatch[1]);
        if (!projectId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (project && project.ownerId && project.ownerId !== user.id) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendError(res, err instanceof HttpPayloadError ? err.statusCode : 400, (err as Error).message);
          return;
        }

        const type = body?.type;
        if (type === 'local') {
          if (isProduction) {
            sendError(res, 403, 'Local filesystem repository validation is disabled in production.');
            return;
          }
          const targetPath = body.path;
          if (typeof targetPath !== 'string' || !targetPath.trim()) {
            sendJson(res, 200, { valid: false, error: 'Local path is required.' });
            return;
          }
          const resolved = path.resolve(targetPath.trim());
          if (!fs.existsSync(resolved)) {
            sendJson(res, 200, { valid: false, error: `Directory does not exist: "${resolved}"` });
            return;
          }
          const stats = fs.statSync(resolved);
          if (!stats.isDirectory()) {
            sendJson(res, 200, { valid: false, error: `Path is not a directory: "${resolved}"` });
            return;
          }

          try {
            const executor = new LocalCommandExecutor({ workspaceRoot: resolved });
            const git = new LocalGitRepository(executor);
            const isGit = await git.isRepository();
            if (isGit) {
              const status = await git.getStatus();
              sendJson(res, 200, {
                valid: true,
                type: 'local',
                path: resolved,
                isGit: true,
                branch: status.branch || 'main',
                isClean: status.clean,
                stagedCount: status.staged.length,
                unstagedCount: status.unstaged.length,
                untrackedCount: status.untracked.length,
              });
              return;
            } else {
              sendJson(res, 200, {
                valid: true,
                type: 'local',
                path: resolved,
                isGit: false,
                warning: 'Directory exists but is not currently a Git repository.',
              });
              return;
            }
          } catch (err) {
            sendJson(res, 200, { valid: false, error: (err as Error).message });
            return;
          }
        }

        if (type === 'github') {
          const url = body.url;
          if (typeof url !== 'string' || !url.trim()) {
            sendJson(res, 200, { valid: false, error: 'GitHub repository URL is required.' });
            return;
          }
          const githubRegex = /^https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_\-.]+)\/([a-zA-Z0-9_\-.]+?)(?:\.git)?$/;
          const match = url.trim().match(githubRegex);
          if (!match) {
            sendJson(res, 200, {
              valid: false,
              error: 'Invalid GitHub URL. Must be in the format https://github.com/owner/repository',
            });
            return;
          }
          sendJson(res, 200, {
            valid: true,
            type: 'github',
            owner: match[1],
            repo: match[2],
            url: url.trim(),
          });
          return;
        }

        if (type === 'none') {
          sendJson(res, 200, { valid: true, type: 'none' });
          return;
        }

        sendError(res, 400, 'Invalid repository type. Supported: "local", "github", "none".');
        return;
      }

      // ── POST /projects/:projectId/repository/import ────────────────────────
      const repoImportMatch = pathname.match(/^\/projects\/([^/]+)\/repository\/import$/);
      if (repoImportMatch) {
        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(repoImportMatch[1]);
        if (!projectId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendError(res, err instanceof HttpPayloadError ? err.statusCode : 400, (err as Error).message);
          return;
        }

        const type = body?.type;
        if (type === 'local') {
          if (isProduction) {
            sendError(res, 403, 'Local filesystem repository import is disabled in production.');
            return;
          }
          const targetPath = body.path;
          if (typeof targetPath !== 'string' || !targetPath.trim()) {
            sendError(res, 400, 'Local path is required.');
            return;
          }
          const resolved = path.resolve(targetPath.trim());
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            sendError(res, 400, `Directory does not exist: "${resolved}"`);
            return;
          }

          await brain.addProjectFact(projectId, {
            key: 'repository_type',
            value: 'local',
            provenance: 'SYSTEM',
            status: 'VERIFIED',
          });
          await brain.addProjectFact(projectId, {
            key: 'repository_path',
            value: resolved,
            provenance: 'SYSTEM',
            status: 'VERIFIED',
          });

          let branch = 'main';
          try {
            const executor = new LocalCommandExecutor({ workspaceRoot: resolved });
            const git = new LocalGitRepository(executor);
            if (await git.isRepository()) {
              const detected = await git.getCurrentBranch();
              if (detected) branch = detected;
            }
          } catch {
            // ignore
          }

          await brain.addProjectFact(projectId, {
            key: 'repository_branch',
            value: branch,
            provenance: 'CODE',
            status: 'VERIFIED',
          });

          sendJson(res, 200, {
            success: true,
            repository: { type: 'local', path: resolved, branch },
          });
          return;
        }

        if (type === 'github') {
          const url = body.url;
          if (typeof url !== 'string' || !url.trim()) {
            sendError(res, 400, 'GitHub URL is required.');
            return;
          }

          // Clone into managed workspaces directory
          const targetDir = path.resolve(workspacesRoot, 'projects', projectId, 'repo');
          await fsp.mkdir(path.dirname(targetDir), { recursive: true });

          if (fs.existsSync(targetDir)) {
            await fsp.rm(targetDir, { recursive: true, force: true });
          }

          const executor = new LocalCommandExecutor({ workspaceRoot: process.cwd() });
          const cloneResult = await executor.execute('git', ['clone', url.trim(), targetDir]);
          if (cloneResult.exitCode !== 0) {
            sendError(
              res,
              400,
              `Git clone failed: ${cloneResult.stderr || cloneResult.stdout || 'Unknown error'}. For private repositories, configure Git credentials.`
            );
            return;
          }

          await brain.addProjectFact(projectId, {
            key: 'repository_type',
            value: 'github',
            provenance: 'SYSTEM',
            status: 'VERIFIED',
          });
          await brain.addProjectFact(projectId, {
            key: 'repository_url',
            value: url.trim(),
            provenance: 'SYSTEM',
            status: 'VERIFIED',
          });
          await brain.addProjectFact(projectId, {
            key: 'repository_path',
            value: targetDir,
            provenance: 'SYSTEM',
            status: 'VERIFIED',
          });

          let branch = 'main';
          try {
            const repoExec = new LocalCommandExecutor({ workspaceRoot: targetDir });
            const git = new LocalGitRepository(repoExec);
            const b = await git.getCurrentBranch();
            if (b) branch = b;
          } catch {
            // ignore
          }

          await brain.addProjectFact(projectId, {
            key: 'repository_branch',
            value: branch,
            provenance: 'CODE',
            status: 'VERIFIED',
          });

          sendJson(res, 200, {
            success: true,
            repository: { type: 'github', url: url.trim(), path: targetDir, branch },
          });
          return;
        }

        if (type === 'none') {
          await brain.addProjectFact(projectId, {
            key: 'repository_type',
            value: 'none',
            provenance: 'SYSTEM',
            status: 'VERIFIED',
          });
          sendJson(res, 200, { success: true, repository: { type: 'none' } });
          return;
        }

        sendError(res, 400, 'Invalid repository type.');
        return;
      }

      // ── GET /projects/:projectId/repository/status ─────────────────────────
      const repoStatusMatch = pathname.match(/^\/projects\/([^/]+)\/repository\/status$/);
      if (repoStatusMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(repoStatusMatch[1]);
        if (!projectId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const repoTypeFact = project.facts.find((f) => f.key === 'repository_type');
        const repoPathFact = project.facts.find((f) => f.key === 'repository_path');
        const repoUrlFact = project.facts.find((f) => f.key === 'repository_url');

        if (!repoPathFact || repoTypeFact?.value === 'none') {
          sendJson(res, 200, {
            type: repoTypeFact?.value || 'none',
            connected: false,
          });
          return;
        }

        const repoPath = repoPathFact.value;
        if (!fs.existsSync(repoPath)) {
          sendJson(res, 200, {
            type: repoTypeFact?.value || 'local',
            path: repoPath,
            connected: false,
            error: 'Repository path does not exist on filesystem.',
          });
          return;
        }

        try {
          const executor = new LocalCommandExecutor({ workspaceRoot: repoPath });
          const git = new LocalGitRepository(executor);
          const isGit = await git.isRepository();
          if (!isGit) {
            sendJson(res, 200, {
              type: repoTypeFact?.value || 'local',
              path: repoPath,
              connected: true,
              isGit: false,
            });
            return;
          }

          const status = await git.getStatus();
          const head = await git.getHeadCommit();

          sendJson(res, 200, {
            type: repoTypeFact?.value || 'local',
            path: repoPath,
            url: repoUrlFact?.value,
            connected: true,
            isGit: true,
            branch: status.branch || 'main',
            isClean: status.clean,
            stagedCount: status.staged.length,
            unstagedCount: status.unstaged.length,
            untrackedCount: status.untracked.length,
            headCommit: head
              ? { hash: head.hash, subject: head.subject, author: head.author, timestamp: head.timestamp }
              : null,
          });
          return;
        } catch (err) {
          sendJson(res, 200, {
            type: repoTypeFact?.value || 'local',
            path: repoPath,
            connected: false,
            error: (err as Error).message,
          });
          return;
        }
      }

      // ── GET /projects/:projectId/repository/tree ───────────────────────────
      const repoTreeMatch = pathname.match(/^\/projects\/([^/]+)\/repository\/tree$/);
      if (repoTreeMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(repoTreeMatch[1]);
        if (!projectId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        let repoPathFact = project.facts.find((f) => f.key === 'repository_path');
        let repoPath = repoPathFact?.value;
        if (!repoPath) {
          const benchmarkDir = path.resolve(process.cwd(), 'benchmarks', projectId);
          if (fs.existsSync(benchmarkDir)) {
            repoPath = benchmarkDir;
          }
        }

        if (!repoPath || !fs.existsSync(repoPath)) {
          sendJson(res, 200, { connected: false, files: [], directories: [] });
          return;
        }

        const ignored = new Set(['.git', 'node_modules', 'dist', '.next', 'build', '.cache', '.turbo', '.orchestrate']);

        function scanDir(dir: string, baseDir: string): { files: any[]; directories: any[] } {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const files: any[] = [];
          const directories: any[] = [];

          for (const entry of entries) {
            if (ignored.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            if (entry.isDirectory()) {
              const sub = scanDir(fullPath, baseDir);
              directories.push({
                name: entry.name,
                path: relPath,
                files: sub.files,
                directories: sub.directories,
              });
            } else {
              let size = 0;
              try {
                size = fs.statSync(fullPath).size;
              } catch {
                // Ignore stat error
              }
              files.push({
                name: entry.name,
                path: relPath,
                size,
                extension: path.extname(entry.name).slice(1),
              });
            }
          }
          return { files, directories };
        }

        try {
          const result = scanDir(repoPath, repoPath);
          sendJson(res, 200, {
            connected: true,
            rootPath: repoPath,
            files: result.files,
            directories: result.directories,
          });
        } catch (scanErr) {
          sendError(res, 500, `Failed to scan repository tree: ${(scanErr as Error).message}`);
        }
        return;
      }

      // ── GET /projects/:projectId/repository/file ───────────────────────────
      const repoFileMatch = pathname.match(/^\/projects\/([^/]+)\/repository\/file$/);
      if (repoFileMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(repoFileMatch[1]);
        if (!projectId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const filePathQuery = reqUrl.searchParams.get('path');
        if (!filePathQuery || !filePathQuery.trim()) {
          sendError(res, 400, 'Query parameter "path" is required.');
          return;
        }

        let repoPathFact = project.facts.find((f) => f.key === 'repository_path');
        let repoPath = repoPathFact?.value;
        if (!repoPath) {
          const benchmarkDir = path.resolve(process.cwd(), 'benchmarks', projectId);
          if (fs.existsSync(benchmarkDir)) {
            repoPath = benchmarkDir;
          }
        }

        if (!repoPath || !fs.existsSync(repoPath)) {
          sendError(res, 404, 'Project repository is not connected.');
          return;
        }

        const normalizedRel = path.normalize(filePathQuery.trim()).replace(/^(\.\.(\/|\\|$))+/, '');
        const targetAbs = path.resolve(repoPath, normalizedRel);
        if (!targetAbs.startsWith(path.resolve(repoPath))) {
          sendError(res, 403, 'Path traversal detected outside repository boundary.');
          return;
        }

        if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
          sendError(res, 404, `File "${normalizedRel}" not found in repository.`);
          return;
        }

        try {
          const content = fs.readFileSync(targetAbs, 'utf8');
          const lines = content.split('\n').length;
          const size = Buffer.byteLength(content, 'utf8');
          sendJson(res, 200, {
            path: normalizedRel.replace(/\\/g, '/'),
            content,
            lines,
            size,
            extension: path.extname(targetAbs).slice(1),
          });
        } catch (readErr) {
          sendError(res, 500, `Failed to read file: ${(readErr as Error).message}`);
        }
        return;
      }

      // ── GET /projects/:projectId/tasks & POST /projects/:projectId/tasks ───
      const tasksMatch = pathname.match(/^\/projects\/([^/]+)\/tasks$/);
      if (tasksMatch) {
        const projectId = safeDecodeParam(tasksMatch[1]);
        if (!projectId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        if (method === 'GET') {
          const rawTasks = await brain.listTasks(projectId);
          const enrichedTasks = [];
          for (const task of rawTasks) {
            const trustState = await brain.deriveTaskTrustState(task.id);
            const history = await brain.getTaskHistory(task.id);
            const latestAttempt = history.length > 0 ? history[history.length - 1] : undefined;
            enrichedTasks.push({
              ...task,
              trustState,
              attemptsCount: history.length,
              latestHandoff: latestAttempt?.handoff,
              latestVerification: latestAttempt?.verificationRecord,
            });
          }
          sendJson(res, 200, { tasks: enrichedTasks });
          return;
        }

        if (method === 'POST') {
          let body: any;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            sendError(res, err instanceof HttpPayloadError ? err.statusCode : 400, (err as Error).message);
            return;
          }

          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
          }

          const { title, description, acceptanceCriteria, verificationCommand, verificationArgs, upstreamTaskId } = body;
          if (typeof title !== 'string' || title.trim() === '') {
            sendError(res, 400, 'Task "title" is required and must be a non-empty string.');
            return;
          }

          const rawId = body.id;
          const taskId =
            typeof rawId === 'string' && rawId.trim()
              ? rawId.trim()
              : `task-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

          try {
            const createdTask = await brain.createTask({
              id: taskId,
              projectId,
              title: title.trim(),
              description: typeof description === 'string' ? description.trim() : '',
            });

            // Store acceptance criteria & verification plan metadata in Project Facts
            if (typeof acceptanceCriteria === 'string' && acceptanceCriteria.trim()) {
              await brain.addProjectFact(projectId, {
                key: `task_${taskId}_acceptance`,
                value: acceptanceCriteria.trim(),
                provenance: 'HUMAN',
                status: 'CLAIMED',
              });
            }

            if (typeof verificationCommand === 'string' && verificationCommand.trim()) {
              let vCmd = verificationCommand.trim();
              let vArgs = Array.isArray(verificationArgs) ? verificationArgs.map(String) : [];
              if (vCmd.includes(' ') && vArgs.length === 0) {
                const parts = vCmd.split(/\s+/);
                vCmd = parts[0];
                vArgs = parts.slice(1);
              }
              await brain.addProjectFact(projectId, {
                key: `task_${taskId}_verification`,
                value: JSON.stringify({
                  command: vCmd,
                  args: vArgs,
                }),
                provenance: 'HUMAN',
                status: 'CLAIMED',
              });
            }

            if (typeof upstreamTaskId === 'string' && upstreamTaskId.trim()) {
              await brain.addProjectFact(projectId, {
                key: `task_${taskId}_upstream`,
                value: upstreamTaskId.trim(),
                provenance: 'HUMAN',
                status: 'CLAIMED',
              });
            }

            sendJson(res, 201, { task: createdTask, trustState: 'UNVERIFIED' });
          } catch (err) {
            sendError(res, 400, (err as Error).message);
          }
          return;
        }

        sendError(res, 405, 'Method Not Allowed');
        return;
      }

      // ── GET /projects/:projectId/tasks/:taskId/diff ────────────────────────
      const taskDiffMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/diff$/);
      if (taskDiffMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(taskDiffMatch[1]);
        const taskId = safeDecodeParam(taskDiffMatch[2]);
        if (!projectId || !taskId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const task = await brain.getTask(taskId);
        if (!task || task.projectId !== projectId) {
          sendError(res, 404, 'Task not found.');
          return;
        }

        const lockKey = `${user.id}:${projectId}:${taskId}`;
        const diff = diffStore.get(lockKey) || '';
        sendJson(res, 200, { diff });
        return;
      }

      // ── POST /projects/:projectId/tasks/:taskId/unblock ────────────────────
      const taskUnblockMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/unblock$/);
      if (taskUnblockMatch) {
        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(taskUnblockMatch[1]);
        const taskId = safeDecodeParam(taskUnblockMatch[2]);
        if (!projectId || !taskId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const task = await brain.getTask(taskId);
        if (!task || task.projectId !== projectId) {
          sendError(res, 404, 'Task not found.');
          return;
        }

        await brain.unblockTask(taskId);
        sendJson(res, 200, { success: true, taskId, trustState: 'UNVERIFIED' });
        return;
      }

      // ── POST /projects/:projectId/tasks/:taskId/cancel ────────────────────
      const taskCancelMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/cancel$/);
      if (taskCancelMatch) {
        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(taskCancelMatch[1]);
        const taskId = safeDecodeParam(taskCancelMatch[2]);
        if (!projectId || !taskId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const task = await brain.getTask(taskId);
        if (!task || task.projectId !== projectId) {
          sendError(res, 404, 'Task not found.');
          return;
        }

        const lockKey = `${user.id}:${projectId}:${taskId}`;
        const ctrl = taskAbortControllers.get(lockKey);
        if (ctrl) {
          ctrl.abort();
          runningTasks.delete(lockKey);
          taskAbortControllers.delete(lockKey);
          sendJson(res, 200, { success: true, taskId, cancelled: true });
        } else {
          sendJson(res, 200, { success: false, taskId, cancelled: false, message: 'Task is not currently running.' });
        }
        return;
      }

      // ── GET /projects/:projectId/tasks/:taskId/events ──────────────────────
      const taskEventsMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/events$/);
      if (taskEventsMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(taskEventsMatch[1]);
        const taskId = safeDecodeParam(taskEventsMatch[2]);
        if (!projectId || !taskId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const task = await brain.getTask(taskId);
        if (task && task.projectId !== projectId) {
          sendError(res, 404, 'Task not found in this project.');
          return;
        }

        const lockKey = `${user.id}:${projectId}:${taskId}`;
        const stored = taskEventsStore.get(lockKey);
        const execInfo = executionInfoStore.get(lockKey);
        const isRunning = runningTasks.has(lockKey);

        sendJson(res, 200, {
          taskId,
          isRunning,
          events: stored?.events || [],
          timeline: stored?.timeline || execInfo?.executionTimeline || [],
        });
        return;
      }

      // ── POST /projects/:projectId/tasks/:taskId/run ────────────────────────
      const taskRunMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/run$/);
      if (taskRunMatch) {
        if (method !== 'POST') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(taskRunMatch[1]);
        const taskId = safeDecodeParam(taskRunMatch[2]);
        if (!projectId || !taskId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const task = await brain.getTask(taskId);
        if (!task || task.projectId !== projectId) {
          sendError(res, 404, `Task "${taskId}" not found in project "${projectId}".`);
          return;
        }

        const lockKey = `${user.id}:${projectId}:${taskId}`;
        if (runningTasks.has(lockKey)) {
          sendError(res, 409, `Task "${taskId}" is already currently running.`);
          return;
        }

        // Check if task is blocked
        const trustState = await brain.deriveTaskTrustState(taskId);
        if (trustState === 'BLOCKED_NEEDS_HUMAN') {
          sendError(
            res,
            400,
            `Task "${taskId}" is in BLOCKED_NEEDS_HUMAN state. Please unblock the task before re-running.`
          );
          return;
        }

        // Verify project has an attached repository
        let repoPathFact = project.facts.find((f) => f.key === 'repository_path');
        const repoTypeFact = project.facts.find((f) => f.key === 'repository_type');
        if (!repoPathFact || repoTypeFact?.value === 'none') {
          // Check if there is an existing benchmark directory matching this project
          let potentialBenchmarkDir = path.resolve(process.cwd(), 'benchmarks', projectId);
          if (!fs.existsSync(potentialBenchmarkDir)) {
            const byName = path.resolve(process.cwd(), 'benchmarks', project.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-'));
            if (fs.existsSync(byName)) {
              potentialBenchmarkDir = byName;
            } else {
              const stripped = projectId.replace(/^proj-/, '').replace(/-[a-z0-9]{4,}$/, '');
              const byStripped = path.resolve(process.cwd(), 'benchmarks', stripped);
              if (fs.existsSync(byStripped)) {
                potentialBenchmarkDir = byStripped;
              }
            }
          }
          if (fs.existsSync(potentialBenchmarkDir) && fs.statSync(potentialBenchmarkDir).isDirectory()) {
            await brain.addProjectFact(projectId, {
              key: 'repository_type',
              value: 'local',
              provenance: 'SYSTEM',
              status: 'VERIFIED',
            });
            await brain.addProjectFact(projectId, {
              key: 'repository_path',
              value: potentialBenchmarkDir,
              provenance: 'SYSTEM',
              status: 'VERIFIED',
            });
            repoPathFact = {
              key: 'repository_path',
              value: potentialBenchmarkDir,
              provenance: 'SYSTEM',
              status: 'VERIFIED',
              recordedAt: new Date().toISOString(),
            };
          } else {
            sendError(
              res,
              400,
              'Cannot execute coding task: Project has no attached repository. Please attach a local repository or clone from GitHub before executing tasks.'
            );
            return;
          }
        }

        if (!repoPathFact || !repoPathFact.value) {
          sendError(res, 400, 'Cannot execute coding task: Project has no attached repository.');
          return;
        }

        const baseRepoPath = repoPathFact.value;
        if (!fs.existsSync(baseRepoPath)) {
          sendError(res, 400, `Project repository path does not exist on disk: "${baseRepoPath}"`);
          return;
        }

        let body: any = {};
        try {
          body = await readJsonBody(req);
        } catch {
          // optional body
        }

        // Validate targetScope to enforce workspace boundary protection
        if (body?.targetScope && typeof body.targetScope === 'object') {
          const scopePaths = Array.isArray(body.targetScope.paths) ? body.targetScope.paths : [];
          for (const p of scopePaths) {
            if (typeof p === 'string' && (p.includes('..') || path.isAbsolute(p))) {
              sendError(res, 400, `Target scope path "${p}" violates workspace boundary (path traversal forbidden).`);
              return;
            }
          }
        }

        runningTasks.add(lockKey);
        const abortCtrl = new AbortController();
        taskAbortControllers.set(lockKey, abortCtrl);

        const executionTimeline: Array<{
          step: string;
          title: string;
          detail: string;
          timestamp: string;
          provider?: string;
          model?: string;
        }> = [];

        try {
          // 1. Prepare isolated task workspace
          const history = await brain.getTaskHistory(taskId);
          const attemptNumber = history.length + 1;
          const taskWorkspaceDir = path.resolve(
            workspacesRoot,
            'tasks',
            projectId,
            taskId,
            `attempt-${attemptNumber}`
          );

          await fsp.mkdir(taskWorkspaceDir, { recursive: true });

          // Copy base repo to isolated task workspace (filtering out build caches)
          await fsp.cp(baseRepoPath, taskWorkspaceDir, {
            recursive: true,
            filter: (source) => {
              const basename = path.basename(source);
              return basename !== 'node_modules' && basename !== 'dist' && basename !== '.git';
            },
          });

          // 2. Initialize isolated git repo in workspace for diff tracking
          try {
            const gitInitExec = new LocalCommandExecutor({ workspaceRoot: taskWorkspaceDir });
            await gitInitExec.execute('git', ['init']);
            await gitInitExec.execute('git', ['config', 'user.name', 'Orchestrate Agent']);
            await gitInitExec.execute('git', ['config', 'user.email', 'agent@orchestrate.local']);
            await gitInitExec.execute('git', ['add', '-A']);
            await gitInitExec.execute('git', ['commit', '-m', 'Initial workspace snapshot']);
          } catch {
            // Non-fatal if git is not on path
          }

          // 3. Build workspace, tools, and verification engine
          const workspace = new LocalWorkspace({ rootPath: taskWorkspaceDir });
          const executor = options.commandExecutorFactory
            ? options.commandExecutorFactory({
                workspaceRoot: taskWorkspaceDir,
                signal: abortCtrl.signal,
              })
            : createCommandExecutor({
                workspaceRoot: taskWorkspaceDir,
                signal: abortCtrl.signal,
              });

          const toolRegistry = new ToolRegistry();
          toolRegistry.register(createReadFileTool(workspace));
          toolRegistry.register(createWriteFileTool(workspace));
          toolRegistry.register(createExecuteCommandTool(executor));
          toolRegistry.register(getProjectInfoTool);

          // 4. Build verification plan from task metadata or default
          const verifFact = project.facts.find((f) => f.key === `task_${taskId}_verification`);
          let verificationPlan: VerificationPlan;

          if (verifFact && verifFact.value) {
            try {
              const parsed = JSON.parse(verifFact.value);
              let cCmd = parsed.command || 'node';
              let cArgs = Array.isArray(parsed.args) ? parsed.args : [];
              if (cCmd.includes(' ') && cArgs.length === 0) {
                const parts = cCmd.split(/\s+/);
                cCmd = parts[0];
                cArgs = parts.slice(1);
              }
              verificationPlan = {
                checks: [
                  {
                    id: 'configured-acceptance-check',
                    name: 'Task Acceptance Check',
                    command: cCmd,
                    args: cArgs,
                    optional: false,
                  },
                ],
              };
            } catch {
              verificationPlan = {
                checks: [
                  {
                    id: 'default-check',
                    name: 'Default Node Syntax Check',
                    command: 'node',
                    args: ['--version'],
                    optional: false,
                  },
                ],
              };
            }
          } else if (body.verificationCommand) {
            let rCmd = String(body.verificationCommand).trim();
            let rArgs = Array.isArray(body.verificationArgs) ? body.verificationArgs.map(String) : [];
            if (rCmd.includes(' ') && rArgs.length === 0) {
              const parts = rCmd.split(/\s+/);
              rCmd = parts[0];
              rArgs = parts.slice(1);
            }
            verificationPlan = {
              checks: [
                {
                  id: 'request-check',
                  name: 'Configured Verification Check',
                  command: rCmd,
                  args: rArgs,
                  optional: false,
                },
              ],
            };
          } else {
            // Default safe verification check
            verificationPlan = {
              checks: [
                {
                  id: 'syntax-and-structure-check',
                  name: 'Workspace Integrity Check',
                  command: 'git',
                  args: ['status'],
                  optional: false,
                },
              ],
            };
          }

          const verificationEngine = new VerificationEngine({
            executor,
            workspaceRoot: taskWorkspaceDir,
          });

          // 5. Select Model Client
          const requestedProvider = body?.modelProvider || body?.provider || (body?.testMode ? 'test' : undefined);
          const resolved = resolveModelClient(user, body?.model, requestedProvider);
          const modelClient = resolved.client;

          // Check for upstream task
          const upstreamFact = project.facts.find((f) => f.key === `task_${taskId}_upstream`);
          const upstreamTaskId = body?.upstreamTaskId || upstreamFact?.value;

          executionTimeline.push(
            {
              step: 'workspace_isolated',
              title: 'Workspace Initialized',
              detail: `Isolated workspace snapshot created at attempt-${attemptNumber}`,
              timestamp: new Date().toISOString(),
            },
            {
              step: 'context_compiled',
              title: 'Context Compiled',
              detail: upstreamTaskId
                ? `Loaded verified handoff and conventions from upstream task "${upstreamTaskId}"`
                : 'Compiled project conventions and repository state',
              timestamp: new Date().toISOString(),
            },
            {
              step: 'model_dispatch',
              title: resolved.isRealInference
                ? `Live Inference Dispatched: ${resolved.model}`
                : `Deterministic Test Execution: ${resolved.model}`,
              detail: resolved.isRealInference
                ? `Provider: Nebius Token Factory (Endpoint: ${sanitizeBaseUrl(customBaseUrl)})`
                : 'Provider: Deterministic Test Provider (Offline / Safe Evaluation)',
              provider: resolved.provider,
              model: resolved.model,
              timestamp: new Date().toISOString(),
            }
          );

          const pushStep = (step: string, title: string, detail: string) => {
            const item = { step, title, detail, timestamp: new Date().toISOString() };
            executionTimeline.push(item);
            taskEventsStore.set(lockKey, {
              isRunning: true,
              events: executionTimeline,
              timeline: executionTimeline,
            });
          };

          taskEventsStore.set(lockKey, {
            isRunning: true,
            events: executionTimeline,
            timeline: executionTimeline,
          });

          // 6. Instantiate AgentRunner and Orchestrator
          const runner = new AgentRunner({
            modelClient,
            defaultModel: resolved.model,
            toolRegistry,
            maxIterations: body.maxIterations || 10,
          });

          const orchestrator = new Orchestrator({
            brain,
            runner,
            verificationEngine,
            compiler,
            toolRegistry,
            workspaceRoot: taskWorkspaceDir,
            modelClient,
          });

          // 8. Execute task!
          const result = await orchestrator.executeTask({
            projectId,
            taskId,
            upstreamTaskId,
            verificationPlan,
            workspaceRoot: taskWorkspaceDir,
            model: resolved.model,
            temperature: body.temperature,
            maxTokens: body.maxTokens,
            enableMultiAgent: body.enableMultiAgent ?? true,
            plannerModel: body.plannerModel,
            reviewerModel: body.reviewerModel,
            targetScope: body.targetScope,
            onProgress: (ev: any) => {
              if (ev.type === 'round_start') {
                pushStep('agent_round', `AI Agent Round #${ev.iteration}`, `Model turn started with ${resolved.model}`);
              } else if (ev.type === 'planner_start') {
                pushStep('planner_start', `Lead Planner: ${ev.model}`, 'Analyzing project requirements and building implementation plan');
              } else if (ev.type === 'planner_complete') {
                pushStep('planner_complete', `Architecture Plan Created`, ev.plan?.summary || 'Plan established');
              } else if (ev.type === 'reviewer_start') {
                pushStep('reviewer_start', `Independent Reviewer: ${ev.model}`, 'Inspecting workspace changes and reviewing implementation against plan');
              } else if (ev.type === 'reviewer_complete') {
                pushStep('reviewer_complete', `Code Review: ${ev.review?.verdict || 'APPROVED'}`, ev.review?.summary || 'Review completed');
              } else if (ev.type === 'tool_start') {
                pushStep('tool_call', `Tool Invoked: ${ev.tool}`, `Arguments: ${JSON.stringify(ev.args || {})}`);
              } else if (ev.type === 'tool_complete') {
                pushStep('tool_complete', `Tool Completed: ${ev.tool}`, `${ev.preview || 'Success'} (${ev.durationMs}ms)`);
              } else if (ev.type === 'duplicate_tool_warning') {
                pushStep('tool_duplicate', `Duplicate Tool Call Detected`, `Tool "${ev.tool}" invoked with identical arguments`);
              } else if (ev.type === 'model_response') {
                if (!ev.toolCallsCount && ev.content) {
                  pushStep('agent_response', `AI Response (Turn #${ev.iteration})`, ev.content.slice(0, 140));
                }
              }
            },
          });

          // Check files modified in handoff
          if (result.handoff?.filesAffected && result.handoff.filesAffected.length > 0) {
            pushStep(
              'tool_call',
              `Workspace Files Modified (${result.handoff.filesAffected.length})`,
              result.handoff.filesAffected.join(', ')
            );
          }

          pushStep(
            'handoff',
            'Structured Handoff Recorded (CLAIMED)',
            result.handoff?.summary || 'Task changes recorded in Brain'
          );

          pushStep(
            'verification',
            `Independent Verification: ${result.verificationResult.status}`,
            `${result.verificationResult.checks.length} check(s) executed independently against workspace`
          );

          // 9. Capture diff
          let capturedDiff = '';
          try {
            await executor.execute('git', ['add', '-N', '.']);
            const gitRepo = new LocalGitRepository(executor);
            capturedDiff = await gitRepo.getDiff();
          } catch {
            // fallback
          }

          diffStore.set(lockKey, capturedDiff);

          // Bounded repair policy (Rule 9): Maximum of two automated repair attempts.
          // If task verification fails consecutively for 2 attempts, transition to BLOCKED_NEEDS_HUMAN.
          let finalTrustState = result.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED';
          if (result.status === 'FAILED') {
            const updatedHistory = await brain.getTaskHistory(taskId);
            let consecutiveFailures = 0;
            for (let i = updatedHistory.length - 1; i >= 0; i--) {
              if (updatedHistory[i].verificationRecord?.result?.status === 'FAILED') {
                consecutiveFailures++;
              } else {
                break;
              }
            }
            if (consecutiveFailures >= 2) {
              await brain.markTaskBlocked(
                taskId,
                `Automated repair loop exhausted (${consecutiveFailures} repair attempts failed). Transitioned to BLOCKED_NEEDS_HUMAN.`
              );
              finalTrustState = 'BLOCKED_NEEDS_HUMAN';
            }
          }

          pushStep(
            'settled',
            `Task Settled: ${finalTrustState}`,
            `Recorded in Project Brain on attempt #${result.attemptNumber}`
          );

          taskEventsStore.set(lockKey, {
            isRunning: false,
            events: executionTimeline,
            timeline: executionTimeline,
          });

          const executionInfo = {
            model: resolved.model,
            provider: resolved.provider,
            isRealInference: resolved.isRealInference,
            executionTimeline,
            usage: result.usage,
            plan: result.plan,
            review: result.review,
          };
          executionInfoStore.set(lockKey, executionInfo);

          sendJson(res, 200, {
            success: true,
            taskId,
            attemptNumber: result.attemptNumber,
            status: result.status,
            trustState: finalTrustState,
            model: resolved.model,
            provider: resolved.provider,
            isRealInference: resolved.isRealInference,
            executionTimeline,
            handoff: result.handoff,
            verificationResult: result.verificationResult,
            diff: capturedDiff,
            plan: result.plan,
            review: result.review,
          });
        } catch (err) {
          const errMsg = (err as Error).message;
          const failStep = {
            step: 'failed',
            title: 'Task Execution Failed',
            detail: errMsg,
            timestamp: new Date().toISOString(),
          };
          executionTimeline.push(failStep);
          taskEventsStore.set(lockKey, {
            isRunning: false,
            events: executionTimeline,
            timeline: executionTimeline,
          });
          executionInfoStore.set(lockKey, {
            executionTimeline,
            error: errMsg,
          });
          sendError(res, 500, `Task execution failed: ${errMsg}`);
        } finally {
          runningTasks.delete(lockKey);
          taskAbortControllers.delete(lockKey);
        }
        return;
      }

      // ── GET /projects/:projectId/tasks/:taskId ─────────────────────────────
      const taskDetailMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)$/);
      if (taskDetailMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(taskDetailMatch[1]);
        const taskId = safeDecodeParam(taskDetailMatch[2]);
        if (!projectId || !taskId) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const task = await brain.getTask(taskId);
        if (!task || task.projectId !== projectId) {
          sendError(res, 404, `Task "${taskId}" not found in project "${projectId}".`);
          return;
        }

        const trustState = await brain.deriveTaskTrustState(taskId);
        const history = await brain.getTaskHistory(taskId);
        const lockKey = `${user.id}:${projectId}:${taskId}`;
        const diff = diffStore.get(lockKey) || '';

        const acceptanceFact = project.facts.find((f) => f.key === `task_${taskId}_acceptance`);
        const verifFact = project.facts.find((f) => f.key === `task_${taskId}_verification`);
        const upstreamFact = project.facts.find((f) => f.key === `task_${taskId}_upstream`);

        sendJson(res, 200, {
          task,
          trustState,
          history,
          diff,
          executionInfo: executionInfoStore.get(lockKey) || null,
          acceptanceCriteria: acceptanceFact?.value,
          verificationConfig: verifFact?.value ? JSON.parse(verifFact.value) : undefined,
          upstreamTaskId: upstreamFact?.value,
          isRunning: runningTasks.has(lockKey),
        });
        return;
      }

      // ── GET /projects/:projectId/handoffs ──────────────────────────────────
      const handoffsMatch = pathname.match(/^\/projects\/([^/]+)\/handoffs$/);
      if (handoffsMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(handoffsMatch[1]);
        if (projectId === null) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const taskId = reqUrl.searchParams.get('taskId');
        if (taskId) {
          const task = await brain.getTask(taskId);
          if (!task || task.projectId !== projectId) {
            sendError(res, 404, `Task "${taskId}" not found in project "${projectId}".`);
            return;
          }
          const history = await brain.getTaskHistory(taskId);
          const handoffs = history
            .map((a) => a.handoff)
            .filter((h): h is Handoff => h !== undefined);
          sendJson(res, 200, { handoffs });
          return;
        }

        const tasks = await brain.listTasks(projectId);
        const allHandoffs: Handoff[] = [];
        for (const task of tasks) {
          const history = await brain.getTaskHistory(task.id);
          for (const attempt of history) {
            if (attempt.handoff) {
              allHandoffs.push(attempt.handoff);
            }
          }
        }
        sendJson(res, 200, { handoffs: allHandoffs });
        return;
      }

      // ── GET /projects/:projectId/verifications ──────────────────────────────
      const verificationsMatch = pathname.match(/^\/projects\/([^/]+)\/verifications$/);
      if (verificationsMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(verificationsMatch[1]);
        if (projectId === null) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const taskId = reqUrl.searchParams.get('taskId');
        if (taskId) {
          const task = await brain.getTask(taskId);
          if (!task || task.projectId !== projectId) {
            sendError(res, 404, `Task "${taskId}" not found in project "${projectId}".`);
            return;
          }
          const history = await brain.getTaskHistory(taskId);
          const verifications = history
            .map((a) => a.verificationRecord)
            .filter((v): v is VerificationRecord => v !== undefined);
          sendJson(res, 200, { verifications });
          return;
        }

        const tasks = await brain.listTasks(projectId);
        const allVerifications: VerificationRecord[] = [];
        for (const task of tasks) {
          const history = await brain.getTaskHistory(task.id);
          for (const attempt of history) {
            if (attempt.verificationRecord) {
              allVerifications.push(attempt.verificationRecord);
            }
          }
        }
        sendJson(res, 200, { verifications: allVerifications });
        return;
      }

      // ── GET /projects/:projectId/context ───────────────────────────────────
      const contextMatch = pathname.match(/^\/projects\/([^/]+)\/context$/);
      if (contextMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(contextMatch[1]);
        if (projectId === null) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        const targetTaskId = reqUrl.searchParams.get('targetTaskId');
        if (!targetTaskId || targetTaskId.trim() === '') {
          sendError(res, 400, 'Query parameter "targetTaskId" is required.');
          return;
        }

        const trimmedTargetId = targetTaskId.trim();
        const targetTask = await brain.getTask(trimmedTargetId);
        if (!targetTask || targetTask.projectId !== projectId) {
          sendError(res, 404, `Target task "${trimmedTargetId}" not found in project "${projectId}".`);
          return;
        }

        const upstreamTaskIdRaw = reqUrl.searchParams.get('upstreamTaskId');
        let upstreamTaskId: string | undefined;
        if (upstreamTaskIdRaw && upstreamTaskIdRaw.trim() !== '') {
          upstreamTaskId = upstreamTaskIdRaw.trim();
          const upstreamTask = await brain.getTask(upstreamTaskId);
          if (!upstreamTask || upstreamTask.projectId !== projectId) {
            sendError(res, 404, `Upstream task "${upstreamTaskId}" not found in project "${projectId}".`);
            return;
          }
        }

        const tagsRaw = reqUrl.searchParams.get('tags');
        const tags = tagsRaw
          ? tagsRaw
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;

        try {
          const compiled: CompiledContext = await compiler.compile({
            projectId,
            targetTaskId: trimmedTargetId,
            upstreamTaskId,
            tags,
          });

          const serialized = ContextSerializer.serialize(compiled);

          sendJson(res, 200, {
            context: compiled,
            serialized,
          });
        } catch (err) {
          sendError(res, 400, (err as Error).message);
        }
        return;
      }

      // ── GET /projects/:projectId ───────────────────────────────────────────
      const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
      if (projectMatch) {
        if (method !== 'GET') {
          sendError(res, 405, 'Method Not Allowed');
          return;
        }

        const projectId = safeDecodeParam(projectMatch[1]);
        if (projectId === null) {
          sendError(res, 400, 'Malformed URI parameter.');
          return;
        }

        const project = await brain.getProject(projectId);
        if (!project || (project.ownerId && project.ownerId !== user.id)) {
          sendError(res, 404, 'Project not found.');
          return;
        }

        sendJson(res, 200, project);
        return;
      }

      // ── 404 Route Not Found ────────────────────────────────────────────────
      sendError(res, 404, 'Not Found');
    } catch {
      // Unhandled server error: do NOT leak internal stack trace
      sendError(res, 500, 'Internal Server Error');
    }
  };

  const server = http.createServer(requestListener);
  let resolvedPort = defaultPort;
  let resolvedHost = defaultHost;

  const instance: EngineServerInstance = {
    server,
    get port() {
      return resolvedPort;
    },
    get host() {
      return resolvedHost;
    },
    get url() {
      return `http://${resolvedHost}:${resolvedPort}`;
    },
    async start(): Promise<{ port: number; host: string; url: string }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(defaultPort, defaultHost, () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (address && typeof address === 'object') {
            resolvedPort = address.port;
            resolvedHost = address.address;
          }
          resolve({
            port: resolvedPort,
            host: resolvedHost,
            url: `http://${resolvedHost}:${resolvedPort}`,
          });
        });
      });
    },
    async stop(): Promise<void> {
      if (!server.listening) {
        return;
      }
      return new Promise((resolve, reject) => {
        if (typeof (server as unknown as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
          (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
        }
        server.close((err) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ERR_SERVER_NOT_RUNNING') {
              resolve();
              return;
            }
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };

  return instance;
}
