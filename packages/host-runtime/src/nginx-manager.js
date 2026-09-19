import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  nginxConfigFileName,
  renderPassengerSiteConfig,
  renderPhpSiteConfig,
  renderProxySiteConfig,
  renderPythonSiteConfig,
  renderStaticSiteConfig,
} from '@yunpanel/config-templates';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const ROLLBACK_RECEIPT_VERSION = 1;
const DEACTIVATION_RECEIPT_VERSION = 1;

export class NginxManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NginxManagerError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function execFileSafe(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(error);
      return resolve(stdout);
    });
  });
}

function configNameForDomain(primaryDomain) {
  return `yunpanel-${nginxConfigFileName(primaryDomain)}`;
}

function renderDomainConfig(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new NginxManagerError('invalid_domain_spec', 'Domain spec must be an object');
  }
  const common = {
    primaryDomain: spec.primaryDomain,
    aliases: spec.aliases ?? [],
    acmeOnlyHostnames: spec.acmeOnlyHostnames ?? [],
    mailDiscoverySocketPath: spec.mailDiscoverySocketPath ?? null,
    tls: spec.tls ?? null,
    canonicalRedirect: spec.canonicalRedirect === true,
    httpsRedirect: spec.httpsRedirect !== false,
  };
  if (spec.targetType === 'static') {
    return renderStaticSiteConfig({
      ...common,
      root: spec.target?.root,
      spaFallback: spec.target?.spaFallback !== false,
      nginxSettings: spec.nginxSettings,
    });
  }
  if (spec.targetType === 'proxy') {
    return renderProxySiteConfig({
      ...common,
      upstreamHost: spec.target?.upstreamHost ?? '127.0.0.1',
      upstreamPort: spec.target?.upstreamPort,
      websocket: spec.target?.websocket !== false,
      nginxSettings: spec.nginxSettings,
    });
  }
  if (spec.targetType === 'passenger') {
    return renderPassengerSiteConfig({
      ...common,
      target: spec.target,
      nginxSettings: spec.nginxSettings,
    });
  }
  if (spec.targetType === 'php') {
    return renderPhpSiteConfig({
      ...common,
      root: spec.target?.root,
      socketPath: spec.target?.socketPath,
      nginxSettings: spec.nginxSettings,
    });
  }
  if (spec.targetType === 'python') {
    return renderPythonSiteConfig({
      ...common,
      socketPath: spec.target?.socketPath,
      upstreamPort: spec.target?.upstreamPort ?? spec.target?.port,
      nginxSettings: spec.nginxSettings,
    });
  }
  throw new NginxManagerError('invalid_target_type', 'Domain targetType must be static, proxy, passenger, php or python');
}

function fileState(content) {
  if (content === null) return Object.freeze({ exists: false, checksum: null, content: null });
  return Object.freeze({ exists: true, checksum: sha256(content), content });
}

function sameFileState(left, right) {
  return left.exists === right.exists
    && left.checksum === right.checksum
    && left.content === right.content;
}

function normalizeReceiptState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.exists !== 'boolean') {
    throw new NginxManagerError('nginx_rollback_receipt_invalid', 'Nginx rollback receipt is invalid');
  }
  if (!value.exists) {
    if (value.content !== null || value.checksum !== null) {
      throw new NginxManagerError('nginx_rollback_receipt_invalid', 'Nginx rollback receipt is invalid');
    }
    return fileState(null);
  }
  if (typeof value.content !== 'string'
    || typeof value.checksum !== 'string'
    || !CHECKSUM_PATTERN.test(value.checksum)
    || sha256(value.content) !== value.checksum) {
    throw new NginxManagerError('nginx_rollback_receipt_invalid', 'Nginx rollback receipt is invalid');
  }
  return fileState(value.content);
}

