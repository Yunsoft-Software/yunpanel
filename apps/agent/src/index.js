import { startControlPlaneLink } from './control-plane-client.js';
import { safeLegacyAgentDiagnosticCode } from './legacy-safe-error.js';
import { createAgentServer } from './server.js';

const host = process.env.YUN_AGENT_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.YUN_AGENT_PORT ?? '4010', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('YUN_AGENT_PORT must be a valid TCP port');
}

const controlPlaneLink = await startControlPlaneLink();
const server = createAgentServer();
server.listen(port, host, () => {
  console.log(`[yun-agent] listening on http://${host}:${port}`);
  console.log(`[yun-agent] mode=${process.env.YUN_AGENT_MODE ?? 'protected'}`);
  if (controlPlaneLink.enabled) {
    console.log(`[yun-agent] control plane linked as server ${controlPlaneLink.serverId}`);
  }
});

function shutdown(signal) {
  console.log(`[yun-agent] received ${signal}, shutting down`);
  controlPlaneLink.stop();
  server.close((error) => {
    if (error) {
      console.error(`[yun-agent] shutdown failed: ${safeLegacyAgentDiagnosticCode(error, 'shutdown_failed')}`);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
