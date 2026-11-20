import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { assertDomainName, assertUuid, isInfrastructureDatabase } from '@yunpanel/shared';
import { createPleskImporter } from './plesk-importer.js';

const EXPORT_NAME = 'plesk.json';
const SITE_NAME = 'site';
const SQL_NAME = 'database.sql';
const RECEIPT_NAME = 'transfer.json';
const BUNDLE_ENTRIES = [SQL_NAME, EXPORT_NAME, SITE_NAME];
const MAX_EXPORT_BYTES = 256 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export class PleskOfflineTransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PleskOfflineTransferError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PleskOfflineTransferError(`plesk_transfer_${code}`, message);
}

function domainName(value) {
  let domain;
  try {
    domain = assertDomainName(value);
  } catch {
    fail('domain_invalid', 'Use valid source and target domain names');
  }
  if (isIP(domain)) fail('domain_invalid', 'Use domain names instead of IP addresses');
  return domain;
}

function databaseName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(value) || isInfrastructureDatabase(value)) {
    fail('database_invalid', 'Use explicit site database names');
  }
  return value;
}

function safeName(value) {
  return value && value !== '.' && value !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(value);
}

function includesPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':');
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function inspectEntry(filePath, uid) {
  const stat = await lstat(filePath, { bigint: true });
  if (!(stat.isDirectory() || stat.isFile()) || stat.uid !== BigInt(uid) || (stat.mode & 0o7022n) !== 0n
    || (stat.isFile() && stat.nlink !== 1n)) {
    fail('entry_unsafe', 'Use locally owned directories and regular files without unsafe modes, links or special entries');
  }
  return stat;
}

async function canonicalDirectory(value, uid) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)
    || value.split(path.sep).some((component) => component === '.' || component === '..')) {
    fail('directory_invalid', 'Provide absolute paths for the bundle and staging directory');
  }
  const absolute = path.resolve(value);
  const stat = await inspectEntry(absolute, uid);
  if (!stat.isDirectory() || absolute === path.parse(absolute).root || await realpath(absolute) !== absolute) {
    fail('directory_invalid', 'Use real local directories without symbolic path components');
  }
  return { absolute, stat };
}

async function assertUnchanged(filePath, original) {
  if (fingerprint(await lstat(filePath, { bigint: true })) !== fingerprint(original)) {
    fail('content_changed', 'An input changed during inspection. Run the preview again after the export finishes');
  }
}

async function readInput(filePath, stat, { maxBytes = null, destination, mode = 0o600 } = {}) {
  if (!stat.isFile()) fail('file_invalid', 'The bundle contains a non-file at a required file path');
  if (maxBytes !== null && stat.size > BigInt(maxBytes)) fail('export_too_large', 'The Plesk metadata file exceeds its size limit');

  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat)) {
      fail('content_changed', 'An input changed during inspection');
    }
    const hash = createHash('sha256');
    const chunks = [];
    let bytes = 0n;
    if (destination) output = await open(destination, 'wx', 0o600);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += BigInt(chunk.length);
      if (bytes > stat.size) fail('content_changed', 'An input grew during inspection');
      hash.update(chunk);
      if (maxBytes !== null) chunks.push(chunk);
      if (output) await output.writeFile(chunk);
    }
    if (bytes !== stat.size || fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat)) {
      fail('content_changed', 'An input changed during inspection');
    }
    await assertUnchanged(filePath, stat);
    if (output) {
      await output.chmod(mode);
      await output.sync();
    }
    return {
      sha256: hash.digest('hex'),
      bytes: stat.size.toString(),
      ...(maxBytes === null ? {} : { content: Buffer.concat(chunks).toString('utf8') }),
    };
  } finally {
    await Promise.all([handle.close(), output?.close()]);
  }
}

async function inspectSite(sitePath, siteStat, documentRoot, uid, destination) {
  if (!siteStat.isDirectory()) fail('site_invalid', 'The bundle must contain a site directory');
  const digest = createHash('sha256');
  let files = 0;
  let directories = 0;
  let bytes = 0n;
  let documentRootFiles = 0;

  async function walk(directory, relative, stat, copyDirectory) {
    if (copyDirectory) await mkdir(copyDirectory, { mode: 0o700 });
    for (const name of (await readdir(directory)).sort()) {
      if (!safeName(name)) fail('entry_unsafe', 'The site contains an unsafe file or directory name');
      const childPath = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = await inspectEntry(childPath, uid);
      const copyPath = copyDirectory && path.join(copyDirectory, name);
      const mode = child.mode & 0o777n;
      if (child.isDirectory()) {
        directories += 1;
        digest.update(`${JSON.stringify(['directory', childRelative, String(mode)])}\n`);
        await walk(childPath, childRelative, child, copyPath);
        if (copyPath) await chmod(copyPath, Number(mode));
      } else {
        const input = await readInput(childPath, child, { destination: copyPath, mode: Number(mode) });
        files += 1;
        bytes += child.size;
        if (childRelative.startsWith(`${documentRoot}/`)) documentRootFiles += 1;
        digest.update(`${JSON.stringify(['file', childRelative, String(mode), input.bytes, input.sha256])}\n`);
      }
    }
    await assertUnchanged(directory, stat);
  }

  await walk(sitePath, '', siteStat, destination);
  if (documentRootFiles === 0) {
    fail('site_invalid', 'Include the declared document root and site files in the bundle');
  }
  return { sha256: digest.digest('hex'), files, directories, bytes: bytes.toString() };
}

