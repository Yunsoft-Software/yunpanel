import assert from 'node:assert/strict';
import test from 'node:test';
import { NginxSettingsValidationError, normalizeNginxSettings } from '../src/index.js';

const rule = (overrides = {}) => ({ source: '/old', target: 'https://new.example.com/page', status: 301, match: 'exact', ...overrides });

test('redirect rules are an optional field on every target type and leave legacy envelopes unchanged', () => {
  for (const target of ['static', 'proxy', 'passenger', 'php', 'python']) {
    assert.equal(Object.hasOwn(normalizeNginxSettings(target, {}), 'redirectRules'), false);
    const settings = normalizeNginxSettings(target, { redirectRules: [rule()] });
    assert.deepEqual(settings.redirectRules, [rule()]);
    assert.ok(Object.isFrozen(settings.redirectRules));
    assert.ok(Object.isFrozen(settings.redirectRules[0]));
  }
  assert.deepEqual(normalizeNginxSettings('php', { redirectRules: [] }).redirectRules, []);
  const base = normalizeNginxSettings('php', { redirectRules: [rule()] });
  assert.deepEqual(normalizeNginxSettings('php', { clientMaxBodySizeMb: 8 }, base).redirectRules, [rule()]);
});

test('redirect rules accept local and absolute targets, prefix moves and both temporary and permanent status', () => {
  const settings = normalizeNginxSettings('static', { redirectRules: [
    rule({ source: '/kampanya', target: '/yeni-kampanya', status: 302 }),
    rule({ source: '/blog/', target: 'https://blog.example.com/', match: 'prefix' }),
    rule({ source: '/', target: 'https://www.example.com/tr/', status: 302 }),
    rule({ source: '/eski.html', target: 'https://example.com/ara?q=yeni&dil=tr' }),
  ] });
  assert.equal(settings.redirectRules.length, 4);
});

test('redirect rules reject nginx injection, unsafe schemes, reserved paths, loops and ambiguous prefixes', () => {
  const invalid = [
    rule({ source: 'old' }), rule({ source: '/old;return 200' }), rule({ source: '/old {' }), rule({ source: '/a b' }),
    rule({ source: '/old\n' }), rule({ source: '/$host' }), rule({ source: '/../etc' }), rule({ source: '//x' }),
    rule({ source: '/.well-known/acme-challenge/x' }), rule({ source: '/autodiscover/autodiscover.xml' }),
    rule({ target: 'javascript:alert(1)' }), rule({ target: 'ftp://example.com/' }), rule({ target: 'https://example.com/a;b' }),
    rule({ target: 'https://example.com/$1' }), rule({ target: 'https://exa mple.com/' }), rule({ target: 'https://example.com/"x' }),
    rule({ target: 'https://example.com/a\\b' }), rule({ target: 'https://user:pass@example.com/' }), rule({ target: '//example.com/' }),
    rule({ target: '/old' }), rule({ status: 307 }), rule({ status: '301' }), rule({ match: 'regex' }),
    rule({ source: '/', match: 'prefix', target: 'https://example.com/' }), rule({ source: '/blog', match: 'prefix', target: 'https://example.com/' }),
    rule({ source: '/blog/', match: 'prefix', target: 'https://example.com/x' }), rule({ source: '/blog/', match: 'prefix', target: 'https://example.com/?a=1' }),
    rule({ extra: true }), { source: '/old', target: '/new', status: 301 },
  ];
  for (const entry of invalid) {
    assert.throws(() => normalizeNginxSettings('php', { redirectRules: [entry] }), NginxSettingsValidationError, JSON.stringify(entry));
  }
  const started = performance.now();
  assert.throws(() => normalizeNginxSettings('php', { redirectRules: [rule({ source: `/${'a'.repeat(180)};` })] }), { code: 'invalid_nginx_redirect_rule' });
  // A backtracking pattern needs hours on 180 characters; the generous bound only keeps a loaded machine from flaking.
  assert.ok(performance.now() - started < 2000, 'path validation must stay linear on hostile input');
  assert.throws(() => normalizeNginxSettings('php', { redirectRules: 'not-a-list' }), { code: 'invalid_nginx_redirect_rules' });
  assert.throws(() => normalizeNginxSettings('php', { redirectRules: Array.from({ length: 51 }, (_, i) => rule({ source: `/p${i}` })) }), { code: 'invalid_nginx_redirect_rules' });
  assert.throws(() => normalizeNginxSettings('php', { redirectRules: [rule(), rule({ target: '/other' })] }), { code: 'duplicate_nginx_redirect_rule' });
  assert.throws(() => normalizeNginxSettings('php', { errorPages: { 404: '/errors/missing.html' }, redirectRules: [rule({ source: '/errors/missing.html' })] }),
    { code: 'nginx_redirect_error_page_conflict' });
});
