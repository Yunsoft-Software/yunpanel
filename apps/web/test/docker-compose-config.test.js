import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDockerEnvironmentText } from '../src/workspace/docker-compose-model.js';

test('Docker environment replacement parser preserves value text and rejects duplicate keys', () => {
  assert.deepEqual(parseDockerEnvironmentText('NODE_ENV=production\nAPI_URL=https://example.test?a=b\nEMPTY='), {
    NODE_ENV: 'production',
    API_URL: 'https://example.test?a=b',
    EMPTY: '',
  });
  assert.throws(() => parseDockerEnvironmentText('A=one\nA=two'), /birden fazla/);
  assert.throws(() => parseDockerEnvironmentText('INVALID KEY=value'), /geçersiz environment anahtarı/);
  assert.throws(() => parseDockerEnvironmentText('NO_SEPARATOR'), /KEY=value/);
});
