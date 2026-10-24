import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { randomBytes, randomUUID } from 'node:crypto';
import { test,expect,manifest,saveManifest,apiCall,waitJob,RUN_DIR,ORIGIN,ready,main } from './support.js';
import { advanceProvisioning } from '../../apps/web/src/workspace/provisioning-advance.js';
import { nextRemovalStep } from '../../apps/web/src/workspace/website-removal-model.js';
test.beforeEach(async({context})=>{
 const dist=path.resolve('apps/web/dist');
 await context.route(url=>url.origin===ORIGIN&&!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tools/'),async route=>{
  const u=new URL(route.request().url());const file=route.request().isNavigationRequest()?path.join(dist,'index.html'):path.join(dist,u.pathname);
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
  const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]??'application/octet-stream';
  await route.fulfill({body:fs.readFileSync(file),contentType:type,headers:{'Cache-Control':'no-store'}});
 });
});
function owned(){const m=manifest();expect(m.fixture.provisioningReady).toBe(true);expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);if(!process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA)throw new Error('Exact native source identity is required');return m;}
function record(action,data){const m=manifest();m.fixture.operations.push({action,...data,at:new Date().toISOString()});saveManifest(m);}
function check(r,label,status=200){record(label,{status:r.status,code:r.body.error?.code});if (Array.isArray(status)) expect(status,label).toContain(r.status); else expect(r.status,label).toBe(status);return r.data;}
async function finishedBackup(c,root,operation){
 const job=await waitJob(c.api,operation.jobId);record('backup.native.job',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
 const actual=check(await apiCall(c.api,c.csrf,'GET',root+'/backup-operations/'+operation.id),'backup.native.operation');
 expect(actual.status).toBe('succeeded');return actual;
}
async function nativeMailboxPassword(c,m,password){
 const box=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mailboxes/'+m.fixture.mailboxIds[1]),'backup.mailbox');
 check(await apiCall(c.api,c.csrf,'POST','/api/panel/mailboxes/'+box.id+'/password',{expectedRevision:box.revision,password}),'backup.mailbox.change');
 const mailDomain=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mail-domains/'+m.fixture.mailDomainId),'backup.mail-domain');
 const input={expectedRevision:mailDomain.revision,status:'enabled'};
 const preview=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+mailDomain.id+'/config-preview',input),'backup.mail.apply.preview');
 const job=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+mailDomain.id+'/config-apply',{
   ...input,previewDigest:preview.previewDigest,configurationSha256:preview.configurationSha256,confirmation:preview.confirmation,requestId:randomUUID()}),'backup.mail.apply.queue',202);
 expect((await waitJob(c.api,job.id)).status).toBe('succeeded');
}

