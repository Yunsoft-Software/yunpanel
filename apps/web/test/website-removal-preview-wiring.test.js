import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source=(name)=>readFile(new URL('../src/workspace/'+name,import.meta.url),'utf8');

test('Owner hosting settings keeps removal preview and enables only reviewed journal mutations',async()=>{
 const text=await source('SiteDetailPage.jsx');
 assert.match(text,/website && isOwner && <WebsiteRemovalPanel/);
 const client=await source('website-removal-client.js');
 assert.match(client,/previewDigest:preview\.previewDigest/);
 assert.match(client,/stepId:step\.stepId/);
 assert.match(client,/\/website-removal-operations/);
 assert.doesNotMatch(client,/setInterval|setTimeout/);
});
test('removal UI requires typed domain confirmation and explicit per-step continuation',async()=>{
 const text=await source('WebsiteRemovalPanel.jsx');
 assert.match(text,/confirmation=\{scope.label\}/);
 assert.match(text,/Sonraki silme adımını çalıştır/);
 assert.match(text,/Her çağrı yalnız journal'daki mevcut adımı ilerletir/);
});
test('global recovery remains available after Website metadata disappears',async()=>{
 const page=await source('WebsitesPage.jsx');
 assert.match(page,/WebsiteRemovalRecoveryPanel/);
 const recovery=await source('WebsiteRemovalRecoveryPanel.jsx');
 assert.match(recovery,/website-removal-operations/);
 assert.match(recovery,/POST tekrar edilmedi/);
});
