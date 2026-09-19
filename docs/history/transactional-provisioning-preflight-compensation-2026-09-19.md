# Transactional Website/Domain Provisioning Preflight, Exact Preview & Compensation — 2026-09-19

## Özet

P0.8 kapsamında transactional Website/Domain provisioning gereksinimleri kaynak kod tarafında tamamlandı:
1. **Preflight ve Exact Resource Preview**:
   - `apps/api/src/site-create-base.js` ve `apps/api/src/site-create-dns-provisioning.js`:
     - FQDN, IDN, duplicate hostname, parent-child hiyerarşisi ve alias conflict kontrolleri tek birleşik preflight akışında doğrulandı.
     - `normalizeInput`: `dns: { mode: 'local' | 'external' }` opsiyonu eklendi. Subdomain'de `local` seçildiğinde `site_create_subdomain_dns_unsupported` (409) hatası fırlatılır. Varsayılan root domain için `local`, subdomain için `external`dır.
     - `previewSiteCreate`: `runtime`, `dns`, `ip`, `certificate` ve `sftp` exact intent'leri `preview.plan.resources` içinde toplandı:
       - `runtime`: runtime type, adapter (passenger/php-fpm/static), documentRoot, appRoot, nodeMajor, startMode, entryFile, healthPath.
       - `dns`: mode (local/external/inherited), zoneName, authoritative, serverDnsIdentityConfigured, publicIpv4, publicIpv6, nameservers.
       - `ip`: publicIpv4, publicIpv6.
       - `certificate`: mode (managed/off), purpose ('web'), primaryDomain, coverage, issuer ('letsencrypt'), webmailCoverage (`webmail.<domain>`).
       - `sftp`: adapter ('openssh-internal-sftp'), unixUser, homeDirectory, documentRoot (hosted runtime'lar için).
     - Package/service blocker'ları (`blockers: []`) apply öncesi preflight'ta toplandı (`dns_identity_required`, `passenger_start_mode_unsupported` vb.). Blocker varsa `complete: false` olur ve `createSite` `site_create_blocked_by_dependency` (409) fırlatarak sunucu mutation'ını engeller.
2. **Apply & Compensation**:
   - `apps/api/src/website-tls-provisioning-handler.js`:
     - `compensate` ve `inspectCompensation` metodları eklendi.
     - Downstream failure durumunda Nginx TLS activation'ını geri alıp Nginx'i HTTP-only haline getirir, domain'in TLS routing durumunu un-TLS'e alır ve exact rollback receipt (`{ satisfied: true, rolledBack: true, nginxChecksum: ... }`) üretir.
   - `apps/api/src/website-certificate-provisioning-handler.js`:
     - `compensate` ve `inspectCompensation` metodları eklendi.
     - Downstream failure'da sertifika silinmez, fiziksel kaldırma yapılmaz; exact retention receipt (`{ satisfied: true, retained: true }`) ile sertifika muhafaza edilir.
   - `apps/api/src/site-create-dns-provisioning.js`:
     - `dns.mode === 'external'` olduğunda `dns_zone` step'i üretilmez, external DNS akışı korunur.
   - `apps/api/src/app.js`:
     - `mountSiteCreateRoutes` çağrısına `serverDnsIdentityRegistry` ve `dnsZoneTemplateRegistry` bağlandı.

## Doğrulama

- Node 24 (`v24.21.0`) ortamında:
  - `node --test apps/api/test/site-create.test.js`
  - `node --test apps/api/test/site-create-dns-provisioning.test.js`
  - `node --test apps/api/test/website-tls-provisioning-handler.test.js`
  - `node --test apps/api/test/website-certificate-provisioning-handler.test.js`
  - `node --test apps/api/test/site-create-http.test.js`
  - `npm run check` (tüm repository genelinde 100% test ve build başarısı).
