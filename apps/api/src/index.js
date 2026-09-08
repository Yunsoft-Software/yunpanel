import path from 'node:path';
import { createApp } from './app.js';
import { createServerRegistry } from './server-registry.js';

const host = process.env.YUNPANEL_API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.YUNPANEL_API_PORT ?? '3001', 10);
const serverStorePath = process.env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('YUNPANEL_API_PORT must be a valid TCP port');
}

const registry = createServerRegistry({ filePath: serverStorePath });
await registry.init();

const app = createApp({ registry });
const server = app.listen(port, host, () => {
  console.log(`[yunpanel-api] listening on http://${host}:${port}`);
  console.log(`[yunpanel-api] server store=${serverStorePath}`);
});

function shutdown(signal) {
  console.log(`[yunpanel-api] received ${signal}, shutting down`);
  server.close((error) => {
    if (error) {
      console.error('[yunpanel-api] shutdown failed', error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
