import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSystemdProperties, systemdInspectionPolicy } from '../src/systemd-inspector.js';

test('parses fixed systemd show properties', () => {
  const parsed = parseSystemdProperties(`
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled
`);

  assert.deepEqual(parsed, {
    loadState: 'loaded',
    activeState: 'active',
    subState: 'running',
    unitFileState: 'enabled',
  });
});

test('systemd inspection policy contains only fixed unit names', () => {
  assert.ok(systemdInspectionPolicy.units.includes('nginx.service'));
  assert.ok(systemdInspectionPolicy.units.includes('docker.service'));
  assert.equal(systemdInspectionPolicy.units.includes('user-supplied.service'), false);

  for (const unit of systemdInspectionPolicy.units) {
    assert.match(unit, /^[a-z0-9@_.-]+\.service$/i);
  }
});
