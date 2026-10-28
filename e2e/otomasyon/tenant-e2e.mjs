// End-to-end check of the automation API against the real .28 panel. Credentials and the
// API key are read/held in memory only and never printed.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const credentials = JSON.parse(readFileSync('/Volumes/DevSSD/Developer/Projects/Projeler/yunpanel/.local/yunpanel-owner-password-only.json', 'utf8'));
const base = new URL(credentials.url).origin;
const PARENT = '157-180-11-28.sslip.io';
const SLUG = 'ypt-e2e';
const HOST = `${SLUG}.${PARENT}`;
const PORT = 32050;
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cookie = '';
let csrf = '';
async function panel(method, path, body) {
  const response = await fetch(`${base}/api/panel${path}`, { method, headers: { origin: base, cookie, 'content-type': 'application/json',
    ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((value) => value.split(';')[0]).filter((value) => /session=/.test(value) && !value.endsWith('='));
  if (session.length) cookie = session.join('; ');
  return { status: response.status, body: await response.json().catch(() => null) };
}
let key = '';
async function automation(method, path, body) {
  const response = await fetch(`${base}/api/automation${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
}
function curl(args) {
  try { return execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url} %{ssl_verify_result}', '--max-time', '15', ...args], { encoding: 'utf8' }); }
  catch (error) { return `curl_failed ${error.status}`; }
}
async function until(predicate, label, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await automation('GET', `/tenant-sites/${SLUG}`);
    if (predicate(last)) return last;
    await sleep(3000);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last?.body)}`);
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); log(ok ? 'PASS' : 'FAIL', name, detail); };

const login = await panel('POST', '/auth/login', { username: credentials.username, password: credentials.password });
csrf = login.body?.data?.csrfToken ?? '';
check('owner login', login.status === 200 && Boolean(cookie) && Boolean(csrf), String(login.status));

const servers = await panel('GET', '/servers');
const serverId = servers.body?.data?.[0]?.id ?? servers.body?.data?.servers?.[0]?.id;
let parent = ((await panel('GET', '/domains')).body?.data ?? []).find((domain) => domain.primaryDomain === PARENT);
if (!parent) {
  const created = await panel('POST', '/domains', { serverId, primaryDomain: PARENT, targetType: 'redirect', target: { url: 'https://example.com' } });
  parent = created.body?.data;
  check('parent domain created', created.status === 201, String(created.status));
}

const keyResponse = await panel('POST', '/api-keys', { name: 'e2e provisioner', parentDomain: PARENT, portMin: 32000, portMax: 32999 });
key = keyResponse.body?.data?.token ?? '';
const keyId = keyResponse.body?.data?.key?.id;
check('api key created (shown once)', keyResponse.status === 201 && key.startsWith('ypk_'));
check('browser request refused', (await fetch(`${base}/api/automation/whoami`, { headers: { authorization: `Bearer ${key}`, origin: base } })).status === 403);

try {
  const put = await automation('PUT', `/tenant-sites/${SLUG}`, { upstreamPort: PORT });
  check('tenant create accepted', [200, 202].includes(put.status), `${put.status} ${put.body?.data?.state ?? put.body?.error?.code}`);
  const active = await until((r) => ['active', 'attention'].includes(r.body?.data?.state), 'provisioning');
  check('tenant active with certificate', active.body.data.state === 'active', JSON.stringify(active.body.data.steps));
  check('https serves the upstream with a valid certificate', curl([`https://${HOST}/`]).startsWith('200 ') && curl([`https://${HOST}/`]).endsWith(' 0'), curl([`https://${HOST}/`]));
  const issuer = execFileSync('bash', ['-c', `echo | openssl s_client -connect ${HOST}:443 -servername ${HOST} 2>/dev/null | openssl x509 -noout -issuer`], { encoding: 'utf8' }).trim();
  check("certificate is Let's Encrypt", /Let's Encrypt/i.test(issuer), issuer);

  for (const [state, extra, expect] of [['stopped', {}, '503'], ['archived', { redirectUrl: 'https://example.com/billing' }, '302 https://example.com/billing'], ['active', {}, '200']]) {
    const change = await automation('POST', `/tenant-sites/${SLUG}/state`, { state, ...extra });
    const done = await until((r) => ['active', 'attention'].includes(r.body?.data?.state) && r.body.data.mode === state, `mode ${state}`, 180_000);
    const answer = curl([`https://${HOST}/`]);
    check(`mode ${state}`, change.status < 300 && done.body.data.state === 'active' && answer.startsWith(expect), answer);
  }

  const removal = await automation('DELETE', `/tenant-sites/${SLUG}`);
  check('delete accepted', removal.status === 202 || removal.status === 200, `${removal.status} ${removal.body?.data?.state ?? removal.body?.error?.code}`);
  const removed = await until((r) => r.status === 404 || ['removed', 'attention'].includes(r.body?.data?.state), 'removal');
  check('tenant removed', removed.status === 404 || removed.body?.data?.state === 'removed', JSON.stringify(removed.body));
  check('name no longer served by the tenant', !curl([`https://${HOST}/`]).startsWith('200 '), curl([`https://${HOST}/`]));
  check('record gone', (await automation('GET', `/tenant-sites/${SLUG}`)).status === 404);
} finally {
  if (keyId) check('api key revoked', (await panel('DELETE', `/api-keys/${keyId}`)).status === 200);
  check('revoked key refused', (await automation('GET', '/whoami')).status === 401);
}
console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.name), parentId: parent?.id ?? null }));
