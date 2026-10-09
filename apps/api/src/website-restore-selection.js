import path from 'node:path';

export class WebsiteRestoreSelectionError extends Error {
  constructor(code, message) { super(message); this.name = 'WebsiteRestoreSelectionError'; this.code = code; this.status = 409; }
}
const within = (value, root) => value === root || value.startsWith(root.replace(/\/$/, '') + '/');
const unique = values => [...new Set(values.filter(v => typeof v === 'string' && path.posix.isAbsolute(v)).map(v => path.posix.normalize(v)))].sort();

export function resolveWebsiteRestoreSelection(backupSet, requested = [], nodes = []) {
  if (!Array.isArray(requested) || requested.some(v => typeof v !== 'string' || !v.trim())) {
    throw new WebsiteRestoreSelectionError('website_restore_selection_invalid', 'Choose the website data to restore.');
  }
  const groups = {
    paths: unique([...(backupSet.files?.targetPaths ?? []), ...(backupSet.data?.targetPaths ?? [])]),
    databases: unique((backupSet.databases ?? []).map(v => v.dumpHook?.stagedDumpPath)),
    mail: unique((backupSet.mail ?? []).flatMap(v => [v.storagePath, v.virtualMailDbSnapshot])),
    dns: unique((backupSet.dns ?? []).map(v => v.stagedZonePath)),
  };
  const allowed = unique(backupSet.targetPaths ?? []);
  const selected = [];
  for (const value of requested) {
    if (Object.hasOwn(groups, value)) {
      if (!groups[value].length) throw new WebsiteRestoreSelectionError('website_restore_selection_empty', 'The selected data is not part of this website backup.');
      selected.push(...groups[value]);
      continue;
    }
    if (!path.posix.isAbsolute(value) || /[*?\[\]{}\u0000]/.test(value) || value.split('/').includes('..')) {
      throw new WebsiteRestoreSelectionError('website_restore_selection_invalid', 'Restore paths must belong to the selected website.');
    }
    let normalized = path.posix.normalize(value);
    const current = backupSet.files?.currentRelease;
    const link = current && nodes.find(node => node.path === current && node.type === 'symlink');
    if (link?.linktarget && within(normalized, current)) {
      const destination = path.posix.resolve(path.posix.dirname(current), link.linktarget);
      if (!backupSet.files?.applicationRoot || !within(destination, backupSet.files.applicationRoot)) {
        throw new WebsiteRestoreSelectionError('website_restore_selection_outside_scope', 'The saved site link points outside this website.');
      }
      normalized = path.posix.join(destination, path.posix.relative(current, normalized));
    }
    if (!allowed.some(root => within(normalized, root))) throw new WebsiteRestoreSelectionError('website_restore_selection_outside_scope', 'A restore path is outside this website backup.');
    selected.push(normalized);
  }
  return Object.freeze(unique(selected));
}

export function assertWebsiteSnapshotContent(nodes, backupSet, selection) {
  const selectedFiles = nodes.filter(node => node.type === 'file' && (!selection.length || selection.some(root => within(node.path, root))));
  if (!selectedFiles.length) throw new WebsiteRestoreSelectionError('website_restore_snapshot_content_missing', 'The snapshot contains no files for this restore selection.');
  const siteRoots = backupSet.files?.targetPaths ?? [];
  const restoringSiteFiles = !selection.length || selection.some(root => siteRoots.some(site => within(root, site) || within(site, root)));
  if (restoringSiteFiles && siteRoots.length && !selectedFiles.some(node => siteRoots.some(root => within(node.path, root)))) {
    throw new WebsiteRestoreSelectionError('website_restore_snapshot_content_missing', 'The snapshot contains a site link but no site files. Choose a verified backup.');
  }
  return selectedFiles.length;
}
