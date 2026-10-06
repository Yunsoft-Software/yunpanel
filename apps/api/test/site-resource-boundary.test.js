import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteResourceBoundary, needsSiteResourceJson } from '../src/site-resource-boundary.js';
const websites = [{id:'site-a',serverId:'server',applicationId:'app-a'},{id:'site-b',serverId:'server',applicationId:'app-b'}];
const domains = [{id:'domain-a',websiteId:'site-a',serverId:'server',certificateId:'cert-a'},{id:'domain-b',websiteId:'site-b',serverId:'server',certificateId:'cert-b'}];
const bindings = [{id:'binding-a',websiteId:'site-a',serverId:'server',applicationId:'app-a',databaseName:'alpha'},{id:'binding-b',websiteId:'site-b',serverId:'server',applicationId:'app-b',databaseName:'beta'}];
const credentials = bindings.map((binding,i)=>({...binding,id:`credential-${i?'b':'a'}`,databaseBindingId:binding.id}));
const mails = [{id:'mail-a',webDomainId:'domain-a',managementMode:'local'},{id:'mail-b',webDomainId:'domain-b',managementMode:'local'}];
const jobs = [{id:'job-a',serverId:'server',resourceType:'database',resourceId:'alpha'},{id:'job-b',serverId:'server',resourceType:'database',resourceId:'beta'},{id:'job-root',serverId:'server',resourceType:'system',resourceId:'server'}];
const lookup=(items)=>async id=>items.find(v=>v.id===id);
const options = {
 localServerId:'server',websiteRegistry:{getWebsite:lookup(websites)},domainRegistry:{getDomain:lookup(domains),listDomains:async()=>domains},
 databaseBindingRegistry:{getBinding:lookup(bindings),listBindings:async()=>bindings},databaseCredentialRegistry:{getCredential:lookup(credentials)},
 mailDomainRegistry:{getMailDomain:lookup(mails)},mailboxRegistry:{getMailbox:lookup([{id:'box-a',mailDomainId:'mail-a'},{id:'box-b',mailDomainId:'mail-b'}])},
 mailAliasRegistry:{getAlias:lookup([{id:'alias-a',mailDomainId:'mail-a'},{id:'alias-b',mailDomainId:'mail-b'}])},jobRegistry:{getJob:lookup(jobs),listJobs:async()=>jobs},
};
const auth={user:{id:'user',role:'site_manager',websiteIds:['site-a']},access:{mode:'site_management'},security:{managementAllowed:true}};
async function run(url,{method='GET',body,session=auth,dependencies=options,output}={}){
 const req={url,originalUrl:url,method,body,auth:session};
 const res={statusCode:200,headers:{},status(n){this.statusCode=n;return this;},setHeader(k,v){this.headers[k]=v;},json(value){this.body=value;return this;}};
 let called=0;await createSiteResourceBoundary(dependencies)(req,res,()=>{called++;if(output)res.json(output);});return{res,called};
}
test('own files work; cross-website read, edit, download and upload stop before handler',async()=>{
 for(const suffix of ['files?path=','files/text?path=index.php','files/download?path=.env','files/upload?path=file']){
  assert.equal((await run(`/api/websites/site-a/${suffix}`)).called,1);
  for(const method of ['GET','PUT','DELETE']){const v=await run(`/api/websites/site-b/${suffix}`,{method});assert.equal(v.res.statusCode,403);assert.equal(v.called,0);}
 }
});
test('database resources require an assigned Website and the matching local server',async()=>{
 assert.equal((await run('/api/servers/server/websites/site-a/database-resources')).called,1);
 for(const path of ['/api/servers/server/websites/site-b/database-resources','/api/servers/foreign/websites/site-a/database-resources'])assert.equal((await run(path)).res.statusCode,403);
});
test('binding and credential actions are resolved from the registry, not a forged body',async()=>{
 for(const path of ['/api/servers/server/database-bindings/binding-b/credential','/api/servers/server/database-credentials/credential-b/password/rotate']){
  const v=await run(path,{method:'POST',body:{websiteId:'site-a'}});assert.equal(v.called,0);assert.equal(v.res.statusCode,403);
 }
 assert.equal((await run('/api/servers/server/database-bindings/binding-a/credential',{method:'POST'})).called,1);
 assert.equal((await run('/api/servers/server/database-credentials/credential-a/apply',{method:'POST'})).called,1);
});
test('handoff requires both assigned site and matching credential',async()=>{
 for (const handoffName of ['phpmyadmin-handoffs', 'pgadmin-handoffs']) {
  const path=`/api/servers/server/websites/site-a/${handoffName}`;
  assert.equal((await run(path,{method:'POST',body:{credentialId:'credential-a'}})).called,1);
  assert.equal((await run(path,{method:'POST',body:{credentialId:'credential-b'}})).res.statusCode,403);
  assert.equal((await run(path,{method:'POST',body:{}})).res.statusCode,403);
  assert.equal((await run(`/api/servers/server/websites/site-b/${handoffName}`,{method:'POST',body:{credentialId:'credential-b'}})).res.statusCode,403);
  assert.equal((await run(`/api/servers/server/websites/site-b/${handoffName}`,{method:'POST',body:{credentialId:'credential-a'}})).res.statusCode,403);
 }
});
test('unbound and global database inventories, mutations, and database unbinding are unavailable to site managers',async()=>{
 for(const path of ['/api/servers/server/databases','/api/servers/server/databases/unbound/bind','/api/servers/server/database-bindings']){
  for(const method of ['GET','POST','DELETE'])assert.equal((await run(path,{method})).res.statusCode,403);
 }
 assert.equal((await run('/api/servers/server/database-bindings/binding-a',{method:'DELETE'})).res.statusCode,403);
 assert.equal((await run('/api/servers/server/websites/site-a/database-bindings/binding-a',{method:'DELETE'})).res.statusCode,403);
});
test('nested database actions cannot substitute another binding',async()=>{
 assert.equal((await run('/api/servers/server/websites/site-a/database-bindings/binding-b/backup',{method:'POST'})).res.statusCode,403);
});
test('mail collection returns only explicit Website links and no global counts',async()=>{
 const v=await run('/api/mail-domains',{output:{data:mails,total:2}});assert.deepEqual(v.res.body,{data:[mails[0]]});
});
test('mailbox and alias collections require one authorized mail domain',async()=>{
 for(const path of ['/api/mailboxes','/api/mail-aliases']){
  assert.equal((await run(path)).res.statusCode,403);
  assert.equal((await run(path+'?mailDomainId=mail-b')).res.statusCode,403);
  assert.equal((await run(path+'?mailDomainId=mail-a&mailDomainId=mail-b')).res.statusCode,403);
  assert.equal((await run(path+'?mailDomainId=mail-a')).called,1);
 }
});
test('mailbox creation, quota and password changes cannot cross mail ownership',async()=>{
 assert.equal((await run('/api/mailboxes',{method:'POST',body:{mailDomainId:'mail-a'}})).called,1);
 assert.equal((await run('/api/mailboxes',{method:'POST',body:{mailDomainId:'mail-b'}})).called,0);
 for(const suffix of ['','/password','/quota','/forwarding','/data/delete']) assert.equal((await run('/api/mailboxes/box-b'+suffix,{method:'POST'})).res.statusCode,403);
 assert.equal((await run('/api/mail-aliases/alias-b',{method:'PATCH'})).res.statusCode,403);
});
test('shared webmail provisioning is read-only for the site account',async()=>{
 assert.equal((await run('/api/mail-domains/mail-a/webmail')).called,1);
 assert.equal((await run('/api/mail-domains/mail-a/webmail/bind',{method:'POST'})).res.statusCode,403);
 assert.equal((await run('/api/mail-domains/mail-b/webmail')).res.statusCode,403);
 for(const p of ['/api/mail/queue','/api/roundcube/config','/api/servers/server/system/packages'])assert.equal((await run(p)).res.statusCode,403);
});
test('site context inventories and job results are limited before response serialization',async()=>{
 assert.deepEqual((await run('/api/websites',{output:{data:websites}})).res.body.data,[websites[0]]);
 assert.deepEqual((await run('/api/domains',{output:{data:domains}})).res.body.data,[domains[0]]);
 assert.deepEqual((await run('/api/jobs',{output:{data:jobs}})).res.body.data,[jobs[0]]);
 assert.equal((await run('/api/jobs/job-b')).res.statusCode,403);
 assert.equal((await run('/api/jobs/job-a')).called,1);
});
test('server collection is minimal metadata without host inventory',async()=>{
 const v=await run('/api/servers',{output:{data:[{id:'server',hostname:'local',inventory:{private:'info'},displayName:'Local',executionMode:'local',connectivity:'online'}]}});
 assert.equal(v.res.body.data[0].inventory,undefined);assert.equal(v.res.body.data[0].id,'server');
});
test('missing registry and permission lookup failure fail closed',async()=>{
 const v=await run('/api/websites/site-a/files',{dependencies:{}});assert.equal(v.called,0);assert.equal(v.res.statusCode,503);
 const deps={...options,websiteRegistry:{getWebsite:async()=>{throw new Error('secret connection string');}}};
 const denied=await run('/api/websites/site-a/files',{dependencies:deps});assert.equal(denied.res.statusCode,503);assert.doesNotMatch(JSON.stringify(denied.res.body),/secret connection/);
});
test('stale Website bindings and credential reassignment fail closed',async()=>{
 const deps={...options,databaseCredentialRegistry:{getCredential:async()=>({...credentials[0],databaseBindingId:'binding-b'})}};
 assert.equal((await run('/api/servers/server/database-credentials/credential-a/apply',{dependencies:deps,method:'POST'})).res.statusCode,403);
 const drift={...options,websiteRegistry:{getWebsite:async()=>({...websites[0],applicationId:'reassigned'})}};
 assert.equal((await run('/api/servers/server/database-bindings/binding-a/credential',{dependencies:drift})).res.statusCode,403);
});
test('owner and read-only still use their existing authorization boundaries; owner is authorized on all database operations and unbinding',async()=>{
 for(const role of ['owner','read_only'])assert.equal((await run('/api/servers/server/databases',{session:{user:{role}},dependencies:{}})).called,1);
 assert.equal((await run('/api/servers/server/database-bindings/binding-a',{method:'DELETE',session:{user:{role:'owner'}},dependencies:{}})).called,1);
 assert.equal((await run('/api/servers/server/database-bindings/binding-b',{method:'DELETE',session:{user:{role:'owner'}},dependencies:{}})).called,1);
 assert.equal((await run('/api/websites/site-a/files',{session:{...auth,security:{managementAllowed:false}}})).res.statusCode,403);
});
test('only small identity-bearing JSON bodies are parsed ahead of the inner app',()=>{
 assert.equal(needsSiteResourceJson({auth,method:'POST',url:'/api/mailboxes'}),true);
 assert.equal(needsSiteResourceJson({auth,method:'POST',url:'/api/servers/server/websites/site-a/phpmyadmin-handoffs'}),true);
 assert.equal(needsSiteResourceJson({auth,method:'POST',url:'/api/websites'}),true);
 assert.equal(needsSiteResourceJson({auth,method:'POST',url:'/api/websites/site-a'}),true);
 assert.equal(needsSiteResourceJson({auth,method:'POST',url:'/api/sites'}),true);
 assert.equal(needsSiteResourceJson({auth,method:'PUT',url:'/api/websites/site-a/files/upload?path=index.php'}),false);
 assert.equal(needsSiteResourceJson({auth,method:'PUT',url:'/api/websites/site-a/files/text'}),false);
});
test('site config preview preserves exact apply tokens but omits global domain and artifact data',async()=>{
 const data={readyToApply:true,previewDigest:'digest',confirmation:'confirm',currentStatus:'enabled',desiredStatus:'enabled',configuration:{sha256:'hash',counts:{mailboxes:1000},artifactDigests:[{path:'/etc/private'}]},domains:[{name:'other.test'}]};
 const v=await run('/api/mail-domains/mail-a/config-preview',{method:'POST',output:{data}});
 assert.equal(v.called,1);assert.equal(v.res.body.data.previewDigest,'digest');assert.deepEqual(v.res.body.data.configuration,{sha256:'hash'});assert.equal(v.res.body.data.domains,undefined);assert.doesNotMatch(JSON.stringify(v.res.body),/other\.test|1000|private/);
});

