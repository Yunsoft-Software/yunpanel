import * as fs from 'node:fs/promises';
import path from 'node:path';

// Run the real file worker against private OS temp files while retaining its
// production managed-path policy. No global managed directory is created.
export function managedFilesystemDependencies(managedRoot, temporaryRoot) {
  const opened = new Map();
  const map = value => typeof value === 'string' && (value === managedRoot || value.startsWith(managedRoot + '/'))
    ? path.join(temporaryRoot, path.posix.relative(managedRoot, value)) : value;
  const canonical = fs.realpath(temporaryRoot);
  return {
    chmod: (value, mode) => fs.chmod(map(value), mode),
    lstat: value => fs.lstat(map(value)),
    stat: value => fs.stat(map(value)),
    mkdir: (value, options) => fs.mkdir(map(value), options),
    open: async (value, flags, mode) => { const handle = await fs.open(map(value), flags, mode); opened.set(handle.fd, value); return handle; },
    readFile: (value, options) => fs.readFile(map(value), options),
    readdir: (value, options) => fs.readdir(map(value), options),
    rename: (from, to) => fs.rename(map(from), map(to)),
    rm: (value, options) => fs.rm(map(value), options),
    realpath: async value => {
      if (value.startsWith('/proc/self/fd/')) return opened.get(Number(value.split('/').at(-1))) ?? '/unknown-descriptor';
      const resolved = await fs.realpath(map(value)), root = await canonical;
      return resolved === root || resolved.startsWith(root + '/') ? path.posix.join(managedRoot, path.relative(root, resolved)) : resolved;
    },
  };
}
