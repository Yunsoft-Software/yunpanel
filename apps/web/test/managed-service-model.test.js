import assert from 'node:assert/strict';
import test from 'node:test';
import {
  managedServiceActions,
  managedServiceCategoryLabel,
  managedServiceConflict,
  managedServiceStatus,
  managedServiceVersion,
} from '../src/workspace/managed-service-model.js';

test('service status distinguishes missing, stopped, active and inspection failures', () => {
  assert.deepEqual(managedServiceStatus({ installed: false }), { state: 'unknown', label: 'Kurulu değil' });
  assert.deepEqual(managedServiceStatus({ installed: true, active: false, units: [] }), { state: 'off', label: 'Durduruldu' });
  assert.deepEqual(managedServiceStatus({ installed: true, active: true }), { state: 'active', label: 'Çalışıyor' });
  assert.deepEqual(managedServiceStatus({ installed: true, active: false, units: [{ inspectionError: true }] }), { state: 'warning', label: 'Durum doğrulanamadı' });
});

test('installed service exposes lifecycle actions but not reinstall', () => {
  assert.deepEqual(managedServiceActions({ id: 'nginx', installed: true, active: true }), {
    install: false, start: false, stop: true, restart: true, conflict: null,
  });
  assert.deepEqual(managedServiceActions({ id: 'nginx', installed: true, active: false }), {
    install: false, start: true, stop: false, restart: true, conflict: null,
  });
});

test('MySQL and MariaDB conflicts are visible before installation', () => {
  const services = [
    { id: 'mariadb', label: 'MariaDB', installed: true, active: true },
    { id: 'mysql', label: 'MySQL', installed: false, active: false },
  ];
  assert.equal(managedServiceConflict(services[1], services), 'MariaDB kurulu olduğu için birlikte kurulamaz.');
  assert.deepEqual(managedServiceActions(services[1], services), {
    install: false, start: false, stop: false, restart: false,
    conflict: 'MariaDB kurulu olduğu için birlikte kurulamaz.',
  });
});

test('service metadata provides category labels and package versions', () => {
  assert.equal(managedServiceCategoryLabel('database'), 'Veritabanı');
  assert.equal(managedServiceCategoryLabel('custom'), 'custom');
  assert.equal(managedServiceVersion({ packages: [{ version: '1.2.3' }, { version: null }] }), '1.2.3');
  assert.equal(managedServiceVersion({ packages: [] }), null);
});