test('@mutation source three-step form creates an uploaded static site without Git and serves the actual uploaded HTML', async ({ page, liveApi }) => {
 test.setTimeout(240000); const m = owned();
 let target = m.fixture.extraStatic?.removed ? null : m.fixture.extraStatic;
 if (!target) {
  const hostname = 'yp-static-' + m.runId + '.157.180.11.28.sslip.io';
  await ready(page, '/websites/new');
  await page.getByLabel('Alan adı', { exact: true }).fill(hostname);
  await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
  await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
  await expect(page.getByRole('textbox', { name: 'GitHub repository', exact: true })).toHaveCount(0);
  await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
  await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
  await page.getByRole('checkbox', { name: /Otomatik E-Posta/ }).uncheck();
  const reply = page.waitForResponse(response => response.url().endsWith('/api/panel/sites') && response.request().method() === 'POST');
  await main(page).getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
  const response = await reply; expect([200, 201]).toContain(response.status());
  const created = (await response.json()).data;
  target = { hostname, websiteId: created.website.id, applicationId: created.application.id, provisioningOperationId: created.provisioning.operationId };
  const current = manifest(); current.fixture.extraStatic = target;
  current.fixture.createdWebsiteIds.push(target.websiteId); saveManifest(current);
  // The normal form owns its automatic continuation. Wait for its result rather
  // than issuing another continuation at the same time.
  await expect(main(page).getByLabel('Site kurulum durumu')).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı', { timeout: 180000 });
 }
 const operation = await advanceProvisioning({ operationId: target.provisioningOperationId, maxSteps: 30,
  read: async () => check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/sites/provisioning/' + target.provisioningOperationId), 'static.upload.provisioning.read'),
  advance: async () => check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/sites/provisioning/' + target.provisioningOperationId + '/continue', { confirmation: 'continue-site-provisioning:' + target.provisioningOperationId }), 'static.upload.provisioning.advance', [200, 202]) });
 expect(operation.ready).toBe(true);
 const domains = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/websites/' + target.websiteId + '/domains'), 'static.upload.domains');
 const domain = domains.find(item => item.primaryDomain === target.hostname); expect(domain?.websiteId).toBe(target.websiteId);
 const current = manifest(); current.fixture.extraStatic.domainId = domain.id;
 if (!current.fixture.createdDomainIds.includes(domain.id)) current.fixture.createdDomainIds.push(domain.id); saveManifest(current);
 const application = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/applications/' + target.applicationId), 'static.upload.application');
 expect(application.state).toBe('active'); expect(application.repositoryUrl).toBe(null); expect(application.currentCommitSha).toBe(null);
 const site = { fixture: target }, marker = '<!doctype html><html lang="tr"><head><title>Uploaded site</title></head><body><h1>STATIC-NATIVE-' + m.runId + '</h1></body></html>';
 await upload(liveApi, site, 'index.html', marker);
 const actual = await liveApi.api.get('http://' + target.hostname + '/'); expect(actual.status()).toBe(200); expect(await actual.text()).toBe(marker);
 await ready(page, '/websites/' + domain.id + '/files'); await expect(main(page)).toContainText('index.html');
 await expect(page.getByRole('navigation', { name: 'Site araçları' }).getByRole('link', { name: /Git/ })).toHaveCount(0);
 record('static.upload.actual-html', { verified: true, websiteId: target.websiteId, noGitRequired: true });
});

test('@mutation source managed phpMyAdmin repair stages actual templates and verifies the native gateway', async ({ liveApi }) => {
 test.setTimeout(180000); const m = owned();
 const queued = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/servers/' + m.serverId + '/services/phpmyadmin/install', { confirmation: 'install:phpmyadmin' }), 'phpmyadmin.repair.queue', 202);
 const job = await waitJob(liveApi.api, queued.id, 150000);
 record('phpmyadmin.repair.native', { status: job.status, code: job.error?.code, transactionId: job.result?.configurationResult?.transactionId });
 expect(job.status).toBe('succeeded');
 expect(job.result?.configurationResult?.applied).toBe(true);
 expect(job.result.configurationResult.httpHealthy).toBe(true);
 expect(job.result.configurationResult.fpmSocketHealthy).toBe(true);
 expect(job.result.configurationResult.gatewaySocketHealthy).toBe(true);
 const current = manifest(); current.fixture.phpMyAdminConfigurationTransaction = job.result.configurationResult.transactionId; saveManifest(current);
});

test('@mutation source uploaded static Website removal completes its real lifecycle and preserves the PHP sibling', async ({ liveApi }) => {
 test.setTimeout(240000); const m = owned(), target = m.fixture.extraStatic;
 expect(target?.websiteId).toBeTruthy(); expect(target.removed).not.toBe(true);
 expect(m.fixture.createdWebsiteIds).toContain(target.websiteId);
 const root = '/api/panel/websites/' + target.websiteId;
 const before = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', root), 'static.remove.website');
 expect(before.runtimeType).toBe('static');
 let operation;
 if (target.removalOperationId) {
  operation = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/website-removal-operations/' + target.removalOperationId), 'static.remove.resume');
 } else {
  const preview = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', root + '/removal'), 'static.remove.preview').preview;
  expect(preview.readyToStart).toBe(true);
  operation = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/removal', {
   previewDigest: preview.previewDigest, confirmation: preview.confirmation,
  }), 'static.remove.start', 201);
 }
 const saved = manifest(); saved.fixture.extraStatic.removalOperationId = operation.id;
 saved.fixture.extraStatic.removalPhysicalScope = { applicationId: before.applicationId, unixUser: before.unixUser,
  documentRoot: before.documentRoot, hostname: target.hostname }; saveManifest(saved);
 for (let attempt = 0; attempt < 80 && operation.status !== 'removed'; attempt++) {
  if (operation.execution?.mode === 'automatic') {
   await new Promise(resolve => setTimeout(resolve, 650));
   operation = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/website-removal-operations/' + operation.id), 'static.remove.server-worker');
   expect(['failed', 'blocked']).not.toContain(operation.status);continue;
  }
  const step = nextRemovalStep(operation); expect(step).toBeTruthy();
  operation = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/website-removal-operations/' + operation.id + '/continue', {
   expectedUpdatedAt: operation.updatedAt, stepId: step.stepId, confirmation: step.confirmation,
  }), 'static.remove.continue');
  record('static.remove.step', { operationId: operation.id, stepId: step.stepId, status: operation.status,
   code: operation.lastError?.code ?? operation.error?.code });
  expect(['failed', 'blocked']).not.toContain(operation.status);
  if (operation.status !== 'removed') await new Promise(resolve => setTimeout(resolve, 650));
 }
 expect(operation.status).toBe('removed');
 expect((await apiCall(liveApi.api, liveApi.csrf, 'GET', root)).status).toBe(404);
 expect((await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/domains/' + target.domainId)).status).toBe(404);
 expect((await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/applications/' + target.applicationId)).status).toBe(404);
 const sibling = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/websites/' + m.fixture.websiteId + '/wordpress'), 'static.remove.php-sibling');
 expect(sibling.installed).toBe(true);
 expect((await liveApi.api.get('https://' + m.fixture.hostname + '/')).status()).toBe(200);
 const result = manifest(); result.fixture.extraStatic.removed = true; saveManifest(result);
 record('static.remove.catalog-and-sibling', { verified: true, websiteId: target.websiteId,
  physicalSshAbsenceVerificationPending: true });
});
async function upload(c,m,name,source){return check(await apiCall(c.api,c.csrf,'PUT','/api/panel/websites/'+m.fixture.websiteId+'/files/upload?path='+name,Buffer.from(source)),'native.file.upload',[200,201]);}

test('@mutation source recovers only the owned static Domain left by the earlier incomplete Website removal plan', async ({ liveApi }) => {
 test.setTimeout(240000); const m = owned(), target = m.fixture.extraStatic;
 expect(target.removalOperationId).toBe('ws-rem-c0d2f997-eecd-4e6e-bbf2-430c06940fdc');
 expect(m.fixture.createdDomainIds).toContain(target.domainId);
 const root = '/api/panel/domains/' + target.domainId;
 async function call(method, endpoint, data, status = 200) {
  const result = await apiCall(liveApi.api, liveApi.csrf, method, endpoint, data);
  record('static.domain-recovery.request', { status: result.status, code: result.body.error?.code });
  expect(result.status).toBe(status); return result.body;
 }
 const domain = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', root), 'static.domain-recovery.identity');
 expect(domain.websiteId).toBe(target.websiteId); expect(domain.primaryDomain).toBe(target.hostname);
 let operation;
 if (target.domainRecoveryOperationId) {
  operation = (await call('GET', root + '/removal-operations/' + target.domainRecoveryOperationId)).operation;
 } else {
  const { preview } = await call('GET', root + '/removal'); expect(preview.readyToStart).toBe(true);
  operation = (await call('POST', root + '/removal', { previewDigest: preview.previewDigest, confirmation: preview.confirmation }, 201)).operation;
  const saved = manifest(); saved.fixture.extraStatic.domainRecoveryOperationId = operation.id; saveManifest(saved);
 }
 for (let attempt = 0; attempt < 80 && operation.status !== 'removed'; attempt++) {
  const base = root + '/removal-operations/' + operation.id;
  if (operation.actions?.routingRetryConfirmation) {
   operation = (await call('POST', base + '/retry-routing', { expectedUpdatedAt: operation.updatedAt,
    checksum: operation.checksum, confirmation: operation.actions.routingRetryConfirmation })).operation;
  } else if (operation.actions?.stepContinuationConfirmation) {
   const step = operation.steps.find(step => step.status !== 'succeeded'); expect(step).toBeTruthy();
   operation = (await call('POST', base + '/continue', { expectedUpdatedAt: operation.updatedAt, stepId: step.id,
    checksum: operation.checksum, confirmation: operation.actions.stepContinuationConfirmation })).operation;
  } else operation = (await call('GET', base)).operation;
  record('static.domain-recovery.phase', { operationId: operation.id, status: operation.status,
   code: operation.error?.code, steps: operation.steps?.map(step => ({ kind: step.kind, status: step.status, code: step.error?.code })) });
  expect(['failed', 'blocked']).not.toContain(operation.status);
  if (operation.status !== 'removed') await new Promise(resolve => setTimeout(resolve, 650));
 }
 expect(operation.status).toBe('removed');
 expect((await apiCall(liveApi.api, liveApi.csrf, 'GET', root)).status).toBe(404);
 expect((await liveApi.api.get('https://' + m.fixture.hostname + '/')).status()).toBe(200);
 record('static.domain-recovery.complete', { verified: true, originalWebsiteRemovalOperationPreserved: true });
});

async function remove(c,m,name){check(await apiCall(c.api,c.csrf,'DELETE','/api/panel/websites/'+m.fixture.websiteId+'/files',{path:name,confirmation:'delete:'+m.fixture.websiteId+':'+name}),'native.file.remove');}

test('@mutation source one database form creates real schema, binding, grants and an application query',async({liveApi})=>{
 test.setTimeout(120000);const m=owned();const website=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId),'database.website');
 const file=path.join(RUN_DIR,'fixture-secrets.json'),secrets=JSON.parse(fs.readFileSync(file,'utf8'));secrets.databasePassword??=randomBytes(28).toString('base64url');fs.writeFileSync(file,JSON.stringify(secrets),{mode:0o600});
 const root='/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases';
 const created=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root,{databaseName:m.fixture.databaseName,mode:m.fixture.binding?'continue':'create',expectedWebsiteRevision:website.revision,...(!m.fixture.binding?{password:secrets.databasePassword}:{})}),'database.unified.queue',202);
 const current=manifest();current.fixture.binding=created.binding;current.fixture.credential=created.credential;current.fixture.createdDatabaseNames=[m.fixture.databaseName];saveManifest(current);
 const job=await waitJob(liveApi.api,created.job.id);record('database.native.finished',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
 const connection=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/'+created.binding.id+'/connection',{revealPassword:true}),'database.connection');
 expect(Boolean(connection.password&&connection.username&&connection.databaseName)).toBe(true);
 const proof='DB-NATIVE-'+m.runId,name='db-proof.php';
 const literal=x=>JSON.stringify(x);const source='<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli('+[connection.host,connection.username,connection.password,connection.databaseName].map(literal).join(',')+');$db->query("CREATE TABLE IF NOT EXISTS yp_native_proof (id INT PRIMARY KEY, value VARCHAR(100))");$s=$db->prepare("REPLACE INTO yp_native_proof VALUES (1, ?)");$v='+literal(proof)+';$s->bind_param("s",$v);$s->execute();$r=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();echo json_encode(["proof"=>$r["value"]]);';
 try {await upload(liveApi,m,name,source);const http=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);expect(http.status()).toBe(200);const actual=await http.json();expect(actual.proof).toBe(proof);record('database.real-application-query',{verified:true});}finally{await remove(liveApi,m,name);}
});