function parseExport(content, serverId, sourceDomain, sourceDatabase) {
  let data;
  let preview;
  try {
    data = JSON.parse(content);
    preview = createPleskImporter({ localServerId: serverId }).importFromOfflineExport(data);
  } catch {
    fail('export_invalid', 'Use a valid and allowed Plesk offline JSON export');
  }
  const rows = Array.isArray(data.websites) ? data.websites : Array.isArray(data.domains) ? data.domains : [data];
  const [site] = preview.websites;
  if ((Array.isArray(data.websites) && Array.isArray(data.domains)) || rows.length !== 1
    || preview.websites.length !== 1 || site.primaryDomain !== sourceDomain) {
    fail('source_mismatch', 'The bundle must contain only the explicitly selected source site');
  }
  const runtime = rows[0].runtime || rows[0];
  const rawPhpVersion = String(runtime.phpVersion || '').trim();
  const declaredPhpVersion = /^(\d+\.\d+)(?:\.\d+)?$/.exec(rawPhpVersion)?.[1];
  if (site.runtime.type !== 'php' || declaredPhpVersion !== site.runtime.phpVersion) {
    fail('runtime_unsupported', 'Specify a supported PHP version for this transfer');
  }
  const documentRoot = site.runtime.documentRoot;
  if (!documentRoot.split('/').every(safeName)) {
    fail('document_root_invalid', 'Declare the PHP document root as a relative directory within site/');
  }
  const rawDatabases = rows[0].databases;
  const rawDatabase = rawDatabases?.[0];
  if (!Array.isArray(rawDatabases) || rawDatabases.length !== 1 || site.databases.length !== 1
    || site.databases[0].name !== sourceDatabase
    || [rawDatabase?.type, rawDatabase?.engine].some((engine) => engine != null
      && !['mysql', 'mariadb'].includes(String(engine).trim().toLowerCase()))) {
    fail('source_mismatch', 'The bundle must contain only the selected MySQL or MariaDB database');
  }
  return { phpVersion: site.runtime.phpVersion, documentRoot };
}

async function inspectBundle(bundle, uid, { serverId, sourceDomain, sourceDatabase }, destination) {
  if (JSON.stringify((await readdir(bundle.absolute)).sort()) !== JSON.stringify(BUNDLE_ENTRIES)) {
    fail('layout_invalid', 'The bundle must contain only plesk.json, site/ and database.sql');
  }
  const exportPath = path.join(bundle.absolute, EXPORT_NAME);
  const sitePath = path.join(bundle.absolute, SITE_NAME);
  const sqlPath = path.join(bundle.absolute, SQL_NAME);
  const copyPath = (name) => destination && path.join(destination, name);
  const metadata = await readInput(exportPath, await inspectEntry(exportPath, uid), {
    maxBytes: MAX_EXPORT_BYTES, destination: copyPath(EXPORT_NAME),
  });
  const runtime = parseExport(metadata.content, serverId, sourceDomain, sourceDatabase);
  const site = await inspectSite(sitePath, await inspectEntry(sitePath, uid), runtime.documentRoot, uid, copyPath(SITE_NAME));
  const sql = await readInput(sqlPath, await inspectEntry(sqlPath, uid), { destination: copyPath(SQL_NAME) });
  if (sql.bytes === '0') fail('sql_empty', 'The database dump must be present and non-empty');
  await assertUnchanged(bundle.absolute, bundle.stat);
  return { runtime, files: { exportSha256: metadata.sha256, site, sql } };
}

