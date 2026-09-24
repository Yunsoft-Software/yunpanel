import { panelRequest } from '../api.js';

export function getAiProviders() {
  return panelRequest('/ai/providers');
}

export function saveAiProvider(data) {
  return panelRequest('/ai/providers', {
    method: 'POST',
    body: data,
  });
}

export function deleteAiProvider(providerId) {
  return panelRequest(`/ai/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
}

export function setActiveAiProvider(providerId) {
  return panelRequest(`/ai/providers/${encodeURIComponent(providerId)}/active`, {
    method: 'POST',
  });
}

export function testAiProvider(providerId) {
  return panelRequest(`/ai/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
  });
}

export function getAiPolicy() {
  return panelRequest('/ai/policy');
}

export function previewAiPolicy(data) {
  return panelRequest('/ai/policy/preview', {
    method: 'POST',
    body: data,
  });
}

export function applyAiPolicy(data) {
  return panelRequest('/ai/policy', {
    method: 'POST',
    body: data,
  });
}

export function getAiTools() {
  return panelRequest('/ai/tools');
}

export function listAiConversations(websiteId = null) {
  const query = websiteId ? `?websiteId=${encodeURIComponent(websiteId)}` : '';
  return panelRequest(`/ai/conversations${query}`);
}

export function listAiConversationPage(websiteId = null, { limit = 20, cursor = null, signal } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (websiteId !== null) query.set('websiteId', websiteId);
  if (cursor !== null) query.set('cursor', cursor);
  return panelRequest(`/ai/conversations?${query}`, { signal });
}

export function createAiConversation({ title, websiteId = null } = {}, { signal } = {}) {
  return panelRequest('/ai/conversations', {
    method: 'POST',
    body: { title, websiteId },
    ...(signal ? { signal } : {}),
  });
}

export function getAiConversation(conversationId, { signal } = {}) {
  const path = `/ai/conversations/${encodeURIComponent(conversationId)}`;
  return signal ? panelRequest(path, { signal }) : panelRequest(path);
}

export function deleteAiConversation(conversationId, { signal } = {}) {
  return panelRequest(`/ai/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}

export function sendAiMessage({ conversationId, text }, { signal } = {}) {
  return panelRequest(`/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: { text },
    ...(signal ? { signal } : {}),
  });
}

export function executeAiTool({ toolName, input = {}, previewDigest = null, confirmation = null }) {
  return panelRequest(`/ai/tools/${encodeURIComponent(toolName)}/execute`, {
    method: 'POST',
    body: { input, previewDigest, confirmation },
  });
}