test('@mutation source SQL import uploads a real SQL file through phpMyAdmin, verifies the database row and removes only its table', async ({ page, liveApi }) => {
 test.setTimeout(120000); const m = owned(), suffix = randomBytes(8).toString('hex');
 const table = 'yp_native_import_' + suffix, proof = 'IMPORT-NATIVE-' + m.runId + '-' + suffix;
 const file = path.join(RUN_DIR, 'owned-sql-import-' + suffix + '.sql');
 fs.writeFileSync(file, 'CREATE TABLE `' + table + '` (id INT PRIMARY KEY, value VARCHAR(128) NOT NULL);\nINSERT INTO `' + table + '` VALUES (1, ' + "'" + proof + "');\n", { mode: 0o600 });
 const connection = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/servers/' + m.serverId + '/websites/' + m.fixture.websiteId + '/databases/' + m.fixture.binding.id + '/connection', { revealPassword: true }), 'sql.import.connection');
 const probe = 'native-sql-import-proof-' + suffix + '.php';
 const countSql = JSON.stringify("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='" + table + "'");
 const source = `<?php
 header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
 try {$db=new mysqli(${[connection.host, connection.username, connection.password, connection.databaseName].map(value => JSON.stringify(value)).join(',')});
 if($_SERVER["REQUEST_METHOD"]==="POST"){$db->query("DROP TABLE IF EXISTS ${table}");echo json_encode(["removed"=>$db->query(${countSql})->fetch_row()[0]==0]);}
 elseif($db->query(${countSql})->fetch_row()[0]==0){echo json_encode(["present"=>false]);}
 else{$row=$db->query("SELECT value FROM ${table} WHERE id=1")->fetch_assoc();echo json_encode(["present"=>true,"proof"=>$row["value"]]);}
 }catch(Throwable $error){http_response_code(500);echo json_encode(["verified"=>false]);}`;
 const current = manifest(); current.fixture.createdSqlImportTables ??= [];
 current.fixture.createdSqlImportTables.push({ databaseName: m.fixture.databaseName, table, probe, removed: false }); saveManifest(current);
 let uploaded = false, absentVerified = false;
 try {
  await upload(liveApi, m, probe, source); uploaded = true;
  const preflight = await liveApi.api.get('https://' + m.fixture.hostname + '/' + probe);
  expect(preflight.status()).toBe(200); expect((await preflight.json()).present).toBe(false); absentVerified = true;
  await ready(page, '/websites/' + m.fixture.domainId + '/databases');
  await main(page).getByRole('row').filter({ hasText: m.fixture.databaseName }).getByRole('button', { name: 'SQL içe aktar', exact: true }).click();
  await expect(page).toHaveURL(/\/tools\/phpmyadmin\/index.php\?/);
  expect(new URL(page.url()).searchParams.get('db')).toBe(m.fixture.databaseName);
  expect(new URL(page.url()).searchParams.get('route')).toBe('/database/import');
  await page.locator('input[type="file"][name="import_file"]').setInputFiles(file);
  const submit = page.getByRole('button', { name: /^(Import|Go)$/ });
  await expect(submit).toHaveCount(1);
  const responseEvent = page.waitForResponse(response => new URL(response.url()).pathname === '/tools/phpmyadmin/index.php' && response.request().method() === 'POST');
  await submit.click(); const response = await responseEvent; expect(response.status()).toBe(200);
  const actual = await liveApi.api.get('https://' + m.fixture.hostname + '/' + probe);
  expect(actual.status()).toBe(200); expect((await actual.json()).proof).toBe(proof);
  record('database.actual-phpmyadmin-sql-import', { verified: true, table, uniqueRowVerified: true });
 } finally {
  if (absentVerified) {
   const removed = await liveApi.api.post('https://' + m.fixture.hostname + '/' + probe);
   expect(removed.status()).toBe(200); expect((await removed.json()).removed).toBe(true);
   const cleanup = manifest(); cleanup.fixture.createdSqlImportTables.find(item => item.table === table).removed = true; saveManifest(cleanup);
  }
  if (uploaded) await remove(liveApi, m, probe);
 }
});

