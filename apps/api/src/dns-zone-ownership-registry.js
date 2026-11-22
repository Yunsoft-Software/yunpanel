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

function validStore(value) {
  return value?.version === STORE_VERSION && Array.isArray(value.receipts) && value.receipts.every(validReceipt);
}

// Proof that the panel itself created a DNS zone outside Website provisioning, which zone retirement
// requires before deleting it. A damaged store remains readable for legacy callers, but cannot prove
// the absence of ownership history.
export function createDnsZoneOwnershipRegistry({
  filePath = null,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  let receipts = [];
  let canProveAbsence = filePath === null;
  let queue = Promise.resolve();

  async function init() {
    if (filePath === null) return;
    let raw;
    try { raw = await readFile(filePath, 'utf8'); }
    catch (error) {
      canProveAbsence = error?.code === 'ENOENT';
      if (!canProveAbsence) logger.error(`[yunpanel-api] DNS zone ownership store unreadable: ${error?.code ?? 'error'}`);
      return;
    }
    try {
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored?.receipts)) throw new TypeError('receipts must be a list');
      canProveAbsence = validStore(stored);
      receipts = stored.receipts.filter(validReceipt).map((receipt) => Object.freeze({ ...receipt }));
    } catch (error) {
      canProveAbsence = false;
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
    async hasNoZoneHistory({ serverId, zoneName }) {
      await queue;
      const matches = (receipt) => receipt.serverId === serverId && receipt.zoneName === zoneName;
      if (!canProveAbsence || receipts.some(matches)) return false;
      if (filePath === null) return true;
      try {
        const current = JSON.parse(await readFile(filePath, 'utf8'));
        return validStore(current) && !current.receipts.some(matches);
      } catch (error) {
        return error?.code === 'ENOENT';
      }
    },
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
