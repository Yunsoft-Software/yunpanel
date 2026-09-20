import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  assertUuid,
  normalizeDomainName,
  normalizeDomainSet,
  MANAGED_NODE_RUNTIME_MAJORS,
  SUPPORTED_PYTHON_VERSIONS,
} from '@yunpanel/shared';
import {
  normalizeCronCommand,
  normalizeCronSchedule,
} from '@yunpanel/config-templates';

export class PleskImporterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PleskImporterError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertNotForbiddenHost(value, field = 'target') {
  if (!value) return;
  if (typeof value === 'string') {
    if (/\.44\b/.test(value) || /157\.180\.11\.44/.test(value)) {
      throw new PleskImporterError(
        'plesk_forbidden_target_server',
        `${field} references prohibited server (.44)`,
        403,
      );
    }
    return;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        assertNotForbiddenHost(value[i], `${field}[${i}]`);
      }
    } else {
      for (const [key, v] of Object.entries(value)) {
        assertNotForbiddenHost(v, `${field}.${key}`);
      }
    }
  }
}

function normalizeRuntime({ runtimeType, nodeVersion, phpVersion, pythonVersion, documentRoot, entryFile } = {}) {
  const type = String(runtimeType || '').toLowerCase().trim();
  if (type === 'node' || type === 'nodejs') {
    const rawMajor = parseInt(String(nodeVersion || '24').replace(/^v/i, ''), 10);
    const nodeMajor = MANAGED_NODE_RUNTIME_MAJORS.includes(rawMajor) ? String(rawMajor) : '24';
    return {
      type: 'node',
      runtimeAdapter: 'passenger',
      nodeMajor,
      entryFile: entryFile ? String(entryFile).trim() : 'app.js',
      documentRoot: documentRoot ? String(documentRoot).trim() : 'public',
    };
  }
  if (type === 'php') {
    const rawPhp = String(phpVersion || '8.3').trim();
    const supported = ['8.1', '8.2', '8.3', '8.4'];
    const matched = supported.find((v) => rawPhp.startsWith(v)) || '8.3';
    return {
      type: 'php',
      phpVersion: matched,
      handler: 'fpm',
      documentRoot: documentRoot ? String(documentRoot).trim() : 'httpdocs',
    };
  }
  if (type === 'python') {
    const rawPy = String(pythonVersion || '3.12').trim();
    const matched = SUPPORTED_PYTHON_VERSIONS.find((v) => rawPy.startsWith(v)) || '3.12';
    return {
      type: 'python',
      pythonVersion: matched,
      entryFile: entryFile ? String(entryFile).trim() : 'app.py',
      documentRoot: documentRoot ? String(documentRoot).trim() : 'httpdocs',
    };
  }
  return {
    type: 'static',
    documentRoot: documentRoot ? String(documentRoot).trim() : 'httpdocs',
  };
}

function normalizeDatabases(rawList, warnings, domainName) {
  if (!Array.isArray(rawList)) return [];
  const result = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    const dbUser = String(item.user || item.username || name).trim();
    result.push({
      name,
      user: dbUser,
      type: 'mariadb',
    });
  }
  return result;
}

function normalizeMail(rawMail, warnings, domainName) {
  if (!rawMail || typeof rawMail !== 'object') return null;
  const mailboxes = [];
  if (Array.isArray(rawMail.mailboxes)) {
    for (const box of rawMail.mailboxes) {
      if (!box || typeof box !== 'object') continue;
      const name = String(box.name || box.mailbox || '').trim();
      if (!name) continue;
      const email = box.email ? String(box.email).trim().toLowerCase() : `${name}@${domainName}`;
      const quotaBytes = Number.isSafeInteger(box.quotaBytes) && box.quotaBytes > 0
        ? box.quotaBytes
        : (box.quotaMb ? box.quotaMb * 1024 * 1024 : null);
      mailboxes.push({ name, email, quotaBytes });
    }
  }
  const aliases = [];
  if (Array.isArray(rawMail.aliases)) {
    for (const al of rawMail.aliases) {
      if (!al || typeof al !== 'object') continue;
      const source = String(al.source || al.from || '').trim().toLowerCase();
      const destination = String(al.destination || al.to || '').trim().toLowerCase();
      if (source && destination) aliases.push({ source, destination });
    }
  }
  const forwardings = [];
  if (Array.isArray(rawMail.forwardings)) {
    for (const fwd of rawMail.forwardings) {
      if (!fwd || typeof fwd !== 'object') continue;
      const source = String(fwd.source || fwd.from || '').trim().toLowerCase();
      const destination = String(fwd.destination || fwd.to || '').trim().toLowerCase();
      if (source && destination) forwardings.push({ source, destination });
    }
  }
  return {
    domainName,
    managementMode: 'local',
    mailboxes,
    aliases,
    forwardings,
  };
}

