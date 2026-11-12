import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import {randomBytes,randomUUID,createHmac,createHash} from 'node:crypto';
import {request} from '@playwright/test';
import {test,expect,apiContext,waitJob,RUN_DIR,ORIGIN,ready,main} from './support.js';
import {createOwnedFixture,cleanupOwnedFixture,readOnlyHostProbe} from './owned-fixture.js';
import {nextRemovalStep} from '../../apps/web/src/workspace/website-removal-model.js';
import {createMailboxRemoval} from '../../apps/web/src/workspace/mailbox-removal-controller.js';

test.describe.configure({mode:'serial'});

// These acceptance gates are retained, never counted as passing or skipped tests.
export const openAcceptances=[

 {id:'13.04',oldCommit:'ba33f4a8^',title:'recovers only the owned static Domain left by the earlier incomplete Website removal plan',assertions:['an orphan Domain belonging to an interrupted removal is recovered using its exact journal and checksum'],reason:'The old case used one fixed October journal. Current normal provisioning and automatic removal do not provide a supported way to manufacture that orphan without corrupting server state.',requiredChannel:'An actual owned interrupted Domain journal, or a separately approved process interruption test'},
 {id:'13.07.version-switch',oldCommit:'ba33f4a8^',title:'PHP version and settings change the actual FPM runtime and persist in the site record',assertions:['a different available PHP major/minor is selected and actual FPM HTTP agrees'],reason:'The authorized native host has only PHP 8.3 installed. Same-version FPM settings are tested separately; installing another server-wide runtime is outside this test scope.',requiredChannel:'A second installed supported PHP runtime'},
 ...(process.env.YUNPANEL_AUDIT_MANAGED_REPAIR==='1'?[]:[{id:'13.02',oldCommit:'ba33f4a8^',title:'managed phpMyAdmin repair stages actual templates and verifies the native gateway',assertions:['repair job succeeded and configuration applied, HTTP/FPM/gateway sockets healthy, transaction receipt'],reason:'Managed repair changes a shared server service. It is executable only in a separately exclusive server window after effect review.',requiredChannel:'Explicit managed repair flag and server-global plus all test-slot locks'}]),
];
let primary,owner,state,stateFile,secretsFile,uploadedStatic,primaryKey,staticKey;
const manifest=()=>state;
function saveManifest(value){state=value;fs.writeFileSync(stateFile,JSON.stringify(value,null,2),{mode:0o600});}
function owned(){expect(primary?.ledger.websiteId,'The current run must own its disposable PHP site').toBe(state?.fixture.websiteId);return state;}
function record(action,data){primary.record(action,data);state.fixture.operations.push({action,...data,at:new Date().toISOString()});saveManifest(state);}
function check(r,label,status=200){record(label,{status:r.status,code:r.body?.error?.code??null});expect(Array.isArray(status)?status:[status],label+' '+(r.body?.error?.code??'')).toContain(r.status);return r.data;}
async function apiCall(api,csrf,method,endpoint,data){
 let response;for(let attempt=0;;attempt++){try{response=await api.fetch(endpoint,{method,data,headers:{Origin:ORIGIN,'x-csrf-token':csrf},timeout:120000,maxRedirects:0});}catch(error){if(method==='GET'&&attempt<3){await new Promise(r=>setTimeout(r,700));continue;}throw error;}if(method==='GET'&&[502,503,504].includes(response.status())&&attempt<3){await new Promise(r=>setTimeout(r,700));continue;}break;}
 const body=await response.json().catch(()=>({}));return{status:response.status(),body,data:body.data??body};
}
function secrets(){return JSON.parse(fs.readFileSync(secretsFile,'utf8'));}
function saveSecrets(value){fs.writeFileSync(secretsFile,JSON.stringify(value),{mode:0o600});}
async function ownRepository(c){
 const all=check(await apiCall(c.api,c.csrf,'GET','/api/panel/backups/repositories'),'backup.repository.inventory');
 let repo=all.find(v=>v.name==='website-'+state.fixture.websiteId);
 if(!repo){const password=randomBytes(32).toString('base64url');const sec=secrets();sec.repositoryPassword=password;saveSecrets(sec);repo=check(await apiCall(c.api,c.csrf,'POST','/api/panel/backups/repositories',{name:'website-'+state.fixture.websiteId,backend:'local',password,initialize:true}),'backup.repository.create',[200,201]);}
 expect(state.baselineRepositoryIds).not.toContain(repo.id);expect(repo.target).toBe('/var/lib/yunpanel/backups/restic/repos/'+repo.id);expect(repo.status).toBe('ready');state.fixture.repository={id:repo.id,target:repo.target};saveManifest(state);return repo;
}
test.beforeAll(async({},info)=>{
 test.setTimeout(300000);
 owner=await apiContext();
 primaryKey='t886-13-'+info.project.name;staticKey='t886-13-static-'+info.project.name;
 primary=await createOwnedFixture(owner,{key:primaryKey,runtime:'php'});
 stateFile=path.join(RUN_DIR,'t886-13-'+info.project.name+'-ledger.json');secretsFile=path.join(RUN_DIR,'t886-13-'+info.project.name+'-secrets.json');
 const repos=await apiCall(owner.api,owner.csrf,'GET','/api/panel/backups/repositories');expect(repos.status).toBe(200);
 state={sourceSha256:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),helperSha256:createHash('sha256').update(fs.readFileSync(new URL('./owned-fixture.js',import.meta.url))).digest('hex'),runId:primary.ledger.runId,serverId:primary.ledger.serverId,baselineRepositoryIds:repos.data.map(v=>v.id),fixture:{...primary.ledger,provisioningReady:true,createdWebsiteIds:[primary.ledger.websiteId],createdDomainIds:[primary.ledger.domainId],databaseName:'t886_'+primary.ledger.nonce,operations:[]}};
 saveManifest(state);saveSecrets({siteAdminEmail:'t886@example.invalid',wpAdminPassword:randomBytes(30).toString('base64url')+'!aA7'});
 await primary.upload('sibling-proof.txt','T886-SIBLING-'+state.runId);
});
test.afterAll(async()=>{
 test.setTimeout(360000);
 const failures=[];
 if(owner&&state?.fixture.mailboxIds)for(const id of state.fixture.mailboxIds){try{await removeMailbox(owner,id);}catch(e){failures.push('mailbox '+id+': '+String(e.message).split('\n')[0]);}}
 if(uploadedStatic){try{await uploadedStatic.cleanup();}catch(e){failures.push('static cleanup: '+String(e.message).split('\n')[0]);}}
 if(owner&&staticKey&&!uploadedStatic&&fs.existsSync(path.join(RUN_DIR,'owned-fixtures',staticKey+'.json'))){try{await cleanupOwnedFixture(owner,{key:staticKey});}catch(e){failures.push('static ledger cleanup: '+String(e.message).split('\n')[0]);}}
 if(primary){try{await primary.cleanup();}catch(e){failures.push('primary cleanup: '+String(e.message).split('\n')[0]);}}
 else if(owner&&primaryKey&&fs.existsSync(path.join(RUN_DIR,'owned-fixtures',primaryKey+'.json'))){try{await cleanupOwnedFixture(owner,{key:primaryKey});}catch(e){failures.push('primary ledger cleanup: '+String(e.message).split('\n')[0]);}}
 await owner?.api.dispose();
 expect(failures,'All owned resources must be cleaned through their normal panel lifecycle').toEqual([]);
});
async function removeMailbox(c,id){
 const base='/api/panel/mailboxes/'+id;let r=await apiCall(c.api,c.csrf,'GET',base);if(r.status===404)return;const box=check(r,'cleanup.mailbox.read');expect(box.mailDomainId).toBe(state.fixture.mailDomainId);
 if(box.enabled){check(await apiCall(c.api,c.csrf,'PATCH',base,{expectedRevision:box.revision,enabled:false}),'cleanup.mailbox.disable');await applyMail(c,state.fixture.mailDomainId,'enabled');}
 const controller=createMailboxRemoval({target:{id,address:box.address,mailDomainId:box.mailDomainId},canManage:()=>true,request:async(route,options={})=>{const result=await apiCall(c.api,c.csrf,options.method??'GET','/api/panel'+route,options.body);if(result.status>=400)throw new Error('Mail cleanup HTTP '+result.status+' '+result.body.error?.code);return result.data;}});
 try{await controller.refresh();for(const action of ['backup','delete','finalize']){await controller.prepare(action);let view=controller.getState();expect(view.approval,'Mailbox cleanup '+action+': '+view.error).toBeTruthy();await controller.confirm(view.approval,view.approval.data.confirmation);view=controller.getState();if(view.job&&['queued','running'].includes(view.job.status)){const j=await waitJob(c.api,view.job.id);expect(j.status,'Mailbox cleanup '+action).toBe('succeeded');await controller.refresh();}expect(controller.getState().error).toBeNull();}expect(controller.getState().status).toBe('deleted');}finally{controller.dispose();}
}
async function applyMail(c,id,status='enabled'){
 const domain=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mail-domains/'+id),'mail.apply.domain');const input={expectedRevision:domain.revision,status};
 const preview=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+id+'/config-preview',input),'mail.apply.preview');
 const q=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+id+'/config-apply',{...input,previewDigest:preview.previewDigest,configurationSha256:preview.configuration.sha256,confirmation:preview.confirmation}),'mail.apply.queue',202);
 expect((await waitJob(c.api,q.id)).status).toBe('succeeded');
}
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
   ...input,previewDigest:preview.previewDigest,configurationSha256:preview.configuration.sha256,confirmation:preview.confirmation,requestId:randomUUID()}),'backup.mail.apply.queue',202);
 expect((await waitJob(c.api,job.id)).status).toBe('succeeded');
}

