import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationCreatePayload } from '../src/workspace/application-form.js';
const form = { type: 'node', serverId: '', name: 'Demo', repositoryUrl: 'https://github.com/example/project', branch: 'main', port: '4301', entryFile: 'server.js', healthPath: '/health', outputDir: 'dist' };
test('multiple servers require a deliberate selection, one server may default', () => {
  assert.throws(() => applicationCreatePayload(form, [{ id: 'a' }, { id: 'b' }]), /sunucu/);
  assert.equal(applicationCreatePayload(form, [{ id: 'a' }]).serverId, 'a');
  assert.equal(applicationCreatePayload({ ...form, serverId: 'b' }, [{ id: 'a' }, { id: 'b' }]).serverId, 'b');
});
test('unknown servers and invalid ports are rejected', () => {
  assert.throws(() => applicationCreatePayload({ ...form, serverId: 'missing' }, [{ id: 'a' }]), /sunucu/);
  for (const port of ['', '1023', '65536', '4.5', 'x']) assert.throws(() => applicationCreatePayload({ ...form, port }, [{ id: 'a' }]), /Port/);
});
test('static and node requests retain their actual backend contracts', () => {
  const node = applicationCreatePayload(form, [{ id: 'a' }]);
  assert.equal(node.runtime.startMode, 'node'); assert.equal(node.runtime.nodeMajor, 24); assert.equal(node.build, undefined);
  const staticApp = applicationCreatePayload({ ...form, type: 'static' }, [{ id: 'a' }]);
  assert.equal(staticApp.runtime, undefined); assert.equal(staticApp.build.outputDir, 'dist'); assert.equal(staticApp.build.installMode, 'ci');
});
