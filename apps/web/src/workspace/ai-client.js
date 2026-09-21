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

export function createAiConversation({ title, websiteId = null } = {}) {
  return panelRequest('/ai/conversations', {
    method: 'POST',
    body: { title, websiteId },
  });
}

export function getAiConversation(conversationId) {
  return panelRequest(`/ai/conversations/${encodeURIComponent(conversationId)}`);
}

export function deleteAiConversation(conversationId) {
  return panelRequest(`/ai/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}

export function sendAiMessage({ conversationId, text }) {
  return panelRequest(`/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: { text },
  });
}

export function executeAiTool({ toolName, input = {}, previewDigest = null, confirmation = null }) {
  return panelRequest(`/ai/tools/${encodeURIComponent(toolName)}/execute`, {
    method: 'POST',
    body: { input, previewDigest, confirmation },
  });
}

