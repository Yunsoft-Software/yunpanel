import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import test from 'node:test';
test('production removal wires cleanup preflight inspectors as well as mutators',async()=>{
 const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 const start=source.indexOf('createWebsiteRemovalRuntime({');const block=source.slice(start,start+2600);
 assert.match(block,/fileCleanupInspector: websiteRemovalCleanupAdapters/);
 assert.match(block,/unixIdentityCleanupInspector: websiteRemovalCleanupAdapters/);
});