test('@mutation source three-step form creates an uploaded static site without Git and serves the actual uploaded HTML',async({page,liveApi},info)=>{
 test.setTimeout(300000);const m=owned();
 uploadedStatic=await createOwnedFixture(owner,{key:staticKey,runtime:'static',create:async(input,_preview,recordInput)=>{
  const route='**/api/panel/sites';const observe=async routed=>{if(routed.request().method()==='POST')recordInput(routed.request().postDataJSON().input);await routed.continue();};await page.route(route,observe);
  try{await ready(page,'/websites/new');await page.getByLabel('Alan adı',{exact:true}).fill(input.primaryDomain);await page.locator('label').filter({hasText:'www davranışı'}).locator('select').selectOption('none');await main(page).getByRole('button',{name:'Devam et',exact:true}).click();
   await page.getByLabel('Site türü',{exact:true}).selectOption('new_static_upload');await expect(page.getByRole('textbox',{name:'GitHub repository',exact:true})).toHaveCount(0);await main(page).getByRole('button',{name:'Devam et',exact:true}).click();await page.getByLabel('DNS yönetimi',{exact:true}).selectOption('external');await page.getByLabel('Sertifika yönetimi',{exact:true}).selectOption('off');await page.getByRole('checkbox',{name:/Otomatik E-Posta|E-posta ve Webmail/}).uncheck();
   const createdEvent=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/panel/sites'&&r.request().method()==='POST',{timeout:180000});await main(page).getByRole('button',{name:'Siteyi oluştur',exact:true}).click();const response=await createdEvent;expect([200,201]).toContain(response.status());const created=(await response.json()).data;await expect(main(page).getByLabel('Site kurulum durumu')).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı',{timeout:180000});return created;
  }finally{await page.unroute(route,observe);}
 }});
 const target=uploadedStatic.ledger;m.fixture.extraStatic={...target};m.fixture.createdWebsiteIds.push(target.websiteId);m.fixture.createdDomainIds.push(target.domainId);saveManifest(m);
 const application=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/applications/'+target.applicationId),'static.upload.application');expect(application.state).toBe('active');expect(application.repositoryUrl).toBe(null);expect(application.currentCommitSha).toBe(null);
 const marker='<!doctype html><html lang="tr"><head><title>Uploaded site</title></head><body><h1>STATIC-NATIVE-'+m.runId+'</h1></body></html>';await uploadedStatic.upload('index.html',marker);const actual=await uploadedStatic.http('/');expect(actual.status).toBe(200);expect(actual.body).toBe(marker);
 await ready(page,uploadedStatic.route('files'));await expect(main(page)).toContainText('index.html');await expect(page.getByRole('navigation',{name:'Site araçları'}).getByRole('link',{name:/Git/})).toHaveCount(0);record('static.upload.actual-html',{verified:true,websiteId:target.websiteId,noGitRequired:true});
});

