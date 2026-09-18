import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const authUrl = new URL('../src/auth-http.js', import.meta.url);
const webServerUrl = new URL('../../web/server.js', import.meta.url);

test('API auth and public web gateway share the reusable integrated-tool descriptor contract', async () => {
  const [auth, web] = await Promise.all([
    readFile(authUrl, 'utf8'),
    readFile(webServerUrl, 'utf8'),
  ]);

  assert.match(auth, /isManagementToolGatewayAccessPath/);
  assert.match(auth, /packages\/protocol\/src\/tool-gateway\.js/);
  assert.doesNotMatch(
    auth,
    /\['\/api\/phpmyadmin-gateway-access', '\/api\/elfinder-gateway-access'\]/,
  );

  assert.match(web, /integratedToolGateway/);
  assert.match(web, /integratedToolGateway\('phpmyadmin'\)/);
  assert.match(web, /integratedToolGateway\('elfinder'\)/);
  assert.match(web, /PHPMYADMIN_GATEWAY\.publicPrefix/);
  assert.match(web, /PHPMYADMIN_GATEWAY\.accessPath/);
  assert.match(web, /PHPMYADMIN_GATEWAY\.socketPath/);
  assert.match(web, /ELFINDER_GATEWAY\.publicPrefix/);
  assert.match(web, /ELFINDER_GATEWAY\.accessPath/);
  assert.match(web, /ELFINDER_GATEWAY\.socketPath/);
});
