import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createOperationalNotificationService } from '../../api/src/operational-notification-service.js';

register('./jsx-loader.js', import.meta.url);
const {
  default: NotificationSettingsPanel, deliveryProblem, notificationFormValues, notificationPreferencesRequest,
} = await import('../src/workspace/NotificationSettingsPanel.jsx');

test('the form round-trips through the real notification service', () => {
  const service = createOperationalNotificationService();
  const values = notificationFormValues(service.getPreferences('usr-owner'));
  assert.equal(values.address, '');

  const saved = service.updatePreferences('usr-owner', notificationPreferencesRequest({
    ...values,
    address: ' Alerts@Example.com ',
    panel: false,
    categories: { ...values.categories, disk: false },
  }));
  assert.equal(saved.channels.email.address, 'alerts@example.com');
  assert.equal(saved.channels.panel.enabled, false);
  assert.equal(saved.categories.disk, false);
  assert.deepEqual(notificationFormValues(saved).categories, { ssl: true, backup: true, disk: false, service: true });

  const cleared = service.updatePreferences('usr-owner', notificationPreferencesRequest({ ...notificationFormValues(saved), address: '  ' }));
  assert.equal(cleared.channels.email.address, null);
});

test('delivery problems are described without internal codes', () => {
  assert.equal(deliveryProblem({ status: 'delivered' }), null);
  assert.equal(deliveryProblem({ status: 'failed', error: { code: 'recipient_email_missing' } }), 'E-posta adresi yok');
  assert.equal(deliveryProblem({ status: 'failed', error: { code: 'smtp_delivery_failed' } }), 'Gönderilemedi');
});

test('the panel renders its heading before settings load', () => {
  assert.ok(renderToStaticMarkup(createElement(NotificationSettingsPanel)).includes('Bildirimler'));
});