test('disabled mail domain cannot be enabled via site-scoped config preview or apply', async () => {
 const disabledMail = [{ id: 'mail-dis', webDomainId: 'domain-a', managementMode: 'local', status: 'disabled' }];
 const deps = { ...options, mailDomainRegistry: { getMailDomain: async (id) => disabledMail.find((m) => m.id === id) || null } };
 const attemptPreview = await run('/api/mail-domains/mail-dis/config-preview', {
  method: 'POST',
  body: { expectedRevision: 1, status: 'enabled' },
  dependencies: deps,
 });
 assert.equal(attemptPreview.res.statusCode, 403);
 assert.equal(attemptPreview.called, 0);

 const attemptApply = await run('/api/mail-domains/mail-dis/config-apply', {
  method: 'POST',
  body: { expectedRevision: 1, status: 'enabled', previewDigest: 'a'.repeat(64), configurationSha256: 'b'.repeat(64), confirmation: 'confirm' },
  dependencies: deps,
 });
 assert.equal(attemptApply.res.statusCode, 403);
 assert.equal(attemptApply.called, 0);

 const validPreview = await run('/api/mail-domains/mail-dis/config-preview', {
  method: 'POST',
  body: { expectedRevision: 1, status: 'disabled' },
  dependencies: deps,
  output: { data: { readyToApply: true, previewDigest: 'd', confirmation: 'c', currentStatus: 'disabled', desiredStatus: 'disabled' } },
 });
 assert.equal(validPreview.called, 1);
});

