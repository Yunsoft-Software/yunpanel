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
    databases: unique((backupSet.databases ?? []).map(v => v.dumpHook?.stagedBackupDirectory ?? v.dumpHook?.stagedDumpPath)),
    mail: unique((backupSet.mail ?? []).flatMap(v => [v.stagedDataDirectory ?? v.storagePath, v.virtualMailDbSnapshot])),
    dns: unique((backupSet.dns ?? []).map(v => v.stagedZonePath)),
    hosting: unique((backupSet.nginx ?? []).flatMap(v => [v.stagedConfigPath,v.stagedMetadataPath])),
    environment: unique([backupSet.env?.stagedMetadataPath]),
  };
  const allowed = unique(backupSet.targetPaths ?? []);
  if (!allowed.length) throw new WebsiteRestoreSelectionError('website_restore_selection_empty', 'This website has no verified restore paths.');
  if (!requested.length) return Object.freeze(allowed);
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
    const stagedMail = (backupSet.mail ?? []).find(mail => mail.stagedDataDirectory
      && (within(normalized, mail.stagedDataDirectory) || within(mail.stagedDataDirectory, normalized)));
    if (stagedMail) selected.push(stagedMail.stagedDataDirectory, stagedMail.virtualMailDbSnapshot);
    else selected.push(normalized);
  }
  return Object.freeze(unique(selected));
}

export function assertWebsiteSnapshotContent(nodes, backupSet, selection) {
  if (!Array.isArray(nodes)) throw new WebsiteRestoreSelectionError('website_restore_snapshot_content_missing', 'Snapshot content could not be inspected.');
  const selectedFiles = nodes.filter(node => node.type === 'file' && (!selection.length || selection.some(root => within(node.path, root))));
  if (!selectedFiles.length) throw new WebsiteRestoreSelectionError('website_restore_snapshot_content_missing', 'The snapshot contains no files for this restore selection.');
  const siteRoots = backupSet.files?.targetPaths ?? [];
  const restoringSiteFiles = !selection.length || selection.some(root => siteRoots.some(site => within(root, site) || within(site, root)));
  if (restoringSiteFiles && siteRoots.length && !selectedFiles.some(node => siteRoots.some(root => within(node.path, root)))) {
    throw new WebsiteRestoreSelectionError('website_restore_snapshot_content_missing', 'The snapshot contains a site link but no site files. Choose a verified backup.');
  }
  for (const database of backupSet.databases ?? []) {
    const directory = database.dumpHook?.stagedBackupDirectory;
    if (!directory || !selection.some(root => within(directory, root) || within(root, directory))) continue;
    if (!['dump.sql', 'manifest.json'].every(name => nodes.some(node => node.type === 'file' && node.path === path.posix.join(directory, name)))) {
      throw new WebsiteRestoreSelectionError('website_restore_database_content_missing', 'The selected database has no verified dump and manifest in this snapshot.');
    }
  }
  for (const mail of backupSet.mail ?? []) {
    const catalog = mail.virtualMailDbSnapshot;
    if (catalog && selection.some(root => within(catalog, root))
      && !nodes.some(node => node.type === 'file' && node.path === catalog)) {
      throw new WebsiteRestoreSelectionError('website_restore_mail_content_missing', 'The selected mail domain has no protected account catalog in this snapshot.');
    }
    const directory = mail.stagedDataDirectory;
    if (directory && selection.some(root => within(directory, root))
      && !nodes.some(node => node.type === 'file' && node.path === path.posix.join(directory, 'manifest.json'))) {
      throw new WebsiteRestoreSelectionError('website_restore_mail_content_missing', 'The selected mail domain has no verified message backup in this snapshot.');
    }
  }
  for (const entry of backupSet.nginx ?? []) {
    if (![entry.stagedConfigPath,entry.stagedMetadataPath].some(target=>target&&selection.some(root=>within(target,root)))) continue;
    if (![entry.stagedConfigPath,entry.stagedMetadataPath].every(target=>target&&nodes.some(node=>node.type==='file'&&node.path===target))) {
      throw new WebsiteRestoreSelectionError('website_restore_hosting_content_missing','This backup has no verified hosting configuration and manifest.');
    }
  }
  return selectedFiles.length;
}
