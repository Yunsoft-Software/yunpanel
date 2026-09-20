# Fresh Website Transactional Provisioning & Compensation Gerçek Ortam Kabulü (2026-09-20)

Bu doküman, `.28` test sunucusunda (`157.180.11.28`, hostname `test`, Ubuntu 24.04 LTS) Fresh Website Transactional Provisioning ve Downstream Compensation mekanizmalarının failure-injection ile yürütülen canlı kabul testlerini belgeler.

---

## 1. Test Kapsamı ve Doğrulanan Mekanizmalar

### 1.1 Preflight Validations & Conflict Checks (Phase 1)
- **FQDN / IDN Normalizasyonu**: Uluslararasılaştırılmış alan adı (`münchen-hosting.com`) FQDN ve Punycode (`xn--mnchen-hosting-gsb.com`) kurallarına uygun olarak başarıyla normalize edildi.
- **Mükerrer Domain Engelleme**: Sunucuda zaten yönetilen bir kök domain ile çakışan istek `site_create_domain_conflict` (HTTP 409) koduyla fail-closed reddedildi.
- **Alias Çakışması Engelleme**: Mevcut bir domain'in alias'ı olarak tanımlı bir hostname ile yeni site açma isteği `site_create_domain_conflict` (HTTP 409) koduyla engellendi.
- **Parent-Child Hiyerarşisi Doğrulaması**: Var olmayan `parentDomainId` ile alt domain oluşturma girişimi `parent_domain_not_found` (HTTP 404) ile fail-closed reddedildi.
- **Subdomain Local DNS Kısıtı**: Alt domain (subdomain) için bağımsız yerel yetkili (authoritative) DNS bölgesi açma talebi `site_create_subdomain_dns_unsupported` (HTTP 409) koduyla engellendi.

### 1.2 Exact Resource Preview Construction (Phase 2)
Tek bir site oluşturma isteği için tüm hedef kaynakların önizleme planında (`preview.plan`) eksiksiz ve deterministik olarak üretildiği doğrulandı:
- **Runtime Preview**: Node 24, Phusion Passenger adaptörü, `server.js` startup dosyası, exact `appRoot` ve `documentRoot`.
- **DNS Preview**: Local mod, yetkili (authoritative) DNS bölgesi, public IPv4 (`157.180.11.28`), IPv6 ve ayrılmış ad sunucuları (`ns1.yunpanel.internal`, `ns2.yunpanel.internal`).
- **IP Preview**: Sunucuya atanmış public IPv4 ve IPv6 adresleri.
- **Certificate Preview**: Managed Let's Encrypt sertifikası, web kapsamı ve dedicated webmail kapsamı (`webmail.test-site.example.com`).
- **SFTP Preview**: `openssh-internal-sftp` adaptörü, izole kullanıcı (`yunapp-*`), home dizini (`/var/lib/yunpanel/homes/...`) ve document root.
- **Database Preview**: Otomatik üretilen `yp_*` veritabanı adı, website/uygulama ve unix kullanıcı sahiplik bağlayıcıları.
- **Mail Domain Preview**: Local yönetim modu, başlangıç durumu `disabled`, hedeflenen durum `enabled`.

### 1.3 Package & Service Blocker Enforcement (Phase 3)
- **Desteklenmeyen Runtime Başlatma Modu**: Passenger tarafından desteklenmeyen `npm start` modu içeren konfigürasyon `passenger_start_mode_unsupported` blocker'ı ile işaretlendi; hazırlanan provizyonlama planı `blocked` durumuna çekilerek işlemin ilerlemesi durduruldu.
- **Eksik DNS Kimliği**: Sunucu DNS kimliği yapılandırılmamışken yerel DNS bölgesi talep edildiğinde `dns_identity_required` blocker'ı tetiklendi ve plan engellendi.