test('reseller actor site resource boundary enforces child customer scope and rejects foreign/owner resources', async () => {
 const resellerSession = {
  user: { id: 'reseller-1', role: 'reseller', websiteIds: ['site-a'], active: true },
  access: { mode: 'site_management' },
  security: { managementAllowed: true },
 };

 // 1. Mailbox access: own mail domain allowed, foreign mail domain 403
 assert.equal((await run('/api/mailboxes?mailDomainId=mail-a', { session: resellerSession })).called, 1);
 const foreignMailboxes = await run('/api/mailboxes?mailDomainId=mail-b', { session: resellerSession });
 assert.equal(foreignMailboxes.called, 0);
 assert.equal(foreignMailboxes.res.statusCode, 403);

 // 2. Mailbox create: own mail domain allowed, foreign mail domain 403
 assert.equal((await run('/api/mailboxes', { session: resellerSession, method: 'POST', body: { mailDomainId: 'mail-a' } })).called, 1);
 const foreignCreate = await run('/api/mailboxes', { session: resellerSession, method: 'POST', body: { mailDomainId: 'mail-b' } });
 assert.equal(foreignCreate.called, 0);
 assert.equal(foreignCreate.res.statusCode, 403);

 // 3. Mailbox individual read: own mailbox allowed, foreign mailbox 403
 assert.equal((await run('/api/mailboxes/box-a', { session: resellerSession })).called, 1);
 const foreignBox = await run('/api/mailboxes/box-b', { session: resellerSession });
 assert.equal(foreignBox.called, 0);
 assert.equal(foreignBox.res.statusCode, 403);

 // 4. Mail alias access: own alias allowed, foreign alias 403
 assert.equal((await run('/api/mail-aliases/alias-a', { session: resellerSession })).called, 1);
 const foreignAlias = await run('/api/mail-aliases/alias-b', { session: resellerSession, method: 'PATCH' });
 assert.equal(foreignAlias.called, 0);
 assert.equal(foreignAlias.res.statusCode, 403);

 // 5. phpMyAdmin handoff: own website allowed with credential, foreign website 403
 const ownHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
  session: resellerSession,
  method: 'POST',
  body: { credentialId: 'credential-a' },
 });
 assert.equal(ownHandoff.called, 1);

 const foreignHandoff = await run('/api/servers/server/websites/site-b/phpmyadmin-handoffs', {
  session: resellerSession,
  method: 'POST',
  body: { credentialId: 'credential-b' },
 });
 assert.equal(foreignHandoff.called, 0);
 assert.equal(foreignHandoff.res.statusCode, 403);

 // 6. Database bindings and credentials: cross-reseller blocked
 const foreignBinding = await run('/api/servers/server/database-bindings/binding-b/credential', {
  session: resellerSession,
  method: 'POST',
 });
 assert.equal(foreignBinding.called, 0);
 assert.equal(foreignBinding.res.statusCode, 403);

 // 7. Domain creation on foreign website blocked
 const foreignDomain = await run('/api/domains', {
  session: resellerSession,
  method: 'POST',
  body: { websiteId: 'site-b' },
 });
 assert.equal(foreignDomain.called, 0);
 assert.equal(foreignDomain.res.statusCode, 403);

 const ownDomain = await run('/api/domains', {
  session: resellerSession,
  method: 'POST',
  body: { websiteId: 'site-a' },
 });
 assert.equal(ownDomain.called, 1);

 // 8. Dynamic customerLookup support when websiteIds is not in session
 const dynamicDeps = {
  ...options,
  websiteRegistry: {
   getWebsite: async (id) => (id === 'site-a' ? { ...websites[0], customerId: 'cust-a' } : { ...websites[1], customerId: 'cust-b' }),
  },
  customerLookup: async (id) => (id === 'cust-a' ? { id: 'cust-a', resellerId: 'reseller-dyn' } : { id: 'cust-b', resellerId: 'other-reseller' }),
 };
 const dynamicSession = {
  user: { id: 'reseller-dyn', role: 'reseller', active: true },
  access: { mode: 'site_management' },
  security: { managementAllowed: true },
 };

 const dynamicOwnHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
  session: dynamicSession,
  dependencies: dynamicDeps,
  method: 'POST',
  body: { credentialId: 'credential-a' },
 });
 assert.equal(dynamicOwnHandoff.called, 1);

 const dynamicForeignHandoff = await run('/api/servers/server/websites/site-b/phpmyadmin-handoffs', {
  session: dynamicSession,
  dependencies: dynamicDeps,
  method: 'POST',
  body: { credentialId: 'credential-b' },
 });
 assert.equal(dynamicForeignHandoff.called, 0);
 assert.equal(dynamicForeignHandoff.res.statusCode, 403);
});

