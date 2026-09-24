import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import test from 'node:test';
const source=(name)=>readFile(new URL('../src/workspace/'+name,import.meta.url),'utf8');
test('Owner hosting settings shows removal preview after suspension/isolation controls',async()=>{const text=await source('SiteDetailPage.jsx');assert.match(text,/website && isOwner && <WebsiteRemovalPanel/);assert.match(text,/WebsiteSuspensionPanel/);assert.match(text,/WebsiteIsolationPanel/);});
test('removal preview client is GET-only and cannot fire destructive POST',async()=>{const text=await source('website-removal-client.js');assert.match(text,/\/removal/);assert.doesNotMatch(text,/method:\s*['"]POST|\/continue/);});
test('removal panel has no destructive button while blocker exists',async()=>{const text=await source('WebsiteRemovalPanel.jsx');assert.match(text,/Sil butonu gösterilmez/);assert.doesNotMatch(text,/onClick=.*remove|onClick=.*delete/);});