### 1.4 Downstream Failure TLS Activation Compensation (Phase 4)
- İleri adımlarda (downstream) bir hata oluştuğunda TLS aktivasyon telafisinin (`tlsHandler.compensate`) Nginx konfigürasyonunu güvenle HTTP-only durumuna geri aldığı (`tls: null`, `httpsRedirect: false`, `canonicalRedirect: false`) kanıtlandı.
- Telafi işlemi sonucunda `{ satisfied: true, rolledBack: true, adapter: 'managed-certificate-nginx', domainId, nginxChecksum, nginxConfigName }` içeren deterministik rollback receipt üretildiği teyit edildi.

### 1.5 Certificate Step Compensation & Physical Retention (Phase 5)
- Sertifika adımı telafisinde (`certHandler.compensate`) ACME/Let's Encrypt sertifikalarının fiziksel olarak silinmediği, güvenli saklama garantisi olarak `{ satisfied: true, retained: true }` formatında retention receipt üretildiği kanıtlandı.

### 1.6 Güvenlik ve Sıfır Secret Sızıntısı (Phase 6)
- Önizleme planında, kaynak detaylarında ve telafi makbuzlarında hiçbir parola, özel anahtar veya gizli bilgi yer almadığı doğrulanarak sıfır sızıntı (zero secret leaks) garanti altına alındı.

---

## 2. Test Yürütme Kaydı (Konsol Çıktısı)

```text
================================================================
  Transactional Provisioning & Compensation Live Acceptance     
  Server: 157.180.11.28 (hostname: test, OS: Linux 6.8.0-139-generic)
================================================================

[Phase 1] Verifying Preflight Validations & Conflict Checks...
  ✔ IDN/FQDN domain normalization confirmed (Punycode: xn--mnchen-hosting-gsb.com)
  ✔ Duplicate primary domain rejected fail-closed (site_create_domain_conflict)
  ✔ Domain alias conflict rejected fail-closed (site_create_domain_conflict)
  ✔ Invalid/missing parentDomainId rejected fail-closed (parent_domain_not_found)
  ✔ Subdomain with local DNS rejected with site_create_subdomain_dns_unsupported

[Phase 2] Verifying Exact Resource Preview Construction...
  ✔ Exact runtime preview verified (Node 24, Passenger, entryFile, documentRoot)
  ✔ Exact DNS preview verified (local authoritative zone, IPs, nameservers)
  ✔ Exact IP preview verified (IPv4 & IPv6)
  ✔ Exact certificate preview verified (web & dedicated webmail TLS coverage)
  ✔ Exact SFTP preview verified (OpenSSH internal-sftp, isolated home)
  ✔ Exact database preview verified (auto-generated yp_* name, ownership binding)
  ✔ Exact mail domain preview verified (local mode, initial disabled -> desired enabled)

[Phase 3] Verifying Package & Service Blocker Enforcement...
  ✔ passenger_start_mode_unsupported blocker correctly halts provisioning plan
  ✔ dns_identity_required blocker halts plan when DNS identity is missing

[Phase 4] Verifying TLS Activation Compensation & HTTP-Only Rollback...
  ✔ TLS activation compensation rolled back Nginx to HTTP-only and produced exact rollback receipt

[Phase 5] Verifying Certificate Step Compensation & Physical Retention...
  ✔ Certificate step compensation produced exact retention receipt without physical deletion

[Phase 6] Verifying Security & Zero Secret Leaks...
  ✔ Zero secret/credential leaks verified in provisioning preview and compensation evidence

================================================================
  🎉 ALL TRANSACTIONAL PROVISIONING TESTS PASSED!               
================================================================
```

---

## 3. Sonuç ve Durum

- **Kapsam**: Fresh Website transactional provisioning, preflight validations, exact resource preview, package/service blocker enforcement, TLS HTTP-only compensation, certificate retention receipt.
- **Hedef Sunucu**: `157.180.11.28` (hostname `test`, Ubuntu 24.04 LTS). Kesinlikle `.44` Plesk sunucusuna dokunulmamıştır.
- **Durum**: Başarıyla tamamlandı ve doğrulandı.
