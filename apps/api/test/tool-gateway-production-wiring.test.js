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
  assert.match(web, /integratedToolGateway\('ttyd'\)/);
  assert.match(web, /integratedToolGateway\('netdata'\)/);
  assert.match(web, /PHPMYADMIN_GATEWAY\.publicPrefix/);
  assert.match(web, /PHPMYADMIN_GATEWAY\.accessPath/);
  assert.match(web, /PHPMYADMIN_GATEWAY\.socketPath/);
  assert.match(web, /ELFINDER_GATEWAY\.publicPrefix/);
  assert.match(web, /ELFINDER_GATEWAY\.accessPath/);
  assert.match(web, /ELFINDER_GATEWAY\.socketPath/);
  assert.match(web, /TTYD_GATEWAY\.publicPrefix/);
  assert.match(web, /TTYD_GATEWAY\.accessPath/);
  assert.match(web, /TTYD_GATEWAY\.socketRoot/);
  assert.match(web, /NETDATA_GATEWAY\.publicPrefix/);
  assert.match(web, /NETDATA_GATEWAY\.accessPath/);
  assert.match(web, /NETDATA_GATEWAY\.loopbackPort/);
  assert.match(web, /integratedToolGateway\('goaccess'\)/);
  assert.match(web, /GOACCESS_GATEWAY\.publicPrefix/);
  assert.match(web, /GOACCESS_GATEWAY\.accessPath/);
  assert.match(web, /GOACCESS_GATEWAY\.socketRoot/);
});

