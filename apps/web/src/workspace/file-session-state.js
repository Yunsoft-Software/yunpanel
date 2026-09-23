import { resolveSiteFilesAccess } from './site-files-access.js';
import { validRelativePath } from './ui/file-workspace-model.js';

// Only in-memory presentation state. This never grants access or caches listings.
export const EMPTY_FILE_SESSION = Object.freeze({ binding: null, path: '', editor: null });
const TRANSIENT = new Set(['idle', 'loading', 'refreshing', 'stale', 'error']);
const bindingFor = (domainId, website) => ({
  domainId, websiteId: website.id, serverId: website.serverId, runtimeType: website.runtimeType,
});
export function fileSessionKey(binding) {
  return binding ? JSON.stringify([binding.domainId, binding.websiteId, binding.serverId, binding.runtimeType]) : null;
}
function readySideStillMatches(collection, binding, kind) {
  if (collection?.status !== 'ready') return TRANSIENT.has(collection?.status);
  if (!Array.isArray(collection.items)) return false;
  const id = kind === 'domain' ? binding.domainId : binding.websiteId;
  const matches = collection.items.filter((item) => item?.id === id);
  if (matches.length !== 1) return false;
  const item = matches[0];
  return item.serverId === binding.serverId && (kind === 'domain'
    ? item.websiteId === binding.websiteId
    : item.runtimeType === binding.runtimeType);
}
export function reconcileFileSession(state = EMPTY_FILE_SESSION, input = {}) {
  const access = resolveSiteFilesAccess(input);
  if (access.state === 'ready') {
    const binding = bindingFor(input.domainId, access.website);
    return fileSessionKey(binding) === fileSessionKey(state.binding)
      ? state : { binding, path: '', editor: null };
  }
  // Permission failures and authoritative binding changes always discard state.
  // A partial refresh may retain it, but the FilesPanel remains unmounted.
  if (access.state === 'unavailable' && state.binding?.domainId === input.domainId
    && readySideStillMatches(input.domains, state.binding, 'domain')
    && readySideStillMatches(input.websites, state.binding, 'website')) return state;
  return EMPTY_FILE_SESSION;
}
export function fileEditorDirty(editor) {
  return Boolean(editor && typeof editor.content === 'string' && typeof editor.saved === 'string'
    && editor.content !== editor.saved);
}
function validEditor(editor) {
  return editor === null || (editor && typeof editor.name === 'string'
    && typeof editor.path === 'string' && editor.path.length > 0 && validRelativePath(editor.path)
    && typeof editor.content === 'string' && typeof editor.saved === 'string'
    && typeof editor.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(editor.sha256));
}
export function updateFileSession(state, key, field, update) {
  // A delayed callback from a former child cannot update the new binding.
  if (!state.binding || key !== fileSessionKey(state.binding) || !['path', 'editor'].includes(field)) return state;
  const value = typeof update === 'function' ? update(state[field]) : update;
  if (field === 'path' ? !validRelativePath(value) : !validEditor(value)) return state;
  return state[field] === value ? state : { ...state, [field]: value };
}
