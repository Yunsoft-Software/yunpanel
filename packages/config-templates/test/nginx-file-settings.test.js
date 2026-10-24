import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPhpSiteConfig, renderStaticSiteConfig } from '../src/nginx.js';

const base = { primaryDomain: 'owned.example.com', root: '/var/www/yunpanel/apps/owned/current' };
for (const [kind, render] of [['static', renderStaticSiteConfig], ['php', renderPhpSiteConfig]]) {
  const target = kind === 'php' ? { ...base, socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' } : base;
  test(kind + ' defaults render identical bytes when file preferences are explicitly reset', () => {
    assert.equal(render({ ...target, nginxSettings: { indexFiles: null, errorPages: {} } }), render(target));
  });
  test(kind + ' renders one internal location per error file and preserves the original status', () => {
    const rendered = render({ ...target, nginxSettings: { indexFiles: ['home.html', 'index.html'], errorPages: { 404: '/errors/common.html', 500: '/errors/common.html' } } });
    assert.match(rendered, /index home\.html index\.html;/);
    assert.match(rendered, /error_page 404 \/errors\/common\.html;/);
    assert.match(rendered, /error_page 500 \/errors\/common\.html;/);
    assert.equal([...rendered.matchAll(/location = \/errors\/common\.html/g)].length, 1);
    assert.match(rendered, /location = \/errors\/common\.html \{\n    internal;\n    try_files \$uri =404;/);
    assert.doesNotMatch(rendered, /error_page \d+ =200|return 200/);
  });
}

for (const [kind, render] of [['static', renderStaticSiteConfig], ['php', renderPhpSiteConfig]]) {
  test(kind + ' serves a contained child and redirects existing names to www without changing the Domain identity', () => {
    const target = kind === 'php' ? { ...base, socketPath: '/run/php/yunpanel-yunapp-123456abcdef.sock' } : base;
    const config = render({ ...target, aliases: ['www.owned.example.com'], canonicalRedirect: true,
      nginxSettings: { documentRoot: 'app/public', preferredDomain: 'www.owned.example.com' } });
    assert.match(config, /root \/var\/www\/yunpanel\/apps\/owned\/current\/app\/public;/);
    assert.match(config, /disable_symlinks on from=\/var\/www\/yunpanel\/apps\/owned\/current;/);
    assert.match(config, /return 301 http:\/\/www.owned.example.com\$request_uri;/);
    assert.throws(() => render({ ...target, nginxSettings: { documentRoot: '../foreign' } }), { code: 'invalid_nginx_document_root' });
    assert.throws(() => render({ ...target, nginxSettings: { preferredDomain: 'foreign.example.com' } }), { code: 'nginx_preferred_domain_unbound' });
  });
}
