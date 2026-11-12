import { createHash, randomBytes } from 'node:crypto';
import { test, expect, apiContext, ready, main } from './support.js';
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
async function finished(fixture, operation) {
  const job = await fixture.waitJob(operation.jobId, 180000); expect(job.status).toBe('succeeded');
  const result = accepted(await fixture.call('GET', fixture.endpoint('/backup-operations/' + operation.id)));
  expect(result.status, result.error?.code).toBe('succeeded'); return result;
}

test.describe('T887 real dedicated Node provisioning and environment restore', () => {
  let actor, fixture, projectName; const keys = new Set();
  test.beforeAll(async ({}, info) => { projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = await apiContext(); });
  test.afterAll(async () => {
    const failures = [];
    for (const key of [...keys].reverse()) try {
      const ledger = fixture?.ledger.key === key ? await fixture.cleanup() : await cleanupOwnedFixture(actor, { key });
      const absent = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
      expect(absent.unixUserExists).toBe(false); expect(absent.unixGroupExists).toBe(false);
      expect(absent.roots.every(value => !value.exists)).toBe(true); expect(absent.nginxFiles.every(value => !value.exists)).toBe(true);
      expect(absent.fpmFiles).toEqual([]); expect(absent.sockets).toEqual([]); expect(absent.mounts).toEqual([]);
    } catch (error) { failures.push(error.message); }
    await actor?.api.dispose(); expect(failures, 'Every exact owned Node ledger must be cleaned').toEqual([]);
  });

  test('@mutation normal Node form provisions one dedicated real Passenger application from the current public sample', async ({ page }) => {
    test.setTimeout(480000);
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
        const pattern = '**/api/panel/sites';
        const observe = async route => {
          if (route.request().method() === 'POST') {
            const body = route.request().postDataJSON(); recordInput(body.input ?? body);
          }
          await route.continue();
        };
        await page.route(pattern, observe);
        try {
          const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/panel/sites' && response.request().method() === 'POST');
          await main(page).getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
          const response = await pending; expect([200, 201]).toContain(response.status()); return (await response.json()).data;
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
  });

  test('@mutation same snapshot restores a secret twice in the actual dedicated running Node process', async () => {
    test.setTimeout(480000);
    if (!fixture) {
      const key = 't887-node-environment-api-' + projectName; keys.add(key);
      fixture = await createOwnedFixture(actor, { key, runtime: 'node', source });
    }
    expect(fixture.ledger.applicationId).toBeTruthy();
    const target = fixture.ledger, probePath = '/yp-t887-proof-' + randomBytes(16).toString('hex');
    const packageFile = await fixture.readText('package.json'); expect(typeof packageFile.content).toBe('string');
    const packageJson = JSON.parse(packageFile.content);
    const imports = packageJson.type === 'module'
      ? "import {createServer} from 'node:http'; import {createHash} from 'node:crypto'; import {realpathSync} from 'node:fs';"
      : "const {createServer}=require('node:http'),{createHash}=require('node:crypto'),{realpathSync}=require('node:fs');";
    // This is an actual owned Node application. Every returned field is read
    // from its running process, and only one secret's SHA-256 is exposed.
    const entry = imports + '\ncreateServer((request,response)=>{response.setHeader("Cache-Control","no-store");'
      + 'if(request.url===' + JSON.stringify(probePath) + '){response.setHeader("Content-Type","application/json");response.end(JSON.stringify({'
      + 'uid:process.getuid(),cwd:realpathSync(process.cwd()),pid:process.pid,node:process.version,'
      + 'environmentHash:createHash("sha256").update(process.env.' + KEY + '??"").digest("hex")}));}'
      + 'else{response.setHeader("Content-Type","text/plain");response.end("Node T887 actual owned runtime");}}).listen(process.env.PORT||3000);\n';
    fixture.record('node.actual-runtime-proof.intent', { entryFile: source.runtime.entryFile, proofPath: probePath, variableName: KEY });
    await uploadOwned(fixture, source.runtime.entryFile, entry);
    async function proof(expectedHash) {
      let observed;
      await expect.poll(async () => {
        const response = await fixture.http(probePath);
        if (response.status !== 200) return 'http:' + response.status;
        try { observed = JSON.parse(response.body); return observed.environmentHash; } catch { return 'not-json'; }
      }, { timeout: 60000, intervals: [500, 1000] }).toBe(expectedHash);
      const application = accepted(await fixture.call('GET', '/api/panel/applications/' + target.applicationId));
      const status = accepted(await fixture.call('GET', '/api/panel/applications/' + target.applicationId + '/environment/status'));
      const identity = await readOnlyHostProbe(fixture, 'owned-site-files');
      expect(observed.uid).toBeGreaterThan(0); expect(observed.uid).toBe(identity.unixUid);
      expect(observed.cwd).toBe(identity.resolvedRoot); expect(identity.currentSymlink).toBe(true);
      expect(identity.currentLinkTarget).toBe('releases/' + application.currentReleaseId);
      expect(status.savedRevision).toBe(status.appliedRevision); expect(status.appliedReleaseId).toBe(application.currentReleaseId);
      expect(status.appliedToRunningProcess).toBe(true);
      expect(identity.environmentIncludeApplicationId).toBe(target.applicationId); expect(identity.environmentIncludeRevision).toBe(status.savedRevision);
      expect((await fixture.http('/')).status).toBe(200);
      return { verified: true, uid: observed.uid, cwd: observed.cwd, environmentHash: observed.environmentHash, releaseId: application.currentReleaseId, revision: status.savedRevision };
    }
    let environmentWrites = 0;
    async function setAndRestart(value) {
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
      try { queued = accepted(await fixture.call('POST', fixture.endpoint('/application/restart'), {}), 202); }
      catch (error) {
        if (error.code !== 'owned_fixture_transport') throw error;
        let matches;
        await expect.poll(async () => {
          matches = accepted(await fixture.call('GET', jobsPath)).filter(job => !priorIds.has(job.id) && job.type === 'app.node.restart'); return matches.length;
        }, { timeout: 5000, intervals: [200, 500] }).toBe(1);
        queued = matches[0]; fixture.record('node.restart.reconciled', { receiptKnown: false, jobId: queued.id, savedRevision: saved.savedRevision });
      }
      expect((await fixture.waitJob(queued.id, 180000)).status).toBe('succeeded'); return proof(hash(value));
    }
    const originalSecret = randomBytes(32).toString('base64url'); let repository, failure;
    try {
      fixture.record('node.environment.original-process', await setAndRestart(originalSecret));
      const name = 'ypaudit-t887-env-' + target.nonce; fixture.record('backup.repository.intent', { name, websiteId: target.websiteId });
      repository = accepted(await fixture.call('POST', '/api/panel/backups/repositories', { name, backend: 'local', password: randomBytes(36).toString('base64url'), initialize: false }), 201);
      fixture.record('backup.repository.owned', { repositoryId: repository.id, target: repository.target, name }); expect(repository.status).toBe('uninitialized');
      const initialized = accepted(await fixture.call('POST', '/api/panel/backups/repositories/' + repository.id + '/init', {})); expect(initialized.status).toBe('ready');
      accepted(await fixture.call('POST', '/api/panel/backups/repositories/' + repository.id + '/check', {}));
      expect(accepted(await fixture.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe('ready');
      fixture.record('backup.repository.explicit-init-check', { verified: true, repositoryId: repository.id });
      const preview = accepted(await fixture.call('POST', fixture.endpoint('/backup/preview'), { repositoryId: repository.id }));
      const backup = accepted(await fixture.call('POST', fixture.endpoint('/backup-operations'), { kind: 'backup', repositoryId: repository.id, expectedPreviewDigest: preview.backupSetDigest, confirmation: preview.confirmation, tags: ['t887-node-env-' + target.nonce] }), 202);
      const snapshotId = (await finished(fixture, backup)).result?.snapshot?.snapshotId; expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
      fixture.record('backup.snapshot.owned', { repositoryId: repository.id, snapshotId });
      for (let pass = 1; pass <= 2; pass++) {
        fixture.record('node.environment.changed-process', { ...await setAndRestart(randomBytes(32).toString('base64url')), pass });
        const input = { repositoryId: repository.id, snapshotId, include: ['environment'], healthPath: '/', timeoutSeconds: 30 };
        const restorePreview = accepted(await fixture.call('POST', fixture.endpoint('/restore/preview'), input));
        const queued = accepted(await fixture.call('POST', fixture.endpoint('/backup-operations'), { kind: 'restore', ...input, expectedPreviewDigest: restorePreview.previewDigest, confirmation: restorePreview.confirmation }), 202);
        await finished(fixture, queued);
        fixture.record('node.environment.restored-process', { ...await proof(hash(originalSecret)), pass, snapshotId, operationId: queued.id });
      }
    } catch (error) { failure = error; }
    try {
      if (repository) {
        accepted(await fixture.call('DELETE', '/api/panel/backups/repositories/' + repository.id));
        expect((await fixture.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe(404);
        fixture.record('backup.repository.physical-cleanup-required', { repositoryId: repository.id, target: repository.target, name: repository.name, registryAbsent: true });
      }
    } catch (error) { fixture.record('node.environment.cleanup-failure', { errorKind: error.name, errorCode: error.code ?? null }); failure ??= error; }
    if (failure) throw failure;
  });
});
