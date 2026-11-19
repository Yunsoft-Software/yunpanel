import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { apiContext, manifest, ORIGIN, privateJson, ready, RUN_DIR } from './runtime.js';
import { cleanupOwnedFixture, createOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const UUID = /^[a-f0-9-]{36}$/;
const SHA = /^[a-f0-9]{64}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function requireStatus(reply, status) {
  const code = /^[a-z0-9_]{1,100}$/.test(reply.body?.error?.code ?? '') ? reply.body.error.code : 'unknown';
  expect(reply.status, `HTTP status (${code})`).toBe(status);
  return reply.data;
}

async function setupDatabase(fixture, proof, save) {
  const { websiteId, serverId, applicationId, nonce } = fixture.ledger;
  const website = requireStatus(await fixture.call('GET', fixture.endpoint()), 200);
  expect(website.applicationId).toBe(applicationId);
  const databaseName = `pcopy${nonce}`;
  const password = randomBytes(24).toString('hex');
  const endpoint = `/api/panel/servers/${serverId}/websites/${websiteId}/databases`;
  proof.database = { databaseName, requested: true, settled: false };
  save();
  const reply = await fixture.call('POST', endpoint, { databaseName, password, mode: 'create', expectedWebsiteRevision: website.revision });
  if ([400, 401, 403, 404, 409, 422].includes(reply.status)) proof.database.settled = true;
  const { binding, credential, job } = requireStatus(reply, 202);
  expect(binding.websiteId).toBe(websiteId);
  expect(credential.databaseBindingId).toBe(binding.id);
  expect(credential.username).toMatch(/^ydb_[a-f0-9]{24}$/);
  expect(job.id).toMatch(UUID);
  Object.assign(proof.database, { bindingId: binding.id, credentialId: credential.id, jobId: job.id });
  save();
  const terminal = await fixture.waitJob(job.id, 120_000);
  proof.database.settled = true;
  proof.database.status = terminal.status;
  save();
  expect(terminal.status, 'The database setup job must complete successfully').toBe('succeeded');
  return { version: 1, bindingId: binding.id, credentialId: credential.id, databaseName, host: 'localhost', username: credential.username, password };
}

const connect = String.raw`
function connect_db($cfg) {
  return new PDO('mysql:host=localhost;dbname='.$cfg['databaseName'].';charset=utf8mb4', $cfg['username'], $cfg['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
}
`;

function initializer(connection, token) {
  const encoded = Buffer.from(JSON.stringify(connection)).toString('base64');
  return `<?php
ini_set('display_errors','0');
header('Cache-Control: no-store');
if (!hash_equals('${token}', $_SERVER['HTTP_X_YUNPANEL_TEST'] ?? '')) { http_response_code(404); exit; }
${connect}
try {
  $home = getenv('HOME');
  if (!is_string($home) || !str_starts_with($home, '/var/lib/yunpanel/data/')) { throw new Exception(); }
  $dir = $home.'/.yunpanel';
  if (!mkdir($dir,0700)) { throw new Exception(); }
  $file = $dir.'/database.json';
  $cfg = json_decode(base64_decode('${encoded}', true), true, 512, JSON_THROW_ON_ERROR);
  umask(0077);
  $handle = fopen($file,'x');
  if (!$handle) { throw new Exception(); }
  fwrite($handle,json_encode($cfg,JSON_THROW_ON_ERROR));
  fclose($handle);
  $db = connect_db($cfg);
  $db->exec('CREATE TABLE copy_entries (id INT PRIMARY KEY, note VARCHAR(64) NOT NULL, bytes VARBINARY(8) NOT NULL) ENGINE=InnoDB');
  $db->exec("INSERT INTO copy_entries VALUES (1,'Türkçe kaynak',X'000AFF80')");
  echo 'initialized';
} catch (Throwable $error) { http_response_code(500); }
`;
}

function application(sourceDatabase, writeToken) {
  return `<?php
ini_set('display_errors','0');
header('Cache-Control: no-store');
header('Content-Type: application/json');
${connect}
try {
  $config = json_decode(file_get_contents(getenv('HOME').'/.yunpanel/database.json'), true, 512, JSON_THROW_ON_ERROR);
  $db = connect_db($config);
  $operation = $_SERVER['REQUEST_METHOD'];
  if ($operation === 'POST') {
    if (!hash_equals('${writeToken}', $_SERVER['HTTP_X_YUNPANEL_TEST'] ?? '')) { http_response_code(403); exit; }
    $db->exec("INSERT INTO copy_entries VALUES (2,'Hedef yazımı',X'11')");
  }
  $sourceRestricted = null;
  if ($config['databaseName'] !== '${sourceDatabase}') {
    try { $db->query('SELECT COUNT(*) FROM ${sourceDatabase}.copy_entries'); $sourceRestricted = false; }
    catch (PDOException $error) { $sourceRestricted = in_array($error->errorInfo[1] ?? null,[1044,1142],true); }
  }
  echo json_encode([
    'database' => $db->query('SELECT DATABASE()')->fetchColumn(),
    'account' => $db->query('SELECT CURRENT_USER()')->fetchColumn(),
    'rows' => $db->query('SELECT id,note,HEX(bytes) AS bytes FROM copy_entries ORDER BY id')->fetchAll(PDO::FETCH_ASSOC),
    'sourceRestricted' => $sourceRestricted, 'sapi' => PHP_SAPI, 'uid' => posix_geteuid()
  ],JSON_THROW_ON_ERROR);
} catch (Throwable $error) { http_response_code(500); }
`;
}

async function appResponse(fixture, options) {
  const response = await fixture.http('/', options);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toContain('no-store');
  const data = JSON.parse(response.body);
  expect(data.sapi).toBe('fpm-fcgi');
  expect(data.uid).toBeGreaterThan(0);
  return data;
}

test('@mutation copies a PHP site and its MariaDB rows with the target account', async ({ page }, info) => {
  test.skip(process.env.YUNPANEL_AUDIT_LANE !== 'mutation', 'Requires the explicit mutation lane');
  test.setTimeout(800_000);
  const actor = await apiContext();
  const keys = ['php-copy-source', 'php-copy-target'];
  const fixtures = new Map();
  const proof = { sourceCommit: manifest().sourceCommit, browser: info.project.name, sites: {}, job: {}, cleanup: [], checks: {} };
  const save = () => privateJson('php-copy-native.json', proof);
  let phase = 'deployment';
  let failure;
  try {
    expect(proof.sourceCommit).toMatch(SHA);
    const diagnostic = await actor.api.get('/api/panel/system/diagnostics/version');
    const version = (await diagnostic.json()).data;
    expect(diagnostic.status()).toBe(200);
    expect(version.commit).toBe(proof.sourceCommit);
    expect(version.sourceInfo.sourceMatchesDeployed).toBe(true);
    expect(version.buildVerified).toBe(true);

    phase = 'owned-php-sites';
    for (const key of keys) {
      const fixture = await createOwnedFixture(actor, { key, runtime: 'php' });
      fixtures.set(key, fixture);
      proof.sites[key] = { websiteId: fixture.ledger.websiteId, applicationId: fixture.ledger.applicationId };
      save();
    }
    const [source, target] = keys.map((key) => fixtures.get(key));
    expect(source.ledger.unixUser).not.toBe(target.ledger.unixUser);
    const originalTarget = (await target.readText('index.php')).sha256;
    phase = 'independent-databases';
    const sourceDb = await setupDatabase(source, proof.sites[keys[0]], save);
    const targetDb = await setupDatabase(target, proof.sites[keys[1]], save);
    expect(sourceDb.databaseName).not.toBe(targetDb.databaseName);
    expect(sourceDb.username).not.toBe(targetDb.username);
    phase = 'prepare-php';
    const initToken = randomBytes(24).toString('hex');
    const writeToken = randomBytes(24).toString('hex');
    const app = application(sourceDb.databaseName, writeToken);
    try {
      await source.upload('index.php', initializer(sourceDb, initToken));
      const initialized = await source.http('/', { headers: { 'X-YunPanel-Test': initToken } });
      expect(initialized.status).toBe(200);
      expect(initialized.body === 'initialized').toBe(true);
    } finally {
      await source.upload('index.php', app);
    }
    const before = await appResponse(source);
    expect(before.account).toBe(`${sourceDb.username}@localhost`);
    expect(before.database).toBe(sourceDb.databaseName);
    expect(before.rows).toEqual([{ id: 1, note: 'Türkçe kaynak', bytes: '000AFF80' }]);
    expect((await target.readText('index.php')).sha256).toBe(originalTarget);

    phase = 'panel-preview';
    const route = source.endpoint('/php-copy');
    const isPost = (request, suffix) => request.method() === 'POST' && request.url() === ORIGIN + route + suffix;
    page.on('request', (request) => {
      if (!isPost(request, '/requests')) return;
      proof.job.requested = true;
      const requestId = request.postDataJSON()?.requestId;
      if (UUID.test(requestId ?? '')) proof.job.requestId = requestId;
      save();
    });
    await ready(page, source.route('overview'));
    await page.getByRole('button', { name: 'Siteyi kopyala', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'PHP sitesini kopyala' });
    await dialog.getByLabel(/^Hedef site/).selectOption(target.ledger.websiteId);
    const previewReply = page.waitForResponse((response) => isPost(response.request(), '/preview'));
    void previewReply.catch(() => {});
    await dialog.getByRole('button', { name: 'Önizle', exact: true }).click();
    const preview = await previewReply;
    const previewBody = await preview.json();
    const plan = requireStatus({ status: preview.status(), body: previewBody, data: previewBody.data }, 200);
    expect(plan.targetWebsiteId).toBe(target.ledger.websiteId);
    expect(plan.files).toBe(1);
    expect(plan.bytes).toBe(Buffer.byteLength(app));
    expect(plan.tables).toBe(1);

    phase = 'panel-job';
    const jobReply = page.waitForResponse((response) => isPost(response.request(), '/requests'));
    void jobReply.catch(() => {});
    await dialog.getByRole('button', { name: 'Siteyi kopyala', exact: true }).click();
    const queued = await jobReply;
    proof.job.httpStatus = queued.status();
    const queuedBody = await queued.json();
    const { job } = requireStatus({ status: queued.status(), body: queuedBody, data: queuedBody.data }, 202);
    expect(job.id).toMatch(UUID);
    expect(job.operation).toBe('website.php.copy');
    expect(job.resourceId).toBe(source.ledger.applicationId);
    expect(job.serverId).toBe(source.ledger.serverId);
    proof.job.id = job.id;
    save();
    await page.waitForURL((url) => url.searchParams.get('phpCopyRequest') === `${source.ledger.websiteId}:${proof.job.requestId}`);
    await page.reload({ waitUntil: 'load' });
    const same = await source.waitJob(job.id, 180_000);
    proof.job.status = same.status;
    proof.job.errorCode = same.error?.code ?? null;
    save();
    expect(same.status, `PHP copy job outcome (${proof.job.errorCode ?? 'no error'})`).toBe('succeeded');
    await expect(page.getByRole('dialog', { name: 'PHP sitesini kopyala' }).getByText('Kopyalanan tablo', { exact: true })).toBeVisible({ timeout: 15_000 });
    const saved = requireStatus(await source.call('GET', `${route}/requests/${proof.job.requestId}`), 200).job;
    expect(saved.id).toBe(job.id);
    expect(saved.result).toEqual({ filesCopied: 1, bytesCopied: Buffer.byteLength(app), tablesCopied: 1, databaseBytes: expect.any(Number) });
    expect(saved.result.databaseBytes).toBeGreaterThan(0);
    proof.checks.reloadReceivedSameJob = true;

    phase = 'target-php-and-sql';
    const targetResult = await appResponse(target);
    expect(targetResult.account).toBe(`${targetDb.username}@localhost`);
    expect(targetResult.database).toBe(targetDb.databaseName);
    expect(targetResult.uid).not.toBe(before.uid);
    expect(targetResult.rows).toEqual(before.rows);
    expect(targetResult.sourceRestricted).toBe(true);
    const written = await appResponse(target, { method: 'POST', headers: { 'X-YunPanel-Test': writeToken } });
    expect(written.rows).toEqual([...before.rows, { id: 2, note: 'Hedef yazımı', bytes: '11' }]);
    expect(await appResponse(source)).toEqual(before);
    expect((await source.readText('index.php')).sha256).toBe(digest(app));
    expect((await target.readText('index.php')).sha256).toBe(digest(app));
    const refused = await source.call('POST', `${route}/preview`, { targetWebsiteId: target.ledger.websiteId });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toMatch(/^php_copy_(?:target_not_empty|connection_invalid)$/);
    expect((await appResponse(target)).rows).toEqual(written.rows);
    proof.checks = { ...proof.checks, separateFpmUsers: true, independentSql: true, sourceAccessDenied: true,
      sourcePreserved: true, fileHashesMatched: true, occupiedTargetRejected: true };
    proof.passed = true;
  } catch (error) {
    proof.failedPhase = phase;
    failure = error;
  } finally {
    const origin = fixtures.get(keys[0]);
    if (proof.job.requested && !['succeeded', 'failed', 'cancelled'].includes(proof.job.status)) {
      try {
        if (!proof.job.id && proof.job.requestId) {
          const lookup = await origin.call('GET', origin.endpoint(`/php-copy/requests/${proof.job.requestId}`));
          if (lookup.status === 200) proof.job.id = lookup.data.job.id;
          else if (lookup.status !== 404 || ![400, 401, 403, 404, 409, 422].includes(proof.job.httpStatus)) proof.cleanupUncertain = true;
        }
        if (proof.job.id) proof.job.status = (await origin.waitJob(proof.job.id, 180_000)).status;
        else if (!proof.job.requestId) proof.cleanupUncertain = true;
      } catch { proof.cleanupUncertain = true; }
    }
    if (Object.values(proof.sites).some(({ database }) => database?.requested && !database.settled)) proof.cleanupUncertain = true;
    for (const key of keys.slice().reverse()) {
      if (proof.cleanupUncertain || !existsSync(path.join(RUN_DIR, 'owned-fixtures', `${key}.json`))) continue;
      try {
        const tracked = fixtures.get(key);
        const ledger = tracked ? await tracked.cleanup() : await cleanupOwnedFixture(actor, { key });
        const physical = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
        expect(physical.unixUserExists || physical.unixGroupExists).toBe(false);
        expect(physical.roots.every((entry) => !entry.exists) && physical.nginxFiles.every((entry) => !entry.exists)).toBe(true);
        expect(physical.fpmFiles.length + physical.sockets.length + physical.mounts.length).toBe(0);
        expect((ledger.backups ?? []).length).toBe(0);
        proof.cleanup.push({ key, physicalAbsence: true, panelIdentityAbsence: true });
      } catch (error) { failure ??= error; proof.cleanupFailed = true; }
    }
    if (!proof.cleanupUncertain && !proof.cleanupFailed && origin && proof.cleanup.length === 2) {
      try {
        const inventory = requireStatus(await origin.call('GET', `/api/panel/servers/${origin.ledger.serverId}/databases`), 200);
        const names = Object.values(proof.sites).map(({ database }) => database?.databaseName).filter(Boolean);
        expect(inventory.inventory?.databases ?? inventory.databases).toEqual(expect.any(Array));
        expect((inventory.inventory?.databases ?? inventory.databases).some(({ name }) => names.includes(name))).toBe(false);
        proof.checks.cleanedDatabaseSchemas = true;
      } catch (error) { failure ??= error; proof.cleanupFailed = true; }
    }
    save();
    await actor.api.dispose();
  }
  if (failure) throw failure;
  expect(proof.cleanup.length).toBe(2);
  expect(proof.cleanupUncertain).toBeUndefined();
});