test('@mutation source PHP version and settings change the actual FPM runtime and persist in the site record',async({liveApi})=>{
 test.setTimeout(120000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/php-tools/config';
 const before=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'php.config.read');const target=before.availablePhpVersions?.includes('8.4')?'8.4':before.phpVersion;
 const config={phpVersion:target,maxChildren:before.fpm.maxChildren===10?11:10,memoryLimitMb:256,maxExecutionSeconds:31};
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',config),'php.config.preview');
 const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root,{config,expectedRevision:preview.websiteRevision,previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'php.config.queue',202);
 const job=await waitJob(liveApi.api,queued.job.id);record('php.native.finished',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
 const after=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'php.config.persisted');expect(after.phpVersion).toBe(target);expect(after.fpm.maxChildren).toBe(config.maxChildren);expect(after.fpm.memoryLimitMb).toBe(256);expect(after.fpm.maxExecutionSeconds).toBe(31);
 const name='php-runtime-proof.php';try{await upload(liveApi,m,name,'<?php header("Content-Type: application/json");echo json_encode(["version"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"memory"=>ini_get("memory_limit"),"seconds"=>ini_get("max_execution_time")]);');const http=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);expect(http.status()).toBe(200);const actual=await http.json();expect(actual.version).toBe(target);expect(actual.memory).toBe('256M');expect(actual.seconds).toBe('31');record('php.actual-http-runtime',{verified:true,...actual});}finally{await remove(liveApi,m,name);}
});

