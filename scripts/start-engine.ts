import { createEngineServer } from '@orchestrate/engine';
import { SqliteProjectBrain } from '@orchestrate/brain';
import fs from 'node:fs';
import path from 'node:path';

function loadEnvFileIfPresent(): void {
  const envFile = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    if (typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile(envFile);
      return;
    }
  } catch {
    // fallback to manual parsing
  }
  try {
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
  } catch {
    // Ignore read errors
  }
}

loadEnvFileIfPresent();

async function main() {
  const dbPath = process.env.ORCHESTRATE_DB_PATH || './orchestrate.sqlite';
  const port = Number(process.env.ORCHESTRATE_PORT || 3001);
  const host = process.env.ORCHESTRATE_HOST || '127.0.0.1';

  const brain = new SqliteProjectBrain({ databasePath: dbPath });
  const server = createEngineServer({
    brain,
    port,
    host,
    // ponytail: allow both localhost:3000 and 127.0.0.1:3000 origins during local dev
    corsOrigin: process.env.ORCHESTRATE_CORS_ORIGIN || '*',
  });

  const info = await server.start();
  const hasKey = Boolean(process.env.NEBIUS_API_KEY && process.env.NEBIUS_API_KEY.trim().length > 0);
  const defaultModel = process.env.NEBIUS_DEFAULT_MODEL || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
  console.log('===============================================================');
  console.log(' Orchestrate Engine API Server');
  console.log(` Listening on:   ${info.url}`);
  console.log(` SQLite Brain:   ${dbPath}`);
  console.log(` AI Provider:    Nebius Token Factory`);
  console.log(` Default Model:  ${defaultModel}`);
  console.log(` API Key Status: ${hasKey ? 'CONFIGURED (Real AI Inference Ready)' : 'MISSING (Configure in .env or Settings)'}`);
  console.log('===============================================================');

  const shutdown = async () => {
    console.log('\nShutting down Orchestrate Engine...');
    await server.stop();
    brain.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('Failed to start Orchestrate Engine:', err);
  process.exit(1);
});
