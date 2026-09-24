import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production Website removal wires receipt-owned cleanup adapters',async()=>{
 const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(source,/createWebsiteRemovalCleanupAdapters/);
 const start=source.indexOf('createWebsiteRemovalRuntime({');const block=source.slice(start,start+2200);
 assert.match(block,/fileCleanupHandler: websiteRemovalCleanupAdapters/);
 assert.match(block,/unixIdentityCleanupHandler: websiteRemovalCleanupAdapters/);
});
test('removal journals Unix identity before recursive file cleanup',async()=>{
 const source=await readFile(new URL('../src/website-removal-operation-registry.js',import.meta.url),'utf8');
 assert.ok(source.indexOf("add('unix_identity_cleanup'") < source.indexOf("add('file_cleanup'"));
});
