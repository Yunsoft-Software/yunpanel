// Presentation validation only. The site file backend remains the security boundary.
export function validFileName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && name !== '.' && name !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(name);
}
export function validRelativePath(value) {
  return typeof value === 'string' && value.length <= 4096
    && (value === '' || value.split('/').every(validFileName));
}
export function fileParent(path) {
  return typeof path === 'string' && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}
export function fileChild(parent, name) {
  if (!validRelativePath(parent) || !validFileName(name)) throw new Error('Geçerli bir dosya veya klasör adı girin.');
  return parent ? `${parent}/${name}` : name;
}
export function fileCrumbs(path) {
  return (path ? path.split('/') : []).map((name, i, parts) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}
export function fileListing(result, requestedPath) {
  if (!validRelativePath(requestedPath) || !Array.isArray(result?.entries)) throw new Error('Dosya listesi okunamadı.');
  const paths = new Set();
  for (const entry of result.entries) {
    if (!validFileName(entry?.name) || entry.path !== fileChild(requestedPath, entry.name) || paths.has(entry.path)) {
      throw new Error('Sunucudan tutarsız dosya listesi alındı. Yeniden deneyin.');
    }
    paths.add(entry.path);
  }
  return result.entries;
}
export function visibleFiles(entries, { query = '', hidden = true, sort = 'name' } = {}) {
  const term = String(query).toLowerCase().replace(/i\u0307/g, 'i');
  return entries.filter((entry) => (hidden || !entry.name.startsWith('.'))
    && entry.name.toLowerCase().replace(/i\u0307/g, 'i').includes(term)).sort((a, b) => {
      const folders = Number(b.type === 'directory') - Number(a.type === 'directory');
      if (folders) return folders;
      if (sort === 'size') return (Number(b.size) || 0) - (Number(a.size) || 0) || a.name.localeCompare(b.name);
      if (sort === 'modified') return (Date.parse(b.mtime) || 0) - (Date.parse(a.mtime) || 0) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name, 'tr', { numeric: true });
    });
}
export function toggleVisibleSelection(selected, visible) {
  const names = visible.map((entry) => entry.path);
  const all = names.length > 0 && names.every((path) => selected.includes(path));
  return all ? selected.filter((path) => !names.includes(path)) : [...new Set([...selected, ...names])];
}
export function fileKind(entry) {
  if (entry.type === 'directory') return 'Klasör';
  if (entry.type !== 'file') return entry.type === 'symlink' ? 'Sembolik bağlantı' : 'Özel dosya';
  const extension = entry.name.includes('.') && !entry.name.startsWith('.') ? entry.name.split('.').at(-1).toUpperCase() : '';
  return extension && extension.length <= 8 ? extension : 'Dosya';
}
