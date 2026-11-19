import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { phpSiteBootstrapManagerInternals } from '@yunpanel/host-runtime/php-site-bootstrap-manager';
import { createApplicationRegistry } from '../../src/application-registry.js';
import { createDomainRegistry } from '../../src/domain-registry.js';
import { createServerRegistry } from '../../src/server-registry.js';
import { executeSiteFileOperation } from '../../src/site-file-worker.js';
import { createStaticSiteCopyPlanner } from '../../src/static-site-copy-plan.js';
import { createWebsiteProvisioningRegistry } from '../../src/website-provisioning-registry.js';
import { createWebsiteRegistry } from '../../src/website-registry.js';

const PUBLISH_ROOT = '/var/www/yunpanel/apps';
const sha = (value) => createHash('sha256').update(value).digest('hex');

export async function staticSiteCopyFixture(t, { targetOwner = { unixUid: 1102 } } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yp-static-copy-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tree = path.join(directory, 'published');
  const receipts = path.join(directory, 'receipts');
  const toDisk = (pathname) => pathname.startsWith(`${PUBLISH_ROOT}/`)
    ? path.join(tree, path.relative(PUBLISH_ROOT, pathname)) : pathname;
  const readCanonicalPath = async (pathname) => {
    const resolved = await fs.realpath(toDisk(pathname));
    return resolved.startsWith(`${tree}/`) ? path.join(PUBLISH_ROOT, path.relative(tree, resolved)) : resolved;
  };
  // Project production release names onto the real disposable tree. macOS has no /proc/self/fd.
  const filesOpened = new Map();
  const filesystem = {
    chmod: (pathname, mode) => fs.chmod(toDisk(pathname), mode),
    link: (previous, next) => fs.link(toDisk(previous), toDisk(next)),
    mkdir: (pathname, options) => fs.mkdir(toDisk(pathname), options),
    readFile: (pathname, options) => fs.readFile(toDisk(pathname), options),
    rename: (previous, next) => fs.rename(toDisk(previous), toDisk(next)),
    rm: (pathname, options) => fs.rm(toDisk(pathname), options),
    stat: (pathname, options) => fs.stat(toDisk(pathname), options),
    lstat: (pathname) => fs.lstat(toDisk(pathname)),
    readdir: (pathname, options) => fs.readdir(toDisk(pathname), options),
    open: async (pathname, ...args) => {
      const file = await fs.open(toDisk(pathname), ...args);
      filesOpened.set(file.fd, pathname);
      return file;
    },
    realpath: (pathname) => pathname.startsWith('/proc/self/fd/')
      ? readCanonicalPath(filesOpened.get(Number(path.basename(pathname)))) : readCanonicalPath(pathname),
  };
  const servers = createServerRegistry({ filePath: path.join(directory, 'servers.json') });
  const server = await servers.createLocalServer({ hostname: 'static-copy.example.test' });
  const serverExists = async (serverId) => Boolean(await servers.getServer(serverId));
  const applicationRegistry = createApplicationRegistry({ filePath: path.join(directory, 'applications.json'), serverExists });
  const websiteRegistry = createWebsiteRegistry({ filePath: path.join(directory, 'websites.json'), serverExists,
    getApplication: (id) => applicationRegistry.getApplication(id) });
  const domainRegistry = createDomainRegistry({ filePath: path.join(directory, 'domains.json'), serverExists,
    getWebsite: (id) => websiteRegistry.getWebsite(id) });
  const websiteProvisioningRegistry = createWebsiteProvisioningRegistry({ filePath: path.join(directory, 'provisioning.json') });
  const siteFileManager = { async execute(websiteId, operation) {
    const { documentRoot } = await websiteRegistry.getWebsite(websiteId);
    return executeSiteFileOperation({ ...operation, root: documentRoot }, filesystem);
  } };

  async function createSite(name, { serverId = server.id, unixUid, unixGid = unixUid, runtime = 'static', parentDomainId = null, ready = true } = {}) {
    const application = runtime === 'static'
      ? await applicationRegistry.createApplication({ serverId, name, repositoryUrl: null, branch: null, build: { mode: 'none' } })
      : await applicationRegistry.createPhpApplication({ serverId, name });
    const site = await websiteRegistry.createWebsite({ serverId, name, applicationId: application.id, runtimeType: runtime });
    if (runtime !== 'static') return { site };
    const domain = await domainRegistry.createDomain({ serverId, websiteId: site.id, primaryDomain: name,
      targetType: 'static', target: { root: site.documentRoot }, parentDomainId });
    if (!ready) return { site, domain };
    const releaseId = randomUUID();
    const intent = { websiteId: site.id, applicationId: application.id, unixUser: site.unixUser, documentRoot: site.documentRoot };
    const spec = phpSiteBootstrapManagerInternals.normalizeIntent(intent, releaseId, 'static');
    const release = toDisk(spec.releaseDirectory);
    await fs.mkdir(release, { recursive: true });
    await fs.symlink(spec.currentLinkTarget, toDisk(site.documentRoot));
    const evidence = { satisfied: true, adapter: 'static-bootstrap', ...intent, currentRelease: site.documentRoot,
      releaseDirectory: spec.releaseDirectory, releaseId, unixUid, unixGid, indexSha256: sha(spec.bootstrapContent) };
    await websiteProvisioningRegistry.create({ operationId: releaseId, websiteId: site.id, resources: { application }, steps: [
      { id: 'runtime', intent: { adapter: 'static', mode: 'upload', ...intent } },
    ] });
    await websiteProvisioningRegistry.beginStep({ operationId: releaseId, stepId: 'runtime' });
    await websiteProvisioningRegistry.completeStep({ operationId: releaseId, stepId: 'runtime', evidence });
    await applicationRegistry.markUploadedStaticReady(application.id, evidence);
    return { site, domain, spec, intent, release, releaseId, evidence };
  }

  const source = await createSite('source.copy.example.test', { unixUid: 1101 });
  const target = await createSite('target.copy.example.test', targetOwner);
  await fs.writeFile(path.join(source.release, 'index.html'), '<h1>Kaynak</h1>');
  await fs.mkdir(path.join(source.release, 'images'));
  await fs.writeFile(path.join(source.release, 'images', 'photo.bin'), Buffer.from([0, 1, 254, 255]));

  function makePlanner(staticBootstrapManager) {
    return createStaticSiteCopyPlanner({ websiteRegistry, applicationRegistry, domainRegistry, websiteProvisioningRegistry,
      siteFileManager, localServerId: server.id, staticBootstrapManager, realpathFn: filesystem.realpath, statFn: filesystem.stat });
  }
  const planner = makePlanner();
  const request = { sourceWebsiteId: source.site.id, targetWebsiteId: target.site.id };
  return { directory, receipts, server, servers, source, target, createSite, planner, request, makePlanner, toDisk, websiteRegistry, filesystem, siteFileManager };
}