export function createNginxManager({
  stagingDir = '/var/lib/yunpanel/staging/nginx',
  sitesDir = '/etc/nginx/sites-enabled',
  nginxPath = '/usr/sbin/nginx',
  systemctlPath = '/usr/bin/systemctl',
  mkdirFn = mkdir,
  readFileFn = readFile,
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
  execFn = execFileSafe,
} = {}) {
  let activationChain = Promise.resolve();
  const rollbackDir = path.join(stagingDir, 'rollback');
  const deactivationDir = path.join(stagingDir, 'deactivation');

  async function atomicWrite(targetPath, content, mode) {
    const temporaryPath = `${targetPath}.${process.pid}.tmp`;
    await writeFileFn(temporaryPath, content, { encoding: 'utf8', mode });
    await renameFn(temporaryPath, targetPath);
  }

  function expectedStage(spec) {
    const config = renderDomainConfig(spec);
    return {
      config,
      configName: configNameForDomain(spec.primaryDomain),
      checksum: sha256(config),
      bytes: Buffer.byteLength(config),
    };
  }

  function rollbackReceiptPath(configName, checksum) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 configuration checksum is required');
    }
    return path.join(rollbackDir, `${configName}.${checksum}.json`);
  }

  async function captureFile(targetPath, errorCode = 'nginx_rollback_capture_failed') {
    try { return fileState(await readFileFn(targetPath, 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return fileState(null);
      throw new NginxManagerError(errorCode, 'Nginx rollback state could not be inspected');
    }
  }

  function normalizeRollbackReceipt(value, { primaryDomain, configName, checksum } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== ROLLBACK_RECEIPT_VERSION
      || value.primaryDomain !== primaryDomain
      || value.configName !== configName
      || value.candidateChecksum !== checksum
      || (value.previousPrimaryDomain !== null && typeof value.previousPrimaryDomain !== 'string')) {
      throw new NginxManagerError('nginx_rollback_receipt_invalid', 'Nginx rollback receipt is invalid');
    }
    const active = normalizeReceiptState(value.active);
    let previousActive = null;
    if (value.previousPrimaryDomain !== null) {
      if (!value.previousActive) {
        throw new NginxManagerError('nginx_rollback_receipt_invalid', 'Nginx rollback receipt is invalid');
      }
      previousActive = normalizeReceiptState(value.previousActive);
    } else if (value.previousActive !== null) {
      throw new NginxManagerError('nginx_rollback_receipt_invalid', 'Nginx rollback receipt is invalid');
    }
    return Object.freeze({
      version: ROLLBACK_RECEIPT_VERSION,
      primaryDomain,
      configName,
      candidateChecksum: checksum,
      previousPrimaryDomain: value.previousPrimaryDomain,
      active,
      previousActive,
    });
  }

  async function loadRollbackReceipt({ primaryDomain, configName, checksum } = {}) {
    const receiptPath = rollbackReceiptPath(configName, checksum);
    let raw;
    try { raw = await readFileFn(receiptPath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new NginxManagerError('nginx_rollback_receipt_unavailable', 'Nginx rollback receipt could not be read');
    }
    try {
      return normalizeRollbackReceipt(JSON.parse(raw), { primaryDomain, configName, checksum });
    } catch (error) {
      if (error instanceof NginxManagerError) throw error;
      throw new NginxManagerError('nginx_rollback_receipt_invalid', 'Nginx rollback receipt is invalid');
    }
  }

  async function persistRollbackReceipt({
    primaryDomain,
    configName,
    checksum,
    previousPrimaryDomain,
    active,
    previousActive,
  }) {
    await mkdirFn(rollbackDir, { recursive: true, mode: 0o700 });
    const receipt = {
      version: ROLLBACK_RECEIPT_VERSION,
      primaryDomain,
      configName,
      candidateChecksum: checksum,
      previousPrimaryDomain,
      active,
      previousActive,
    };
    await atomicWrite(
      rollbackReceiptPath(configName, checksum),
      `${JSON.stringify(receipt)}\n`,
      0o600,
    );
    return normalizeRollbackReceipt(receipt, { primaryDomain, configName, checksum });
  }

  function deactivationReceiptPath(configName, checksum) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 active configuration checksum is required');
    }
    return path.join(deactivationDir, `${configName}.${checksum}.json`);
  }

  function normalizeDeactivationReceipt(value, { primaryDomain, configName, checksum } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== DEACTIVATION_RECEIPT_VERSION
      || value.primaryDomain !== primaryDomain
      || value.configName !== configName
      || value.activeChecksum !== checksum) {
      throw new NginxManagerError(
        'nginx_deactivation_receipt_invalid',
        'Nginx deactivation receipt is invalid',
      );
    }
    const active = normalizeReceiptState(value.active);
    if (!active.exists || active.checksum !== checksum) {
      throw new NginxManagerError(
        'nginx_deactivation_receipt_invalid',
        'Nginx deactivation receipt does not match the expected active configuration',
      );
    }
    return Object.freeze({
      version: DEACTIVATION_RECEIPT_VERSION,
      primaryDomain,
      configName,
      activeChecksum: checksum,
      active,
    });
  }

  async function loadDeactivationReceipt({ primaryDomain, configName, checksum } = {}) {
    let raw;
    try {
      raw = await readFileFn(deactivationReceiptPath(configName, checksum), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new NginxManagerError(
        'nginx_deactivation_receipt_unavailable',
        'Nginx deactivation receipt could not be read',
      );
    }
    try {
      return normalizeDeactivationReceipt(JSON.parse(raw), { primaryDomain, configName, checksum });
    } catch (error) {
      if (error instanceof NginxManagerError) throw error;
      throw new NginxManagerError(
        'nginx_deactivation_receipt_invalid',
        'Nginx deactivation receipt is invalid',
      );
    }
  }

  async function persistDeactivationReceipt({ primaryDomain, configName, checksum, active }) {
    await mkdirFn(deactivationDir, { recursive: true, mode: 0o700 });
    const receipt = {
      version: DEACTIVATION_RECEIPT_VERSION,
      primaryDomain,
      configName,
      activeChecksum: checksum,
      active,
    };
    await atomicWrite(
      deactivationReceiptPath(configName, checksum),
      `${JSON.stringify(receipt)}\n`,
      0o600,
    );
    return normalizeDeactivationReceipt(receipt, { primaryDomain, configName, checksum });
  }

  async function restoreFile(targetPath, state, mode = 0o644) {
    if (!state.exists) {
      await rmFn(targetPath, { force: true });
      return;
    }
    await atomicWrite(targetPath, state.content, mode);
  }

  async function stageDomain(spec) {
    const expected = expectedStage(spec);
    const stagePath = path.join(stagingDir, expected.configName);
    await mkdirFn(stagingDir, { recursive: true, mode: 0o750 });
    await atomicWrite(stagePath, expected.config, 0o640);
    return { configName: expected.configName, checksum: expected.checksum, bytes: expected.bytes };
  }

  async function inspectStagedDomain(spec) {
    const expected = expectedStage(spec);
    const stagePath = path.join(stagingDir, expected.configName);
    let current;
    try {
      current = await readFileFn(stagePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { satisfied: false, result: null };
      }
      throw new NginxManagerError('staged_config_inspection_failed', 'Staged Nginx configuration could not be inspected');
    }
    if (sha256(current) !== expected.checksum || current !== expected.config) {
      return { satisfied: false, result: null };
    }
    return {
      satisfied: true,
      result: { configName: expected.configName, checksum: expected.checksum, bytes: expected.bytes },
    };
  }

  async function inspectActiveDomain({ primaryDomain, previousPrimaryDomain = null, checksum } = {}) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 active configuration checksum is required');
    }
    const configName = configNameForDomain(primaryDomain);
    const activePath = path.join(sitesDir, configName);
    let current;
    try {
      current = await readFileFn(activePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { satisfied: false, result: null };
      throw new NginxManagerError('active_config_inspection_failed', 'Active Nginx configuration could not be inspected');
    }
    if (sha256(current) !== checksum) return { satisfied: false, result: null };
    if (previousPrimaryDomain !== null && previousPrimaryDomain !== primaryDomain) {
      const previousPath = path.join(sitesDir, configNameForDomain(previousPrimaryDomain));
      try {
        await readFileFn(previousPath, 'utf8');
        return { satisfied: false, result: null };
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new NginxManagerError('active_config_inspection_failed', 'Active Nginx configuration could not be inspected');
        }
      }
    }
    return { satisfied: true, result: { configName, checksum, active: true } };
  }

  async function activationState({ activePath, previousActivePath }) {
    return Object.freeze({
      active: await captureFile(activePath),
      previousActive: previousActivePath ? await captureFile(previousActivePath) : null,
    });
  }

  function stateMatchesReceipt(state, receipt) {
    return sameFileState(state.active, receipt.active)
      && (receipt.previousActive === null
        ? state.previousActive === null
        : state.previousActive !== null && sameFileState(state.previousActive, receipt.previousActive));
  }

  function stateMatchesCandidate(state, checksum, hasPreviousPath) {
    return state.active.exists
      && state.active.checksum === checksum
      && (!hasPreviousPath || (state.previousActive !== null && !state.previousActive.exists));
  }

  async function activateNow({ primaryDomain, previousPrimaryDomain = null, checksum }) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 staging checksum is required');
    }
    const configName = configNameForDomain(primaryDomain);
    const stagePath = path.join(stagingDir, configName);
    const activePath = path.join(sitesDir, configName);
    const previousConfigName = previousPrimaryDomain === null ? null : configNameForDomain(previousPrimaryDomain);
    const previousActivePath = previousConfigName && previousConfigName !== configName
      ? path.join(sitesDir, previousConfigName)
      : null;
    const normalizedPreviousPrimaryDomain = previousActivePath ? previousPrimaryDomain : null;
    let candidate;
    try { candidate = await readFileFn(stagePath, 'utf8'); }
    catch { throw new NginxManagerError('staged_config_missing', 'Staged Nginx configuration was not found'); }
    if (sha256(candidate) !== checksum) throw new NginxManagerError('staged_config_changed', 'Staged Nginx configuration checksum does not match');

    const before = await activationState({ activePath, previousActivePath });
    let receipt = await loadRollbackReceipt({ primaryDomain, configName, checksum });
    if (receipt) {
      if (receipt.previousPrimaryDomain !== normalizedPreviousPrimaryDomain
        || (!stateMatchesReceipt(before, receipt)
          && !stateMatchesCandidate(before, checksum, Boolean(previousActivePath)))) {
        throw new NginxManagerError('nginx_rollback_receipt_conflict', 'Nginx activation rollback receipt conflicts with current state');
      }
    } else {
      receipt = await persistRollbackReceipt({
        primaryDomain,
        configName,
        checksum,
        previousPrimaryDomain: normalizedPreviousPrimaryDomain,
        active: before.active,
        previousActive: before.previousActive,
      });
    }

    async function restoreInvocationState() {
      await restoreFile(activePath, before.active);
      if (previousActivePath) await restoreFile(previousActivePath, before.previousActive);
    }

    try {
      await mkdirFn(sitesDir, { recursive: true, mode: 0o755 });
      await atomicWrite(activePath, candidate, 0o644);
      if (previousActivePath) await rmFn(previousActivePath, { force: true });
    } catch {
      try { await restoreInvocationState(); }
      catch { throw new NginxManagerError('nginx_rollback_failed', 'Nginx activation preparation failed and rollback could not be confirmed'); }
      throw new NginxManagerError('nginx_activation_prepare_failed', 'Nginx activation could not replace the active configuration');
    }
    try {
      await execFn(nginxPath, ['-t']);
    } catch {
      try { await restoreInvocationState(); }
      catch { throw new NginxManagerError('nginx_rollback_failed', 'Nginx rejected the staged configuration and rollback could not be confirmed'); }
      throw new NginxManagerError('nginx_config_invalid', 'Nginx rejected the staged configuration');
    }
    try {
      await execFn(systemctlPath, ['reload', 'nginx']);
    } catch {
      try { await restoreInvocationState(); }
      catch { throw new NginxManagerError('nginx_rollback_failed', 'Nginx reload failed and rollback could not be confirmed'); }
      try {
        await execFn(nginxPath, ['-t']);
        await execFn(systemctlPath, ['reload', 'nginx']);
      } catch {
        throw new NginxManagerError('nginx_rollback_failed', 'Nginx reload failed and rollback could not be confirmed');
      }
      throw new NginxManagerError('nginx_reload_failed', 'Nginx reload failed and the previous configuration was restored');
    }
    return {
      configName,
      checksum,
      active: true,
      rollback: {
        receiptVersion: receipt.version,
        hadPreviousActive: receipt.active.exists,
        previousChecksum: receipt.active.checksum,
      },
    };
  }

  function activateDomain(input) {
    const run = activationChain.catch(() => {}).then(() => activateNow(input));
    activationChain = run;
    return run;
  }

  async function inspectDomainCompensation({ primaryDomain, checksum } = {}) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 active configuration checksum is required');
    }
    const configName = configNameForDomain(primaryDomain);
    const receipt = await loadRollbackReceipt({ primaryDomain, configName, checksum });
    if (!receipt) {
      return { satisfied: false, reason: 'nginx_compensation_receipt_missing', configName, checksum };
    }
    const activePath = path.join(sitesDir, configName);
    const previousActivePath = receipt.previousPrimaryDomain
      ? path.join(sitesDir, configNameForDomain(receipt.previousPrimaryDomain))
      : null;
    const current = await activationState({ activePath, previousActivePath });
    if (stateMatchesReceipt(current, receipt)) {
      return {
        satisfied: true,
        configName,
        checksum,
        restoredPrevious: receipt.active.exists,
        previousChecksum: receipt.active.checksum,
      };
    }
    if (stateMatchesCandidate(current, checksum, Boolean(previousActivePath))) {
      return { satisfied: false, reason: 'nginx_compensation_pending', configName, checksum };
    }
    throw new NginxManagerError('nginx_compensation_drift', 'Nginx compensation refused because active state has drifted');
  }

  async function compensateNow({ primaryDomain, checksum } = {}) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 active configuration checksum is required');
    }
    const configName = configNameForDomain(primaryDomain);
    const receipt = await loadRollbackReceipt({ primaryDomain, configName, checksum });
    if (!receipt) {
      throw new NginxManagerError('nginx_compensation_receipt_missing', 'Nginx compensation rollback receipt is missing');
    }
    const activePath = path.join(sitesDir, configName);
    const previousActivePath = receipt.previousPrimaryDomain
      ? path.join(sitesDir, configNameForDomain(receipt.previousPrimaryDomain))
      : null;
    const before = await activationState({ activePath, previousActivePath });
    if (stateMatchesReceipt(before, receipt)) return inspectDomainCompensation({ primaryDomain, checksum });
    if (!stateMatchesCandidate(before, checksum, Boolean(previousActivePath))) {
      throw new NginxManagerError('nginx_compensation_drift', 'Nginx compensation refused because active state has drifted');
    }

    async function restoreBeforeCompensation() {
      await restoreFile(activePath, before.active);
      if (previousActivePath) await restoreFile(previousActivePath, before.previousActive);
    }

    try {
      await restoreFile(activePath, receipt.active);
      if (previousActivePath) await restoreFile(previousActivePath, receipt.previousActive);
      await execFn(nginxPath, ['-t']);
      await execFn(systemctlPath, ['reload', 'nginx']);
    } catch {
      try {
        await restoreBeforeCompensation();
        await execFn(nginxPath, ['-t']);
        await execFn(systemctlPath, ['reload', 'nginx']);
      } catch {
        throw new NginxManagerError('nginx_compensation_rollback_failed', 'Nginx compensation failed and the active configuration could not be restored');
      }
      throw new NginxManagerError('nginx_compensation_failed', 'Nginx compensation failed and the active configuration was restored');
    }

    const inspected = await inspectDomainCompensation({ primaryDomain, checksum });
    if (!inspected.satisfied) {
      throw new NginxManagerError('nginx_compensation_unverified', 'Nginx compensation could not be verified');
    }
    return inspected;
  }

  function compensateDomain(input) {
    const run = activationChain.catch(() => {}).then(() => compensateNow(input));
    activationChain = run;
    return run;
  }

  async function inspectDomainDeactivation({ primaryDomain, checksum } = {}) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 active configuration checksum is required');
    }
    const configName = configNameForDomain(primaryDomain);
    const activePath = path.join(sitesDir, configName);
    const receipt = await loadDeactivationReceipt({ primaryDomain, configName, checksum });
    const current = await captureFile(activePath, 'nginx_deactivation_inspection_failed');

    if (!current.exists) {
      if (!receipt) {
        return {
          satisfied: false,
          deactivationCandidate: false,
          restorable: false,
          reason: 'nginx_deactivation_unowned_absence',
          configName,
          checksum,
        };
      }
      return {
        satisfied: true,
        deactivationCandidate: false,
        deactivated: true,
        restorable: true,
        configName,
        checksum,
        receiptVersion: receipt.version,
      };
    }
    if (current.checksum !== checksum) {
      throw new NginxManagerError(
        'nginx_deactivation_drift',
        'Nginx deactivation refused because active configuration checksum drifted',
      );
    }
    if (receipt && !sameFileState(current, receipt.active)) {
      throw new NginxManagerError(
        'nginx_deactivation_drift',
        'Nginx deactivation refused because active configuration differs from retained receipt',
      );
    }
    return {
      satisfied: false,
      deactivationCandidate: true,
      restorable: Boolean(receipt),
      configName,
      checksum,
      receiptVersion: receipt?.version ?? null,
    };
  }

  async function deactivateNow({ primaryDomain, checksum } = {}) {
    const inspection = await inspectDomainDeactivation({ primaryDomain, checksum });
    if (inspection.satisfied) {
      return {
        ...inspection,
        changed: false,
      };
    }
    if (!inspection.deactivationCandidate) {
      throw new NginxManagerError(
        'nginx_deactivation_unowned_absence',
        'Nginx deactivation cannot claim an already absent active configuration',
      );
    }

    const configName = configNameForDomain(primaryDomain);
    const activePath = path.join(sitesDir, configName);
    const before = await captureFile(activePath, 'nginx_deactivation_inspection_failed');
    if (!before.exists || before.checksum !== checksum) {
      throw new NginxManagerError(
        'nginx_deactivation_drift',
        'Nginx active configuration changed before deactivation',
      );
    }
    let receipt = await loadDeactivationReceipt({ primaryDomain, configName, checksum });
    if (!receipt) {
      receipt = await persistDeactivationReceipt({
        primaryDomain,
        configName,
        checksum,
        active: before,
      });
    } else if (!sameFileState(before, receipt.active)) {
      throw new NginxManagerError(
        'nginx_deactivation_drift',
        'Nginx active configuration no longer matches retained deactivation receipt',
      );
    }

    async function restoreActive() {
      await restoreFile(activePath, receipt.active);
    }

    try {
      await rmFn(activePath, { force: true });
      await execFn(nginxPath, ['-t']);
      await execFn(systemctlPath, ['reload', 'nginx']);
    } catch {
      try {
        await restoreActive();
        await execFn(nginxPath, ['-t']);
        await execFn(systemctlPath, ['reload', 'nginx']);
      } catch {
        throw new NginxManagerError(
          'nginx_deactivation_rollback_failed',
          'Nginx deactivation failed and the exact active configuration could not be restored',
        );
      }
      throw new NginxManagerError(
        'nginx_deactivation_failed',
        'Nginx deactivation failed and the exact active configuration was restored',
      );
    }

    const verified = await inspectDomainDeactivation({ primaryDomain, checksum });
    if (!verified.satisfied) {
      throw new NginxManagerError(
        'nginx_deactivation_unverified',
        'Nginx deactivation could not be verified',
      );
    }
    return {
      ...verified,
      changed: true,
    };
  }

  function deactivateDomain(input) {
    const run = activationChain.catch(() => {}).then(() => deactivateNow(input));
    activationChain = run;
    return run;
  }

  async function inspectDomainDeactivationRollback({ primaryDomain, checksum } = {}) {
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new NginxManagerError('invalid_checksum', 'A SHA-256 active configuration checksum is required');
    }
    const configName = configNameForDomain(primaryDomain);
    const receipt = await loadDeactivationReceipt({ primaryDomain, configName, checksum });
    if (!receipt) {
      return {
        satisfied: false,
        reason: 'nginx_deactivation_receipt_missing',
        configName,
        checksum,
      };
    }
    const activePath = path.join(sitesDir, configName);
    const current = await captureFile(activePath, 'nginx_deactivation_rollback_inspection_failed');
    if (!current.exists) {
      return {
        satisfied: false,
        reason: 'nginx_deactivation_rollback_pending',
        configName,
        checksum,
      };
    }
    if (!sameFileState(current, receipt.active)) {
      throw new NginxManagerError(
        'nginx_deactivation_rollback_drift',
        'Nginx deactivation rollback refused because active state drifted',
      );
    }
    return {
      satisfied: true,
      restored: true,
      configName,
      checksum,
      receiptVersion: receipt.version,
    };
  }

  async function rollbackDeactivationNow({ primaryDomain, checksum } = {}) {
    const inspected = await inspectDomainDeactivationRollback({ primaryDomain, checksum });
    if (inspected.satisfied) {
      return {
        ...inspected,
        changed: false,
      };
    }
    if (inspected.reason === 'nginx_deactivation_receipt_missing') {
      throw new NginxManagerError(
        'nginx_deactivation_receipt_missing',
        'Nginx deactivation rollback receipt is missing',
      );
    }

    const configName = configNameForDomain(primaryDomain);
    const receipt = await loadDeactivationReceipt({ primaryDomain, configName, checksum });
    const activePath = path.join(sitesDir, configName);
    const before = await captureFile(activePath, 'nginx_deactivation_rollback_inspection_failed');
    if (before.exists) {
      throw new NginxManagerError(
        'nginx_deactivation_rollback_drift',
        'Nginx deactivation rollback refused because active configuration unexpectedly exists',
      );
    }

    try {
      await restoreFile(activePath, receipt.active);
      await execFn(nginxPath, ['-t']);
      await execFn(systemctlPath, ['reload', 'nginx']);
    } catch {
      try {
        await rmFn(activePath, { force: true });
        await execFn(nginxPath, ['-t']);
        await execFn(systemctlPath, ['reload', 'nginx']);
      } catch {
        throw new NginxManagerError(
          'nginx_deactivation_restore_rollback_failed',
          'Nginx deactivation rollback failed and suspended state could not be restored',
        );
      }
      throw new NginxManagerError(
        'nginx_deactivation_restore_failed',
        'Nginx deactivation rollback failed and suspended state was restored',
      );
    }

    const verified = await inspectDomainDeactivationRollback({ primaryDomain, checksum });
    if (!verified.satisfied) {
      throw new NginxManagerError(
        'nginx_deactivation_restore_unverified',
        'Nginx deactivation rollback could not be verified',
      );
    }
    return {
      ...verified,
      changed: true,
    };
  }

  function rollbackDomainDeactivation(input) {
    const run = activationChain.catch(() => {}).then(() => rollbackDeactivationNow(input));
    activationChain = run;
    return run;
  }

  return {
    stageDomain,
    inspectStagedDomain,
    inspectActiveDomain,
    activateDomain,
    compensateDomain,
    inspectDomainCompensation,
    inspectDomainDeactivation,
    deactivateDomain,
    inspectDomainDeactivationRollback,
    rollbackDomainDeactivation,
  };
}

export const nginxManager = createNginxManager();

export const nginxManagerInternals = Object.freeze({
  sha256,
  fileState,
  sameFileState,
  normalizeReceiptState,
  rollbackReceiptVersion: ROLLBACK_RECEIPT_VERSION,
  deactivationReceiptVersion: DEACTIVATION_RECEIPT_VERSION,
});
