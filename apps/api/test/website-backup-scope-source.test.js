import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site resource boundary blocks global backup repository enumeration',async()=>{
 const source=await readFile(new URL('../src/site-resource-boundary.js',import.meta.url),'utf8');
 assert.match(source,/backups\(\?:\\\/\|\$\)/);
});
test('site scoped backup browser remains under Website route boundary',async()=>{
 const source=await readFile(new URL('../src/website-backup-http.js',import.meta.url),'utf8');
 assert.match(source,/\/api\/websites\/:websiteId\/backups/);
 assert.doesNotMatch(source,/\/api\/backups\/repositories.*websiteBackupBrowser/);
});
