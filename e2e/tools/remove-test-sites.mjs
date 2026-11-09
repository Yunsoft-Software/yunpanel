// Removes leftover test Websites from the .28 test server through the panel's own removal flow.
// Never writes registries or touches the host directly, and never prints credentials.
//
//   node e2e/tools/remove-test-sites.mjs                 # list test sites (t<area><nn>[suffix]- or ypaudit-), change nothing
//   node e2e/tools/remove-test-sites.mjs --apply         # remove them
//   node e2e/tools/remove-test-sites.mjs --apply tweb05  # only names starting with tweb05
//
// A site whose Domain routing drifted (removal stops at routing_suspend with
// domain_removal_suspension_preview_stale) is repaired first with the panel's stage + activate.
// Run from the repository root; it reads the Owner login from .local like the e2e tests.
import { chromium } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

const ORIGIN = process.env.PLAYWRIGHT_BASE_URL || 'https://server.cryptoraichu.website';
// Feature tests name sites t<area><nn>[suffix]-… (tweb05nossl-, tweb06e-); live-audit uses ypaudit-.
const TEST_NAME = /^(t[a-z]{2,4}\d\d[a-z]*-|ypaudit-)/;
const apply = process.argv.includes('--apply');
const prefix = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ baseURL: ORIGIN, ignoreHTTPSErrors: true })).newPage();
await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
const csrf = (await (await page.request.get('/api/auth/session')).json()).data?.csrfToken;
const headers = { 'x-csrf-token': csrf, origin: ORIGIN };
const body = async (response) => { try { return await response.json(); } catch { return null; } };
const api = async (method, path, data) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await page.request.fetch(`/api/panel${path}`, { method, headers, data });
      return { status: response.status(), body: await body(response) };
    } catch (e) {
      if (attempt === 4) throw e;
      await page.waitForTimeout(1000 * (attempt + 1));
    }
  }
};
const listOf = (value) => (Array.isArray(value) ? value : value?.data ?? []);

async function waitJob(jobId) {
  for (let i = 0; jobId && i < 60; i += 1) {
    const job = (await api('GET', `/jobs/${jobId}`)).body?.data;
    if (job && !['queued', 'running'].includes(job.status)) return job.status;
    await page.waitForTimeout(2000);
  }
  return 'unknown';
}

async function repairRouting(domainId) {
  for (const action of ['stage', 'activate']) {
    const result = await api('POST', `/domains/${domainId}/${action}`, {});
    if (result.status >= 400) return `${action} ${result.body?.error?.code ?? result.status}`;
    const status = await waitJob(result.body?.data?.job?.id ?? result.body?.data?.id);
    if (status !== 'succeeded') return `${action} job ${status}`;
  }
  return null;
}

// The removal journal pauses after each host job; continue it step by step until it finishes.
async function removeWebsite(websiteId) {
  const preview = await api('GET', `/websites/${websiteId}/removal`);
  if (preview.status === 404) return null;
  const data = preview.body?.data ?? preview.body;
  let op = (data?.operations ?? []).find((candidate) => candidate.status !== 'removed') ?? null;
  if (!op) {
    if (!data?.preview?.readyToStart) return `preview: ${(data?.preview?.hardBlockers ?? []).join(',') || preview.status}`;
    const started = await api('POST', `/websites/${websiteId}/removal`,
      { previewDigest: data.preview.previewDigest, confirmation: data.preview.confirmation });
    if (started.status >= 400) return `start: ${started.body?.error?.code ?? started.status}`;
    op = started.body?.data?.operation ?? started.body?.data;
  }
  for (let round = 0; round < 80 && op?.status !== 'removed'; round += 1) {
    const step = op.steps?.find((candidate) => candidate.status !== 'succeeded');
    const failed = op.steps?.find((candidate) => ['blocked', 'failed'].includes(candidate.status));
    const confirmation = op.actions?.stepContinuationConfirmation;
    if (failed && !confirmation) return `${failed.kind}: ${failed.error?.code ?? failed.status}`;
    if (step && confirmation) {
      const next = await api('POST', `/website-removal-operations/${op.id}/continue`,
        { expectedUpdatedAt: op.updatedAt, stepId: step.id, confirmation });
      if (next.status < 400) { op = next.body?.data?.operation ?? next.body?.data; continue; }
      // A busy or stale answer means another sweep moved the journal; read it again.
      if (!['website_removal_busy', 'website_removal_step_continuation_stale'].includes(next.body?.error?.code)) {
        return `${step.kind}: ${next.body?.error?.code ?? next.status}`;
      }
    }
    await page.waitForTimeout(2000);
    op = (await api('GET', `/website-removal-operations/${op.id}`)).body?.data ?? op;
  }
  return op?.status === 'removed' ? null : 'did not finish';
}

const websites = listOf((await api('GET', '/websites')).body).filter((site) => TEST_NAME.test(site.name) && site.name.startsWith(prefix));
const domains = listOf((await api('GET', '/domains')).body);
console.log(`${websites.length} test site(s)${apply ? '' : ' (list only; pass --apply to remove)'}`);
let removed = 0;
for (const site of websites) {
  if (!apply) { console.log(' ', site.name); continue; }
  let failure = await removeWebsite(site.id);
  const domain = domains.find((candidate) => candidate.websiteId === site.id);
  if (failure && domain && /routing_suspend|domain_removal/.test(failure)) {
    const repair = await repairRouting(domain.id);
    failure = repair ? `repair ${repair}` : await removeWebsite(site.id);
  }
  if (failure) console.log('STUCK  ', site.name, failure);
  else { removed += 1; console.log('REMOVED', site.name); }
}
if (apply) console.log(`removed ${removed} of ${websites.length}`);
await browser.close();
