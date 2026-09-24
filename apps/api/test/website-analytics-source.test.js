import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import test from 'node:test';
test('realtime lifecycle is Owner-only while static report/status remain site-scoped reads',async()=>{
 const source=await readFile(new URL('../src/website-analytics-http.js',import.meta.url),'utf8');
 assert.match(source,/analytics\/status', requirePanelRouteAccess/);
 assert.match(source,/analytics\/realtime\/start', requireAnalyticsOwner/);
 assert.match(source,/analytics\/realtime\/stop', requireAnalyticsOwner/);
 assert.match(source,/analytics\/realtime\/restart', requireAnalyticsOwner/);
});
test('JSON analytics response does not publish outputPath or pid/socket paths',async()=>{
 const source=await readFile(new URL('../src/website-analytics-http.js',import.meta.url),'utf8');
 const jsonBlock=source.slice(source.indexOf("return response.json({\n      data: {"),source.indexOf("app.get('/api/websites/:websiteId/analytics/status"));
 assert.doesNotMatch(jsonBlock,/outputPath/);
 assert.match(source,/analyticsStatusView/);
});