test('@mutation source WordPress installs against real site DB, logs in and changes administrator password',async({liveApi,page})=>{
 test.setTimeout(240000);const m=owned();expect(m.fixture.binding?.id).toBeTruthy();const root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress';
 const secretFile=path.join(RUN_DIR,'fixture-secrets.json'),secrets=JSON.parse(fs.readFileSync(secretFile,'utf8'));const username='native_admin';
 async function action(options,password){const p=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',{options}),'wordpress.preview');const {randomUUID}=await import('node:crypto');const requestId=randomUUID();const q=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/actions',{options,requestId,expectedWebsiteRevision:p.websiteRevision,previewDigest:p.previewDigest,confirmation:p.confirmation,...(password?{password}:{})}),'wordpress.queue',202);const current=manifest();current.fixture.wordpressRequest=requestId;saveManifest(current);const job=await waitJob(liveApi.api,q.job.id,180000);record('wordpress.native.finished',{action:options.action,status:job.status,code:job.error?.code});expect(job.status,options.action).toBe('succeeded');return job;}
 let before=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.status');
 if(!before.installed)await action({action:'install',databaseBindingId:m.fixture.binding.id,title:'Native acceptance '+m.runId,adminUser:username,adminEmail:secrets.siteAdminEmail,locale:'en_US',scheme:'http'},secrets.wpAdminPassword);
 const installed=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.installed');expect(installed.installed).toBe(true);expect(installed.loginUrl).toBe('http://'+m.fixture.hostname+'/wp-login.php');expect(installed.administrators).toContain(username);
 await page.goto(installed.loginUrl);await page.locator('#user_login').fill(username);await page.locator('#user_pass').fill(secrets.wpAdminPassword);await page.locator('#wp-submit').click();await expect(page).toHaveURL(/\/wp-admin\//);await expect(page.locator('#wpadminbar')).toBeVisible();record('wordpress.real-browser-login',{verified:true});
 const next=randomBytes(24).toString('base64url');secrets.pendingWpPassword=next;fs.writeFileSync(secretFile,JSON.stringify(secrets),{mode:0o600});await action({action:'password',username},next);secrets.wpAdminPassword=next;delete secrets.pendingWpPassword;fs.writeFileSync(secretFile,JSON.stringify(secrets),{mode:0o600});
 await page.context().clearCookies({domain:m.fixture.hostname});await page.goto(installed.loginUrl);await page.locator('#user_login').fill(username);await page.locator('#user_pass').fill(next);await page.locator('#wp-submit').click();await expect(page).toHaveURL(/\/wp-admin\//);record('wordpress.rotated-browser-login',{verified:true});
});

test('@mutation source mail domain and mailbox forms apply the actual service before closing',async({liveApi,page})=>{
 test.setTimeout(180000);const m=owned();
 if(!m.fixture.mailDomainId){await ready(page,'/mail');await main(page).getByRole('button',{name:'Mail alan adı ekle',exact:true}).first().click();const dialog=page.getByRole('dialog');await expect(dialog).toHaveCount(1);await dialog.getByRole('combobox',{name:'Alan adı',exact:true}).selectOption(m.fixture.domainId);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/mail-domains')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'Posta hizmetini oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(201);const current=manifest();current.fixture.mailDomainId=(await r.json()).data.id;saveManifest(current);await expect(dialog).toBeHidden({timeout:120000});
 }
 const now=manifest();const domain=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mail-domains/'+now.fixture.mailDomainId),'mail.native.enabled');expect(domain.status).toBe('enabled');
 await ready(page,'/mail/'+domain.id);const file=path.join(RUN_DIR,'fixture-secrets.json'),secrets=JSON.parse(fs.readFileSync(file,'utf8'));secrets.mailPasswords??={};
 for(const name of ['alpha','beta']){
  secrets.mailPasswords[name]??=randomBytes(24).toString('base64url');fs.writeFileSync(file,JSON.stringify(secrets),{mode:0o600});
  const boxes=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes?mailDomainId='+domain.id),'mail.boxes.read');if(boxes.some(b=>b.address===name+'@'+now.fixture.hostname))continue;
  await main(page).getByRole('button',{name:'E-posta hesabı oluştur',exact:true}).first().click();const dialog=page.getByRole('dialog');await expect(dialog).toHaveCount(1);await dialog.getByLabel('Adres',{exact:true}).fill(name);await dialog.getByLabel('İlk parola',{exact:true}).fill(secrets.mailPasswords[name]);const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/mailboxes')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'E-posta hesabı oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(201);const box=(await r.json()).data;const current=manifest();current.fixture.mailboxIds??=[];current.fixture.mailboxIds.push(box.id);saveManifest(current);await expect(dialog).toBeHidden({timeout:120000});await expect(main(page)).toContainText(name+'@'+now.fixture.hostname);
 }
 record('mail.native-forms',{verified:true,mailboxes:2});
 const current=manifest();const delivered=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/mailboxes/'+current.fixture.mailboxIds[0]+'/test-delivery',{recipient:'beta@'+current.fixture.hostname,subject:'OWNED-NATIVE-'+current.runId}),'mail.owned-delivery');expect(delivered.delivered).toBe(true);record('mail.owned-smtp-delivery',{verified:true});
});


