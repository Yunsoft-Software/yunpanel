import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, apiContext, ready, main, RUN_DIR } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const KEY = 'YP_T887_ENV_PROOF';
const source = { kind: 'new_node', repositoryUrl: 'https://github.com/heroku/node-js-getting-started.git', branch: 'main', retention: 2,
  runtime: { nodeMajor: 24, installMode: 'ci', buildScript: null, startMode: 'node', entryFile: 'index.js', healthPath: '/', healthTimeoutSeconds: 30, restartPolicy: 'on-failure' } };
const hash = value => createHash('sha256').update(value).digest('hex');
const accepted = (result, status = 200) => { expect(result.status, result.body?.error?.code).toBe(status); return result.data; };
async function uploadOwned(fixture, filename, value) {
  try { await fixture.upload(filename, value); }
  catch (error) {
    if (error.code !== 'owned_fixture_transport') throw error;
    let readback;
    try { readback = await fixture.readText(filename); }
    catch { fixture.record('files.upload.unconfirmed', { filename, receiptKnown: false }); throw error; }
    const sha256 = hash(value);
    expect(readback.sha256).toBe(sha256); expect(readback.content).toBe(Buffer.from(value).toString('utf8'));
    fixture.record('files.upload.reconciled', { filename, sha256, receiptKnown: false, actualContentVerified: true });
  }
}
// A missing mutation reply or an unread/mismatched operation is sticky KEEP.
// Entries exist before POST and survive until terminal identity AND content proof.
let native18StickyHold = false, native18CaseActive = false;
const native18Operations = new Map();
const native18Uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const native18Sha = /^[a-f0-9]{64}$/;
const operationFields = ['id', 'websiteId', 'serverId', 'repositoryId', 'jobId', 'kind', 'previewDigest', 'include', 'createdAt'];
const jobFields = ['id', 'serverId', 'type', 'operation', 'resourceType', 'resourceId', 'createdAt'];
const select = (value, fields) => Object.fromEntries(fields.map(key => [key, value?.[key]]));
function knownOperation(operation) {
  const matches = [...native18Operations.values()].filter(value => value.accepted?.id === operation?.id);
  expect(matches, 'An operation must belong to exactly one pre-POST owned intent').toHaveLength(1); return matches[0];
}
function operationBinding(operation, record) {
  expect(select(operation, operationFields)).toEqual(record.accepted);
  if (record.intent.kind === 'restore') expect(operation.snapshotId).toBe(record.intent.snapshotId);
  else if (record.acceptedSnapshotId !== null) expect(operation.snapshotId).toBe(record.acceptedSnapshotId);
}
function jobBinding(job, record) { expect(select(job, jobFields)).toEqual(record.job); }
async function queuedOperation(fixture, input, preview, expectedEnvironmentHash = null) {
  expect(native18StickyHold, 'UNKNOWN_KEEP forbids another operation mutation').toBe(false);
  expect(native18Operations.size, 'Prior owned operation must be fully reconciled before another POST').toBe(0);
  const kind = input.kind; expect(['backup', 'restore']).toContain(kind);
  expect(input.repositoryId).toMatch(native18Uuid); expect(input.expectedPreviewDigest).toMatch(native18Sha);
  expect(input.expectedPreviewDigest).toBe(kind === 'backup' ? preview.backupSetDigest : preview.previewDigest);
  if (kind === 'restore') { expect(input.snapshotId).toMatch(native18Sha); expect(input.snapshotId).toBe(preview.snapshotId); expect(expectedEnvironmentHash).toMatch(native18Sha); }
  else expect(expectedEnvironmentHash).toBe(null);
  const intent = Object.freeze({ websiteId: fixture.ledger.websiteId, applicationId: fixture.ledger.applicationId,
    serverId: fixture.ledger.serverId, repositoryId: input.repositoryId, kind, snapshotId: input.snapshotId ?? null,
    previewDigest: input.expectedPreviewDigest, include: Object.freeze([...(input.include ?? [])]), expectedEnvironmentHash });
  const intentId = randomBytes(16).toString('hex'), record = { intentId, intent, accepted: null, job: null, terminal: null,
    resolvedInclude: kind === 'restore' ? Object.freeze([...preview.include]) : null };
  native18Operations.set(intentId, record);
  fixture.record('node.backup.operation-intent', { intentId, intent });
  try {
    const operation = accepted(await fixture.call('POST', fixture.endpoint('/backup-operations'), input), 202);
    expect(operation.id).toMatch(native18Uuid); expect(operation.jobId).toMatch(native18Uuid);
    expect(Number.isFinite(Date.parse(operation.createdAt))).toBe(true);
    expect(select(operation, ['websiteId', 'serverId', 'repositoryId', 'kind', 'previewDigest', 'include'])).toEqual(select(intent, ['websiteId', 'serverId', 'repositoryId', 'kind', 'previewDigest', 'include']));
    if (kind === 'restore') expect(operation.snapshotId).toBe(intent.snapshotId);
    else if (operation.snapshotId !== null) expect(operation.snapshotId).toMatch(native18Sha);
    record.accepted = Object.freeze({ ...select(operation, operationFields), include: Object.freeze([...operation.include]) });
    record.acceptedSnapshotId = operation.snapshotId;
    fixture.record('node.backup.operation-accepted', { intentId, accepted: record.accepted, snapshotId: operation.snapshotId });
    const job = accepted(await fixture.call('GET', '/api/panel/jobs/' + operation.jobId));
    expect(Number.isFinite(Date.parse(job.createdAt))).toBe(true);
    record.job = Object.freeze({ id: operation.jobId, serverId: intent.serverId, type: 'website.backup.action', operation: 'website.backup.action', resourceType: 'backup', resourceId: operation.id, createdAt: job.createdAt });
    jobBinding(job, record); fixture.record('node.backup.job-bound', { intentId, ...record.job }); return operation;
  } catch (error) { native18StickyHold = true; throw error; }
}
async function finished(fixture, operation) {
  try {
    const record = knownOperation(operation); operationBinding(operation, record);
    const job = await fixture.waitJob(operation.jobId, 180000); expect(job.status).toBe('succeeded');
    jobBinding(job, record); expect(job.error).toBe(null);
    const result = accepted(await fixture.call('GET', fixture.endpoint('/backup-operations/' + operation.id)));
    expect(result.status, result.error?.code).toBe('succeeded');
    operationBinding(result, record); expect(result.error).toBe(null);
    expect(result.result).not.toBe(null); expect(result.result.status).toBe('succeeded'); expect(result.result.websiteId).toBe(record.intent.websiteId);
    expect(result.snapshotId).toMatch(native18Sha);
    if (record.intent.kind === 'backup') {
      expect(result.result.repositoryId).toBe(record.intent.repositoryId); expect(result.result.backupSetDigest).toBe(record.intent.previewDigest);
      expect(result.result.snapshot?.snapshotId).toBe(result.snapshotId); expect(result.preRestoreSnapshotId).toBe(null);
    } else {
      expect(result.result.snapshotId).toBe(record.intent.snapshotId); expect(result.preRestoreSnapshotId).toMatch(native18Sha);
      expect(result.result.preRestoreSnapshotId).toBe(result.preRestoreSnapshotId); expect(result.result.healthCheck?.satisfied).toBe(true);
      expect(result.result.include).toEqual(record.resolvedInclude); expect(result.result.selective).toBe(true);
    }
    // A succeeded wrapper job may carry rolled_back. This happy path requires
    // the operation and public result to be succeeded as separate assertions.
    expect(job.result).toEqual({ version: 1, operationId: result.id, websiteId: record.intent.websiteId, repositoryId: record.intent.repositoryId,
      kind: record.intent.kind, status: result.status, snapshotId: result.snapshotId, preRestoreSnapshotId: result.preRestoreSnapshotId,
      verified: true, sideEffects: true });
    record.terminal = Object.freeze({ snapshotId: result.snapshotId, preRestoreSnapshotId: result.preRestoreSnapshotId, status: result.status });
    fixture.record('node.backup.operation-terminal-bound', { intentId: record.intentId, operationId: result.id, jobId: job.id,
      operationKind: record.intent.kind, operationStatus: result.status, jobStatus: job.status, snapshotId: result.snapshotId, contentProofPending: true });
    return result;
  } catch (error) { native18StickyHold = true; throw error; }
}
function operationContentVerified(fixture, operation, content) {
  try {
    const record = knownOperation(operation); expect(native18StickyHold).toBe(false); expect(record.terminal?.status).toBe('succeeded');
    if (record.intent.kind === 'backup') expect(content.snapshotId).toBe(record.terminal.snapshotId);
    else {
      expect(content.environmentHash).toBe(record.intent.expectedEnvironmentHash); expect(content.uid).toBeGreaterThan(0);
      expect(content.hostProcess.pid).toBe(content.pid); expect(content.hostProcess.uid).toBe(content.uid); expect(content.hostProcess.cwd).toBe(content.cwd);
      expect(content.hostProcess.proofSha256).toBe(content.environmentHash); expect(content.noStore).toBe(true);
      expect(content.actualNodeVersion).toMatch(/^v24\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/); expect(content.processInstanceId).toMatch(/^[a-f0-9]{32}$/);
    }
    fixture.record('node.backup.operation-content-verified', { intentId: record.intentId, operationId: record.accepted.id, jobId: record.job.id,
      operationKind: record.intent.kind, snapshotId: record.terminal.snapshotId, ...(record.intent.kind === 'restore' ? { environmentHash: content.environmentHash, pid: content.pid, processInstanceId: content.processInstanceId } : {}) });
    native18Operations.delete(record.intentId);
  } catch (error) { native18StickyHold = true; throw error; }
}

