import { createHash } from 'node:crypto';
import { DnsZoneTemplateRegistryError } from './dns-zone-template-registry.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireVersion(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DnsZoneTemplateRegistryError(
      'invalid_dns_template_version',
      `${field} must be a positive integer`,
    );
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createDnsZoneTemplateRollbackService({ registry } = {}) {
  if (!registry || typeof registry.ensureForServer !== 'function'
    || typeof registry.getVersion !== 'function'
    || typeof registry.preview !== 'function'
    || typeof registry.update !== 'function') {
    throw new Error('DNS zone template registry is required');
  }

  async function buildPlan({ serverId, expectedVersion, targetVersion } = {}) {
    const expected = requireVersion(expectedVersion, 'expectedVersion');
    const target = requireVersion(targetVersion, 'targetVersion');
    const current = await registry.ensureForServer(serverId);
    if (current.version !== expected) {
      throw new DnsZoneTemplateRegistryError(
        'dns_template_revision_conflict',
        'DNS template changed; refresh before rollback',
        409,
      );
    }
    if (target === current.version) {
      throw new DnsZoneTemplateRegistryError(
        'dns_template_rollback_same_version',
        'DNS template is already on the requested version',
        409,
      );
    }
    const historical = await registry.getVersion(serverId, target);
    if (!historical) {
      throw new DnsZoneTemplateRegistryError(
        'dns_template_version_not_found',
        'DNS template version was not found',
        404,
      );
    }
    const base = await registry.preview({
      serverId,
      expectedVersion: current.version,
      records: historical.records,
    });
    const previewDigest = digest({
      version: 1,
      serverId,
      currentVersion: current.version,
      targetVersion: historical.version,
      nextVersion: base.nextVersion,
      records: historical.records,
      basePreviewDigest: base.previewDigest,
    });
    const publicPlan = Object.freeze({
      serverId,
      currentVersion: current.version,
      targetVersion: historical.version,
      targetCreatedAt: historical.createdAt,
      nextVersion: base.nextVersion,
      records: historical.records,
      previewDigest,
      confirmation: `rollback-dns-zone-template:${serverId}:${current.version}:${historical.version}:${previewDigest}`,
      existingZonesAutomaticApply: false,
    });
    return { publicPlan, base };
  }

  async function preview(input = {}) {
    return (await buildPlan(input)).publicPlan;
  }

  async function apply({
    serverId,
    expectedVersion,
    targetVersion,
    previewDigest,
    confirmation,
  } = {}) {
    if (typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)) {
      throw new DnsZoneTemplateRegistryError(
        'dns_template_rollback_confirmation_invalid',
        'A current DNS template rollback preview digest is required',
        409,
      );
    }
    const plan = await buildPlan({ serverId, expectedVersion, targetVersion });
    if (previewDigest !== plan.publicPlan.previewDigest || confirmation !== plan.publicPlan.confirmation) {
      throw new DnsZoneTemplateRegistryError(
        'dns_template_rollback_confirmation_invalid',
        'DNS template rollback preview is stale or confirmation is invalid',
        409,
      );
    }
    const updated = await registry.update({
      serverId,
      expectedVersion: plan.publicPlan.currentVersion,
      records: plan.publicPlan.records,
      previewDigest: plan.base.previewDigest,
      confirmation: plan.base.confirmation,
    });
    return Object.freeze({
      ...updated,
      rollback: Object.freeze({
        fromVersion: plan.publicPlan.currentVersion,
        targetVersion: plan.publicPlan.targetVersion,
        createdVersion: updated.version,
      }),
    });
  }

  return Object.freeze({ preview, apply });
}

export const dnsZoneTemplateRollbackInternals = Object.freeze({ requireVersion, digest });
