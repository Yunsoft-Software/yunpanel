import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NetdataTemplateError,
  netdataTemplatePolicy,
  previewNetdataConfiguration,
  renderNetdataConfig,
} from '../src/index.js';

test('netdataTemplatePolicy defines fixed paths and loopback defaults', () => {
  assert.equal(netdataTemplatePolicy.configPath, '/etc/netdata/netdata.conf');
  assert.equal(netdataTemplatePolicy.configMode, 0o644);
  assert.equal(netdataTemplatePolicy.serviceUnit, 'netdata.service');
  assert.equal(netdataTemplatePolicy.bindAddress, '127.0.0.1');
  assert.equal(netdataTemplatePolicy.defaultPort, 19999);
  assert.equal(netdataTemplatePolicy.runAsUser, 'netdata');
});

test('renderNetdataConfig renders valid loopback configuration with default settings', () => {
  const rendered = renderNetdataConfig();
  assert.match(rendered, /bind to = 127\.0\.0\.1/);
  assert.match(rendered, /default port = 19999/);
  assert.match(rendered, /run as user = netdata/);
  assert.match(rendered, /\[global\]/);
  assert.match(rendered, /\[web\]/);
});

test('renderNetdataConfig accepts IPv6 loopback and custom port', () => {
  const rendered = renderNetdataConfig({ bindAddress: '::1', port: 29999, runAsUser: 'customnetdata' });
  assert.match(rendered, /bind to = ::1/);
  assert.match(rendered, /default port = 29999/);
  assert.match(rendered, /run as user = customnetdata/);
});

test('renderNetdataConfig rejects non-loopback addresses fail-closed', () => {
  for (const unsafe of ['0.0.0.0', '::', '192.168.1.1', '10.0.0.1', 'example.com', '']) {
    assert.throws(
      () => renderNetdataConfig({ bindAddress: unsafe }),
      (error) => error instanceof NetdataTemplateError && error.code === 'netdata_bind_address_unsafe',
    );
  }
});

test('renderNetdataConfig rejects invalid port and user', () => {
  for (const invalidPort of [80, 443, 1023, 65536, '19999', null]) {
    assert.throws(
      () => renderNetdataConfig({ port: invalidPort }),
      (error) => error instanceof NetdataTemplateError && error.code === 'netdata_port_invalid',
    );
  }
  for (const invalidUser of ['', '123bad', 'user;drop', '-bad', 'too_long_username_that_exceeds_thirty_two_chars']) {
    assert.throws(
      () => renderNetdataConfig({ runAsUser: invalidUser }),
      (error) => error instanceof NetdataTemplateError && error.code === 'netdata_user_invalid',
    );
  }
});

test('previewNetdataConfiguration generates reproducible sha256 and artifact metadata', () => {
  const preview = previewNetdataConfiguration();
  assert.equal(preview.version, 1);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.artifact.path, '/etc/netdata/netdata.conf');
  assert.equal(preview.artifact.sha256, preview.sha256);
  assert.equal(preview.artifact.mode, 0o644);
  assert.equal(preview.artifact.sensitive, false);
  assert.ok(preview.artifact.bytes > 0);
});
