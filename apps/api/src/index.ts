/**
 * Kaizen API entrypoint.
 *
 * Boots the shared engine and serves REST + WebSocket on 127.0.0.1.
 * Ordinary startup NEVER downloads binaries (explicit-setup policy): a
 * missing binary surfaces as BINARY_NOT_AVAILABLE on network creation.
 */

import { createEngine } from '@kaizen/engine';
import { API_HOST, API_PORT, createServer } from './server';

async function main(): Promise<void> {
  const engine = createEngine();
  const app = createServer(engine);

  await app.listen({ host: API_HOST, port: API_PORT });
  console.log(`kaizen-api listening on http://${API_HOST}:${API_PORT}`);
  console.log(`  data dir: ${engine.dataDir}`);
  console.log(`  events  : ws://${API_HOST}:${API_PORT}/api/events`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down (running networks are left as daemons)`);
    void app
      .close()
      .then(() => engine.close())
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        console.error('shutdown error:', e);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
