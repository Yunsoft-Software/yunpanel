import { requestJson } from '../session-client.js';

export function getAiProviders() {
  return requestJson('/api/ai/providers');
}

export function saveAiProvider(data) {
  return requestJson('/api/ai/providers', {
    method: 'POST',
    body: data,
  });
}

export function deleteAiProvider(providerId) {
  return requestJson(`/api/ai/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
}

export function setActiveAiProvider(providerId) {
  return requestJson(`/api/ai/providers/${encodeURIComponent(providerId)}/active`, {
    method: 'POST',
  });
}

export function testAiProvider(providerId) {
  return requestJson(`/api/ai/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
  });
}

export function getAiPolicy() {
  return requestJson('/api/ai/policy');
}

export function previewAiPolicy(data) {
  return requestJson('/api/ai/policy/preview', {
    method: 'POST',
    body: data,
  });
}

export function applyAiPolicy(data) {
  return requestJson('/api/ai/policy', {
    method: 'POST',
    body: data,
  });
}

export function getAiTools() {
  return requestJson('/api/ai/tools');
}

export function listAiConversations(websiteId = null) {
  const query = websiteId ? `?websiteId=${encodeURIComponent(websiteId)}` : '';
  return requestJson(`/api/ai/conversations${query}`);
}

export function createAiConversation({ title, websiteId = null } = {}) {
  return requestJson('/api/ai/conversations', {
    method: 'POST',
    body: { title, websiteId },
  });
}

export function getAiConversation(conversationId) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}`);
}

export function deleteAiConversation(conversationId) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}

export function sendAiMessage({ conversationId, text }) {
  return requestJson(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: { text },
  });
}

export function executeAiTool({ toolName, input = {}, previewDigest = null, confirmation = null }) {
  return requestJson(`/api/ai/tools/${encodeURIComponent(toolName)}/execute`, {
    method: 'POST',
    body: { input, previewDigest, confirmation },
  });
}