function normalizeDns(rawDns, warnings, domainName) {
  if (!rawDns || typeof rawDns !== 'object') return null;
  const rawRecords = Array.isArray(rawDns.records) ? rawDns.records : [];
  const records = [];
  for (const r of rawRecords) {
    if (!r || typeof r !== 'object') continue;
    const type = String(r.type || '').toUpperCase().trim();
    const name = String(r.name || domainName).trim().toLowerCase();
    const value = String(r.value || r.content || '').trim();
    const ttl = Number.isSafeInteger(r.ttl) && r.ttl >= 60 ? r.ttl : 3600;
    if (type && value) {
      assertNotForbiddenHost(value, `DNS record ${name} (${type})`);
      records.push({ name, type, value, ttl });
    }
  }
  return {
    zoneName: domainName,
    mode: 'local',
    records,
  };
}

function normalizeCrons(rawCrons, warnings, domainName) {
  if (!Array.isArray(rawCrons)) return [];
  const crons = [];
  for (const c of rawCrons) {
    if (!c || typeof c !== 'object') continue;
    const scheduleRaw = String(c.schedule || '').trim();
    const commandRaw = String(c.command || '').trim();
    const name = String(c.name || `Cron ${crons.length + 1}`).trim();
    if (!scheduleRaw || !commandRaw) continue;
    try {
      const schedule = normalizeCronSchedule(scheduleRaw);
      const command = normalizeCronCommand(commandRaw);
      crons.push({
        name,
        schedule,
        command,
        enabled: c.enabled !== false,
      });
    } catch (err) {
      warnings.push({
        domain: domainName,
        code: 'cron_expression_invalid',
        message: `Cron task '${name}' has invalid schedule or command: ${err.message}`,
      });
    }
  }
  return crons;
}

function normalizeCertificates(rawCerts, warnings, domainName) {
  if (!Array.isArray(rawCerts)) return [];
  const certs = [];
  for (const cert of rawCerts) {
    if (!cert || typeof cert !== 'object') continue;
    const name = String(cert.name || `${domainName}-cert`).trim();
    const certPem = cert.cert || cert.certPem || null;
    const chainPem = cert.chain || cert.chainPem || null;
    const privkeyPem = cert.privkey || cert.privkeyPem || cert.key || null;
    if (certPem && privkeyPem) {
      certs.push({
        name,
        certPem: String(certPem).trim(),
        chainPem: chainPem ? String(chainPem).trim() : null,
        privkeyPem: String(privkeyPem).trim(),
        domains: Array.isArray(cert.domains) ? cert.domains.map(String) : [domainName],
      });
    }
  }
  return certs;
}

function normalizeBackups(rawBackups, warnings, domainName) {
  if (!Array.isArray(rawBackups)) return [];
  const backups = [];
  for (const b of rawBackups) {
    if (!b || typeof b !== 'object') continue;
    const name = String(b.name || b.fileName || '').trim();
    const filePath = String(b.path || b.filePath || '').trim();
    const sizeBytes = Number.isSafeInteger(b.sizeBytes) ? b.sizeBytes : (b.size || 0);
    if (name) {
      backups.push({ name, path: filePath, sizeBytes });
    }
  }
  return backups;
}

