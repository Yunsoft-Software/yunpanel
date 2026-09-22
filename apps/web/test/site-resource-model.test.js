import test from 'node:test';
import assert from 'node:assert/strict';
import { siteMailDomains, mailSection, webmailMappingUrl } from '../src/workspace/ui/site-resource-model.js';
import { SITE_TABS, siteHref } from '../src/workspace/site-model.js';
test('mail matches explicit site-linked Domain IDs, not matching hostname suffixes',()=>{
 const domains=[{id:'d1',websiteId:'w1'},{id:'d2',websiteId:'w2'}];
 const mails=[{id:'m1',webDomainId:'d1',domainName:'example.test'},{id:'m2',webDomainId:'d2',domainName:'sub.example.test'},{id:'m3',webDomainId:null,domainName:'example.test'}];
 assert.deepEqual(siteMailDomains(mails,domains,'w1'),[mails[0]]);
 assert.deepEqual(siteMailDomains(mails,domains,'w2'),[mails[1]]);
 assert.deepEqual(siteMailDomains(mails,domains,''),[]);
});
test('owner-only mail settings cannot be selected with a forged query',()=>{
 for(const value of ['dns','__proto__','../'])assert.equal(mailSection(value,false),'mailboxes');
 assert.equal(mailSection('webmail',false),'webmail');assert.equal(mailSection('configuration',true),'configuration');assert.equal(mailSection('configuration',false),'configuration');
});
test('mail and database deep links preserve Domain route identity',()=>{
 for(const tab of ['mail','databases']){assert.ok(SITE_TABS.some(([key])=>key===tab));assert.equal(siteHref('domain-a',tab),`/websites/domain-a/${tab}`);}
 assert.equal(siteHref('domain/a','mail'),'/websites/domain%2Fa/mail');
});
test('webmail link requires an active returned mapping and valid hostname',()=>{
 assert.equal(webmailMappingUrl({state:'active',hostname:'webmail.example.test'}),'https://webmail.example.test/');
 for(const hostname of ['evil.test/path','evil.test?next=','evil.test:443','evil@host.test','javascript:evil','a'.repeat(64)+'.test'])assert.equal(webmailMappingUrl({state:'active',hostname}),null);
 assert.equal(webmailMappingUrl({state:'pending',hostname:'webmail.example.test'}),null);
 assert.equal(webmailMappingUrl(null),null);
});

import { workspaceResources } from '../src/workspace/workspace-resources.js';
test('direct mail/database reloads load scoped job history for locks and backup choices',()=>{
 for(const tab of ['mail','databases']) {
  const demand=workspaceResources(`/websites/domain-a/${tab}`);
  assert.equal(demand.websites,true); assert.equal(demand.domains,true);
  assert.equal(demand.servers,true); assert.equal(demand.jobs,true);
 }
 assert.equal(workspaceResources('/websites/domain-a/files').jobs,false);
});
