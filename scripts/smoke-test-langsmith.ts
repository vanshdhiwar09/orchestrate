import { LangSmithTracer, sanitizeSecretText } from '@orchestrate/telemetry';
import type { TaskExecutionSpan } from '@orchestrate/telemetry';

interface RecordedRequest {
  method: string;
  url: string;
  status: number;
  ok: boolean;
}

const EXPECTED_APAC_ENDPOINT = 'https://apac.api.smith.langchain.com';

async function runSmokeTest(): Promise<void> {
  console.log('=== Orchestrate M8.1 LangSmith Smoke Test ===');

  // 1. Validate environment configuration safely (without revealing secrets)
  const rawApiKey = process.env.LANGSMITH_API_KEY?.trim();
  const rawEndpoint = process.env.LANGSMITH_ENDPOINT?.trim();
  const projectName = process.env.LANGSMITH_PROJECT?.trim() || 'orchestrate';

  if (!rawApiKey) {
    console.error('[FATAL] LANGSMITH_API_KEY is not defined in environment.');
    console.error('Ensure you load .env using Node: node --env-file=.env scripts/smoke-test-langsmith.ts');
    process.exit(1);
  }

  if (!rawEndpoint) {
    console.error('[FATAL] LANGSMITH_ENDPOINT is not defined in environment.');
    process.exit(1);
  }

  const normalizedEndpoint = rawEndpoint.replace(/\/+$/, '');
  if (normalizedEndpoint !== EXPECTED_APAC_ENDPOINT) {
    console.error('[FATAL] LANGSMITH_ENDPOINT configuration error.');
    process.exit(1);
  }

  console.log('[CONFIG] LANGSMITH_API_KEY: Configured');
  console.log(`[CONFIG] LANGSMITH_ENDPOINT: ${EXPECTED_APAC_ENDPOINT}`);
  console.log('[CONFIG] Regional Host: apac.api.smith.langchain.com (APAC confirmed)');
  console.log(`[CONFIG] LANGSMITH_PROJECT: ${projectName}`);
  console.log('[CONFIG] Payload Capture: DISABLED (capturePayloads: false, metadata only)');

  // 2. Track outgoing requests, run IDs, and telemetry errors safely
  const recordedRequests: RecordedRequest[] = [];
  const capturedErrors: Error[] = [];
  let submittedRunId: string | undefined;
  let patchedRunId: string | undefined;

  const trackedFetch: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;

    // Capture run IDs structurally for validation without logging request body
    if (method === 'POST') {
      try {
        const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (parsed && typeof parsed.id === 'string') {
          submittedRunId = parsed.id;
        }
      } catch {
        // Safe fallback; non-JSON body
      }
    } else if (method === 'PATCH') {
      try {
        const parsedUrl = new URL(rawUrl);
        const match = parsedUrl.pathname.match(/\/runs\/([^/]+)$/);
        if (match) {
          patchedRunId = match[1];
        }
      } catch {
        // Safe fallback; URL parsing failure
      }
    }

    // Execute real HTTP request
    const response = await fetch(input, init);

    // Sanitize and record request details (strictly NO headers, NO bodies)
    recordedRequests.push({
      method,
      url: sanitizeSecretText(rawUrl, [rawApiKey]),
      status: response.status,
      ok: response.ok,
    });

    return response;
  };

  // 3. Instantiate LangSmithTracer with metadata-only configuration
  const tracer = new LangSmithTracer({
    apiKey: rawApiKey,
    apiUrl: rawEndpoint,
    projectName,
    capturePayloads: false, // Strict privacy: zero prompts, model responses, code, or tool args
    timeoutMs: 10000,
    fetchFn: trackedFetch,
    onError: (err) => {
      capturedErrors.push(err);
    },
  });

  if (!tracer.enabled) {
    console.error('[FATAL] LangSmithTracer reported enabled: false despite API key presence.');
    process.exit(1);
  }

  // 4. Construct synthetic root trace with harmless metadata only
  const syntheticSpan: TaskExecutionSpan = {
    projectId: 'orchestrate-smoke-test',
    taskId: 'smoke-test-handshake',
    attemptNumber: 1,
    startedAt: new Date().toISOString(),
    status: 'IN_PROGRESS',
    model: 'synthetic-smoke-test-model',
    provider: 'synthetic-provider',
    tags: ['smoke-test', 'm8.1', 'metadata-only'],
  };

  console.log('\n[EXECUTION] Submitting synthetic root trace start...');
  await tracer.onTaskStart(syntheticSpan);

  // Validate internal run registration immediately after task start
  const activeRegisteredRunId = tracer.getRegisteredRunId(syntheticSpan);

  // Complete the synthetic root trace
  syntheticSpan.completedAt = new Date().toISOString();
  syntheticSpan.status = 'VERIFIED';
  syntheticSpan.durationMs = 50;
  syntheticSpan.usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  console.log('[EXECUTION] Closing synthetic root trace...');
  await tracer.onTaskComplete(syntheticSpan);

  // Validate internal run cleanup immediately after task complete
  const postCompleteRunId = tracer.getRegisteredRunId(syntheticSpan);

  // 5. Verify trace submission, run ID lifecycle, and error isolation
  console.log('\n=== Smoke Test Verification Results ===');

  if (capturedErrors.length > 0) {
    console.error(`[FAILURE] Telemetry reported ${capturedErrors.length} error(s):`);
    for (const err of capturedErrors) {
      console.error(`  - ${sanitizeSecretText(err.message, [rawApiKey])}`);
    }
    process.exit(1);
  }

  if (recordedRequests.length !== 2) {
    console.error(
      `[FAILURE] Expected exactly 2 HTTP requests (1 POST, 1 PATCH), but recorded ${recordedRequests.length}.`
    );
    process.exit(1);
  }

  const [postRun, patchRun] = recordedRequests;

  if (postRun.method !== 'POST' || !postRun.ok) {
    console.error(`[FAILURE] POST /runs failed with HTTP status ${postRun.status}`);
    process.exit(1);
  }

  if (patchRun.method !== 'PATCH' || !patchRun.ok) {
    console.error(`[FAILURE] PATCH /runs/:id failed with HTTP status ${patchRun.status}`);
    process.exit(1);
  }

  // Validate Run ID correlation lifecycle
  if (!submittedRunId) {
    console.error('[FAILURE] Could not determine run ID from POST /runs request.');
    process.exit(1);
  }

  if (submittedRunId !== activeRegisteredRunId) {
    console.error(
      '[FAILURE] POST run ID mismatch: body ID does not match tracer registered ID.'
    );
    process.exit(1);
  }

  if (patchedRunId !== submittedRunId) {
    console.error(
      '[FAILURE] Run correlation mismatch: PATCH target does not match POST target.'
    );
    process.exit(1);
  }

  if (postCompleteRunId !== undefined) {
    console.error('[FAILURE] Tracer did not remove completed run from internal active map.');
    process.exit(1);
  }

  console.log(`[PASS] POST /runs -> HTTP ${postRun.status}`);
  console.log(`[PASS] PATCH /runs/:id -> HTTP ${patchRun.status}`);
  console.log('[PASS] Run ID lifecycle verified: created, correlated, patched, and cleaned up.');
  console.log('[SUCCESS] LangSmith synthetic trace was successfully accepted by the remote endpoint.');
  process.exit(0);
}

runSmokeTest().catch((err) => {
  const rawApiKey = process.env.LANGSMITH_API_KEY?.trim();
  const safeErr = sanitizeSecretText(
    err instanceof Error ? err.message : String(err),
    rawApiKey ? [rawApiKey] : []
  );
  console.error(`[UNCAUGHT ERROR] ${safeErr}`);
  process.exit(1);
});
