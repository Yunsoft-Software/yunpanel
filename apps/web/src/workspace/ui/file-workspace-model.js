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

export const ARCHIVE_EXTENSIONS = Object.freeze(new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z']));

export function isArchiveFile(entry) {
  if (!entry || entry.type !== 'file' || typeof entry.name !== 'string') return false;
  const name = entry.name.toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tar.bz2') || name.endsWith('.tar.xz')) return true;
  const ext = name.includes('.') && !name.startsWith('.') ? name.split('.').at(-1) : '';
  return ARCHIVE_EXTENSIONS.has(ext);
}

export function paginateFiles(entries, { page = 1, pageSize = 50 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!pageSize || pageSize <= 0 || !Number.isFinite(pageSize)) {
    return {
      page: 1,
      pageSize: list.length,
      totalPages: 1,
      totalItems: list.length,
      paginatedItems: list,
      startItem: list.length > 0 ? 1 : 0,
      endItem: list.length,
    };
  }
  const totalItems = list.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, Math.floor(page)), totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedItems = list.slice(startIndex, startIndex + pageSize);
  return {
    page: currentPage,
    pageSize,
    totalPages,
    totalItems,
    paginatedItems,
    startItem: totalItems > 0 ? startIndex + 1 : 0,
    endItem: Math.min(startIndex + pageSize, totalItems),
  };
}

export function parsePermissions(mode) {
  let octalStr = '';
  if (typeof mode === 'string') {
    const clean = mode.trim();
    octalStr = clean.length >= 3 ? clean.slice(-3) : clean.padStart(3, '0');
  } else if (typeof mode === 'number' && Number.isInteger(mode)) {
    octalStr = (mode & 0o777).toString(8).padStart(3, '0');
  } else {
    octalStr = '640';
  }
  const digits = octalStr.padStart(3, '0').slice(-3).split('').map((d) => Number.parseInt(d, 8) || 0);
  const [u, g, o] = digits;
  return {
    octal: `0${octalStr.padStart(3, '0').slice(-3)}`,
    user: { read: (u & 4) !== 0, write: (u & 2) !== 0, execute: (u & 1) !== 0 },
    group: { read: (g & 4) !== 0, write: (g & 2) !== 0, execute: (g & 1) !== 0 },
    others: { read: (o & 4) !== 0, write: (o & 2) !== 0, execute: (o & 1) !== 0 },
  };
}

export function formatPermissions({ user, group, others }) {
  const digit = (r, w, x) => (r ? 4 : 0) + (w ? 2 : 0) + (x ? 1 : 0);
  const u = digit(user?.read, user?.write, user?.execute);
  const g = digit(group?.read, group?.write, group?.execute);
  const o = digit(others?.read, others?.write, others?.execute);
  return `0${u}${g}${o}`;
}

export function validateSafePermissions(modeStr, { isDirectory = false } = {}) {
  const parsed = parsePermissions(modeStr);
  const octalNum = Number.parseInt(parsed.octal, 8);
  if ((octalNum & 0o002) !== 0) {
    throw new Error('Güvenlik ihlali: Başkalarına yazma yetkisi (world-writable) verilemez.');
  }
  if (!parsed.user.read) {
    throw new Error('Dosya sahibi için okuma izni zorunludur.');
  }
  if (isDirectory && !parsed.user.execute) {
    throw new Error('Klasörler için arama/geçiş (execute) izni gereklidir.');
  }
  return parsed.octal;
}

export function checkItemConflict(existingEntries, targetName) {
  if (!Array.isArray(existingEntries) || !targetName) return null;
  const match = existingEntries.find((entry) => entry.name.toLowerCase() === String(targetName).toLowerCase());
  return match ?? null;
}

export function validateDestinationPath(sourcePaths, targetFolder) {
  if (!validRelativePath(targetFolder)) {
    throw new Error('Hedef klasör yolu geçersiz.');
  }
  const sources = Array.isArray(sourcePaths) ? sourcePaths : [sourcePaths];
  for (const src of sources) {
    if (!validRelativePath(src)) throw new Error('Kaynak dosya yolu geçersiz.');
    if (targetFolder === src || targetFolder.startsWith(`${src}/`)) {
      throw new Error('Bir klasör kendi içine veya alt klasörlerine kopyalanamaz/taşınamaz.');
    }
  }
  return true;
}

export function availableFileActions(entry) {
  if (!entry) return [];
  const base = ['rename', 'copy', 'move', 'permissions', 'delete'];
  if (entry.type === 'directory') {
    return ['archive', ...base];
  }
  if (entry.type === 'file') {
    const list = ['download', 'edit', ...base];
    if (isArchiveFile(entry)) list.unshift('extract');
    return list;
  }
  return base;
}
