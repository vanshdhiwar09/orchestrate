const EXPECTED_DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

async function main(): Promise<void> {
  console.log('=== Nebius Authentication Preflight ===');

  const apiKey = process.env.NEBIUS_API_KEY?.trim();
  const envBaseUrl = process.env.NEBIUS_BASE_URL?.trim();
  const rawBaseUrl = envBaseUrl || EXPECTED_DEFAULT_BASE_URL;

  let sanitizedBaseUrl = 'UNKNOWN';
  let cleanBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(cleanBaseUrl);
    sanitizedBaseUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    cleanBaseUrl = sanitizedBaseUrl;
  } catch {
    console.error('[FATAL] Configured base URL is not a valid URL.');
    process.exitCode = 1;
    return;
  }

  if (!apiKey) {
    console.error('[FATAL] NEBIUS_API_KEY is not defined.');
    process.exitCode = 1;
    return;
  }

  console.log(`[CONFIG] Base URL: ${sanitizedBaseUrl}`);
  console.log('[CONFIG] API Key: Configured');

  const endpoint = `${cleanBaseUrl}/models`;

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    console.log(`[PREFLIGHT] HTTP Status: ${response.status}`);

    if (response.ok) {
      let modelCount: number | undefined;
      try {
        const data = (await response.json()) as { data?: unknown[] };
        if (Array.isArray(data?.data)) {
          modelCount = data.data.length;
        }
      } catch {
        // Discard body on JSON parse failure; response was still HTTP 2xx
      }

      const countSnippet = modelCount !== undefined ? ` (${modelCount} model(s) available)` : '';
      console.log(`[PREFLIGHT] Result: SUCCESS${countSnippet}`);
      process.exitCode = 0;
    } else {
      console.error('[PREFLIGHT] Result: FAILED (Authentication/Access Rejected)');
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    if (isTimeout) {
      console.error('[PREFLIGHT] Result: FAILED (Request Timed Out)');
    } else {
      console.error('[PREFLIGHT] Result: FAILED (Network/Connection Error)');
    }
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.error('[UNCAUGHT ERROR] Preflight encountered an unexpected error.');
  process.exitCode = 1;
});
