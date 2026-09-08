import { createAgentServer } from './server.js';

const host = process.env.YUN_AGENT_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.YUN_AGENT_PORT ?? '4010', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('YUN_AGENT_PORT must be a valid TCP port');
}

const server = createAgentServer();
server.listen(port, host, () => {
  console.log(`[yun-agent] listening on http://${host}:${port}`);
  console.log(`[yun-agent] mode=${process.env.YUN_AGENT_MODE ?? 'development'}`);
});

function shutdown(signal) {
  console.log(`[yun-agent] received ${signal}, shutting down`);
  server.close((error) => {
    if (error) {
      console.error('[yun-agent] shutdown failed', error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
