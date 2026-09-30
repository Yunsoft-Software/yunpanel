import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_EXTENSIONS,
  availableFileActions,
  checkItemConflict,
  fileChild,
  fileCrumbs,
  fileKind,
  fileListing,
  fileParent,
  formatPermissions,
  isArchiveFile,
  paginateFiles,
  parsePermissions,
  toggleVisibleSelection,
  validateDestinationPath,
  validateSafePermissions,
  validFileName,
  validRelativePath,
  visibleFiles,
} from '../src/workspace/ui/file-workspace-model.js';
const dir = { name: 'assets', path: 'assets', type: 'directory', size: 0 };
const file = { name: 'index.php', path: 'index.php', type: 'file', size: 1024, mtime: '2026-09-22T12:00:00Z' };
const hidden = { name: '.env', path: '.env', type: 'file', size: 128, mtime: '2026-09-20T12:00:00Z' };
test('names reject traversal separators and control characters, preserve dotfiles', () => {
  for (const name of ['', '.', '..', '../file', 'a/b', 'a\\b', '\0', 'a\n', 'x'.repeat(256)]) assert.equal(validFileName(name), false, JSON.stringify(name));
  for (const name of ['.env', '.gitignore', 'index.php', 'bir dosya.txt', 'görsel.png']) assert.equal(validFileName(name), true);
});
test('all file paths remain relative to the chosen Website root', () => {
  assert.equal(fileChild('assets', 'style.css'), 'assets/style.css');
  assert.equal(fileParent('assets/css'), 'assets'); assert.equal(fileParent('assets'), '');
  assert.equal(validRelativePath(''), true);
  for (const path of ['/etc', '../site', 'a//b', 'a/../b']) assert.equal(validRelativePath(path), false);
  assert.throws(() => fileChild('assets', '../secret')); assert.throws(() => fileChild('../', 'test'));
  assert.deepEqual(fileCrumbs('assets/css'), [{ name: 'assets', path: 'assets' }, { name: 'css', path: 'assets/css' }]);
});
test('listing validates explicit paths and refuses cross-directory and duplicate entries', () => {
  assert.deepEqual(fileListing({ entries: [file] }, ''), [file]);
  assert.throws(() => fileListing({ entries: [file] }, 'assets'));
  assert.throws(() => fileListing({ entries: [file, file] }, ''));
  assert.throws(() => fileListing({ entries: [{...file, path:'../index.php'}] }, ''));
  assert.throws(() => fileListing({}, ''));
});
test('search, hidden filter, stable sort keep folders first without changing input', () => {
  const input = [file, hidden, dir];
  assert.deepEqual(visibleFiles(input, { hidden: false }), [dir, file]);
  assert.deepEqual(visibleFiles(input, { query: 'INDEX' }), [file]);
  assert.deepEqual(visibleFiles(input, { sort:'size' }), [dir, file, hidden]);
  assert.deepEqual(visibleFiles(input, { sort:'modified' }), [dir, file, hidden]);
  assert.deepEqual(input, [file, hidden, dir]);
});
test('select all applies to filtered items and preserves selections outside filter', () => {
  assert.deepEqual(toggleVisibleSelection(['.env'], [file]), ['.env','index.php']);
  assert.deepEqual(toggleVisibleSelection(['.env','index.php'], [file]), ['.env']);
  assert.deepEqual(toggleVisibleSelection(['.env'], []), ['.env']);
});
test('file labels distinguish directories, dotfiles and symbolic links', () => {
  assert.equal(fileKind(dir), 'Klasör'); assert.equal(fileKind(file), 'PHP'); assert.equal(fileKind(hidden), 'Dosya');
  assert.equal(fileKind({name:'link',type:'symlink'}), 'Sembolik bağlantı');
});
test('isArchiveFile identifies supported archive extensions', () => {
  for (const ext of ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']) {
    assert.equal(isArchiveFile({ name: `backup.${ext}`, type: 'file' }), true, ext);
  }
  assert.equal(isArchiveFile({ name: 'archive.tar.gz', type: 'file' }), true);
  assert.equal(isArchiveFile({ name: 'file.txt', type: 'file' }), false);
  assert.equal(isArchiveFile({ name: 'image.png', type: 'file' }), false);
  assert.equal(isArchiveFile({ name: 'folder.zip', type: 'directory' }), false);
  assert.equal(isArchiveFile({ name: '.zip', type: 'file' }), false);
  assert.equal(isArchiveFile(null), false);
});
test('paginateFiles slices entries according to page and pageSize', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ name: `file${i}.txt`, path: `file${i}.txt`, type: 'file', size: 10 }));
  const p1 = paginateFiles(items, { page: 1, pageSize: 3 });
  assert.equal(p1.page, 1);
  assert.equal(p1.pageSize, 3);
  assert.equal(p1.totalPages, 3);
  assert.equal(p1.totalItems, 7);
  assert.equal(p1.startItem, 1);
  assert.equal(p1.endItem, 3);
  assert.equal(p1.paginatedItems.length, 3);
  assert.equal(p1.paginatedItems[0].name, 'file0.txt');

  const p3 = paginateFiles(items, { page: 3, pageSize: 3 });
  assert.equal(p3.page, 3);
  assert.equal(p3.startItem, 7);
  assert.equal(p3.endItem, 7);
  assert.equal(p3.paginatedItems.length, 1);
  assert.equal(p3.paginatedItems[0].name, 'file6.txt');

  const pOver = paginateFiles(items, { page: 10, pageSize: 3 });
  assert.equal(pOver.page, 3);

  const pUnder = paginateFiles(items, { page: -1, pageSize: 3 });
  assert.equal(pUnder.page, 1);

  const pAll = paginateFiles(items, { pageSize: 0 });
  assert.equal(pAll.page, 1);
  assert.equal(pAll.totalPages, 1);
  assert.equal(pAll.paginatedItems.length, 7);

  const pEmpty = paginateFiles([], { page: 1, pageSize: 10 });
  assert.equal(pEmpty.totalItems, 0);
  assert.equal(pEmpty.startItem, 0);
  assert.equal(pEmpty.endItem, 0);
  assert.equal(pEmpty.paginatedItems.length, 0);
});
test('parsePermissions and formatPermissions convert octal and permission matrices bidirectionally', () => {
  const parsed = parsePermissions('0644');
  assert.equal(parsed.octal, '0644');
  assert.deepEqual(parsed.user, { read: true, write: true, execute: false });
  assert.deepEqual(parsed.group, { read: true, write: false, execute: false });
  assert.deepEqual(parsed.others, { read: true, write: false, execute: false });

  const formatted = formatPermissions(parsed);
  assert.equal(formatted, '0644');

  const numParsed = parsePermissions(0o750);
  assert.equal(numParsed.octal, '0750');
  assert.deepEqual(numParsed.user, { read: true, write: true, execute: true });
  assert.deepEqual(numParsed.group, { read: true, write: false, execute: true });
  assert.deepEqual(numParsed.others, { read: false, write: false, execute: false });
  assert.equal(formatPermissions(numParsed), '0750');
});
test('validateSafePermissions enforces security rules and fails closed', () => {
  assert.equal(validateSafePermissions('0640'), '0640');
  assert.equal(validateSafePermissions('0755', { isDirectory: true }), '0755');

  assert.throws(() => validateSafePermissions('0777'), /world-writable/);
  assert.throws(() => validateSafePermissions('0666'), /world-writable/);
  assert.throws(() => validateSafePermissions('0642'), /world-writable/);

  assert.throws(() => validateSafePermissions('0200'), /okuma izni zorunludur/);
  assert.throws(() => validateSafePermissions('0000'), /okuma izni zorunludur/);

  assert.throws(() => validateSafePermissions('0644', { isDirectory: true }), /arama\/geçiş/);
});
test('checkItemConflict detects case-insensitive name collisions', () => {
  const entries = [
    { name: 'Index.html', type: 'file' },
    { name: 'Styles', type: 'directory' },
  ];
  assert.ok(checkItemConflict(entries, 'index.html'));
  assert.ok(checkItemConflict(entries, 'INDEX.HTML'));
  assert.ok(checkItemConflict(entries, 'styles'));
  assert.equal(checkItemConflict(entries, 'about.html'), null);
  assert.equal(checkItemConflict([], 'test.txt'), null);
  assert.equal(checkItemConflict(null, 'test.txt'), null);
});
test('validateDestinationPath protects against path traversal and directory self-nesting', () => {
  assert.equal(validateDestinationPath(['assets/logo.png'], 'public'), true);
  assert.equal(validateDestinationPath(['assets/logo.png', 'assets/icon.png'], ''), true);

  assert.throws(() => validateDestinationPath(['assets'], '../var'), /Hedef klasör yolu geçersiz/);
  assert.throws(() => validateDestinationPath(['../escape'], 'public'), /Kaynak dosya yolu geçersiz/);

  assert.throws(() => validateDestinationPath(['docs'], 'docs'), /kendi içine veya alt klasörlerine/);
  assert.throws(() => validateDestinationPath(['docs'], 'docs/sub'), /kendi içine veya alt klasörlerine/);
});
test('availableFileActions returns appropriate actions by entry type', () => {
  const directory = { name: 'images', type: 'directory' };
  const txtFile = { name: 'readme.txt', type: 'file' };
  const zipFile = { name: 'backup.zip', type: 'file' };

  assert.deepEqual(availableFileActions(directory), ['archive', 'rename', 'copy', 'move', 'permissions', 'delete']);
  assert.deepEqual(availableFileActions(txtFile), ['download', 'edit', 'rename', 'copy', 'move', 'permissions', 'delete']);
  assert.deepEqual(availableFileActions(zipFile), ['extract', 'download', 'edit', 'rename', 'copy', 'move', 'permissions', 'delete']);
  assert.deepEqual(availableFileActions(null), []);
});
test('validateSafePermissions distinguishes directories from files regarding execute bit', () => {
  assert.equal(validateSafePermissions('0755', { isDirectory: true }), '0755');
  assert.equal(validateSafePermissions('0750', { isDirectory: true }), '0750');
  assert.equal(validateSafePermissions('0640', { isDirectory: false }), '0640');
  assert.throws(() => validateSafePermissions('0640', { isDirectory: true }), /arama\/geçiş/);
});
