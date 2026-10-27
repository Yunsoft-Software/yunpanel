import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Records of tenant sites created through the automation API. A record is the
// ownership marker: only a hostname recorded here may be changed or removed by a key.
export function createTenantSiteStore({ filePath = null } = {}) {
  let state = { version: 1, sites: [] };
  let loaded = !filePath;

  async function load() {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.sites)) throw new Error('invalid');
      state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw Object.assign(new Error('Tenant site store is unreadable'), { code: 'tenant_site_store_invalid', status: 500 });
    }
    loaded = true;
  }

  async function persist() {
    if (!filePath) return;
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
  }

  const find = (hostname) => state.sites.find((site) => site.hostname === hostname) ?? null;

  return Object.freeze({
    async get(hostname) { await load(); const site = find(hostname); return site ? structuredClone(site) : null; },
    async put(site) {
      await load();
      state.sites = [...state.sites.filter((entry) => entry.hostname !== site.hostname), structuredClone(site)];
      await persist();
      return structuredClone(site);
    },
    async remove(hostname) { await load(); state.sites = state.sites.filter((entry) => entry.hostname !== hostname); await persist(); },
    async list(parentDomain) { await load(); return state.sites.filter((site) => site.parentDomain === parentDomain).map((site) => structuredClone(site)); },
  });
}
