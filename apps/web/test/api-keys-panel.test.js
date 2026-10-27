import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApiKeyStore } from '../../api/src/api-key-store.js';

register('./jsx-loader.js', import.meta.url);
const { default: ApiKeysPanel, apiKeyRequest } = await import('../src/workspace/ApiKeysPanel.jsx');

test('the key form builds a definition the real key store accepts', async () => {
  const body = apiKeyRequest({ name: ' Kurulum ', parentDomain: ' St.Alan.com ', portMin: '32000', portMax: '32999' });
  assert.deepEqual(body, { name: 'Kurulum', parentDomain: 'st.alan.com', portMin: 32000, portMax: 32999 });
  const { key } = await createApiKeyStore().create(body);
  assert.deepEqual(key.scope, { parentDomain: 'st.alan.com', portMin: 32000, portMax: 32999 });
});

test('the panel offers key creation', () => {
  const markup = renderToStaticMarkup(createElement(ApiKeysPanel));
  for (const label of ['API anahtarları', 'Üst alan adı', 'Anahtar oluştur']) assert.ok(markup.includes(label), label);
});