test('@mutation source actual IMAP authentication finds the SMTP test message only in the owned recipient',async({liveApi})=>{
 test.setTimeout(45000);const m=owned();expect(m.fixture.mailboxIds?.length).toBe(2);
 const settings=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes/'+m.fixture.mailboxIds[1]+'/connection-settings'),'mail.imap.settings');
 const secrets=JSON.parse(fs.readFileSync(path.join(RUN_DIR,'fixture-secrets.json'),'utf8'));
 const hostname=settings.mailHostname??settings.incoming?.hostname;expect(typeof hostname).toBe('string');
 const result=await new Promise((resolve,reject)=>{
  const socket=tls.connect({host:'157.180.11.28',port:993,servername:hostname,rejectUnauthorized:true});let buffer='',stage='greeting',attempts=0;
  const timer=setTimeout(()=>fail('IMAP receipt deadline exceeded'),25000);
  function fail(message){clearTimeout(timer);socket.destroy();reject(new Error(message+'; credentials and protocol contents withheld'));}
  function search(){stage='search';socket.write('A3 SEARCH HEADER Subject '+JSON.stringify('OWNED-NATIVE-'+m.runId)+'\r\n');}
  socket.on('error',error=>fail('Trusted IMAP connection failed ('+(['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ECONNREFUSED','ECONNRESET'].includes(error.code)?error.code:'TLS_OR_TRANSPORT_ERROR')+')'));
  socket.on('data',chunk=>{
   buffer+=chunk.toString();
   if(stage==='greeting'&&buffer.includes('\r\n')){buffer='';stage='login';socket.write('A1 LOGIN '+JSON.stringify('beta@'+m.fixture.hostname)+' '+JSON.stringify(secrets.mailPasswords.beta)+'\r\n');return;}
   if(stage==='login'&&/A1 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A1 OK '))return fail('Actual mailbox authentication failed');buffer='';stage='examine';socket.write('A2 EXAMINE INBOX\r\n');return;}
   if(stage==='examine'&&/A2 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A2 OK '))return fail('Owned mailbox could not be examined');buffer='';search();return;}
   if(stage==='search'&&/A3 (OK|NO|BAD) /.test(buffer)){const found=/\* SEARCH [0-9]+/.test(buffer);if(found){clearTimeout(timer);socket.end('A4 LOGOUT\r\n');resolve({authenticated:true,received:true});}else if(++attempts<20){buffer='';stage='waiting';setTimeout(search,500);}else fail('SMTP message was not present in the actual recipient');}
  });
 });expect(result.received).toBe(true);record('mail.actual-imap-receipt',result);
});

test('@mutation source real backup restores file content, SQL, the owned mail account configuration and protected environment catalog',async({liveApi})=>{
 test.setTimeout(240000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId;
 const secretFile=path.join(RUN_DIR,'fixture-secrets.json'),secrets=JSON.parse(fs.readFileSync(secretFile,'utf8'));
 await nativeMailboxPassword(liveApi,m,secrets.mailPasswords.beta);
 const repos=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/backups/repositories'),'backup.repositories');
 const repo=repos.find(item=>item.name==='website-'+m.fixture.websiteId);expect(repo?.status).toBe('ready');
 const markerName='native-restore-proof-'+m.runId+'.txt',marker='NATIVE-RESTORE-'+m.runId;
 await upload(liveApi,m,markerName,marker);
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup/preview',{repositoryId:repo.id}),'backup.preview');
 const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'backup',repositoryId:repo.id,
   expectedPreviewDigest:preview.backupSetDigest,confirmation:preview.confirmation,tags:['native-'+m.runId]}),'backup.queue',202);
 const backedUp=await finishedBackup(liveApi,root,queued);const snapshotId=backedUp.result?.snapshot?.snapshotId;expect(snapshotId).toBeTruthy();
 const current=manifest();current.fixture.nativeBackup={repositoryId:repo.id,snapshotId,operationId:queued.id,markerName};saveManifest(current);
 await upload(liveApi,m,markerName,'CHANGED-'+m.runId);
 secrets.nativeBackupChangedPassword??=randomBytes(28).toString('base64url');fs.writeFileSync(secretFile,JSON.stringify(secrets),{mode:0o600});
 await nativeMailboxPassword(liveApi,m,secrets.nativeBackupChangedPassword);
 const connection=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases/'+m.fixture.binding.id+'/connection',{revealPassword:true}),'backup.database.connection');
 const sqlName='native-restore-sql-'+m.runId+'.php';
 const changedProof='CHANGED-'+m.runId+'-'+randomBytes(6).toString('hex');
 const sql='<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli('+[connection.host,connection.username,connection.password,connection.databaseName].map(value=>JSON.stringify(value)).join(',')+');if($_SERVER["REQUEST_METHOD"]==="POST"){$db->query('+JSON.stringify("UPDATE yp_native_proof SET value='"+changedProof+"' WHERE id=1")+');}$row=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();echo json_encode(["proof"=>$row["value"]]);';
 await upload(liveApi,m,sqlName,sql);
 const sqlUrl='https://'+m.fixture.hostname+'/'+sqlName;
 const before=await liveApi.api.get(sqlUrl);expect(before.status()).toBe(200);const beforeRow=await before.json();
 expect(beforeRow.proof).not.toBe(changedProof);
 const changedRow=await liveApi.api.post(sqlUrl);expect(changedRow.status()).toBe(200);expect((await changedRow.json()).proof).toBe(changedProof);
 const input={repositoryId:repo.id,snapshotId,healthPath:'/'+markerName,timeoutSeconds:30,include:['paths','databases','mail','/var/lib/yunpanel/backups/resources/website/'+m.fixture.websiteId+'/env-metadata.json']};
 const restorePreview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/restore/preview',input),'backup.restore.preview');
 const restore=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'restore',...input,
   expectedPreviewDigest:restorePreview.previewDigest,confirmation:restorePreview.confirmation}),'backup.restore.queue',202);
 try {
  await finishedBackup(liveApi,root,restore);
  const actual=await liveApi.api.get('https://'+m.fixture.hostname+'/'+markerName);expect(actual.status()).toBe(200);expect(await actual.text()).toBe(marker);
  const restoredRow=await liveApi.api.get(sqlUrl);expect(restoredRow.status()).toBe(200);expect((await restoredRow.json()).proof).toBe(beforeRow.proof);
  record('backup.real-file-and-sql-content',{verified:true,snapshotId,restoreOperationId:restore.id});
 } finally {await remove(liveApi,m,sqlName);}
 // The next IMAP test authenticates with the original private password and
 // locates the original SMTP message after the native Maildir replacement.
});


