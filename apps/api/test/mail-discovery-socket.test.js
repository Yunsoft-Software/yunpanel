import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createMailDiscoveryHttpHandler,
  mailDiscoverySocketInternals,
} from '../src/mail-discovery-socket.js';

function request({ method, url, headers = {}, body = '' }) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function response() {
  let status = null;
  let headers = null;
  let body = '';
  return {
    headersSent: false,
    destroyed: false,
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
      this.headersSent = true;
    },
    end(value = '') {
      body += String(value);
    },
    destroy() {
      this.destroyed = true;
    },
    snapshot: () => ({ status, headers, body }),
  };
}

function serviceFixture() {
  const calls = [];
  return {
    calls,
    service: {
      async autoconfig(input) {
        calls.push(['autoconfig', input]);
        return {
          contentType: 'application/xml; charset=utf-8',
          body: '<clientConfig version="1.1"/>\n',
        };
      },
      async autodiscover(input) {
        calls.push(['autodiscover', input]);
        return {
          contentType: 'application/xml; charset=utf-8',
          body: '<Autodiscover/>\n',
        };
      },
    },
  };
}

test('managed socket accepts Thunderbird root autoconfig only through HTTPS proxy evidence', async () => {
  const fixture = serviceFixture();
  const handler = createMailDiscoveryHttpHandler({ mailDiscoveryService: fixture.service });
  const res = response();
  await handler(request({
    method: 'GET',
    url: '/mail/config-v1.1.xml?emailaddress=User%40example.com',
    headers: {
      host: 'example.com',
      'x-forwarded-proto': 'https',
    },
  }), res);

  assert.deepEqual(fixture.calls, [[
    'autoconfig',
    { domainName: 'example.com', emailAddress: 'User@example.com' },
  ]]);
  assert.equal(res.snapshot().status, 200);
  assert.equal(res.snapshot().headers['cache-control'], 'no-store');
  assert.match(res.snapshot().headers['content-type'], /^application\/xml/);
  assert.equal(res.snapshot().body, '<clientConfig version="1.1"/>\n');
});

test('managed socket accepts Thunderbird well-known autoconfig route', async () => {
  const fixture = serviceFixture();
  const handler = createMailDiscoveryHttpHandler({ mailDiscoveryService: fixture.service });
  const res = response();
  await handler(request({
    method: 'GET',
    url: '/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40example.com',
    headers: {
      host: 'example.com',
      'x-forwarded-proto': 'https',
    },
  }), res);

  assert.equal(res.snapshot().status, 200);
  assert.equal(fixture.calls[0][0], 'autoconfig');
});

test('managed socket extracts exactly one Outlook EMailAddress from bounded XML', async () => {
  const fixture = serviceFixture();
  const handler = createMailDiscoveryHttpHandler({ mailDiscoveryService: fixture.service });
  const res = response();
  await handler(request({
    method: 'POST',
    url: '/autodiscover/autodiscover.xml',
    headers: {
      host: 'example.com',
      'x-forwarded-proto': 'https',
      'content-type': 'text/xml; charset=utf-8',
    },
    body: '<?xml version="1.0"?><Autodiscover><Request><EMailAddress>user@example.com</EMailAddress></Request></Autodiscover>',
  }), res);

  assert.deepEqual(fixture.calls, [[
    'autodiscover',
    { domainName: 'example.com', emailAddress: 'user@example.com' },
  ]]);
  assert.equal(res.snapshot().status, 200);
  assert.equal(res.snapshot().body, '<Autodiscover/>\n');
});

test('managed socket rejects direct/non-HTTPS access before consulting domain state', async () => {
  const fixture = serviceFixture();
  const handler = createMailDiscoveryHttpHandler({ mailDiscoveryService: fixture.service });
  const res = response();
  await handler(request({
    method: 'GET',
    url: '/mail/config-v1.1.xml?emailaddress=user%40example.com',
    headers: { host: 'example.com' },
  }), res);

  assert.equal(res.snapshot().status, 404);
  assert.match(res.snapshot().body, /mail_discovery_https_required/);
  assert.deepEqual(fixture.calls, []);
});

test('managed socket rejects DTD/entity autodiscover bodies without invoking service', async () => {
  const fixture = serviceFixture();
  const handler = createMailDiscoveryHttpHandler({ mailDiscoveryService: fixture.service });
  const res = response();
  await handler(request({
    method: 'POST',
    url: '/autodiscover/autodiscover.xml',
    headers: {
      host: 'example.com',
      'x-forwarded-proto': 'https',
      'content-type': 'application/xml',
    },
    body: '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Autodiscover><EMailAddress>&xxe;</EMailAddress></Autodiscover>',
  }), res);

  assert.equal(res.snapshot().status, 400);
  assert.match(res.snapshot().body, /mail_discovery_body_invalid/);
  assert.deepEqual(fixture.calls, []);
});

test('mail discovery socket policy exposes one fixed www-data-owned path', () => {
  assert.equal(mailDiscoverySocketInternals.socketDirectory, '/run/yunpanel-mail-discovery');
  assert.equal(mailDiscoverySocketInternals.socketPath, '/run/yunpanel-mail-discovery/discovery.sock');
  assert.equal(mailDiscoverySocketInternals.socketGroup, 'www-data');
  assert.equal(mailDiscoverySocketInternals.directoryMode, 0o750);
  assert.equal(mailDiscoverySocketInternals.socketMode, 0o660);
  assert.deepEqual(mailDiscoverySocketInternals.autoconfigPaths, [
    '/mail/config-v1.1.xml',
    '/.well-known/autoconfig/mail/config-v1.1.xml',
  ]);
});
