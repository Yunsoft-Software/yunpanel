import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production PHP action wiring uses live session lookup both at queue and worker time', async()=>{
 const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(source,/authStore\.getSessionById\(actor\.sessionId\)/);
 assert.match(source,/authorizeActor: authorizeWebsitePhpActor/);
 assert.match(source,/withApplicationLock: websitePhpActionLock\.withApplicationLock/);
 assert.match(source,/websitePhpToolActionService,/);
});
test('queue response uses public job view so actor/session payload is not exposed',async()=>{
 const source=await readFile(new URL('../src/website-php-tool-action-service.js',import.meta.url),'utf8');
 assert.match(source,/job: jobPublicView\(job\)/);
});
