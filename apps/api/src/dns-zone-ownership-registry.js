import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;

function validReceipt(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && [value.operationId, value.serverId, value.webDomainId, value.zoneName, value.createdAt]
      .every((field) => typeof field === 'string' && field.length > 0));
}

function sameZone(receipt, { serverId, webDomainId, zoneName }) {
  return receipt.serverId === serverId && receipt.webDomainId === webDomainId && receipt.zoneName === zoneName;
}

// Proof that the panel itself created a DNS zone outside Website provisioning, which zone retirement
// requires before deleting it. A missing or unreadable receipt only keeps the zone protected, so a bad
// file is logged and treated as empty instead of stopping the API at startup.
export function createDnsZoneOwnershipRegistry({
  filePath = null,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  let receipts = [];
  let queue = Promise.resolve();

  async function init() {
    if (filePath === null) return;
    let raw;
    try { raw = await readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') logger.error(`[yunpanel-api] DNS zone ownership store unreadable: ${error?.code ?? 'error'}`);
      return;
    }
    try {
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored?.receipts)) throw new TypeError('receipts must be a list');
      receipts = stored.receipts.filter(validReceipt).map((receipt) => Object.freeze({ ...receipt }));
    } catch (error) {
      logger.error(`[yunpanel-api] DNS zone ownership store invalid: ${error?.name ?? 'error'}`);
    }
  }

  async function persist() {
    if (filePath === null) return;
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({ version: STORE_VERSION, receipts }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  }

  // Writes run one at a time so a concurrent request cannot lose another request's receipt.
  function serialized(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }

  return Object.freeze({
    init,
    getForZone: async (scope) => receipts.find((receipt) => sameZone(receipt, scope)) ?? null,
    recordCreated: ({ serverId, webDomainId, zoneName }) => serialized(async () => {
      const scope = { serverId, webDomainId, zoneName };
      const receipt = Object.freeze({ operationId: randomUUID(), ...scope, createdAt: now() });
      receipts = [...receipts.filter((entry) => !sameZone(entry, scope)), receipt];
      await persist();
      return receipt;
    }),
    removeForZone: ({ serverId, zoneName }) => serialized(async () => {
      const remaining = receipts.filter((receipt) => receipt.serverId !== serverId || receipt.zoneName !== zoneName);
      if (remaining.length === receipts.length) return;
      receipts = remaining;
      await persist();
    }),
  });
}
