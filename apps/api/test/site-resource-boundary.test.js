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
 const path='/api/servers/server/websites/site-a/phpmyadmin-handoffs';
 assert.equal((await run(path,{method:'POST',body:{credentialId:'credential-a'}})).called,1);
 assert.equal((await run(path,{method:'POST',body:{credentialId:'credential-b'}})).res.statusCode,403);
 assert.equal((await run(path,{method:'POST',body:{}})).res.statusCode,403);
});
test('unbound and global database inventories and mutations are unavailable to site managers',async()=>{
 for(const path of ['/api/servers/server/databases','/api/servers/server/databases/unbound/bind','/api/servers/server/database-bindings']){
  for(const method of ['GET','POST','DELETE'])assert.equal((await run(path,{method})).res.statusCode,403);
 }
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
test('owner and read-only still use their existing authorization boundaries',async()=>{
 for(const role of ['owner','read_only'])assert.equal((await run('/api/servers/server/databases',{session:{user:{role}},dependencies:{}})).called,1);
 assert.equal((await run('/api/websites/site-a/files',{session:{...auth,security:{managementAllowed:false}}})).res.statusCode,403);
});
test('only small identity-bearing JSON bodies are parsed ahead of the inner app',()=>{
 assert.equal(needsSiteResourceJson({auth,method:'POST',url:'/api/mailboxes'}),true);
 assert.equal(needsSiteResourceJson({auth,method:'POST',url:'/api/servers/server/websites/site-a/phpmyadmin-handoffs'}),true);
 assert.equal(needsSiteResourceJson({auth,method:'PUT',url:'/api/websites/site-a/files/upload?path=index.php'}),false);
 assert.equal(needsSiteResourceJson({auth,method:'PUT',url:'/api/websites/site-a/files/text'}),false);
});
test('site config preview preserves exact apply tokens but omits global domain and artifact data',async()=>{
 const data={readyToApply:true,previewDigest:'digest',confirmation:'confirm',currentStatus:'enabled',desiredStatus:'enabled',configuration:{sha256:'hash',counts:{mailboxes:1000},artifactDigests:[{path:'/etc/private'}]},domains:[{name:'other.test'}]};
 const v=await run('/api/mail-domains/mail-a/config-preview',{method:'POST',output:{data}});
 assert.equal(v.called,1);assert.equal(v.res.body.data.previewDigest,'digest');assert.deepEqual(v.res.body.data.configuration,{sha256:'hash'});assert.equal(v.res.body.data.domains,undefined);assert.doesNotMatch(JSON.stringify(v.res.body),/other\.test|1000|private/);
});
