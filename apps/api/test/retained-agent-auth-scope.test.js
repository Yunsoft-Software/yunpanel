import assert from 'node:assert/strict';
import test from 'node:test';
import { isAgentRoute } from '../src/auth-http.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const jobId = '123e4567-e89b-12d3-a456-426614174000';

test('retired enrollment endpoint is not an agent-channel auth bypass', () => {
  assert.equal(isAgentRoute('POST', '/api/servers/enroll'), false);
  assert.equal(isAgentRoute('GET', '/api/servers/enroll'), false);
  assert.equal(isAgentRoute('POST', '/api/servers/enrollment-tokens'), false);
});

test('only retained rollback transport routes keep the agent-channel auth boundary', () => {
  assert.equal(isAgentRoute('POST', `/api/servers/${serverId}/heartbeat`), true);
  assert.equal(isAgentRoute('GET', `/api/servers/${serverId}/commands/next`), true);
  assert.equal(isAgentRoute('GET', `/api/servers/${serverId}/applications/${applicationId}/environment`), true);
  assert.equal(isAgentRoute('POST', `/api/servers/${serverId}/commands/${jobId}/result`), true);

  assert.equal(isAgentRoute('POST', `/api/servers/${serverId}/commands/next`), false);
  assert.equal(isAgentRoute('GET', `/api/servers/${serverId}/heartbeat`), false);
  assert.equal(isAgentRoute('GET', `/api/servers/${serverId}/commands/${jobId}/result`), false);
});
