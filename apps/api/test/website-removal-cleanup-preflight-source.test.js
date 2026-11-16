import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import test from 'node:test';
test('production removal wires cleanup preflight inspectors as well as mutators',async()=>{
 const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 const block=source.match(/createWebsiteRemovalRuntime\(\{[\s\S]*?\n\s*\}\)\s*: null;/)?.[0];assert.ok(block,'Production removal construction must be present');
 assert.match(block,/fileCleanupInspector: websiteRemovalCleanupAdapters/);
 assert.match(block,/unixIdentityCleanupInspector: websiteRemovalCleanupAdapters/);
});