export function createPleskImporter({ localServerId } = {}) {
  const serverId = assertUuid(localServerId, 'localServerId');

  function importFromOfflineExport(exportData) {
    if (!exportData) {
      throw new PleskImporterError('plesk_export_empty', 'Plesk offline export data is required');
    }
    let data = exportData;
    if (typeof data === 'string') {
      assertNotForbiddenHost(data, 'Plesk export payload');
      try {
        data = JSON.parse(data);
      } catch (err) {
        throw new PleskImporterError('plesk_export_invalid_json', `Plesk export is not valid JSON: ${err.message}`);
      }
    }
    assertNotForbiddenHost(data, 'Plesk export payload');

    if (!data || typeof data !== 'object') {
      throw new PleskImporterError('plesk_export_invalid', 'Plesk offline export must be an object');
    }

    const rawWebsites = Array.isArray(data.websites) ? data.websites : (Array.isArray(data.domains) ? data.domains : [data]);
    if (rawWebsites.length === 0) {
      throw new PleskImporterError('plesk_export_no_websites', 'Plesk offline export contains no website entries');
    }

    const warnings = [];
    const websites = [];

    let totalDomains = 0;
    let totalDatabases = 0;
    let totalMailboxes = 0;
    let totalDnsZones = 0;
    let totalCrons = 0;
    let totalCertificates = 0;

    for (const raw of rawWebsites) {
      if (!raw || typeof raw !== 'object') continue;
      const rawDomain = raw.primaryDomain || raw.name || raw.domain;
      if (!rawDomain || typeof rawDomain !== 'string') {
        warnings.push({ code: 'website_missing_domain', message: 'A website entry is missing its primary domain' });
        continue;
      }
      assertNotForbiddenHost(rawDomain, 'Plesk domain');

      let domainSet;
      try {
        domainSet = normalizeDomainSet(rawDomain, Array.isArray(raw.aliases) ? raw.aliases : []);
      } catch (err) {
        warnings.push({
          domain: rawDomain,
          code: 'domain_name_invalid',
          message: `Invalid domain or alias in Plesk entry: ${err.message}`,
        });
        continue;
      }

      const primaryDomain = domainSet.primary;
      const aliases = domainSet.aliases;
      totalDomains += 1 + aliases.length;

      const runtime = normalizeRuntime(raw.runtime || raw);
      const databases = normalizeDatabases(raw.databases, warnings, primaryDomain);
      totalDatabases += databases.length;

      const mail = normalizeMail(raw.mail || raw.mailDomain, warnings, primaryDomain);
      if (mail) totalMailboxes += mail.mailboxes.length;

      const dns = normalizeDns(raw.dns || raw.dnsZone, warnings, primaryDomain);
      if (dns) totalDnsZones += 1;

      const crons = normalizeCrons(raw.crons || raw.cronTasks, warnings, primaryDomain);
      totalCrons += crons.length;

      const certificates = normalizeCertificates(raw.certificates || raw.ssl, warnings, primaryDomain);
      totalCertificates += certificates.length;

      const backups = normalizeBackups(raw.backups || raw.backupArchives, warnings, primaryDomain);

      websites.push({
        id: randomUUID(),
        serverId,
        primaryDomain,
        aliases,
        runtime,
        databases,
        mailDomain: mail,
        dnsZone: dns,
        crons,
        certificates,
        backups,
      });
    }

    const summary = {
      websitesCount: websites.length,
      domainsCount: totalDomains,
      databasesCount: totalDatabases,
      mailboxesCount: totalMailboxes,
      dnsZonesCount: totalDnsZones,
      cronsCount: totalCrons,
      certificatesCount: totalCertificates,
    };

    const previewPayload = {
      version: 1,
      serverId,
      summary,
      websites,
      warnings,
    };

    const previewDigest = sha256(JSON.stringify(previewPayload));

    return Object.freeze({
      previewId: randomUUID(),
      createdAt: new Date().toISOString(),
      serverId,
      summary: Object.freeze(summary),
      websites: Object.freeze(websites),
      warnings: Object.freeze(warnings),
      previewDigest,
      readOnly: true,
    });
  }

  return Object.freeze({
    importFromOfflineExport,
  });
}
