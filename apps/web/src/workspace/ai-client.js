import { panelRequest } from '../api.js';
import { sessionHeaders } from '../session-client.js';

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

export async function streamAiMessage({ conversationId, text }, { onEvent, signal } = {}) {
  const url = `/api/panel/ai/conversations/${encodeURIComponent(conversationId)}/messages/stream`;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers: {
      ...sessionHeaders('POST'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    error.code = payload?.error?.code ?? `http_${response.status}`;
    error.status = response.status;
    throw error;
  }

  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (onEvent) onEvent(data);
        } catch {
          // ignore unparseable chunk
        }
      }
    }
  }
  if (buffer.startsWith('data: ')) {
    try {
      const data = JSON.parse(buffer.slice(6));
      if (onEvent) onEvent(data);
    } catch {
      // ignore
    }
  }
}

export function executeAiTool({ toolName, input = {}, previewDigest = null, confirmation = null }) {
  return panelRequest(`/ai/tools/${encodeURIComponent(toolName)}/execute`, {
    method: 'POST',
    body: { input, previewDigest, confirmation },
  });
}

