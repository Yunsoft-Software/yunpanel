import { spawn } from 'node:child_process';

const processes = [
  { name: 'agent', args: ['run', 'dev:agent'] },
  { name: 'api', args: ['run', 'dev:api'] },
  { name: 'web', args: ['run', 'dev:web'] },
];

const children = new Map();
let shuttingDown = false;

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children.values()) {
    if (!child.killed) child.kill(signal);
  }
}

for (const processConfig of processes) {
  const child = spawn('npm', processConfig.args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      YUN_AGENT_MODE: process.env.YUN_AGENT_MODE ?? 'development',
    },
  });

  children.set(processConfig.name, child);

  child.on('error', (error) => {
    console.error(`[dev] ${processConfig.name} failed to start: ${error.message}`);
    process.exitCode = 1;
    stopAll();
  });

  child.on('exit', (code, signal) => {
    children.delete(processConfig.name);
    if (!shuttingDown && code !== 0) {
      console.error(`[dev] ${processConfig.name} exited unexpectedly (${signal ?? code})`);
      process.exitCode = code || 1;
      stopAll();
    }
  });
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
