#!/usr/bin/env node
/**
 * scripts/live-smoke-test.ts
 *
 * Dedicated live inference smoke test for Nebius Token Factory with NVIDIA Nemotron.
 *
 * SAFETY INVARIANT:
 * This script will NEVER consume inference credits or make network requests to
 * the Nebius API unless explicitly authorized by the operator via:
 *   --authorize-credits
 *   or AUTHORIZE_LIVE_CREDITS=true
 */

import { NebiusModelClient } from '@orchestrate/model';
import * as fs from 'node:fs';
import * as path from 'node:path';

function loadEnvFileIfPresent(): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      if (typeof (process as any).loadEnvFile === 'function') {
        (process as any).loadEnvFile(envPath);
      } else {
        const content = fs.readFileSync(envPath, 'utf8');
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isAuthorized =
    args.includes('--authorize-credits') || process.env.AUTHORIZE_LIVE_CREDITS === 'true';

  console.log('='.repeat(70));
  console.log('ORCHESTRATE — NEBIUS LIVE INFERENCE SMOKE TEST');
  console.log('Default Model: nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  console.log('Provider: Nebius Token Factory (https://api.tokenfactory.nebius.com/v1)');
  console.log('='.repeat(70));

  if (!isAuthorized) {
    console.log('\n[SAFETY GATE] Live inference authorization not provided.');
    console.log('Zero live requests were made; zero inference credits were spent.');
    console.log('\nTo run a single verified live call to Nebius Token Factory, re-run with:');
    console.log('  node --experimental-strip-types scripts/live-smoke-test.ts --authorize-credits');
    console.log('  or set AUTHORIZE_LIVE_CREDITS=true');
    console.log('='.repeat(70));
    process.exit(0);
  }

  loadEnvFileIfPresent();

  const apiKey = process.env.NEBIUS_API_KEY?.trim();
  if (!apiKey) {
    console.error('\n[ERROR] NEBIUS_API_KEY is not configured in environment or .env.');
    console.error('Please configure NEBIUS_API_KEY in your .env file or export it.');
    process.exit(1);
  }

  const modelId = process.env.NEBIUS_DEFAULT_MODEL?.trim() || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
  const maskedKey = apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '****';
  console.log(`\nAuthorized by operator. Initiating live inference call...`);
  console.log(`API Key: ${maskedKey}`);
  console.log(`Model Target: ${modelId}`);

  const client = new NebiusModelClient({
    apiKey,
    defaultModel: modelId,
  });

  const startTime = Date.now();
  try {
    const response = await client.complete({
      model: modelId,
      messages: [
        {
          role: 'user',
          content: 'Respond with exactly "ORCHESTRATE_NEMOTRON_ONLINE" and nothing else.',
        },
      ],
      maxTokens: 16,
      temperature: 0.0,
    });

    const elapsedMs = Date.now() - startTime;
    console.log('\n[LIVE INFERENCE SUCCESS]');
    console.log(`HTTP Status: 200 OK (Roundtrip: ${elapsedMs}ms)`);
    console.log(`Provider: ${response.provider}`);
    console.log(`Model: ${response.model}`);
    console.log(`Finish Reason: ${response.finishReason}`);
    console.log(`Response Content: ${JSON.stringify(response.message.content)}`);
    if (response.usage) {
      console.log(`Token Accounting:`);
      console.log(`  - Prompt Tokens:     ${response.usage.promptTokens}`);
      console.log(`  - Completion Tokens: ${response.usage.completionTokens}`);
      console.log(`  - Total Tokens:      ${response.usage.totalTokens}`);
    }
    console.log('='.repeat(70));
  } catch (err: unknown) {
    const elapsedMs = Date.now() - startTime;
    console.error(`\n[LIVE INFERENCE FAILED] (${elapsedMs}ms)`);
    console.error((err as Error).message);
    process.exit(1);
  }
}

main();
