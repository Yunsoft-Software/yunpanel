import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => new URL(`../src/${name}`, import.meta.url);
const text = (name) => readFile(source(name), 'utf8');

test('production DKIM key lifecycle uses persistent registry, managed-mail idle guard and host retirement evidence', async () => {
  const [indexSource, httpSource, registrySource] = await Promise.all([
    text('index.js'),
    text('mail-dkim-http.js'),
    text('mail-dkim-registry.js'),
  ]);

  assert.match(indexSource, /createMailDkimRegistry\(\{[\s\S]*?keyRoot:\s*mailDkimRootPath,[\s\S]*?\}\)/);
  assert.match(httpSource, /createMailDkimRetirementInspector\(\)/);
  assert.match(httpSource, /\/api\/mail-domains\/:mailDomainId\/dkim\/rotate/);
  assert.match(httpSource, /app\.delete\('\/api\/mail-domains\/:mailDomainId\/dkim'/);
  assert.match(httpSource, /ensureMailConfigurationIdle\(jobRegistry, scoped\.webDomain\.serverId\)/);
  assert.match(httpSource, /mailDkimRetirementInspector\.inspect\(\{ domain: key\.domainName, selector: key\.selector \}\)/);
  assert.match(registrySource, /async function rotateKey/);
  assert.match(registrySource, /async function deleteKey/);
  assert.match(registrySource, /PREVIOUS_PREFIX/);
  assert.match(registrySource, /DELETED_PREFIX/);
});
