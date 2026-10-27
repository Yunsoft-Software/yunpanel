import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.js', import.meta.url);
const { DELIVERY_STATUS, DeliveryStatus, deliveryRange } = await import('../src/workspace/MailDeliveryTrackingPanel.jsx');
const client = readFileSync(new URL('../src/workspace/mail-client.js', import.meta.url), 'utf8');

test('every tracked status has a Turkish label and a badge tone', () => {
  for (const status of ['sent', 'deferred', 'bounced', 'expired', 'rejected', 'queued']) {
    assert.ok(DELIVERY_STATUS[status], status);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(DeliveryStatus, { status })), new RegExp(`>${status}<`));
  }
  assert.match(renderToStaticMarkup(React.createElement(DeliveryStatus, { status: 'bounced' })), /ws-badge-bad[^>]*>.*Geri döndü/);
});

test('the range is an exact ISO window the API accepts', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  assert.deepEqual(deliveryRange(7, now), { since: '2026-10-20T12:00:00.000Z', until: '2026-10-27T12:00:00.000Z' });
});

test('the client calls the tracking route and sends search as q (the server parameter)', () => {
  assert.match(client, /\/delivery-tracking/);
  assert.doesNotMatch(client, /query\.set\('search'/);
  const page = readFileSync(new URL('../src/workspace/MailDomainsPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /\['delivery', 'Teslimat'\]/);
});