test('@mutation @managed-repair source managed phpMyAdmin repair stages actual templates and verifies the native gateway', async ({ liveApi }) => {
 test.setTimeout(180000);expect(process.env.YUNPANEL_AUDIT_MANAGED_REPAIR,'Managed repair requires the separately approved exclusive server window').toBe('1');const m = owned();
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

async function upload(c,m,name,source){return check(await apiCall(c.api,c.csrf,'PUT','/api/panel/websites/'+m.fixture.websiteId+'/files/upload?path='+name,Buffer.from(source)),'native.file.upload',[200,201]);}

async function remove(c,m,name){check(await apiCall(c.api,c.csrf,'DELETE','/api/panel/websites/'+m.fixture.websiteId+'/files',{path:name,confirmation:'delete:'+m.fixture.websiteId+':'+name}),'native.file.remove');}

test('@mutation source one database form creates real schema, binding, grants and an application query',async({liveApi,page})=>{
 test.setTimeout(180000);const m=owned();await ready(page,'/databases');await main(page).getByRole('button',{name:'Veritabanı oluştur',exact:true}).first().click();
 const d=page.getByRole('dialog');await expect(d).toBeVisible();await d.locator('select').filter({has:page.locator('option[value="'+m.fixture.websiteId+'"]')}).selectOption(m.fixture.websiteId);await d.getByLabel('Veritabanı adı',{exact:true}).fill(m.fixture.databaseName);
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases'&&r.request().method()==='POST');
 await d.getByRole('button',{name:'Oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(202);const created=(await r.json()).data;
 m.fixture.binding=created.binding;m.fixture.credential=created.credential;m.fixture.createdDatabaseNames=[m.fixture.databaseName];saveManifest(m);
 const j=await waitJob(liveApi.api,created.job.id);expect(j.status).toBe('succeeded');await expect(d).toContainText('hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.',{timeout:30000});await d.getByRole('button',{name:'Tamam',exact:true}).click();await expect(d).toBeHidden();
 const connection=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases/'+created.binding.id+'/connection',{revealPassword:true}),'database.connection');expect(Boolean(connection.password&&connection.username&&connection.databaseName)).toBe(true);
 const proof='DB-NATIVE-'+m.runId,name='db-proof.php';const source='<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli('+[connection.host,connection.username,connection.password,connection.databaseName].map(v=>JSON.stringify(v)).join(',')+');$db->query("CREATE TABLE yp_native_proof (id INT PRIMARY KEY, value VARCHAR(128))");$s=$db->prepare("INSERT INTO yp_native_proof VALUES (1, ?)");$v='+JSON.stringify(proof)+';$s->bind_param("s",$v);$s->execute();$r=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();echo json_encode(["proof"=>$r["value"]]);';
 try{await upload(liveApi,m,name,source);const actual=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);expect(actual.status()).toBe(200);expect((await actual.json()).proof).toBe(proof);record('database.real-application-query',{verified:true,jobId:j.id});}finally{await remove(liveApi,m,name);}
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
  const preflight = await liveApi.api.get('http://' + m.fixture.hostname + '/' + probe);
  expect(preflight.status()).toBe(200); expect((await preflight.json()).present).toBe(false); absentVerified = true;
  await ready(page, '/websites/' + m.fixture.domainId + '/databases');
  await main(page).getByRole('row').filter({ hasText: m.fixture.databaseName }).getByRole('button', { name: 'SQL içe aktar', exact: true }).click();
  const importPage=page;
  await expect(importPage).toHaveURL(/\/tools\/phpmyadmin\/index.php\?/);
  expect(new URL(importPage.url()).searchParams.get('db')).toBe(m.fixture.databaseName);
  expect(new URL(importPage.url()).searchParams.get('route')).toBe('/database/import');
  await importPage.locator('input[type="file"][name="import_file"]').setInputFiles(file);
  const submit = importPage.getByRole('button', { name: /^(Import|Go|İçe aktar|Git)$/ });
  await expect(submit).toHaveCount(1);
  const responseEvent = importPage.waitForResponse(response => new URL(response.url()).pathname === '/tools/phpmyadmin/index.php' && response.request().method() === 'POST');
  await submit.click(); const response = await responseEvent; expect(response.status()).toBe(200);
  const actual = await liveApi.api.get('http://' + m.fixture.hostname + '/' + probe);
  expect(actual.status()).toBe(200); expect((await actual.json()).proof).toBe(proof);
  record('database.actual-phpmyadmin-sql-import', { verified: true, table, uniqueRowVerified: true });
 } finally {
  if (absentVerified) {
   const removed = await liveApi.api.post('http://' + m.fixture.hostname + '/' + probe);
   expect(removed.status()).toBe(200); expect((await removed.json()).removed).toBe(true);
   const cleanup = manifest(); cleanup.fixture.createdSqlImportTables.find(item => item.table === table).removed = true; saveManifest(cleanup);
  }
  if (uploaded) await remove(liveApi, m, probe);
 }
});

test('@mutation source PHP settings change the actual FPM runtime and persist at the installed version',async({liveApi})=>{
 test.setTimeout(120000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/php-tools/config';
 const before=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'php.config.read');const target=before.phpVersion;
 const config={phpVersion:target,maxChildren:before.fpm.maxChildren===10?11:10,memoryLimitMb:256,maxExecutionSeconds:31};
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',config),'php.config.preview');
 const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root,{config,expectedRevision:preview.websiteRevision,previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'php.config.queue',202);
 const job=await waitJob(liveApi.api,queued.job.id);record('php.native.finished',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
 const after=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'php.config.persisted');expect(after.phpVersion).toBe(target);expect(after.fpm.maxChildren).toBe(config.maxChildren);expect(after.fpm.memoryLimitMb).toBe(256);expect(after.fpm.maxExecutionSeconds).toBe(31);
 const name='php-runtime-proof.php';try{await upload(liveApi,m,name,'<?php header("Content-Type: application/json");echo json_encode(["version"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"memory"=>ini_get("memory_limit"),"seconds"=>ini_get("max_execution_time")]);');const http=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);expect(http.status()).toBe(200);const actual=await http.json();expect(actual.version).toBe(target);expect(actual.memory).toBe('256M');expect(actual.seconds).toBe('31');record('php.actual-http-runtime',{verified:true,...actual});}finally{await remove(liveApi,m,name);}
});

async function browserLogin(browser,installed,username,password,phase='initial'){
 const c=await browser.newContext({ignoreHTTPSErrors:false,storageState:{cookies:[],origins:[]}});
 try{const hostname=new URL(installed.loginUrl).hostname;const previousSiteSessions=(await c.cookies()).filter(v=>v.domain===hostname||v.domain==='.'+hostname).length;expect(previousSiteSessions,'A fresh login context must contain no site session').toBe(0);const p=await c.newPage();const response=await p.goto(installed.loginUrl,{waitUntil:'domcontentloaded'});record('wordpress.browser-login.http',{phase,status:response?.status()??null,hostname:new URL(p.url()).hostname,path:new URL(p.url()).pathname,title:await p.title(),formInputs:await p.locator('#user_login').count(),previousSiteSessions});await p.locator('#user_login').fill(username);await p.locator('#user_pass').fill(password);await p.locator('#wp-submit').click();await expect(p).toHaveURL(/\/wp-admin\//);await expect(p.locator('#wpadminbar')).toBeVisible();}finally{await c.close();}
}

test('@mutation source WordPress installs in Turkish against the real site DB and authenticates in a fresh browser',async({liveApi,page,browser})=>{
 test.setTimeout(480000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress',sec=secrets(),username='t886_admin';expect(m.fixture.binding?.id).toBeTruthy();
 await ready(page,'/websites/'+m.fixture.domainId+'/wordpress');const form=main(page).locator('form.ws-form-grid');await expect(form).toBeVisible();
 await form.getByLabel('Site başlığı',{exact:true}).fill('T886 Türkçe '+m.runId);await form.getByLabel('Yönetici kullanıcı adı',{exact:true}).fill(username);await form.getByLabel('Yönetici e-posta adresi',{exact:true}).fill(sec.siteAdminEmail);await form.locator('input[type=password]').fill(sec.wpAdminPassword);
 await form.locator('select').filter({has:page.locator('option[value=tr_TR]')}).selectOption('tr_TR');await form.locator('select').filter({has:page.locator('option[value=http]')}).selectOption('http');await form.locator('select').filter({has:page.locator('option[value="'+m.fixture.binding.id+'"]')}).selectOption(m.fixture.binding.id);
 const queued=page.waitForResponse(r=>new URL(r.url()).pathname===root+'/actions'&&r.request().method()==='POST',{timeout:180000});await form.getByRole('button',{name:'WordPress kur',exact:true}).click();const response=await queued;expect(response.status()).toBe(202);const install=(await response.json()).data;
 expect((await waitJob(liveApi.api,install.job.id,420000)).status).toBe('succeeded');
 const installed=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.installed');expect(installed.installed).toBe(true);expect(installed.loginUrl).toBe('http://'+m.fixture.hostname+'/wp-login.php');expect(installed.administrators).toContain(username);
 const http=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(http.status()).toBe(200);expect(await http.text()).toMatch(/<html[^>]*\blang=["']tr(?:-TR)?["']/i);const locale=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/wp-cli/run',{command:'eval',args:['echo json_encode(array("locale"=>get_locale(),"available"=>in_array("tr_TR",get_available_languages(),true)));','--skip-plugins','--skip-themes','--skip-packages'],timeout:30000}),'wordpress.actual-locale');expect(locale.success).toBe(true);expect(JSON.parse(locale.stdout.trim())).toEqual({locale:'tr_TR',available:true});
 await browserLogin(browser,installed,username,sec.wpAdminPassword);record('wordpress.real-browser-login',{verified:true});

});

test('@mutation source mail domain and mailbox forms apply the actual service before closing',async({liveApi,page})=>{
 test.setTimeout(180000);const m=owned();
 if(!m.fixture.mailDomainId){await ready(page,'/mail');await main(page).getByRole('button',{name:'Mail alan adı ekle',exact:true}).first().click();const dialog=page.getByRole('dialog');await expect(dialog).toHaveCount(1);await dialog.locator('select').filter({has:page.locator('option[value="'+m.fixture.domainId+'"]')}).selectOption(m.fixture.domainId);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/mail-domains')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'Posta hizmetini oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(201);const current=manifest();current.fixture.mailDomainId=(await r.json()).data.id;saveManifest(current);await expect(dialog).toBeHidden({timeout:120000});
 }
 const now=manifest();const domain=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mail-domains/'+now.fixture.mailDomainId),'mail.native.enabled');expect(domain.status).toBe('enabled');
 await ready(page,'/mail/'+domain.id);const file=secretsFile,secrets=JSON.parse(fs.readFileSync(file,'utf8'));secrets.mailPasswords??={};
 for(const name of ['alpha','beta']){
  secrets.mailPasswords[name]??=randomBytes(24).toString('base64url');fs.writeFileSync(file,JSON.stringify(secrets),{mode:0o600});
  const boxes=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes?mailDomainId='+domain.id),'mail.boxes.read');expect(boxes.some(b=>b.address===name+'@'+now.fixture.hostname),'Every fresh mailbox must be created through its form').toBe(false);
  await main(page).getByRole('button',{name:'E-posta hesabı oluştur',exact:true}).first().click();const dialog=page.getByRole('dialog');await expect(dialog).toHaveCount(1);await dialog.getByLabel('Adres',{exact:true}).fill(name);await dialog.getByLabel('İlk parola',{exact:true}).fill(secrets.mailPasswords[name]);const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/mailboxes')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'E-posta hesabı oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(201);const box=(await r.json()).data;const current=manifest();current.fixture.mailboxIds??=[];current.fixture.mailboxIds.push(box.id);saveManifest(current);await expect(dialog).toBeHidden({timeout:120000});await expect(main(page)).toContainText(name+'@'+now.fixture.hostname);const actualBox=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes/'+box.id),'mail.actual-enabled');expect(actualBox.enabled).toBe(true);
 }
 record('mail.native-forms',{verified:true,mailboxes:2});
 const current=manifest();const delivered=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/mailboxes/'+current.fixture.mailboxIds[0]+'/test-delivery',{recipient:'beta@'+current.fixture.hostname,subject:'OWNED-NATIVE-'+current.runId}),'mail.owned-delivery');expect(delivered.delivered).toBe(true);record('mail.owned-smtp-delivery',{verified:true});
});


async function verifyProtectedWebhookSecret(secret,expectedStatus){
 const jobEndpoint='/api/panel/jobs?resourceId='+state.fixture.applicationId;const before=check(await apiCall(owner.api,owner.csrf,'GET',jobEndpoint),'webhook.jobs.before').map(job=>job.id).sort();
 const api=await request.newContext({baseURL:ORIGIN,ignoreHTTPSErrors:false,storageState:{cookies:[],origins:[]}});
 try{const body='{}',signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');const response=await api.post('/api/webhooks/github/'+state.fixture.applicationId,{data:body,headers:{'content-type':'application/json','x-github-event':'ping','x-github-delivery':randomUUID(),'x-hub-signature-256':signature},timeout:30000});expect(response.status(),'Actual protected secret HMAC verification').toBe(expectedStatus);const result=await response.json();if(expectedStatus===202)expect(result.data).toMatchObject({status:'ignored',reason:'event_not_supported',event:'ping'});else expect(result.error?.code).toBe('github_webhook_signature_invalid');}finally{await api.dispose();}const after=check(await apiCall(owner.api,owner.csrf,'GET',jobEndpoint),'webhook.jobs.after').map(job=>job.id).sort();expect(after,'Signed non-push verification must not queue a deployment').toEqual(before);
}
async function imapReceipt({hostname,address,password,subject=null}){
 return await new Promise((resolve,reject)=>{
 const socket=tls.connect({host:'157.180.11.28',port:993,servername:hostname,rejectUnauthorized:true});let buffer='',stage='greeting';
 const timer=setTimeout(()=>finish(new Error('Actual IMAP receipt deadline exceeded; credentials and protocol withheld')),25000);
 function finish(error,result){clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(result);}
 socket.on('error',()=>finish(new Error('Trusted IMAP transport failed; credentials and protocol withheld')));
 socket.on('data',chunk=>{buffer+=chunk.toString();
 if(stage==='greeting'&&buffer.includes('\r\n')){stage='login';buffer='';socket.write('A1 LOGIN '+JSON.stringify(address)+' '+JSON.stringify(password)+'\r\n');return;}
 if(stage==='login'&&/A1 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A1 OK '))return finish(null,{authenticated:false});if(!subject)return finish(null,{authenticated:true});stage='examine';buffer='';socket.write('A2 EXAMINE INBOX\r\n');return;}
 if(stage==='examine'&&/A2 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A2 OK '))return finish(new Error('Owned IMAP inbox could not be examined'));stage='search';buffer='';socket.write('A3 SEARCH HEADER Subject '+JSON.stringify(subject)+'\r\n');return;}
 if(stage==='search'&&/A3 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A3 OK '))return finish(new Error('Actual IMAP subject search failed'));const matches=(buffer.match(/\* SEARCH([^\r\n]*)/)?.[1]??'').trim().split(/\s+/).filter(v=>/^\d+$/.test(v));finish(null,{authenticated:true,received:matches.length>0,messages:matches.length});}
 });
 });
}
test('@mutation source actual IMAP authentication finds the SMTP test message only in the owned recipient',async({liveApi})=>{
 test.setTimeout(90000);const m=owned();expect(m.fixture.mailboxIds?.length).toBe(2);const sec=secrets();
 const settings=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes/'+m.fixture.mailboxIds[1]+'/connection-settings'),'mail.imap.settings');const hostname=settings.mailHostname??settings.incoming?.hostname;expect(typeof hostname).toBe('string');m.fixture.mailHostname=hostname;saveManifest(m);
 const input={hostname,subject:'OWNED-NATIVE-'+m.runId};let received;
 for(let attempt=0;attempt<10;attempt++){received=await imapReceipt({...input,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta});if(received.received)break;await new Promise(r=>setTimeout(r,500));}
 expect(received).toMatchObject({authenticated:true,received:true,messages:1});
 const sender=await imapReceipt({...input,address:'alpha@'+m.fixture.hostname,password:sec.mailPasswords.alpha});expect(sender).toMatchObject({authenticated:true,received:false,messages:0});record('mail.actual-imap-receipt',{recipient:received,sender});
});

test('@mutation source real backup restores file content, SQL, mailbox authentication and the protected environment secret',async({liveApi})=>{
 test.setTimeout(480000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId,sec=secrets();expect(m.fixture.mailHostname).toBeTruthy();
 await nativeMailboxPassword(liveApi,m,sec.mailPasswords.beta);const repo=await ownRepository(liveApi);
 const markerName='native-restore-proof-'+m.runId+'.txt',marker='NATIVE-RESTORE-'+m.runId,sqlName='native-restore-sql-'+m.runId+'.php',changedProof='CHANGED-'+m.runId+'-'+randomBytes(6).toString('hex');
 const connection=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases/'+m.fixture.binding.id+'/connection',{revealPassword:true}),'backup.database.connection');
 const sql='<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli('+[connection.host,connection.username,connection.password,connection.databaseName].map(v=>JSON.stringify(v)).join(',')+');if($_SERVER["REQUEST_METHOD"]==="POST"){$db->query('+JSON.stringify("UPDATE yp_native_proof SET value='"+changedProof+"' WHERE id=1")+');}$row=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();echo json_encode(["proof"=>$row["value"]]);';
 await upload(liveApi,m,markerName,marker);await upload(liveApi,m,sqlName,sql);const sqlUrl='http://'+m.fixture.hostname+'/'+sqlName;const beforeSql=await liveApi.api.get(sqlUrl);expect(beforeSql.status()).toBe(200);const beforeRow=await beforeSql.json();
 const envRoot='/api/panel/applications/'+m.fixture.applicationId+'/github-webhook';sec.environmentBefore=randomBytes(32).toString('base64url');sec.environmentAfter=randomBytes(32).toString('base64url');saveSecrets(sec);
 check(await apiCall(liveApi.api,liveApi.csrf,'PUT',envRoot,{secret:sec.environmentBefore}),'backup.environment.original');
 const envBefore=check(await apiCall(liveApi.api,liveApi.csrf,'GET',envRoot),'backup.environment.before');await verifyProtectedWebhookSecret(sec.environmentBefore,202);
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup/preview',{repositoryId:repo.id}),'backup.preview');const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'backup',repositoryId:repo.id,expectedPreviewDigest:preview.backupSetDigest,confirmation:preview.confirmation,tags:['t886-'+m.runId]}),'backup.queue',202);
 const backedUp=await finishedBackup(liveApi,root,queued),snapshotId=backedUp.result?.snapshot?.snapshotId;expect(snapshotId).toBeTruthy();m.fixture.nativeBackup={repositoryId:repo.id,snapshotId,operationId:queued.id,markerName};saveManifest(m);
 await upload(liveApi,m,markerName,'CHANGED-'+m.runId);const changedSql=await liveApi.api.post(sqlUrl);expect(changedSql.status()).toBe(200);expect((await changedSql.json()).proof).toBe(changedProof);
 sec.nativeBackupChangedPassword=randomBytes(30).toString('base64url');saveSecrets(sec);await nativeMailboxPassword(liveApi,m,sec.nativeBackupChangedPassword);
 expect((await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.nativeBackupChangedPassword})).authenticated).toBe(true);
 check(await apiCall(liveApi.api,liveApi.csrf,'PUT',envRoot,{secret:sec.environmentAfter}),'backup.environment.changed');await verifyProtectedWebhookSecret(sec.environmentBefore,401);await verifyProtectedWebhookSecret(sec.environmentAfter,202);
 const input={repositoryId:repo.id,snapshotId,healthPath:'/'+markerName,timeoutSeconds:30,include:['paths','databases','mail','environment']};const restorePreview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/restore/preview',input),'backup.restore.preview');const restore=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'restore',...input,expectedPreviewDigest:restorePreview.previewDigest,confirmation:restorePreview.confirmation}),'backup.restore.queue',202);
 await finishedBackup(liveApi,root,restore);
 const actual=await liveApi.api.get('http://'+m.fixture.hostname+'/'+markerName);expect(actual.status()).toBe(200);expect(await actual.text()).toBe(marker);const restoredSql=await liveApi.api.get(sqlUrl);expect(restoredSql.status()).toBe(200);expect((await restoredSql.json()).proof).toBe(beforeRow.proof);
 const oldLogin=await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta,subject:'OWNED-NATIVE-'+m.runId});expect(oldLogin).toMatchObject({authenticated:true,received:true,messages:1});expect((await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.nativeBackupChangedPassword})).authenticated).toBe(false);
 const envAfter=check(await apiCall(liveApi.api,liveApi.csrf,'GET',envRoot),'backup.environment.restored');expect(envAfter).toEqual(envBefore);await verifyProtectedWebhookSecret(sec.environmentBefore,202);await verifyProtectedWebhookSecret(sec.environmentAfter,401);
 record('backup.real-content-and-authentication',{verified:true,snapshotId,restoreOperationId:restore.id,file:true,sql:true,originalMailboxAuthentication:true,changedMailboxAuthenticationRejected:true,messageRestored:true,environmentMetadata:true,environmentValueVerified:true,verificationQueuedNoDeployment:true});
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
  const response=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(response.status()).toBe(200);
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
 const themed=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(await themed.text()).toContain('/themes/'+theme+'/');
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
  const actual=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(actual.status()).toBe(200);expect(await actual.text()).not.toBe('Owned health verification');
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
 const actual=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(actual.status()).toBe(200);
 const checksum=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/wp-cli/run',{command:'core',args:['verify-checksums','--skip-plugins','--skip-themes','--skip-packages'],timeout:120000}),'wordpress.core.actual-checksums');expect(checksum.success).toBe(true);expect(checksum.exitCode).toBe(0);record('wordpress.core.result',{verified:true,beforeVersion:before.coreVersion,afterVersion:after.coreVersion,versionChanged:before.coreVersion!==after.coreVersion});
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
 const url = 'http://' + m.fixture.hostname + '/' + probe;
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
   const actual = await liveApi.api.get('http://' + m.fixture.hostname + '/'); expect(actual.status()).toBe(200);
   record('wordpress.remove.restored-installation', { verified: true });
  }
  if(!queued)await remove(liveApi,m,probe);
  const absent=await apiCall(liveApi.api,liveApi.csrf,'GET',websiteRoot+'/files/text?path='+probe);expect(absent.status).toBe(404);
 }
});


test('@mutation source WordPress administrator password rotates through the UI and authenticates in a fresh browser',async({liveApi,page,browser})=>{
 test.setTimeout(180000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress',sec=secrets(),username='t886_admin';const installed=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.password.installed');expect(installed.installed).toBe(true);
 await ready(page,'/websites/'+m.fixture.domainId+'/wordpress');await main(page).getByRole('button',{name:'Yönetici parolası',exact:true}).click();const d=page.getByRole('dialog');await expect(d).toBeVisible();const next=randomBytes(30).toString('base64url')+'!aA7';sec.pendingWpPassword=next;saveSecrets(sec);await d.getByLabel('Yeni parola',{exact:true}).fill(next);
 const passwordJob=page.waitForResponse(r=>new URL(r.url()).pathname===root+'/actions'&&r.request().method()==='POST');await d.getByRole('button',{name:'Yönetici parolasını değiştir',exact:true}).click();const changed=await passwordJob;const result=await changed.json().catch(()=>({}));const requestId=changed.request().postDataJSON()?.requestId;m.fixture.wpPasswordRequestId=requestId;saveManifest(m);record('wordpress.password.queue',{status:changed.status(),code:result.error?.code??null,requestId});if(changed.status()!==202){const existing=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/requests/'+requestId);record('wordpress.password.queue-readback',{status:existing.status,code:existing.body.error?.code??null,jobStatus:existing.data?.status??null});}expect(changed.status(),'WordPress password queue '+(result.error?.code??'unknown')).toBe(202);expect((await waitJob(liveApi.api,result.data.job.id)).status).toBe('succeeded');await expect(d).toBeHidden();
 sec.wpAdminPassword=next;delete sec.pendingWpPassword;saveSecrets(sec);const loginHttp=await primary.http('/wp-login.php');record('wordpress.password.login-http',{status:loginHttp.status,formPresent:/id=["']loginform["']/.test(loginHttp.body)});expect(loginHttp.status,'Actual login HTTP after password change').toBe(200);expect(loginHttp.body).toMatch(/id=["']loginform["']/);await browserLogin(browser,installed,username,next,'rotated');record('wordpress.rotated-browser-login',{verified:true,independentBrowserContext:true});
});


test('@mutation source uploaded static Website removal completes its real lifecycle and preserves the PHP sibling', async ({ liveApi }) => {
 test.setTimeout(240000); const m = owned(), target = m.fixture.extraStatic;
 expect(target?.websiteId).toBeTruthy(); expect(target.removed).not.toBe(true);
 expect(m.fixture.createdWebsiteIds).toContain(target.websiteId);
 const beforeNginx=readOnlyHostProbe(primary,'nginx-config');expect(beforeNginx.exists).toBe(true);expect(beforeNginx.sha256).toMatch(/^[a-f0-9]{64}$/);const beforeHttp=await primary.http('/');record('static.remove.sibling-before',{status:beforeHttp.status,nginxSha256:beforeNginx.sha256});expect(beforeHttp.status).toBe(200);
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
 const siblingHttp=await liveApi.api.get('http://'+m.fixture.hostname+'/');const direct=await primary.http('/');const afterNginx=readOnlyHostProbe(primary,'nginx-config');record('static.remove.sibling-after',{status:siblingHttp.status(),directStatus:direct.status,nginxSha256:afterNginx.sha256});if(siblingHttp.status()!==200||direct.status!==200){const physical=readOnlyHostProbe(primary,'owned-site-files');record('static.remove.sibling-runtime',{uid:physical.uid,unixUserExists:physical.unixUserExists,fpmFiles:physical.fpmFiles,sockets:physical.sockets});await new Promise(r=>setTimeout(r,1000));const followup=await primary.http('/');record('static.remove.sibling-followup',{status:followup.status});}expect(siblingHttp.status(),'Deleting the static site must preserve the PHP sibling immediately').toBe(200);expect(direct.status).toBe(200);expect(afterNginx.sha256).toBe(beforeNginx.sha256);
 const result = manifest(); result.fixture.extraStatic.removed = true; saveManifest(result);await uploadedStatic.cleanup();const physical=readOnlyHostProbe(uploadedStatic,'lifecycle-absence');expect(physical.unixUserExists).toBe(false);expect(physical.unixGroupExists).toBe(false);expect(physical.roots.every(v=>!v.exists)).toBe(true);expect(physical.fpmFiles).toEqual([]);expect(physical.sockets).toEqual([]);expect(physical.nginxFiles.every(v=>!v.exists)).toBe(true);
 record('static.remove.catalog-and-sibling', { verified: true, websiteId: target.websiteId,
  physicalAbsenceVerified: true });
});