test('customer actor site resource boundary manages own website DB credentials/password/phpmyadmin but cannot unbind or cross-access foreign site DB resources', async () => {
 const customerSession = {
  user: { id: 'customer-1', role: 'customer', websiteIds: ['site-a'], active: true },
  access: { mode: 'site_management' },
  security: { managementAllowed: true },
 };

 // 1. Own database resources allowed, foreign site 403
 assert.equal((await run('/api/servers/server/websites/site-a/database-resources', { session: customerSession })).called, 1);
 const foreignDbRes = await run('/api/servers/server/websites/site-b/database-resources', { session: customerSession });
 assert.equal(foreignDbRes.called, 0);
 assert.equal(foreignDbRes.res.statusCode, 403);

 // 2. Credential actions on own binding allowed, foreign binding 403
 assert.equal((await run('/api/servers/server/database-bindings/binding-a/credential', { session: customerSession, method: 'POST' })).called, 1);
 const foreignBinding = await run('/api/servers/server/database-bindings/binding-b/credential', { session: customerSession, method: 'POST' });
 assert.equal(foreignBinding.called, 0);
 assert.equal(foreignBinding.res.statusCode, 403);

 // 3. Database unbind is forbidden even on own site binding
 const unbindAttempt = await run('/api/servers/server/database-bindings/binding-a', { session: customerSession, method: 'DELETE' });
 assert.equal(unbindAttempt.called, 0);
 assert.equal(unbindAttempt.res.statusCode, 403);

 const nestedUnbindAttempt = await run('/api/servers/server/websites/site-a/database-bindings/binding-a', { session: customerSession, method: 'DELETE' });
 assert.equal(nestedUnbindAttempt.called, 0);
 assert.equal(nestedUnbindAttempt.res.statusCode, 403);

 // 4. Password rotation on own credential allowed, foreign credential 403
 assert.equal((await run('/api/servers/server/database-credentials/credential-a/password/rotate', { session: customerSession, method: 'POST' })).called, 1);
 const foreignRotate = await run('/api/servers/server/database-credentials/credential-b/password/rotate', { session: customerSession, method: 'POST' });
 assert.equal(foreignRotate.called, 0);
 assert.equal(foreignRotate.res.statusCode, 403);

 // 5. phpMyAdmin handoff: own website allowed with credential, foreign website 403
 const ownHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
  session: customerSession,
  method: 'POST',
  body: { credentialId: 'credential-a' },
 });
 assert.equal(ownHandoff.called, 1);

 const foreignHandoff = await run('/api/servers/server/websites/site-b/phpmyadmin-handoffs', {
  session: customerSession,
  method: 'POST',
  body: { credentialId: 'credential-b' },
 });
 assert.equal(foreignHandoff.called, 0);
 assert.equal(foreignHandoff.res.statusCode, 403);

 // 6. Global databases and unbind forbidden
 for (const p of ['/api/servers/server/databases', '/api/servers/server/databases/alpha/bind', '/api/servers/server/database-bindings']) {
  const r = await run(p, { session: customerSession });
  assert.equal(r.called, 0);
  assert.equal(r.res.statusCode, 403);
 }
});

