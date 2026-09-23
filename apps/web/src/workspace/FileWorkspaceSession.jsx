import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { EMPTY_FILE_SESSION, fileEditorDirty, fileSessionKey, reconcileFileSession, updateFileSession } from './file-session-state.js';

const FileSessionContext = createContext(null);
// The parent is keyed by user, session generation and Domain ID. Only a refresh
// of the same verified Website can resume this in-memory editor and path.
export function FileWorkspaceSession({ input, children }) {
  const [stored, setStored] = useState(EMPTY_FILE_SESSION);
  const state = reconcileFileSession(stored, input);
  // Reset before rendering children; an effect would expose old content for a frame.
  if (state !== stored) setStored(state);
  const key = fileSessionKey(state.binding);
  const setEditor = useCallback((update) => setStored((current) => updateFileSession(current, key, 'editor', update)), [key]);
  const rememberPath = useCallback((path) => setStored((current) => updateFileSession(current, key, 'path', path)), [key]);
  const dirty = fileEditorDirty(state.editor);
  useUnsavedChanges(dirty);
  const waiting = input.domains?.status !== 'ready' || input.websites?.status !== 'ready';
  return <FileSessionContext.Provider value={{ ...state, setEditor, rememberPath }}>
    {waiting && dirty && <p className="ws-muted" role="status">Kaydedilmemiş dosya taslağınız bu sekmede korunuyor. Site erişimi doğrulandığında aynı klasör ve taslak yeniden açılır.</p>}
    {children}
  </FileSessionContext.Provider>;
}
export function useFileWorkspaceSession({ websiteId, runtimeType }) {
  const shared = useContext(FileSessionContext);
  const [localEditor, setLocalEditor] = useState(null);
  const ignorePath = useCallback(() => {}, []);
  const matching = Boolean(shared?.binding && shared.binding.websiteId === websiteId && shared.binding.runtimeType === runtimeType);
  // FileWorkspace is keyed by Website/runtime, so a successful navigation must
  // not restart its initial listing every time the remembered path is updated.
  const initialPath = useRef(matching ? shared.path : '').current;
  useUnsavedChanges(!matching && fileEditorDirty(localEditor));
  return {
    initialPath,
    editor: matching ? shared.editor : localEditor,
    setEditor: matching ? shared.setEditor : setLocalEditor,
    rememberPath: matching ? shared.rememberPath : ignorePath,
  };
}
