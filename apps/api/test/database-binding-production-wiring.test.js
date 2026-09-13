import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);
const appUrl = new URL('../src/app.js', import.meta.url);
const envUrl = new URL('../../../.env.example', import.meta.url);
const postinstUrl = new URL('../../../packaging/debian/postinst', import.meta.url);

test('production boot persists and injects database ownership bindings', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /createDatabaseBindingRegistry/);
  assert.match(source, /YUNPANEL_DATABASE_BINDING_STORE/);
  assert.match(source, /database-binding-registry\.json/);
  assert.match(source, /getWebsite: async \(websiteId\) => websiteRegistry\.getWebsite\(websiteId\)/);
  assert.match(source, /getApplication: async \(applicationId\) => applicationRegistry\.getApplication\(applicationId\)/);
  assert.match(source, /databaseBindingRegistry,/);
});

test('production app mounts binding routes and protects schema deletion with the same registry', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /mountDatabaseBindingRoutes/);
  assert.match(source, /mountDatabaseRoutes\(app, \{ registry: localRegistry, jobRegistry, databaseBindingRegistry \}\)/);
  assert.match(source, /DatabaseBindingRegistryError/);
});

test('source and Debian upgrade environments retain the database binding store path', async () => {
  const [envSource, postinst] = await Promise.all([
    readFile(envUrl, 'utf8'),
    readFile(postinstUrl, 'utf8'),
  ]);
  assert.match(envSource, /^YUNPANEL_DATABASE_BINDING_STORE=\.data\/database-binding-registry\.json$/m);
  assert.match(postinst, /YUNPANEL_DATABASE_BINDING_STORE=\/var\/lib\/yunpanel\/control-plane\/database-binding-registry\.json/);
});
