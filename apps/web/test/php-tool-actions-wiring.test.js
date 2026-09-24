import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source=(name)=>readFile(new URL(`../src/workspace/${name}`,import.meta.url),'utf8');
test('PHP panel uses reviewed queue and never raw run endpoints',async()=>{
 const [panel,client]=await Promise.all([source('SitePhpToolsPanel.jsx'),source('php-tools-client.js')]);
 assert.match(panel,/İşlemi kuyruğa al/); assert.match(panel,/ConfirmDialog/);
 assert.match(client,/\/actions\/preview/); assert.match(client,/\/actions\/queue/);
 assert.doesNotMatch(client,/wp-cli\/run|composer\/run/);
});
test('terminal completion refreshes both status channels',async()=>{
 const client=await source('php-tools-client.js');
 assert.match(client,/job\.status === 'succeeded'/);
 assert.match(client,/load\('wordpress'\)/); assert.match(client,/load\('composer'\)/);
});
