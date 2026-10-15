import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryProjectBrain } from '@orchestrate/brain';
import { ContextCompiler } from '@orchestrate/compiler';
import {
  AgentRunner,
  createDefaultToolRegistry,
  Orchestrator,
  type OrchestrationResult,
} from '@orchestrate/core';
import { NebiusModelClient } from '@orchestrate/model';
import {
  InstrumentedModelClient,
  LangSmithTracer,
} from '@orchestrate/telemetry';
import { VerificationEngine, type VerificationPlan } from '@orchestrate/verification';
import { LocalCommandExecutor, LocalWorkspace } from '@orchestrate/workspace';

const EXPECTED_APAC_ENDPOINT = 'https://apac.api.smith.langchain.com';
const FIXED_NEBIUS_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
const ALLOWED_ERROR_CATEGORIES = new Set([
  'AgentExecutionError',
  'Error',
  'TypeError',
  'RangeError',
]);

interface TrackedRequest {
  method: string;
  status: number;
  ok: boolean;
  runType?: string;
  runId?: string;
  parentRunId?: string;
  patchTargetId?: string;
  isApacEndpoint: boolean;
  isExpectedPath: boolean;
}

async function main(): Promise<void> {
  console.log('=== Orchestrate M8.2: Task A Real Telemetry Validation ===');

  // 1. Validate required environment configuration
  const nebiusApiKey = process.env.NEBIUS_API_KEY?.trim();
  const langsmithApiKey = process.env.LANGSMITH_API_KEY?.trim();
  const rawEndpoint = process.env.LANGSMITH_ENDPOINT?.trim();
  const projectName = process.env.LANGSMITH_PROJECT?.trim() || 'Orchestrate';

  if (!nebiusApiKey) {
    console.error('[FATAL] NEBIUS_API_KEY is not defined.');
    process.exit(1);
  }
  if (!langsmithApiKey) {
    console.error('[FATAL] LANGSMITH_API_KEY is not defined.');
    process.exit(1);
  }
  if (!rawEndpoint || rawEndpoint.replace(/\/+$/, '') !== EXPECTED_APAC_ENDPOINT) {
    console.error('[FATAL] LANGSMITH_ENDPOINT is not configured to the required APAC endpoint.');
    process.exit(1);
  }

  console.log('[CONFIG] Nebius API Key: Configured');
  console.log('[CONFIG] LangSmith API Key: Configured');
  console.log(`[CONFIG] LangSmith Endpoint: ${EXPECTED_APAC_ENDPOINT}`);
  console.log(`[CONFIG] Nebius Model: ${FIXED_NEBIUS_MODEL}`);
  console.log(`[CONFIG] LangSmith Project: ${projectName}`);
  console.log('[CONFIG] Privacy Mode: METADATA-ONLY (capturePayloads: false)');

  let tempDir: string | undefined;
  let taskVerificationPassed = false;
  let orchestratorResult: OrchestrationResult | null = null;
  let taskErrorCategory: string | undefined;
  let taskErrorStatus: number | undefined;
  const brain = new MemoryProjectBrain();
  const projectId = 'proj-real-task-a';
  const taskId = 'task-greeting-module';

  // 2. Tracked LangSmith tracer with structural inspection (zero secret/ID logging)
  const recordedRequests: TrackedRequest[] = [];
  let telemetryErrorCount = 0;

  const trackedFetch: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;

    let isApacEndpoint = false;
    let isExpectedPath = false;
    let runType: string | undefined;
    let runId: string | undefined;
    let parentRunId: string | undefined;
    let patchTargetId: string | undefined;

    try {
      const parsedUrl = new URL(rawUrl);
      isApacEndpoint = parsedUrl.origin === EXPECTED_APAC_ENDPOINT;

      if (method === 'POST') {
        isExpectedPath = parsedUrl.pathname === '/runs';
        if (typeof init?.body === 'string') {
          const parsed = JSON.parse(init.body);
          if (typeof parsed.run_type === 'string') runType = parsed.run_type;
          if (typeof parsed.id === 'string') runId = parsed.id;
          if (typeof parsed.parent_run_id === 'string') parentRunId = parsed.parent_run_id;
        }
      } else if (method === 'PATCH') {
        const match = parsedUrl.pathname.match(/^\/runs\/([a-f0-9-]+)$/i);
        isExpectedPath = Boolean(match);
        if (match) {
          patchTargetId = match[1];
        }
      }
    } catch {
      // Safe URL parse fallback
    }

    const response = await fetch(input, init);

    recordedRequests.push({
      method,
      status: response.status,
      ok: response.ok,
      runType,
      runId,
      parentRunId,
      patchTargetId,
      isApacEndpoint,
      isExpectedPath,
    });

    return response;
  };

  const tracer = new LangSmithTracer({
    apiKey: langsmithApiKey,
    apiUrl: EXPECTED_APAC_ENDPOINT,
    projectName,
    capturePayloads: false, // Strict privacy: zero prompts, model responses, code, or tool args
    timeoutMs: 10000,
    fetchFn: trackedFetch,
    onError: () => {
      telemetryErrorCount++;
    },
  });

  try {
    // 3. Allocate fresh disposable workspace
    tempDir = await mkdtemp(join(tmpdir(), 'orchestrate-real-task-a-'));
    const workspace = new LocalWorkspace({ rootPath: tempDir });
    const executor = new LocalCommandExecutor({ workspaceRoot: tempDir });
    const verificationEngine = new VerificationEngine({ executor });

    // 4. Brain & Compiler setup
    const compiler = new ContextCompiler({ brain });

    await brain.createProject({ id: projectId, name: 'Real Task A Validation Project' });
    await brain.createTask({
      id: taskId,
      projectId,
      title: 'Create reusable greeting module',
      description: 'Create src/greeting.ts exporting createGreeting(name: string): string.',
    });

    // 5. Model Client & Agent Runner setup
    const rawModelClient = new NebiusModelClient({
      apiKey: nebiusApiKey,
      defaultModel: FIXED_NEBIUS_MODEL,
    });

    const instrumentedClient = new InstrumentedModelClient({
      modelClient: rawModelClient,
      telemetrySink: tracer,
      projectId,
      taskId,
      attemptNumber: 1,
    });

    const toolRegistry = createDefaultToolRegistry({ workspace, executor });

    const runner = new AgentRunner({
      modelClient: instrumentedClient,
      defaultModel: FIXED_NEBIUS_MODEL,
      toolRegistry,
    });

    const orchestrator = new Orchestrator({
      brain,
      runner,
      verificationEngine,
      compiler,
      telemetrySink: tracer,
      toolRegistry,
    });

    // 6. Independent Verification Plan
    const verificationPlan: VerificationPlan = {
      checks: [
        {
          id: 'check-greeting-module',
          name: 'Verify greeting module exists and exports createGreeting',
          command: 'node',
          args: [
            '--experimental-strip-types',
            '--input-type=module',
            '-e',
            'import { createGreeting } from "./src/greeting.ts"; if (typeof createGreeting !== "function") process.exit(1); if (createGreeting("World") !== "Hello, World!") process.exit(1); console.log("createGreeting verified successfully");',
          ],
        },
      ],
    };

    console.log('\n[EXECUTION] Executing Task A via Orchestrator with live inference...');
    orchestratorResult = await orchestrator.executeTask({
      projectId,
      taskId,
      verificationPlan,
      model: FIXED_NEBIUS_MODEL,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object') {
      const errorObj = err as Record<string, unknown>;
      const rawName = typeof errorObj.name === 'string' ? errorObj.name : '';
      taskErrorCategory = ALLOWED_ERROR_CATEGORIES.has(rawName) ? rawName : 'UnknownError';

      const candidateStatus =
        errorObj.status ??
        errorObj.statusCode ??
        (errorObj.cause && typeof errorObj.cause === 'object'
          ? (errorObj.cause as Record<string, unknown>).status ?? (errorObj.cause as Record<string, unknown>).statusCode
          : undefined) ??
        (errorObj.response && typeof errorObj.response === 'object'
          ? (errorObj.response as Record<string, unknown>).status ?? (errorObj.response as Record<string, unknown>).statusCode
          : undefined);

      if (
        typeof candidateStatus === 'number' &&
        Number.isInteger(candidateStatus) &&
        candidateStatus >= 100 &&
        candidateStatus <= 599
      ) {
        taskErrorStatus = candidateStatus;
      } else if (typeof errorObj.message === 'string') {
        const match = errorObj.message.match(/\bstatus\s+(\d{3})\b/i);
        if (match) {
          const parsed = Number.parseInt(match[1], 10);
          if (parsed >= 100 && parsed <= 599) {
            taskErrorStatus = parsed;
          }
        }
      }
    } else {
      taskErrorCategory = 'UnknownError';
    }
  } finally {
    // Guaranteed cleanup on every exit path
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── SECTION A: Independent Verification Outcome ──
  console.log('\n========================================');
  console.log(' SECTION A: INDEPENDENT TASK VERIFICATION');
  console.log('========================================');

  if (orchestratorResult) {
    const trustState = await brain.deriveTaskTrustState(taskId);
    const checks = orchestratorResult.verificationResult?.checks ?? [];
    const checkEvidence = checks[0];

    const hasPassingCheck =
      checks.length === 1 &&
      checkEvidence?.checkId === 'check-greeting-module' &&
      checkEvidence?.passed === true &&
      checkEvidence?.exitCode === 0 &&
      checkEvidence?.timedOut === false;

    console.log(`[EVIDENCE] Verification Status: ${orchestratorResult.status}`);
    console.log(`[EVIDENCE] Handoff Status: ${orchestratorResult.handoff?.status}`);
    console.log(`[EVIDENCE] Check Status: ${hasPassingCheck ? 'PASSED (exitCode: 0, timedOut: false)' : 'FAILED'}`);
    console.log(`[EVIDENCE] Project Brain Trust State: ${trustState}`);

    taskVerificationPassed =
      orchestratorResult.status === 'VERIFIED' &&
      trustState === 'VERIFIED' &&
      hasPassingCheck;
  } else {
    const statusSnippet = taskErrorStatus !== undefined ? ` (HTTP ${taskErrorStatus})` : '';
    const categorySnippet = taskErrorCategory ? ` (Category: ${taskErrorCategory}${statusSnippet})` : '';
    console.error(`[EVIDENCE] Task Execution: FAILED${categorySnippet}`);
    taskVerificationPassed = false;
  }

  // ── SECTION B: Telemetry & Observability Outcome ──
  console.log('\n========================================');
  console.log(' SECTION B: TELEMETRY & OBSERVABILITY');
  console.log('========================================');

  // Structural Lifecycle Validation Assertions
  const allEndpointsValid =
    recordedRequests.length > 0 &&
    recordedRequests.every((r) => r.isApacEndpoint && r.isExpectedPath);

  const allRequestsSucceeded =
    recordedRequests.length > 0 &&
    recordedRequests.every((r) => r.ok && r.status >= 200 && r.status < 300);

  const rootPostRequests = recordedRequests.filter(
    (r) => r.method === 'POST' && r.runType === 'chain' && !r.parentRunId
  );
  const rootRunId = rootPostRequests[0]?.runId;

  const modelChildRequests = recordedRequests.filter(
    (r) => r.method === 'POST' && r.runType === 'llm' && Boolean(r.parentRunId) && r.parentRunId === rootRunId
  );

  const toolChildRequests = recordedRequests.filter(
    (r) => r.method === 'POST' && r.runType === 'tool' && Boolean(r.parentRunId) && r.parentRunId === rootRunId
  );

  const patchRequests = recordedRequests.filter((r) => r.method === 'PATCH');
  const patchMatchesRoot =
    patchRequests.length === 1 && Boolean(rootRunId) && patchRequests[0].patchTargetId === rootRunId;

  const zeroTelemetryErrors = telemetryErrorCount === 0;

  const hasExactRootPost = rootPostRequests.length === 1 && Boolean(rootRunId);
  const hasAtLeastOneModelChild = modelChildRequests.length >= 1;
  const hasAtLeastOneToolChild = toolChildRequests.length >= 1;
  const hasExactRootPatch = patchRequests.length === 1;

  console.log(`[TELEMETRY] APAC Host & Path Validation: ${allEndpointsValid ? 'VERIFIED' : 'FAILED'}`);
  console.log(`[TELEMETRY] Root Chain POST: ${hasExactRootPost ? 'OK (HTTP 2xx)' : 'FAILED'}`);
  console.log(`[TELEMETRY] Child LLM POSTs: ${hasAtLeastOneModelChild ? `OK (${modelChildRequests.length} run(s))` : 'FAILED'}`);
  console.log(`[TELEMETRY] Child Tool POSTs: ${hasAtLeastOneToolChild ? `OK (${toolChildRequests.length} run(s))` : 'FAILED'}`);
  console.log(`[TELEMETRY] Root PATCH Close: ${hasExactRootPatch ? 'OK (HTTP 2xx)' : 'FAILED'}`);
  console.log(`[TELEMETRY] Trace Correlation: ${patchMatchesRoot ? 'VERIFIED (matched root task ID)' : 'FAILED'}`);
  console.log(`[TELEMETRY] All HTTP 2xx: ${allRequestsSucceeded ? 'PASSED' : 'FAILED'}`);
  console.log(`[TELEMETRY] Telemetry Errors: ${zeroTelemetryErrors ? '0 (Clean)' : `${telemetryErrorCount} error(s)`}`);

  const telemetryPassed =
    allEndpointsValid &&
    allRequestsSucceeded &&
    hasExactRootPost &&
    hasAtLeastOneModelChild &&
    hasAtLeastOneToolChild &&
    hasExactRootPatch &&
    patchMatchesRoot &&
    zeroTelemetryErrors;

  // ── FINAL VALIDATION SUMMARY ──
  console.log('\n========================================');
  console.log(' FINAL VALIDATION SUMMARY');
  console.log('========================================');
  console.log(`Task Engineering Verification: ${taskVerificationPassed ? 'PASSED (VERIFIED)' : 'FAILED'}`);
  console.log(`Telemetry Export to LangSmith:  ${telemetryPassed ? 'PASSED (Lifecycle Verified)' : 'FAILED'}`);

  if (taskVerificationPassed && telemetryPassed) {
    console.log('\n[SUCCESS] M8.2 Task A Real Telemetry Validation Succeeded.');
    process.exit(0);
  } else {
    console.error('\n[FAILURE] Validation did not satisfy all criteria.');
    process.exit(1);
  }
}

main().catch(() => {
  console.error('[UNCAUGHT ERROR] Validation failed due to an unexpected fatal error.');
  process.exit(1);
});