test('comprehensive multi-tenant hierarchy matrix (Owner, 2 Reseller, 4 Customer, Direct Owner Customer) resource boundary isolation', async () => {
  const topologyWebsites = [
    { id: 'site-1a', serverId: 'server', applicationId: 'app-1a', customerId: 'customer-1a', resellerId: 'reseller-1' },
    { id: 'site-1b', serverId: 'server', applicationId: 'app-1b', customerId: 'customer-1b', resellerId: 'reseller-1' },
    { id: 'site-2a', serverId: 'server', applicationId: 'app-2a', customerId: 'customer-2a', resellerId: 'reseller-2' },
    { id: 'site-2b', serverId: 'server', applicationId: 'app-2b', customerId: 'customer-2b', resellerId: 'reseller-2' },
    { id: 'site-direct', serverId: 'server', applicationId: 'app-direct', customerId: 'customer-direct', resellerId: null },
  ];
  const topologyDomains = [
    { id: 'domain-1a', websiteId: 'site-1a', serverId: 'server', certificateId: 'cert-1a' },
    { id: 'domain-1b', websiteId: 'site-1b', serverId: 'server', certificateId: 'cert-1b' },
    { id: 'domain-2a', websiteId: 'site-2a', serverId: 'server', certificateId: 'cert-2a' },
    { id: 'domain-2b', websiteId: 'site-2b', serverId: 'server', certificateId: 'cert-2b' },
    { id: 'domain-direct', websiteId: 'site-direct', serverId: 'server', certificateId: 'cert-direct' },
  ];
  const topologyBindings = [
    { id: 'binding-1a', websiteId: 'site-1a', serverId: 'server', applicationId: 'app-1a', databaseName: 'db_1a' },
    { id: 'binding-1b', websiteId: 'site-1b', serverId: 'server', applicationId: 'app-1b', databaseName: 'db_1b' },
    { id: 'binding-2a', websiteId: 'site-2a', serverId: 'server', applicationId: 'app-2a', databaseName: 'db_2a' },
    { id: 'binding-2b', websiteId: 'site-2b', serverId: 'server', applicationId: 'app-2b', databaseName: 'db_2b' },
    { id: 'binding-direct', websiteId: 'site-direct', serverId: 'server', applicationId: 'app-direct', databaseName: 'db_direct' },
  ];
  const topologyCredentials = topologyBindings.map((b) => ({
    ...b,
    id: `credential-${b.id.replace('binding-', '')}`,
    databaseBindingId: b.id,
  }));
  const topologyMails = [
    { id: 'mail-1a', webDomainId: 'domain-1a', managementMode: 'local' },
    { id: 'mail-1b', webDomainId: 'domain-1b', managementMode: 'local' },
    { id: 'mail-2a', webDomainId: 'domain-2a', managementMode: 'local' },
    { id: 'mail-2b', webDomainId: 'domain-2b', managementMode: 'local' },
    { id: 'mail-direct', webDomainId: 'domain-direct', managementMode: 'local' },
  ];
  const topologyBoxes = [
    { id: 'box-1a', mailDomainId: 'mail-1a' },
    { id: 'box-1b', mailDomainId: 'mail-1b' },
    { id: 'box-2a', mailDomainId: 'mail-2a' },
    { id: 'box-2b', mailDomainId: 'mail-2b' },
    { id: 'box-direct', mailDomainId: 'mail-direct' },
  ];
  const topologyAliases = [
    { id: 'alias-1a', mailDomainId: 'mail-1a' },
    { id: 'alias-1b', mailDomainId: 'mail-1b' },
    { id: 'alias-2a', mailDomainId: 'mail-2a' },
    { id: 'alias-2b', mailDomainId: 'mail-2b' },
    { id: 'alias-direct', mailDomainId: 'mail-direct' },
  ];
  const topologyJobs = [
    { id: 'job-1a', serverId: 'server', resourceType: 'website', resourceId: 'site-1a', payload: { websiteId: 'site-1a' } },
    { id: 'job-1b', serverId: 'server', resourceType: 'website', resourceId: 'site-1b', payload: { websiteId: 'site-1b' } },
    { id: 'job-2a', serverId: 'server', resourceType: 'website', resourceId: 'site-2a', payload: { websiteId: 'site-2a' } },
    { id: 'job-2b', serverId: 'server', resourceType: 'website', resourceId: 'site-2b', payload: { websiteId: 'site-2b' } },
    { id: 'job-direct', serverId: 'server', resourceType: 'website', resourceId: 'site-direct', payload: { websiteId: 'site-direct' } },
  ];
  const customerDb = {
    'customer-1a': { id: 'customer-1a', kind: 'customer', resellerId: 'reseller-1', active: true },
    'customer-1b': { id: 'customer-1b', kind: 'customer', resellerId: 'reseller-1', active: true },
    'customer-2a': { id: 'customer-2a', kind: 'customer', resellerId: 'reseller-2', active: true },
    'customer-2b': { id: 'customer-2b', kind: 'customer', resellerId: 'reseller-2', active: true },
    'customer-direct': { id: 'customer-direct', kind: 'customer', resellerId: null, active: true },
  };

  const matrixDeps = {
    localServerId: 'server',
    websiteRegistry: {
      getWebsite: lookup(topologyWebsites),
      listWebsites: async () => topologyWebsites,
    },
    domainRegistry: {
      getDomain: lookup(topologyDomains),
      listDomains: async () => topologyDomains,
    },
    databaseBindingRegistry: {
      getBinding: lookup(topologyBindings),
      listBindings: async () => topologyBindings,
    },
    databaseCredentialRegistry: {
      getCredential: lookup(topologyCredentials),
    },
    mailDomainRegistry: {
      getMailDomain: lookup(topologyMails),
    },
    mailboxRegistry: {
      getMailbox: lookup(topologyBoxes),
    },
    mailAliasRegistry: {
      getAlias: lookup(topologyAliases),
    },
    jobRegistry: {
      getJob: lookup(topologyJobs),
      listJobs: async () => topologyJobs,
    },
    customerLookup: async (id) => customerDb[id] ?? null,
  };

  // Actors
  const ownerSession = {
    user: { id: 'owner-user', role: 'owner', active: true },
    access: { mode: 'management' },
    security: { managementAllowed: true },
  };
  const reseller1Session = {
    user: { id: 'reseller-1', role: 'reseller', websiteIds: ['site-1a', 'site-1b'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const reseller2Session = {
    user: { id: 'reseller-2', role: 'reseller', websiteIds: ['site-2a', 'site-2b'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const customer1ASession = {
    user: { id: 'customer-1a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, websiteIds: ['site-1a'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const customer1BSession = {
    user: { id: 'customer-1b', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-1' }, websiteIds: ['site-1b'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const customer2ASession = {
    user: { id: 'customer-2a', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-2' }, websiteIds: ['site-2a'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const customer2BSession = {
    user: { id: 'customer-2b', role: 'customer', hosting: { kind: 'customer', resellerId: 'reseller-2' }, websiteIds: ['site-2b'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const customerDirectSession = {
    user: { id: 'customer-direct', role: 'customer', hosting: { kind: 'customer', resellerId: null }, websiteIds: ['site-direct'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };

  const runMatrix = async (url, { method = 'GET', body, session = customer1ASession, output } = {}) => {
    return run(url, { method, body, session, dependencies: matrixDeps, output });
  };

  const assertFailClosedNoLeak = (result, forbiddenTokens = []) => {
    assert.equal(result.called, 0);
    assert.ok(result.res.statusCode === 403 || result.res.statusCode === 404);
    const bodyStr = JSON.stringify(result.res.body ?? {});
    for (const token of forbiddenTokens) {
      assert.equal(bodyStr.includes(token), false, `Response leaked sensitive metadata: ${token}`);
    }
  };

  // 1. Customer scope visibility in collections
  // Customer 1A sees only attached site-1a
  const c1aSites = await runMatrix('/api/websites', { session: customer1ASession, output: { data: topologyWebsites } });
  assert.deepEqual(c1aSites.res.body.data.map((w) => w.id), ['site-1a']);

  const c1aDomains = await runMatrix('/api/domains', { session: customer1ASession, output: { data: topologyDomains } });
  assert.deepEqual(c1aDomains.res.body.data.map((d) => d.id), ['domain-1a']);

  const c1aJobs = await runMatrix('/api/jobs', { session: customer1ASession, output: { data: topologyJobs } });
  assert.deepEqual(c1aJobs.res.body.data.map((j) => j.id), ['job-1a']);

  // Customer 1B sees only attached site-1b
  const c1bSites = await runMatrix('/api/websites', { session: customer1BSession, output: { data: topologyWebsites } });
  assert.deepEqual(c1bSites.res.body.data.map((w) => w.id), ['site-1b']);

  const c1bDomains = await runMatrix('/api/domains', { session: customer1BSession, output: { data: topologyDomains } });
  assert.deepEqual(c1bDomains.res.body.data.map((d) => d.id), ['domain-1b']);

  // Customer 2A sees only attached site-2a
  const c2aSites = await runMatrix('/api/websites', { session: customer2ASession, output: { data: topologyWebsites } });
  assert.deepEqual(c2aSites.res.body.data.map((w) => w.id), ['site-2a']);

  const c2aDomains = await runMatrix('/api/domains', { session: customer2ASession, output: { data: topologyDomains } });
  assert.deepEqual(c2aDomains.res.body.data.map((d) => d.id), ['domain-2a']);

  // Customer 2B sees only attached site-2b
  const c2bSites = await runMatrix('/api/websites', { session: customer2BSession, output: { data: topologyWebsites } });
  assert.deepEqual(c2bSites.res.body.data.map((w) => w.id), ['site-2b']);

  const c2bDomains = await runMatrix('/api/domains', { session: customer2BSession, output: { data: topologyDomains } });
  assert.deepEqual(c2bDomains.res.body.data.map((d) => d.id), ['domain-2b']);

  // Reseller 1 sees only direct child customer sites: site-1a and site-1b
  const r1Sites = await runMatrix('/api/websites', { session: reseller1Session, output: { data: topologyWebsites } });
  assert.deepEqual(r1Sites.res.body.data.map((w) => w.id).sort(), ['site-1a', 'site-1b']);

  const r1Domains = await runMatrix('/api/domains', { session: reseller1Session, output: { data: topologyDomains } });
  assert.deepEqual(r1Domains.res.body.data.map((d) => d.id).sort(), ['domain-1a', 'domain-1b']);

  const r1Jobs = await runMatrix('/api/jobs', { session: reseller1Session, output: { data: topologyJobs } });
  assert.deepEqual(r1Jobs.res.body.data.map((j) => j.id).sort(), ['job-1a', 'job-1b']);

  // Reseller 2 sees only direct child customer sites: site-2a and site-2b
  const r2Sites = await runMatrix('/api/websites', { session: reseller2Session, output: { data: topologyWebsites } });
  assert.deepEqual(r2Sites.res.body.data.map((w) => w.id).sort(), ['site-2a', 'site-2b']);

  const r2Domains = await runMatrix('/api/domains', { session: reseller2Session, output: { data: topologyDomains } });
  assert.deepEqual(r2Domains.res.body.data.map((d) => d.id).sort(), ['domain-2a', 'domain-2b']);

  // Direct Owner customer sees only site-direct
  const directSites = await runMatrix('/api/websites', { session: customerDirectSession, output: { data: topologyWebsites } });
  assert.deepEqual(directSites.res.body.data.map((w) => w.id), ['site-direct']);

  // Owner sees all 5 sites
  const oSites = await runMatrix('/api/websites', { session: ownerSession, output: { data: topologyWebsites } });
  assert.equal(oSites.res.body.data.length, 5);

  // 2. Customer 1A attempts to access foreign sites (site-1b, site-2a, site-2b, site-direct)
  const foreignTokens = ['site-1b', 'site-2a', 'site-2b', 'site-direct', 'customer-1b', 'customer-2a', 'customer-direct', 'reseller-2'];
  const foreignTargets = ['site-1b', 'site-2a', 'site-2b', 'site-direct'];

  for (const targetId of foreignTargets) {
    // 1. Website
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}`), foreignTokens);

    // 2. Files
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files?path=`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/text?path=index.php`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/text`, { method: 'PUT', body: { content: 'test' } }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/download?path=.env`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/upload?path=test.txt`, { method: 'PUT' }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/file`, { method: 'POST', body: { path: 'a.txt' } }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/mkdir`, { method: 'POST', body: { path: 'dir' } }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/rename`, { method: 'POST', body: { path: 'a', destination: 'b' } }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files`, { method: 'DELETE', body: { path: 'a' } }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files/batch-delete`, { method: 'POST', body: { paths: ['a'] } }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/files?path=`), foreignTokens);

    // 3. DB
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/database-resources`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/database-bindings/binding-${targetId.replace('site-', '')}`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/phpmyadmin-handoffs`, {
      method: 'POST',
      body: { credentialId: `credential-${targetId.replace('site-', '')}` },
    }), foreignTokens);

    // 4. Backup
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/backups`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/backups`), foreignTokens);

    // 5. Analytics
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/analytics/status`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/analytics`), foreignTokens);

    // 6. PHP
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/wp-cli/status`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/composer/status`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/actions/preview`, { method: 'POST', body: { actionId: 'test' } }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/wp-cli/status`), foreignTokens);

    // 7. Cron
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/crons`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/crons/c-1`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/crons`), foreignTokens);

    // 8. SFTP
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/sftp/keys`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/sftp/keys`), foreignTokens);

    // 9. elFinder
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/elfinder-handoffs`, { method: 'POST' }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/elfinder-handoffs`, { method: 'POST' }), foreignTokens);

    // 10. Terminal
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/terminal`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/terminal`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix('/api/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: targetId },
    }), foreignTokens);

    // 11. Log
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/logs`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/logs`), foreignTokens);
  }

  // 12. Mail foreign boundaries
  for (const mId of ['mail-1b', 'mail-2a', 'mail-2b', 'mail-direct']) {
    assertFailClosedNoLeak(await runMatrix(`/api/mail-domains/${mId}`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/mail-domains/${mId}/config-preview`, { method: 'POST' }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/mailboxes?mailDomainId=${mId}`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/mailboxes/box-${mId.replace('mail-', '')}`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/mail-aliases?mailDomainId=${mId}`), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/mail-aliases/alias-${mId.replace('mail-', '')}`), foreignTokens);
  }

  // 13. DNS foreign boundaries
  for (const dId of ['domain-1b', 'domain-2a', 'domain-2b', 'domain-direct']) {
    assertFailClosedNoLeak(await runMatrix(`/api/domains/${dId}`), foreignTokens);
  }
  for (const targetId of foreignTargets) {
    assertFailClosedNoLeak(await runMatrix('/api/domains', {
      method: 'POST',
      body: { websiteId: targetId, primaryDomain: `new.${targetId}.com` },
    }), foreignTokens);
  }

  // 14. Job foreign boundaries
  for (const jId of ['job-1b', 'job-2a', 'job-2b', 'job-direct']) {
    assertFailClosedNoLeak(await runMatrix(`/api/jobs/${jId}`), foreignTokens);
  }

  // Root terminal denied for non-owner
  assertFailClosedNoLeak(await runMatrix('/api/terminal/capabilities', {
    method: 'POST',
    body: { scope: 'server', serverId: 'server' },
    session: customer1ASession,
  }));
  assertFailClosedNoLeak(await runMatrix('/api/terminal/capabilities', {
    method: 'POST',
    body: { scope: 'server', serverId: 'server' },
    session: reseller1Session,
  }));

  // 3. Reseller 1 boundary isolation:
  // Reseller 1 can access site-1a and site-1b resources
  assert.equal((await runMatrix('/api/websites/site-1a', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/websites/site-1b', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/websites/site-1a/files?path=', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/websites/site-1b/files?path=', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/domains/domain-1a', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/domains/domain-1b', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/mail-domains/mail-1a', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/mail-domains/mail-1b', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/jobs/job-1a', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/jobs/job-1b', { session: reseller1Session })).called, 1);
  assert.equal((await runMatrix('/api/terminal/capabilities', {
    method: 'POST',
    body: { scope: 'site', websiteId: 'site-1a' },
    session: reseller1Session,
  })).called, 1);
  assert.equal((await runMatrix('/api/terminal/capabilities', {
    method: 'POST',
    body: { scope: 'site', websiteId: 'site-1b' },
    session: reseller1Session,
  })).called, 1);

  // Reseller 1 CANNOT access Reseller 2 sites (site-2a, site-2b) or Direct Owner site (site-direct)
  const resellerForeignTargets = ['site-2a', 'site-2b', 'site-direct'];
  const resellerForbiddenTokens = ['site-2a', 'site-2b', 'site-direct', 'customer-2a', 'customer-2b', 'customer-direct', 'reseller-2'];
  for (const targetId of resellerForeignTargets) {
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files?path=`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/files?path=`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/database-resources`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/backups`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/analytics/status`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/wp-cli/status`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/crons`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/sftp/keys`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/elfinder-handoffs`, { method: 'POST', session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix('/api/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: targetId },
      session: reseller1Session,
    }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/logs`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/domains/domain-${targetId.replace('site-', '')}`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/mail-domains/mail-${targetId.replace('site-', '')}`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/jobs/job-${targetId.replace('site-', '')}`, { session: reseller1Session }), resellerForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix('/api/domains', {
      method: 'POST',
      body: { websiteId: targetId, primaryDomain: `new.${targetId}.com` },
      session: reseller1Session,
    }), resellerForbiddenTokens);
  }

  // 4. Direct Owner Customer CANNOT access Reseller 1 or Reseller 2 sites
  for (const targetId of ['site-1a', 'site-1b', 'site-2a', 'site-2b']) {
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}`, { session: customerDirectSession }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files?path=`, { session: customerDirectSession }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}/database-resources`, { session: customerDirectSession }), foreignTokens);
    assertFailClosedNoLeak(await runMatrix('/api/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: targetId },
      session: customerDirectSession,
    }), foreignTokens);
  }

  // 5. Reseller 2 boundary isolation:
  // Reseller 2 can access site-2a and site-2b resources
  assert.equal((await runMatrix('/api/websites/site-2a', { session: reseller2Session })).called, 1);
  assert.equal((await runMatrix('/api/websites/site-2b', { session: reseller2Session })).called, 1);
  assert.equal((await runMatrix('/api/websites/site-2a/files?path=', { session: reseller2Session })).called, 1);
  assert.equal((await runMatrix('/api/websites/site-2b/files?path=', { session: reseller2Session })).called, 1);
  assert.equal((await runMatrix('/api/domains/domain-2a', { session: reseller2Session })).called, 1);
  assert.equal((await runMatrix('/api/domains/domain-2b', { session: reseller2Session })).called, 1);

  // Reseller 2 CANNOT access Reseller 1 sites (site-1a, site-1b) or Direct Owner site (site-direct)
  const reseller2ForeignTargets = ['site-1a', 'site-1b', 'site-direct'];
  const reseller2ForbiddenTokens = ['site-1a', 'site-1b', 'site-direct', 'customer-1a', 'customer-1b', 'customer-direct', 'reseller-1'];
  for (const targetId of reseller2ForeignTargets) {
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}`, { session: reseller2Session }), reseller2ForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/servers/server/websites/${targetId}`, { session: reseller2Session }), reseller2ForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix(`/api/websites/${targetId}/files?path=`, { session: reseller2Session }), reseller2ForbiddenTokens);
    assertFailClosedNoLeak(await runMatrix('/api/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: targetId },
      session: reseller2Session,
    }), reseller2ForbiddenTokens);
  }

  // 6. Cross-customer isolation (Customer 1B, 2A, 2B cannot access sibling or foreign sites)
  assertFailClosedNoLeak(await runMatrix('/api/websites/site-1a', { session: customer1BSession }), ['site-1a']);
  assertFailClosedNoLeak(await runMatrix('/api/websites/site-2a', { session: customer1BSession }), ['site-2a']);
  assertFailClosedNoLeak(await runMatrix('/api/websites/site-2b', { session: customer2ASession }), ['site-2b']);
  assertFailClosedNoLeak(await runMatrix('/api/websites/site-1a', { session: customer2ASession }), ['site-1a']);
  assertFailClosedNoLeak(await runMatrix('/api/websites/site-2a', { session: customer2BSession }), ['site-2a']);
  assertFailClosedNoLeak(await runMatrix('/api/websites/site-1b', { session: customer2BSession }), ['site-1b']);
});

test('YP-04: site-admin and owner DB/phpMyAdmin role boundaries, session binding, grant revocation, logout rotation, and replay prevention', async () => {
  const siteASession = {
    user: { id: 'admin-a', role: 'site_manager', websiteIds: ['site-a'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const siteBSession = {
    user: { id: 'admin-b', role: 'site_manager', websiteIds: ['site-b'], active: true },
    access: { mode: 'site_management' },
    security: { managementAllowed: true },
  };
  const ownerSession = {
    user: { id: 'owner-user', role: 'owner', active: true },
    access: { mode: 'management' },
    security: { managementAllowed: true },
  };

  // 1. Site-admin on Site A can manage credentials, grants, and password rotation for Site A
  assert.equal((await run('/api/servers/server/websites/site-a/database-resources', { session: siteASession })).called, 1);
  assert.equal((await run('/api/servers/server/database-bindings/binding-a/credential', { session: siteASession, method: 'POST' })).called, 1);
  assert.equal((await run('/api/servers/server/database-credentials/credential-a/grants', { session: siteASession, method: 'PATCH' })).called, 1);
  assert.equal((await run('/api/servers/server/database-credentials/credential-a/password/rotate', { session: siteASession, method: 'POST' })).called, 1);
  assert.equal((await run('/api/servers/server/database-credentials/credential-a/apply', { session: siteASession, method: 'POST' })).called, 1);

  // 2. Cross-tenant isolation: Site A admin cannot access or manage Site B database resources (Owner -> Site A -> Site B)
  const crossDbRes = await run('/api/servers/server/websites/site-b/database-resources', { session: siteASession });
  assert.equal(crossDbRes.called, 0);
  assert.equal(crossDbRes.res.statusCode, 403);

  const crossBinding = await run('/api/servers/server/database-bindings/binding-b/credential', { session: siteASession, method: 'POST' });
  assert.equal(crossBinding.called, 0);
  assert.equal(crossBinding.res.statusCode, 403);

  const crossGrants = await run('/api/servers/server/database-credentials/credential-b/grants', { session: siteASession, method: 'PATCH' });
  assert.equal(crossGrants.called, 0);
  assert.equal(crossGrants.res.statusCode, 403);

  const crossRotate = await run('/api/servers/server/database-credentials/credential-b/password/rotate', { session: siteASession, method: 'POST' });
  assert.equal(crossRotate.called, 0);
  assert.equal(crossRotate.res.statusCode, 403);

  const crossApply = await run('/api/servers/server/database-credentials/credential-b/apply', { session: siteASession, method: 'POST' });
  assert.equal(crossApply.called, 0);
  assert.equal(crossApply.res.statusCode, 403);

  // 3. Database unbind (DELETE) is forbidden for site-admin on any site, but allowed for Owner
  const unbindA = await run('/api/servers/server/database-bindings/binding-a', { session: siteASession, method: 'DELETE' });
  assert.equal(unbindA.called, 0);
  assert.equal(unbindA.res.statusCode, 403);

  const nestedUnbindA = await run('/api/servers/server/websites/site-a/database-bindings/binding-a', { session: siteASession, method: 'DELETE' });
  assert.equal(nestedUnbindA.called, 0);
  assert.equal(nestedUnbindA.res.statusCode, 403);

  // Owner is authorized on unbinding and all database operations across all sites
  assert.equal((await run('/api/servers/server/database-bindings/binding-a', { session: ownerSession, method: 'DELETE' })).called, 1);
  assert.equal((await run('/api/servers/server/database-bindings/binding-b', { session: ownerSession, method: 'DELETE' })).called, 1);
  assert.equal((await run('/api/servers/server/websites/site-a/database-resources', { session: ownerSession })).called, 1);
  assert.equal((await run('/api/servers/server/websites/site-b/database-resources', { session: ownerSession })).called, 1);
  assert.equal((await run('/api/servers/server/databases', { session: ownerSession })).called, 1);

  // Global database routes are forbidden for site-admin
  for (const globalPath of ['/api/servers/server/databases', '/api/servers/server/database-bindings']) {
    const res = await run(globalPath, { session: siteASession });
    assert.equal(res.called, 0);
    assert.equal(res.res.statusCode, 403);
  }

  // 4. phpMyAdmin session handoff: strictly bound to active panel session and current Website grant
  const ownHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
    session: siteASession,
    method: 'POST',
    body: { credentialId: 'credential-a' },
  });
  assert.equal(ownHandoff.called, 1);

  // Foreign site handoff attempt fails closed (403)
  const foreignHandoff = await run('/api/servers/server/websites/site-b/phpmyadmin-handoffs', {
    session: siteASession,
    method: 'POST',
    body: { credentialId: 'credential-b' },
  });
  assert.equal(foreignHandoff.called, 0);
  assert.equal(foreignHandoff.res.statusCode, 403);

  // Mismatched credential (attempting to use Site B credential on Site A) fails closed (403)
  const mismatchedHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
    session: siteASession,
    method: 'POST',
    body: { credentialId: 'credential-b' },
  });
  assert.equal(mismatchedHandoff.called, 0);
  assert.equal(mismatchedHandoff.res.statusCode, 403);

  // Replay attempt with empty/invalid payload fails closed (403)
  const emptyBodyHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
    session: siteASession,
    method: 'POST',
    body: {},
  });
  assert.equal(emptyBodyHandoff.called, 0);
  assert.equal(emptyBodyHandoff.res.statusCode, 403);

  // 5. Grant revocation and session invalidation fail closed immediately
  const revokedGrantSession = {
    ...siteASession,
    user: { ...siteASession.user, websiteIds: [] },
  };
  const revokedHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
    session: revokedGrantSession,
    method: 'POST',
    body: { credentialId: 'credential-a' },
  });
  assert.equal(revokedHandoff.called, 0);
  assert.equal(revokedHandoff.res.statusCode, 403);

  const revokedDbRes = await run('/api/servers/server/websites/site-a/database-resources', {
    session: revokedGrantSession,
  });
  assert.equal(revokedDbRes.called, 0);
  assert.equal(revokedDbRes.res.statusCode, 403);

  // Inactive / suspended account fails closed (403)
  const inactiveSession = {
    ...siteASession,
    user: { ...siteASession.user, active: false },
  };
  const inactiveHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
    session: inactiveSession,
    method: 'POST',
    body: { credentialId: 'credential-a' },
  });
  assert.equal(inactiveHandoff.called, 0);
  assert.equal(inactiveHandoff.res.statusCode, 403);

  // Site account with managementAllowed: false or mode: 'read_only' cannot mutate DB credentials, rotate password, or mint phpMyAdmin handoff
  const restrictedSession = {
    ...siteASession,
    access: { mode: 'read_only' },
    security: { managementAllowed: false },
  };
  const restrictedHandoff = await run('/api/servers/server/websites/site-a/phpmyadmin-handoffs', {
    session: restrictedSession,
    method: 'POST',
    body: { credentialId: 'credential-a' },
  });
  assert.equal(restrictedHandoff.called, 0);
  assert.equal(restrictedHandoff.res.statusCode, 403);

  const restrictedRotate = await run('/api/servers/server/database-credentials/credential-a/password/rotate', {
    session: restrictedSession,
    method: 'POST',
  });
  assert.equal(restrictedRotate.called, 0);
  assert.equal(restrictedRotate.res.statusCode, 403);
});
