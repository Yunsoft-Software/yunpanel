import { statfs } from 'node:fs/promises';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;

const percent = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

async function readRootDisk() {
  const stats = await statfs('/');
  // Same basis as df: space reserved for root is not available to sites.
  const usedBlocks = stats.blocks - stats.bfree;
  return [{
    mountPoint: '/',
    usagePercent: percent(usedBlocks, usedBlocks + stats.bavail),
    usedBytes: usedBlocks * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
    inodeUsagePercent: percent(stats.files - stats.ffree, stats.files),
    usedInodes: stats.files - stats.ffree,
    totalInodes: stats.files,
  }];
}

export function createOperationalNotificationSweep({
  service,
  readDisks = readRootDisk,
  logger = console,
} = {}) {
  let timer = null;
  let firstRun = null;
  let running = false;

  async function step(name, action) {
    try { await action(); }
    catch (error) { logger.error?.(`[operational-notifications] ${name} check failed:`, error.message); }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      await step('address', () => service.refreshAlertAddress());
      await step('certificate', () => service.checkCertificateExpirations());
      await step('disk', async () => service.checkDiskAndInodeThresholds({ disks: await readDisks() }));
    } finally {
      running = false;
    }
  }

  function start({ intervalMs = DEFAULT_INTERVAL_MS, firstRunDelayMs = FIRST_RUN_DELAY_MS } = {}) {
    stop();
    firstRun = setTimeout(() => { void runOnce(); }, firstRunDelayMs);
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    firstRun.unref?.();
    timer.unref?.();
  }

  function stop() {
    if (firstRun) clearTimeout(firstRun);
    if (timer) clearInterval(timer);
    firstRun = null;
    timer = null;
  }

  return Object.freeze({ runOnce, start, stop });
}