async function inspectTransfer({
  bundleDirectory, stagingDirectory, serverId, sourceDomain, sourceDatabase,
  targetDomain, targetDatabase, expectedDigest,
} = {}) {
  const uid = process.getuid?.();
  if (uid === undefined) fail('platform_unsupported', 'A POSIX filesystem with local ownership checks is required');
  let targetServer;
  try {
    targetServer = assertUuid(serverId, 'serverId');
  } catch {
    fail('server_invalid', 'Provide the target YunPanel server UUID');
  }
  sourceDomain = domainName(sourceDomain);
  targetDomain = domainName(targetDomain);
  sourceDatabase = databaseName(sourceDatabase);
  targetDatabase = databaseName(targetDatabase);
  if (expectedDigest !== undefined && (typeof expectedDigest !== 'string' || !DIGEST_PATTERN.test(expectedDigest))) {
    fail('digest_invalid', 'Provide a lower-case SHA-256 digest from a previous preview');
  }

  try {
    const bundle = await canonicalDirectory(bundleDirectory, uid);
    const staging = await canonicalDirectory(stagingDirectory, uid);
    if (includesPath(bundle.absolute, staging.absolute) || includesPath(staging.absolute, bundle.absolute)) {
      fail('directory_overlap', 'The bundle and staging directory must be separate');
    }
    if ((await readdir(staging.absolute)).length !== 0) fail('target_not_empty', 'Use an empty staging directory');
    const identity = { serverId: targetServer, sourceDomain, sourceDatabase };
    const { runtime, files } = await inspectBundle(bundle, uid, identity);
    await assertUnchanged(staging.absolute, staging.stat);

    const preview = {
      version: 1,
      source: { domain: sourceDomain, database: sourceDatabase, ...runtime },
      target: { serverId: targetServer, domain: targetDomain, database: targetDatabase },
      files,
      readOnly: true,
    };
    const digest = createHash('sha256')
      .update(JSON.stringify([preview, staging.absolute, String(staging.stat.dev), String(staging.stat.ino)]))
      .digest('hex');
    if (expectedDigest !== undefined && digest !== expectedDigest) {
      fail('digest_mismatch', 'The bundle or target differs from the approved preview');
    }
    return { preview: { ...preview, digest }, bundle, staging, uid, identity };
  } catch (error) {
    if (error instanceof PleskOfflineTransferError) throw error;
    fail('input_unavailable', 'Could not read and verify the local bundle and staging directory');
  }
}

export async function previewPleskOfflineTransfer(options) {
  return (await inspectTransfer(options)).preview;
}

async function cleanupPrivateDirectory(directory, identity) {
  if (!sameEntry(identity, await lstat(directory, { bigint: true }))) {
    fail('staging_cleanup_failed', 'The private staging directory changed before cleanup');
  }

  async function makeRemovable(current) {
    if (!(await lstat(current)).isDirectory()) return;
    await chmod(current, 0o700);
    for (const name of await readdir(current)) await makeRemovable(path.join(current, name));
  }

  await makeRemovable(directory);
  await rm(directory, { recursive: true, force: true });
}

let stagingActive = false;

// The operator CLI runs this in a dedicated process so relative writes stay on the verified directory inode.
export async function stagePleskOfflineTransfer(options = {}) {
  if (options.expectedDigest === undefined) fail('digest_required', 'Staging requires the digest of an approved preview');
  if (stagingActive) fail('staging_busy', 'A staging operation is already active in this process');
  stagingActive = true;
  let initialDirectory;
  let privateDirectory;
  let privateIdentity;
  let published = false;
  try {
    const { preview, bundle, staging, uid, identity } = await inspectTransfer(options);
    initialDirectory = process.cwd();
    process.chdir(staging.absolute);
    await assertUnchanged('.', staging.stat);
    privateDirectory = await mkdtemp('.transfer-');
    privateIdentity = await inspectEntry(privateDirectory, uid);
    const preparedPath = path.join(privateDirectory, 'bundle');
    await mkdir(preparedPath, { mode: 0o700 });

    const prepared = await inspectBundle(bundle, uid, identity, preparedPath);
    const readback = await inspectBundle({ absolute: preparedPath, stat: await inspectEntry(preparedPath, uid) }, uid, identity);
    if (JSON.stringify(prepared.files) !== JSON.stringify(preview.files)
      || JSON.stringify(readback.files) !== JSON.stringify(preview.files)) {
      fail('digest_mismatch', 'The staged files differ from the approved preview');
    }
    const receipt = {
      version: 1,
      status: 'ready',
      digest: preview.digest,
      source: preview.source,
      target: preview.target,
      files: preview.files,
      bundleDirectory: preparedPath,
    };
    const marker = path.join(privateDirectory, '.receipt.pending');
    const handle = await open(marker, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!sameEntry(staging.stat, (await canonicalDirectory(staging.absolute, uid)).stat)
      || !sameEntry(privateIdentity, await inspectEntry(privateDirectory, uid))) {
      fail('content_changed', 'The staging directory changed before publication');
    }
    const targetEntries = await readdir('.');
    if (targetEntries.length !== 1 || targetEntries[0] !== privateDirectory) {
      fail('target_not_empty', 'The staging directory is no longer empty');
    }
    await link(marker, RECEIPT_NAME);
    published = true;
    // Publication has succeeded even if removal of the private link is interrupted.
    await unlink(marker).catch(() => {});
    return receipt;
  } catch (error) {
    if (privateDirectory && privateIdentity && !published) {
      try {
        await cleanupPrivateDirectory(privateDirectory, privateIdentity);
      } catch {
        fail('staging_cleanup_failed', 'Staging failed and its private directory could not be removed');
      }
    }
    if (error instanceof PleskOfflineTransferError) throw error;
    if (error?.code === 'EEXIST') fail('target_not_empty', 'The staging directory is no longer empty');
    fail('staging_failed', 'Could not copy and publish the approved local bundle');
  } finally {
    try {
      if (initialDirectory) process.chdir(initialDirectory);
    } finally {
      stagingActive = false;
    }
  }
}
