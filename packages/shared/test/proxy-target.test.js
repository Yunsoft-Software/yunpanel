import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProxyHostForUrl, normalizeProxyHost, ProxyTargetValidationError } from '../src/index.js';

test('proxy hosts canonicalize DNS, IDN, IPv4 and IPv6 without accepting URLs', () => {
  assert.equal(normalizeProxyHost('API.Example.COM.'), 'api.example.com');
  assert.equal(normalizeProxyHost('BÜCHER.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeProxyHost('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeProxyHost('[2001:0DB8:0:0:0:0:0:1]'), '2001:db8::1');
  assert.equal(formatProxyHostForUrl('2001:db8::1'), '[2001:db8::1]');
});

test('proxy hosts reject schemes, paths, credentials and config control characters', () => {
  for (const value of [
    '',
    'https://example.com',
    'example.com/path',
    'user@example.com',
    'example.com:8080',
    'example.com; include /etc/shadow',
    '[2001:db8::1',
    '-invalid.example',
  ]) {
    assert.throws(
      () => normalizeProxyHost(value),
      (error) => error instanceof ProxyTargetValidationError && error.code === 'invalid_proxy_host',
    );
  }
});
