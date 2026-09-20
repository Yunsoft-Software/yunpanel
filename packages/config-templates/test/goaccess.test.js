import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOACCESS_DATE_FORMAT,
  GOACCESS_DEFAULT_REPORTS_ROOT,
  GOACCESS_DEFAULT_SOCKET_ROOT,
  GOACCESS_LOG_FORMAT,
  GOACCESS_TIME_FORMAT,
  GoAccessTemplateError,
  goAccessTemplatePolicy,
  previewGoAccessConfig,
  renderGoAccessConfig,
} from '../src/index.js';

test('goAccessTemplatePolicy defines fixed formats and defaults', () => {
  assert.equal(goAccessTemplatePolicy.logFormat, 'COMBINED');
  assert.equal(goAccessTemplatePolicy.dateFormat, '%d/%b/%Y');
  assert.equal(goAccessTemplatePolicy.timeFormat, '%H:%M:%S');
  assert.equal(goAccessTemplatePolicy.defaultSocketRoot, '/run/yunpanel/goaccess');
  assert.equal(goAccessTemplatePolicy.defaultReportsRoot, '/var/lib/yunpanel/reports/goaccess');
});

test('renderGoAccessConfig renders valid baseline configuration with default settings', () => {
  const config = renderGoAccessConfig();
  assert.match(config, /^time-format %H:%M:%S$/m);
  assert.match(config, /^date-format %d\/%b\/%Y$/m);
  assert.match(config, /^log-format COMBINED$/m);
  assert.equal(config.includes('real-time-html'), false);
});

test('renderGoAccessConfig renders real-time configuration with unix socket and ws-url', () => {
  const config = renderGoAccessConfig({
    logPath: '/var/log/nginx/example.com.access.log',
    outputPath: '/var/lib/yunpanel/reports/goaccess/site-1.html',
    realTime: true,
    wsUrl: 'wss://panel.example.com/tools/goaccess/site-1/ws',
    unixSocket: '/run/yunpanel/goaccess/site-1.sock',
    pidFile: '/run/yunpanel/goaccess/site-1.pid',
  });

  assert.match(config, /^log-file \/var\/log\/nginx\/example\.com\.access\.log$/m);
  assert.match(config, /^output \/var\/lib\/yunpanel\/reports\/goaccess\/site-1\.html$/m);
  assert.match(config, /^real-time-html true$/m);
  assert.match(config, /^ws-url wss:\/\/panel\.example\.com\/tools\/goaccess\/site-1\/ws$/m);
  assert.match(config, /^unix-socket \/run\/yunpanel\/goaccess\/site-1\.sock$/m);
  assert.match(config, /^pid-file \/run\/yunpanel\/goaccess\/site-1\.pid$/m);
});

test('renderGoAccessConfig rejects unsafe paths fail-closed', () => {
  assert.throws(
    () => renderGoAccessConfig({ logPath: 'relative/path.log' }),
    (error) => error instanceof GoAccessTemplateError && error.code === 'invalid_path',
  );
  assert.throws(
    () => renderGoAccessConfig({ logPath: '/var/log/../../etc/passwd' }),
    (error) => error instanceof GoAccessTemplateError && error.code === 'invalid_path',
  );
  assert.throws(
    () => renderGoAccessConfig({ realTime: true, unixSocket: '/tmp/../etc/bad.sock' }),
    (error) => error instanceof GoAccessTemplateError && error.code === 'invalid_path',
  );
  assert.throws(
    () => renderGoAccessConfig({ realTime: true, wsUrl: 'bad url with spaces' }),
    (error) => error instanceof GoAccessTemplateError && error.code === 'invalid_ws_url',
  );
});

test('previewGoAccessConfig generates reproducible sha256 and metadata', () => {
  const preview = previewGoAccessConfig({
    logPath: '/var/log/nginx/test.access.log',
    realTime: true,
  });

  assert.equal(typeof preview.checksum, 'string');
  assert.equal(preview.checksum.length, 64);
  assert.equal(preview.logFormat, 'COMBINED');
  assert.equal(preview.realTime, true);
  assert.equal(preview.content, renderGoAccessConfig({
    logPath: '/var/log/nginx/test.access.log',
    realTime: true,
  }));
});