// This delegates the actual Owner API client; it never supplies or changes a reply.
// The gate and real fetch invocation execute in one JS turn with no intervening await.
let native18DispatchPhase = 'work', native18CleanupAuthorized = false;
const native18StartedCases = new Set(), native18CompletedCases = new Set(), native18ForwardIntents = new Map();
function native18DispatchArtifact(id, suffix, value) {
  expect(fs.realpathSync(RUN_DIR)).toBe(RUN_DIR);
  const root = fs.lstatSync(RUN_DIR); expect(root.isDirectory()).toBe(true); expect(root.isSymbolicLink()).toBe(false);
  expect(root.uid).toBe(process.getuid()); expect(root.mode & 0o777).toBe(0o700);
  const name = RUN_DIR + '/native18-dispatch-' + id + '-' + suffix + '.json';
  const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { const meta = fs.fstatSync(fd); expect(meta.isFile()).toBe(true); expect(meta.uid).toBe(process.getuid()); expect(meta.nlink).toBe(1); expect(meta.mode & 0o777).toBe(0o600);
    const bytes = Buffer.from(JSON.stringify(value)); expect(bytes.length).toBeLessThan(4096); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); expect(fs.fstatSync(fd).size).toBe(bytes.length);
  } finally { fs.closeSync(fd); }
  const directory = fs.openSync(RUN_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function native18SynchronousDispatchGate(method, route) {
  try {
    expect(native18StickyHold, 'UNKNOWN_KEEP forbids any subsequent mutation dispatch').toBe(false);
    expect([...native18ForwardIntents.values()].every(value => value.responseKnown), 'Every prior actual mutation dispatch must have a known HTTP response').toBe(true);
    if (native18DispatchPhase === 'work') {
      expect(native18CaseActive, 'A late continuation cannot dispatch after the active case ended').toBe(true);
      if (native18Operations.size) {
        const pending = [...native18Operations.values()]; expect(pending).toHaveLength(1);
        expect(pending[0].accepted).toBe(null); expect(method).toBe('POST');
        expect(route).toBe('/api/panel/websites/' + pending[0].intent.websiteId + '/backup-operations');
      }
    } else {
      expect(native18DispatchPhase).toBe('cleanup'); expect(native18CleanupAuthorized).toBe(true);
      expect(native18CaseActive).toBe(false); expect(native18Operations.size).toBe(0);
      expect([...native18StartedCases].every(value => native18CompletedCases.has(value))).toBe(true);
      const allowed = method === 'POST' && (/^\/api\/panel\/websites\/[a-f0-9-]{36}\/removal$/.test(route) || /^\/api\/panel\/website-removal-operations\/ws-rem-[a-f0-9-]{36}\/continue$/.test(route))
        || method === 'DELETE' && /^\/api\/panel\/backups\/repositories\/[a-f0-9-]{36}$/.test(route);
      expect(allowed, 'Only the existing exact normal owned-fixture removal flow is authorized in afterAll').toBe(true);
    }
  } catch (error) { native18StickyHold = true; throw error; }
}
function native18BeginDispatch(method, endpoint) {
  const route = String(endpoint).split('?')[0]; expect(route.startsWith('/api/')).toBe(true);
  native18SynchronousDispatchGate(method, route);
  const id = randomBytes(12).toString('hex'), intent = Object.freeze({ version: 1, id, method, route, phase: native18DispatchPhase, issuedAt: new Date().toISOString() });
  const record = { intent, responseKnown: false, status: null }; native18ForwardIntents.set(id, record);
  native18DispatchArtifact(id, 'intent', intent); return record;
}
function native18DispatchResponse(record, response) {
  const status = response.status(); expect(Number.isSafeInteger(status)).toBe(true);
  native18DispatchArtifact(record.intent.id, 'response', { version: 1, id: record.intent.id, status, observedAt: new Date().toISOString() });
  record.status = status; record.responseKnown = true; return response;
}
function native18DispatchUnknown(record) {
  native18StickyHold = true;
  native18DispatchArtifact(record.intent.id, 'unknown', { version: 1, id: record.intent.id, observedAt: new Date().toISOString(), outcome: 'UNKNOWN_KEEP' });
}
function native18GuardOwnerContext(context) {
  const actual = context.api;
  const guarded = new Proxy(actual, { get(target, key) {
    const value = Reflect.get(target, key, target); if (typeof value !== 'function') return value;
    if (!['fetch', 'post', 'put', 'patch', 'delete'].includes(key)) return value.bind(target);
    return (...args) => {
      const method = key === 'fetch' ? String(args[1]?.method ?? 'GET').toUpperCase() : String(key).toUpperCase();
      if (['GET', 'HEAD'].includes(method)) return value.apply(target, args);
      const record = native18BeginDispatch(method, args[0]);
      // No await, timer, request rewrite or substitute transport between gate and delegation.
      try { return value.apply(target, args).then(response => native18DispatchResponse(record, response), error => { native18DispatchUnknown(record); throw error; }); }
      catch (error) { native18DispatchUnknown(record); throw error; }
    };
  } });
  return { ...context, api: guarded };
}
function native18BeginWork(name) {
  expect(native18StickyHold).toBe(false); expect(native18DispatchPhase).toBe('work'); expect(native18CaseActive).toBe(false);
  native18StartedCases.add(name); native18CaseActive = true;
}
function native18CompleteWork(name) {
  expect(native18StickyHold).toBe(false); expect(native18CaseActive).toBe(true); expect(native18Operations.size).toBe(0);
  expect([...native18ForwardIntents.values()].every(value => value.responseKnown)).toBe(true);
  native18CompletedCases.add(name); native18CaseActive = false;
}

test.describe('T887 real dedicated Node provisioning and environment restore', () => {
  let actor, fixture, projectName; const keys = new Set();
  test.beforeAll(async ({}, info) => { projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = native18GuardOwnerContext(await apiContext()); });
  test.afterAll(async () => {
    if (native18StickyHold || native18CaseActive || native18Operations.size) { native18StickyHold = true; await actor?.api.dispose(); throw new Error('UNKNOWN_KEEP: native18 operation/content reconciliation is incomplete; no repository or Website cleanup'); }
    expect([...native18StartedCases].every(value => native18CompletedCases.has(value))).toBe(true);
    expect([...native18ForwardIntents.values()].every(value => value.responseKnown)).toBe(true);
    native18DispatchPhase = 'cleanup'; native18CleanupAuthorized = true;
    const failures = [];
    for (const key of [...keys].reverse()) try {
      const ledger = fixture?.ledger.key === key ? await fixture.cleanup() : await cleanupOwnedFixture(actor, { key });
      const absent = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
      expect(absent.unixUserExists).toBe(false); expect(absent.unixGroupExists).toBe(false);
      expect(absent.roots.every(value => !value.exists)).toBe(true); expect(absent.nginxFiles.every(value => !value.exists)).toBe(true);
      expect(absent.fpmFiles).toEqual([]); expect(absent.sockets).toEqual([]); expect(absent.mounts).toEqual([]);
      expect(absent.passengerEnvironmentInclude.path).toBe('/etc/yunpanel/passenger-env/' + ledger.applicationId + '.conf');
      expect(absent.passengerEnvironmentInclude.parentTrustVerified).toBe(true); expect(absent.passengerEnvironmentInclude.exists).toBe(false);
    } catch (error) { native18StickyHold = true; failures.push(error.message); }
    native18DispatchPhase = 'closed'; native18CleanupAuthorized = false;
    await actor?.api.dispose(); expect(failures, 'Every exact owned Node ledger must be cleaned').toEqual([]);
  });

  test('@mutation normal Node form provisions one dedicated real Passenger application from the current public sample', async ({ page }) => {
    test.setTimeout(480000); native18BeginWork('provision');
    const key = 't887-node-environment-' + projectName; keys.add(key);
    fixture = await createOwnedFixture(actor, { key, runtime: 'node', source,
      create: async (input, preview, recordInput) => {
        void preview;
        await ready(page, '/websites/new'); await page.getByLabel('Alan adı', { exact: true }).fill(input.primaryDomain);
        await page.getByLabel(/^www davranışı/).selectOption('none');
        await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
        await page.getByLabel('Site türü', { exact: true }).selectOption('new_node');
        await page.getByLabel('GitHub repository', { exact: true }).fill(source.repositoryUrl);
        await page.getByLabel('Branch', { exact: true }).fill(source.branch);
        await page.getByLabel('Başlangıç dosyası', { exact: true }).fill(source.runtime.entryFile);
        await page.getByLabel('Sağlık kontrolü yolu', { exact: true }).fill('/');
        const database = page.getByRole('checkbox', { name: /otomatik veritabanı oluştur/ });
        if (await database.count()) await database.uncheck();
        await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
        await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('local');
        await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
        await page.getByRole('checkbox', { name: /E-posta ve Webmail etkinleştir/ }).uncheck();
        const pattern = '**/api/panel/sites'; let nodeUIRequestIntent;
        const observe = async route => {
          if (route.request().method() === 'POST') {
            const body = route.request().postDataJSON(); recordInput(body.input ?? body);
            nodeUIRequestIntent = native18BeginDispatch('POST', '/api/panel/sites');
          }
          await route.continue();
        };
        await page.route(pattern, observe);
        try {
          const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/panel/sites' && response.request().method() === 'POST');
          await main(page).getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
          const response = await pending; expect([200, 201]).toContain(response.status());
          const body = await response.json(); native18DispatchResponse(nodeUIRequestIntent, response); return body.data;
        } finally { await page.unroute(pattern, observe); }
      },
    });
    const target = fixture.ledger;
    const operation = accepted(await fixture.call('GET', '/api/panel/sites/provisioning/' + target.provisioningId));
    expect(operation.ready).toBe(true); expect(['failed', 'blocked']).not.toContain(operation.status);
    const domains = accepted(await fixture.call('GET', fixture.endpoint('/domains'))), domain = domains.find(value => value.primaryDomain === target.hostname);
    expect(domain.websiteId).toBe(target.websiteId); expect(domain.id).toBe(target.domainId);
    const application = accepted(await fixture.call('GET', '/api/panel/applications/' + target.applicationId));
    expect(application.state).toBe('active'); expect(application.currentCommitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(application.runtimeAdapter).toBe('passenger'); expect(application.activeRuntime.port).toBe(null);
    const websites = accepted(await fixture.call('GET', '/api/panel/websites'));
    expect(websites.filter(value => value.name === target.hostname)).toHaveLength(1);
    expect(websites.filter(value => value.unixUser === target.unixUser).map(value => value.id)).toEqual([target.websiteId]);
    const identity = await readOnlyHostProbe(fixture, 'owned-site-files'); expect(identity.unixUid).toBeGreaterThan(0);
    expect(identity.indexJsFile.uid).toBe(identity.unixUid);
    const actual = await fixture.http('/'); expect(actual.status).toBe(200); expect(actual.body.toLowerCase()).toContain('node');
    await ready(page, fixture.route('node')); expect(page.auditErrors).toEqual([]);
    fixture.record('node.normal-form.real-provision', { verified: true, observedCommitSha: application.currentCommitSha, runtimeAdapter: 'passenger' });
    native18CompleteWork('provision');
  });

  test('@mutation same snapshot restores a secret twice in the actual dedicated running Node process', async () => {
    test.setTimeout(480000); native18BeginWork('environment-restore');
    if (!fixture) {
      const key = 't887-node-environment-api-' + projectName; keys.add(key);
      fixture = await createOwnedFixture(actor, { key, runtime: 'node', source });
    }
    expect(fixture.ledger.applicationId).toBeTruthy();
    const target = fixture.ledger, probePath = '/yp-t887-proof-' + randomBytes(16).toString('hex');
    const packageFile = await fixture.readText('package.json'); expect(typeof packageFile.content).toBe('string');
    const packageJson = JSON.parse(packageFile.content);
    const imports = packageJson.type === 'module'
      ? "import {createServer} from 'node:http'; import {createHash,randomBytes} from 'node:crypto'; import {realpathSync} from 'node:fs';"
      : "const {createServer}=require('node:http'),{createHash,randomBytes}=require('node:crypto'),{realpathSync}=require('node:fs');";
    // This is an actual owned Node application. Every returned field is read
    // from its running process, and only one secret's SHA-256 is exposed.
    const entry = imports + '\nconst processInstanceId=randomBytes(16).toString("hex");\ncreateServer((request,response)=>{response.setHeader("Cache-Control","no-store");'
      + 'const proofURL=new URL(request.url,"http://localhost");if(proofURL.pathname===' + JSON.stringify(probePath) + '){response.setHeader("Content-Type","application/json");response.end(JSON.stringify({'
      + 'uid:process.getuid(),cwd:realpathSync(process.cwd()),pid:process.pid,node:process.version,processInstanceId,requestNonce:proofURL.searchParams.get("nonce"),'
      + 'environmentHash:createHash("sha256").update(process.env.' + KEY + '??"").digest("hex")}));}'
      + 'else{response.setHeader("Content-Type","text/plain");response.end("Node T887 actual owned runtime");}}).listen(process.env.PORT||3000);\n';
    fixture.record('node.actual-runtime-proof.intent', { entryFile: source.runtime.entryFile, proofPath: probePath, variableName: KEY, entrySha256: hash(entry), requestedNodeMajor: source.runtime.nodeMajor });
    expect(native18StickyHold, 'UNKNOWN_KEEP forbids upload after a lost test context').toBe(false);
    await uploadOwned(fixture, source.runtime.entryFile, entry);
    let previousProcessProof;
    async function proof(expectedHash, transitionKind) {
      expect(['normal-restart', 'snapshot-environment-restore']).toContain(transitionKind);
      const requestNonce = randomBytes(16).toString('hex');
      let observed, proofResponse;
      await expect.poll(async () => {
        const response = await fixture.http(probePath + '?nonce=' + requestNonce); proofResponse = response;
        if (response.status !== 200) return 'http:' + response.status;
        try { observed = JSON.parse(response.body); return observed.environmentHash; } catch { return 'not-json'; }
      }, { timeout: 60000, intervals: [500, 1000] }).toBe(expectedHash);
      const application = accepted(await fixture.call('GET', '/api/panel/applications/' + target.applicationId));
      const status = accepted(await fixture.call('GET', '/api/panel/applications/' + target.applicationId + '/environment/status'));
      const identity = await readOnlyHostProbe(fixture, 'node-environment');
      expect(observed.requestNonce).toBe(requestNonce);
      expect(String(proofResponse.headers['cache-control']).split(',').map(value => value.trim().toLowerCase())).toContain('no-store');
      expect(Number.isSafeInteger(observed.pid)).toBe(true); expect(observed.pid).toBeGreaterThan(1);
      expect(observed.node).toMatch(/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/);
      expect(Number(observed.node.slice(1).split('.')[0])).toBe(source.runtime.nodeMajor);
      expect(observed.processInstanceId).toMatch(/^[a-f0-9]{32}$/);
      const matchingProcesses = identity.processes.filter(value => value.pid === observed.pid);
      expect(matchingProcesses, 'The HTTP PID must name the same dedicated Node process read from /proc').toHaveLength(1);
      const hostProcess = matchingProcesses[0];
      expect(hostProcess.uid).toBe(observed.uid); expect(hostProcess.cwd).toBe(observed.cwd);
      expect(hostProcess.proofSha256).toBe(expectedHash); expect(hostProcess.proofSha256).toBe(observed.environmentHash);
      expect(observed.uid).toBeGreaterThan(0); expect(observed.uid).toBe(identity.unixUid);
      expect(observed.cwd).toBe(identity.resolvedRoot); expect(identity.currentSymlink).toBe(true);
      expect(identity.currentLinkTarget).toBe('releases/' + application.currentReleaseId);
      expect(status.savedRevision).toBe(status.appliedRevision); expect(status.appliedReleaseId).toBe(application.currentReleaseId);
      expect(status.appliedToRunningProcess).toBe(true);
      expect(identity.environmentIncludeApplicationId).toBe(target.applicationId); expect(identity.environmentIncludeRevision).toBe(status.savedRevision);
      expect((await fixture.http('/')).status).toBe(200);
      // The instance ID is created once by the actual application at startup.
      // A recycled PID is permitted; a normal restart must replace the instance.
      const processTransition = previousProcessProof ? { kind: transitionKind, previousPid: previousProcessProof.pid,
        previousProcessInstanceId: previousProcessProof.processInstanceId, pidChanged: observed.pid !== previousProcessProof.pid } : null;
      if (previousProcessProof) expect(observed.processInstanceId, 'The completed normal restart/restore must replace the prior application instance').not.toBe(previousProcessProof.processInstanceId);
      previousProcessProof = { pid: observed.pid, processInstanceId: observed.processInstanceId };
      return { verified: true, uid: observed.uid, cwd: observed.cwd, environmentHash: observed.environmentHash, releaseId: application.currentReleaseId, revision: status.savedRevision,
        pid: observed.pid, actualNodeVersion: observed.node, requestedNodeMajor: source.runtime.nodeMajor, processInstanceId: observed.processInstanceId,
        requestNonce, noStore: true, hostProcess, processTransition };
    }
    let environmentWrites = 0;
    async function setAndRestart(value) {
      expect(native18StickyHold, 'UNKNOWN_KEEP forbids another environment mutation').toBe(false); expect(native18Operations.size).toBe(0);
      const environmentPath = '/api/panel/applications/' + target.applicationId + '/environment';
      const before = accepted(await fixture.call('GET', environmentPath + '/status'));
      if (environmentWrites === 0) expect(accepted(await fixture.call('GET', environmentPath)).some(item => item.key === KEY)).toBe(false);
      let receiptKnown = true;
      try { accepted(await fixture.call('PUT', environmentPath + '/' + KEY, { value, secret: true })); }
      catch (error) { if (error.code !== 'owned_fixture_transport') throw error; receiptKnown = false; }
      let saved;
      await expect.poll(async () => {
        saved = accepted(await fixture.call('GET', environmentPath + '/status')); return saved.savedRevision;
      }, { timeout: 5000, intervals: [200, 500] }).toBe(before.savedRevision + 1);
      const masked = accepted(await fixture.call('GET', environmentPath)).find(item => item.key === KEY);
      expect(masked?.secret === true).toBe(true); expect(masked?.hasValue === true).toBe(true);
      expect(masked?.value !== undefined, 'The API must never return the protected value').toBe(false);
      environmentWrites++;
      if (!receiptKnown) fixture.record('node.environment.save-reconciled', { receiptKnown: false, savedRevision: saved.savedRevision, maskedKeyObserved: true });
      const jobsPath = '/api/panel/jobs?resourceType=application&resourceId=' + target.applicationId;
      const priorIds = new Set(accepted(await fixture.call('GET', jobsPath)).map(job => job.id));
      let queued;
      expect(native18StickyHold, 'UNKNOWN_KEEP forbids restart after a lost test context').toBe(false);
      try { queued = accepted(await fixture.call('POST', fixture.endpoint('/application/restart'), {}), 202); }
      catch (error) {
        if (error.code !== 'owned_fixture_transport') throw error;
        let matches;
        await expect.poll(async () => {
          matches = accepted(await fixture.call('GET', jobsPath)).filter(job => !priorIds.has(job.id) && job.type === 'app.node.restart'); return matches.length;
        }, { timeout: 5000, intervals: [200, 500] }).toBe(1);
        queued = matches[0]; fixture.record('node.restart.reconciled', { receiptKnown: false, jobId: queued.id, savedRevision: saved.savedRevision });
      }
      expect((await fixture.waitJob(queued.id, 180000)).status).toBe('succeeded'); return proof(hash(value), 'normal-restart');
    }
    const originalSecret = randomBytes(32).toString('base64url'); let repository, failure;
    try {
      fixture.record('node.environment.original-process', await setAndRestart(originalSecret));
      const name = 'ypaudit-t887-env-' + target.nonce; fixture.record('backup.repository.intent', { name, websiteId: target.websiteId });
      expect(native18StickyHold).toBe(false);
      repository = accepted(await fixture.call('POST', '/api/panel/backups/repositories', { name, backend: 'local', password: randomBytes(36).toString('base64url'), initialize: false }), 201);
      fixture.record('backup.repository.owned', { repositoryId: repository.id, target: repository.target, name }); expect(repository.status).toBe('uninitialized');
      expect(native18StickyHold).toBe(false);
      const initialized = accepted(await fixture.call('POST', '/api/panel/backups/repositories/' + repository.id + '/init', {})); expect(initialized.status).toBe('ready');
      expect(native18StickyHold).toBe(false);
      accepted(await fixture.call('POST', '/api/panel/backups/repositories/' + repository.id + '/check', {}));
      expect(accepted(await fixture.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe('ready');
      fixture.record('backup.repository.explicit-init-check', { verified: true, repositoryId: repository.id });
      const preview = accepted(await fixture.call('POST', fixture.endpoint('/backup/preview'), { repositoryId: repository.id }));
      const backup = await queuedOperation(fixture, { kind: 'backup', repositoryId: repository.id, expectedPreviewDigest: preview.backupSetDigest, confirmation: preview.confirmation, tags: ['t887-node-env-' + target.nonce] }, preview);
      const snapshotId = (await finished(fixture, backup)).result?.snapshot?.snapshotId; expect(snapshotId).toMatch(/^[a-f0-9]{64}$/); operationContentVerified(fixture, backup, { snapshotId });
      fixture.record('backup.snapshot.owned', { repositoryId: repository.id, snapshotId });
      for (let pass = 1; pass <= 2; pass++) {
        fixture.record('node.environment.changed-process', { ...await setAndRestart(randomBytes(32).toString('base64url')), pass });
        const input = { repositoryId: repository.id, snapshotId, include: ['environment'], healthPath: '/', timeoutSeconds: 30 };
        const restorePreview = accepted(await fixture.call('POST', fixture.endpoint('/restore/preview'), input));
        const queued = await queuedOperation(fixture, { kind: 'restore', ...input, expectedPreviewDigest: restorePreview.previewDigest, confirmation: restorePreview.confirmation }, restorePreview, hash(originalSecret));
        await finished(fixture, queued);
        const restoredProof = await proof(hash(originalSecret), 'snapshot-environment-restore');
        fixture.record('node.environment.restored-process', { ...restoredProof, pass, snapshotId, operationId: queued.id });
        operationContentVerified(fixture, queued, restoredProof);
      }
    } catch (error) { native18StickyHold = true; failure = error; }
    try {
      if (native18StickyHold || native18Operations.size) throw new Error('UNKNOWN_KEEP: repository and Website retained until exact operation and content reconciliation');
      if (repository) {
        accepted(await fixture.call('DELETE', '/api/panel/backups/repositories/' + repository.id));
        expect((await fixture.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe(404);
        fixture.record('backup.repository.physical-cleanup-required', { repositoryId: repository.id, target: repository.target, name: repository.name, registryAbsent: true });
      }
    } catch (error) { fixture.record('node.environment.cleanup-failure', { errorKind: error.name, errorCode: error.code ?? null }); native18StickyHold = true; failure ??= error; }
    if (failure) throw failure; native18CompleteWork('environment-restore');
  });
});
