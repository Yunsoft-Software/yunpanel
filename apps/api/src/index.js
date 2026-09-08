import { createApp } from './app.js';

const host = process.env.YUNPANEL_API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.YUNPANEL_API_PORT ?? '3001', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('YUNPANEL_API_PORT must be a valid TCP port');
}

const app = createApp();
const server = app.listen(port, host, () => {
  console.log(`[yunpanel-api] listening on http://${host}:${port}`);
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
