import test from 'node:test';
import assert from 'node:assert/strict';
import { fileChild, fileCrumbs, fileKind, fileListing, fileParent, toggleVisibleSelection, validFileName, validRelativePath, visibleFiles } from '../src/workspace/ui/file-workspace-model.js';
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