test('@mutation source WordPress plugin and theme lifecycle changes real inventory and keeps the actual site responding', async ({ liveApi, page }) => {
 test.setTimeout(360000); const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress';
 const initial=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.packages.initial');expect(initial.installed).toBe(true);
 const plugin='hello-dolly',theme='twentytwentyone',previousTheme=initial.themes.find(item=>item.status==='active')?.name;
 expect(previousTheme).toBeTruthy();expect(previousTheme).not.toBe(theme);
 async function action(options){
  const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',{options}),'wordpress.package.preview');
  const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/actions',{options,requestId:randomUUID(),expectedWebsiteRevision:preview.websiteRevision,
   previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'wordpress.package.queue',202);
  const job=await waitJob(liveApi.api,queued.job.id,180000);record('wordpress.package.native',{action:options.action,package:options.package,status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
  const status=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.package.inventory');
  const response=await liveApi.api.get('https://'+m.fixture.hostname+'/');expect(response.status()).toBe(200);
  return status;
 }
 let current=initial;
 if(!current.plugins.some(item=>item.name===plugin))current=await action({action:'plugin.install',package:plugin});
 expect(current.plugins.some(item=>item.name===plugin)).toBe(true);
 current=await action({action:'plugin.activate',package:plugin});expect(current.plugins.find(item=>item.name===plugin)?.status).toBe('active');
 current=await action({action:'plugin.deactivate',package:plugin});expect(current.plugins.find(item=>item.name===plugin)?.status).toBe('inactive');
 current=await action({action:'plugin.remove',package:plugin});expect(current.plugins.some(item=>item.name===plugin)).toBe(false);
 if(!current.themes.some(item=>item.name===theme))current=await action({action:'theme.install',package:theme});
 current=await action({action:'theme.activate',package:theme});expect(current.themes.find(item=>item.name===theme)?.status).toBe('active');
 const themed=await liveApi.api.get('https://'+m.fixture.hostname+'/');expect(await themed.text()).toContain('/themes/'+theme+'/');
 current=await action({action:'theme.activate',package:previousTheme});expect(current.themes.find(item=>item.name===previousTheme)?.status).toBe('active');
 current=await action({action:'theme.remove',package:theme});expect(current.themes.some(item=>item.name===theme)).toBe(false);
 await ready(page,'/websites/'+m.fixture.domainId+'/wordpress');await expect(main(page).getByRole('heading',{name:'WordPress',exact:true})).toBeVisible();
 await expect(page.getByRole('dialog')).toHaveCount(0);record('wordpress.package-lifecycle',{verified:true,pluginRemoved:true,themeRemoved:true,previousThemeRestored:true});
});

test('@mutation source WordPress refuses CLI success when a plugin breaks actual HTTP and verifies the real backup rollback', async ({ liveApi }) => {
 test.setTimeout(240000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress';
 const slug='yp-owned-health-failure',pluginPath='wp-content/plugins/'+slug+'.php';
 await upload(liveApi,m,pluginPath,'<?php\n/* Plugin Name: YunPanel owned health verification */\nif (!defined("WP_CLI") || !WP_CLI) { http_response_code(503); exit("Owned health verification"); }\n');
 try {
  const before=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.failure.before');
  expect(before.plugins.some(item=>item.name===slug)).toBe(true);
  const options={action:'plugin.activate',package:slug};
  const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',{options}),'wordpress.failure.preview');
  const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/actions',{options,requestId:randomUUID(),expectedWebsiteRevision:preview.websiteRevision,
   previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'wordpress.failure.queue',202);
  const job=await waitJob(liveApi.api,queued.job.id,180000);record('wordpress.real-http-failure',{status:job.status,code:job.error?.code});
  expect(job.status).toBe('failed');expect(job.error?.code).toBe('wordpress_http_health_failed');
  const actual=await liveApi.api.get('https://'+m.fixture.hostname+'/');expect(actual.status()).toBe(200);expect(await actual.text()).not.toBe('Owned health verification');
  const after=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.failure.after');expect(after.plugins.find(item=>item.name===slug)?.status).toBe('inactive');
  record('wordpress.real-http-rollback',{verified:true,pluginInactive:true});
 } finally {await remove(liveApi,m,pluginPath);}
});

test('@mutation source WordPress core update verifies real checksums, inventory and HTTP through the current worker', async ({ liveApi }) => {
 test.setTimeout(240000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress',options={action:'core.update'};
 const before=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.core.before');expect(before.installed).toBe(true);
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',{options}),'wordpress.core.preview');
 const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/actions',{options,requestId:randomUUID(),expectedWebsiteRevision:preview.websiteRevision,
  previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'wordpress.core.queue',202);
 const job=await waitJob(liveApi.api,queued.job.id,180000);record('wordpress.core.native',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
 const after=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.core.after');expect(after.installed).toBe(true);
 const actual=await liveApi.api.get('https://'+m.fixture.hostname+'/');expect(actual.status()).toBe(200);
 record('wordpress.core.result',{verified:true,beforeVersion:before.coreVersion,afterVersion:after.coreVersion,versionChanged:before.coreVersion!==after.coreVersion});
});

test('@mutation source WordPress removal removes actual core files and prefix tables, preserves other content, then restores the owned installation', async ({ liveApi }) => {
 test.setTimeout(240000);
 const m = owned(), websiteRoot = '/api/panel/websites/' + m.fixture.websiteId, root = websiteRoot + '/wordpress';
 const saved = m.fixture.nativeBackup;
 expect(saved?.snapshotId).toBeTruthy();
 const connection = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/servers/' + m.serverId + '/websites/' + m.fixture.websiteId + '/databases/' + m.fixture.binding.id + '/connection', { revealPassword: true }), 'wordpress.remove.connection');
 const probe = 'native-wp-remove-proof-' + m.runId + '.php';
 const source = '<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli(' + [connection.host, connection.username, connection.password, connection.databaseName].map(value => JSON.stringify(value)).join(',') + ');$tables=[];$r=$db->query("SHOW TABLES");while($row=$r->fetch_row()){$tables[]=$row[0];}$proof=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();echo json_encode(["wpTables"=>array_values(array_filter($tables,fn($name)=>str_starts_with($name,"' + ('yp' + m.fixture.websiteId.replaceAll('-', '').slice(0, 12) + '_') + '"))),"otherProof"=>$proof["value"]]);';
 let queued = false;
 try {
 await upload(liveApi, m, probe, source);
 const url = 'https://' + m.fixture.hostname + '/' + probe;
 const beforeResponse = await liveApi.api.get(url); expect(beforeResponse.status()).toBe(200);
 const before = await beforeResponse.json(); expect(before.wpTables.length).toBeGreaterThan(8);
  const options = { action: 'remove' };
  const preview = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/preview', { options }), 'wordpress.remove.preview');
  const result = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/actions', { options, requestId: randomUUID(), expectedWebsiteRevision: preview.websiteRevision, previewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'wordpress.remove.queue', 202);
  queued = true;
  const job = await waitJob(liveApi.api, result.job.id, 120000);
  record('wordpress.remove.native', { status: job.status, code: job.error?.code });
  expect(job.status).toBe('succeeded');
  const afterResponse = await liveApi.api.get(url); expect(afterResponse.status()).toBe(200);
  const after = await afterResponse.json(); expect(after.wpTables).toEqual([]); expect(after.otherProof).toBe(before.otherProof);
  const files = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/websites/' + m.fixture.websiteId + '/files'), 'wordpress.remove.files');
  const names = (files.entries ?? files.files ?? []).map(entry => entry.name);
  for (const name of ['wp-config.php', 'wp-load.php', 'wp-admin', 'wp-includes', 'wp-content']) expect(names).not.toContain(name);
  expect(names).toContain(probe);
  record('wordpress.remove.physical-content', { verified: true, prefixTablesRemoved: true, unrelatedContentPreserved: true });
 } finally {
  if (queued) {
   const input = { repositoryId: saved.repositoryId, snapshotId: saved.snapshotId, healthPath: '/', timeoutSeconds: 30, include: ['paths', 'databases'] };
   const preview = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', websiteRoot + '/restore/preview', input), 'wordpress.remove.restore-preview');
   const operation = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', websiteRoot + '/backup-operations', { kind: 'restore', ...input, expectedPreviewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'wordpress.remove.restore-queue', 202);
   await finishedBackup(liveApi, websiteRoot, operation);
   const status = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', root), 'wordpress.remove.restored'); expect(status.installed).toBe(true);
   const actual = await liveApi.api.get('https://' + m.fixture.hostname + '/'); expect(actual.status()).toBe(200);
   record('wordpress.remove.restored-installation', { verified: true });
  }
  await remove(liveApi, m, probe);
 }
});
