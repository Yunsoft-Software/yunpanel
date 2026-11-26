import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.js', import.meta.url);
const { Field, Select, Table, Tabs, nextTabIndex } = await import('../src/workspace/PanelKit.jsx');

test('Table renders the shared table markup, hidden column labels and rows', () => {
  const html = renderToStaticMarkup(h(Table, {
    label: 'İşlem kayıtları', className: 'ws-table ws-jobs-table',
    columns: ['İşlem', { label: 'İşlemler', className: 'ws-row-end', hidden: true }],
  }, [h('tr', { key: 'a', role: 'row' }, h('td', { role: 'cell' }, 'Yedek'))]));
  assert.match(html, /^<div class="ws-table-scroll"><table class="ws-table ws-jobs-table" role="table" aria-label="İşlem kayıtları">/);
  assert.match(html, /<th scope="col" role="columnheader">İşlem<\/th>/);
  assert.match(html, /<th scope="col" role="columnheader" class="ws-row-end"><span class="ws-sr-only">İşlemler<\/span><\/th>/);
  assert.match(html, /<tbody role="rowgroup"><tr role="row"><td role="cell">Yedek<\/td><\/tr><\/tbody>/);
});

test('Table shows the empty state only when there are no rows', () => {
  const empty = h('p', null, 'Kayıt yok');
  assert.equal(renderToStaticMarkup(h(Table, { label: 'Liste', columns: ['Ad'], empty }, [])), '<p>Kayıt yok</p>');
  const withoutEmpty = renderToStaticMarkup(h(Table, { label: 'Liste', columns: ['Ad'] }, []));
  assert.match(withoutEmpty, /<tbody role="rowgroup"><\/tbody>/);
  const withRows = renderToStaticMarkup(h(Table, { label: 'Liste', columns: ['Ad'], empty }, [h('tr', { key: 1 })]));
  assert.doesNotMatch(withRows, /Kayıt yok/);
});

test('Field links label, control, hint and error', () => {
  const html = renderToStaticMarkup(h(Field, { label: 'Kota', hint: 'MiB cinsinden', error: 'Geçersiz değer', className: 'ws-filter-search' },
    h('input', { type: 'number', 'aria-describedby': 'outer' })));
  const id = html.match(/<input[^>]* id="([^"]+)"/)[1];
  assert.match(html, new RegExp(`^<label class="ws-filter-search" for="${id}">Kota<input`));
  const describedBy = html.match(/aria-describedby="([^"]+)"/)[1].split(' ');
  assert.equal(describedBy[0], 'outer');
  assert.equal(describedBy.length, 3);
  assert.match(html, new RegExp(`<span id="${describedBy[1]}" class="ws-field-hint">MiB cinsinden</span>`));
  assert.match(html, new RegExp(`<span id="${describedBy[2]}" class="ws-field-hint" role="alert">Geçersiz değer</span>`));
  assert.match(html, /aria-invalid="true"/);
});

test('Field keeps an existing control id and adds nothing extra without hint or error', () => {
  const html = renderToStaticMarkup(h(Field, { label: 'Ad' }, h('input', { id: 'name' })));
  assert.equal(html, '<label for="name">Ad<input id="name"/></label>');
});

test('Select renders options with values, labels and disabled state', () => {
  const html = renderToStaticMarkup(h(Select, { 'aria-label': 'Durum', value: 'b', onChange() {}, options: [
    { value: 'a', label: 'Birinci' }, { value: 'b', label: 'İkinci', disabled: true },
  ] }));
  assert.match(html, /^<select aria-label="Durum">/);
  assert.match(html, /<option value="a">Birinci<\/option>/);
  assert.match(html, /<option value="b" disabled="" selected="">İkinci<\/option>/);
});

test('Tabs renders one tab stop with the selected tab marked', () => {
  const html = renderToStaticMarkup(h(Tabs, { label: 'Merkez sekmeleri', className: 'yp-notification-tabs', value: 'alerts', onChange() {},
    items: [{ id: 'tasks', label: 'Görevler' }, { id: 'alerts', label: 'Uyarılar' }] }));
  assert.match(html, /^<div class="ws-tabs yp-notification-tabs" role="tablist" aria-label="Merkez sekmeleri">/);
  assert.match(html, /<button type="button" role="tab" aria-selected="false" tabindex="-1" class="ws-tab">Görevler<\/button>/);
  assert.match(html, /<button type="button" role="tab" aria-selected="true" tabindex="0" class="ws-tab is-active">Uyarılar<\/button>/);
});

test('Tabs keyboard moves wrap with arrows and jump with Home/End', () => {
  assert.equal(nextTabIndex('ArrowRight', 0, 3), 1);
  assert.equal(nextTabIndex('ArrowRight', 2, 3), 0);
  assert.equal(nextTabIndex('ArrowLeft', 0, 3), 2);
  assert.equal(nextTabIndex('Home', 2, 3), 0);
  assert.equal(nextTabIndex('End', 0, 3), 2);
  assert.equal(nextTabIndex('ArrowRight', -1, 3), 1);
  assert.equal(nextTabIndex('Enter', 0, 3), null);
  assert.equal(nextTabIndex('ArrowRight', 0, 0), null);
});
