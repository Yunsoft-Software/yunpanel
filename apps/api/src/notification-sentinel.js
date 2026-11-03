// Runs from a systemd timer, outside the API process, so an API that cannot start still
// produces an alert. Keep its imports minimal for the same reason.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname as readHostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuthMailer } from './auth-mailer.js';

const FAILURES_BEFORE_ALERT = 2;
const PROBE_TIMEOUT_MS = 10_000;

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeState(filePath, state) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, filePath);
}

export async function runSentinelCheck({
  targets, probe, notificationStore, stateFile, mailer, hostname = readHostname(), logger = console,
}) {
  const stored = readJson(stateFile);
  const state = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const address = readJson(notificationStore)?.alertAddress ?? null;

  async function send(subject, text) {
    if (!address) {
      logger.error?.(`[yunpanel-sentinel] no alert address: ${subject}`);
      return false;
    }
    try {
      await mailer.sendMail({ to: address, subject, text });
      return true;
    } catch (error) {
      logger.error?.(`[yunpanel-sentinel] alert could not be sent: ${error.message}`);
      return false;
    }
  }

  for (const target of targets) {
    const entry = state[target.id] ?? { failures: 0, alerted: false };
    if (await probe(target)) {
      if (entry.alerted) {
        const sent = await send(
          `[YunPanel] Düzeldi: ${target.label}`,
          `${hostname} sunucusunda ${target.label} yeniden yanıt veriyor.`,
        );
        entry.alerted = !sent;
      }
      entry.failures = 0;
    } else {
      entry.failures += 1;
      if (!entry.alerted && entry.failures >= FAILURES_BEFORE_ALERT) {
        entry.alerted = await send(
          `[YunPanel] Kesinti: ${target.label} yanıt vermiyor`,
          `${hostname} sunucusunda ${target.label} art arda ${entry.failures} kontrolde yanıt vermedi.\nDüzelince ayrıca haber verilecek.`,
        );
      }
    }
    state[target.id] = entry;
  }
  writeState(stateFile, state);
  return state;
}

async function probeHttp(target) {
  try {
    const response = await fetch(target.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' });
    return response.status < 500;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stateRoot = path.dirname(process.env.YUNPANEL_SERVER_STORE ?? '/var/lib/yunpanel/control-plane/server-registry.json');
  const apiHost = process.env.YUNPANEL_API_HOST ?? '127.0.0.1';
  const apiPort = process.env.YUNPANEL_API_PORT ?? '3001';
  const webHost = process.env.YUNPANEL_WEB_HOST ?? '127.0.0.1';
  const webPort = process.env.YUNPANEL_WEB_PORT ?? '4300';
  try {
    await runSentinelCheck({
      targets: [
        { id: 'api', label: 'Panel API', url: `http://${apiHost}:${apiPort}/api/health` },
        { id: 'web', label: 'Panel arayüzü', url: `http://${webHost}:${webPort}/` },
      ],
      probe: probeHttp,
      notificationStore: path.join(stateRoot, 'operational-notifications.json'),
      stateFile: path.join(stateRoot, 'notification-sentinel.json'),
      mailer: createAuthMailer(),
    });
  } catch (error) {
    console.error(`[yunpanel-sentinel] check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
