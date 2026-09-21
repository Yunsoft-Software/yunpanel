# Canlı Sunucu Kabul Raporu: PowerDNS Authoritative DNS Retirement (T-DNS)

- **Tarih:** 2026-09-21
- **Hedef Sunucu:** `157.180.11.28` (hostname: `test`, Ubuntu 24.04 LTS, x86_64)
- **Kapsam:** P0.3 / P0.9 — Authoritative DNS retirement, blocker kapıları, snapshot journal, drift tespiti, fiziksel PowerDNS silme, lost-ack uzlaşması ve restart kurtarma.
- **Yürütücü:** `/root/acceptance-powerdns-retirement-live.mjs`

---

## 1. Test Edilen Yetenekler ve Doğrulama Sonuçları

### 1. Retention Policy Sınır Doğrulaması (1..3650 Gün)
- `snapshotRetentionDays` için geçersiz değerler (0, -1, 3651, 5000, string) `createDnsZoneRetirementService` tarafından `dns_zone_retirement_policy_invalid` (500) hatası ile reddedildi.

### 2. Canlı PowerDNS Ortamı ve Anahtar Sağlama
- `pdns.service` servisinin aktif (`active`) olduğu doğrulandı.
- `powerDnsSecretRegistry.materializeForServer` ile yerel sunucu için PowerDNS API anahtarı başarıyla çözüldü.

### 3. Gerçek PowerDNS Zone Kurulumu ve Yönetilen Kayıtlar
- PowerDNS üzerinde dinamik test zone'u (`dnstest-*.webrich.news`) oluşturuldu.
- Apex SOA, NS ve A kayıtları `template` kaynaklı ve yönetilen yorumlar (managed comments) ile eklendi.

### 4. Blocker Kapılarının Fail-Closed Doğrulanması
Aşağıdaki durumlarda yıkıcı DELETE işleminin kesin olarak engellendiği (`retirementPlanReady === false`, `confirmation === null`) doğrulandı:
- **Yapılandırılmamış Retention Policy:** `dns_zone_delete_retention_policy_required`
- **Eksik/Yabancı Provisioning Geçmişi:** `dns_zone_delete_ownership_evidence_required` (`created=true` kanıtı yoksa silme onaylanmaz)
- **Manuel / Yönetilmeyen RRset:** Zone içine unmanaged TXT kaydı eklendiğinde `dns_zone_manual_rrsets_present`
- **Yerel Mail Domain Bağımlılığı:** Domain'e bağlı aktif mail domain varsa `dns_zone_mail_dependencies_present`
- **Aktif Domain Görevi:** Kuyrukta veya çalışan domain job'ı varsa `dns_zone_domain_jobs_active`
- **Parent DS Kaydı:** Registrar/üst bölgede DS mevcutsa `dns_zone_parent_ds_present`; DS doğrulanamıyorsa `dns_zone_parent_ds_unverifiable`
- **Website Bağlantısı:** `domain_website_binding_present`
- **Sertifika Bağlantısı:** `domain_certificate_present`
- **Alt Domain (Descendant) Varlığı:** `domain_descendants_present`
- **Aktif Yönlendirme:** Domain exact suspension durumunda değilse (`state !== 'suspended'`) `domain_routing_active`

### 5. Açılan Önizleme (Unlocked Preview) ve Korumalı Snapshot
- Bütün blocker koşulları sağlandığında `retirementPlanReady === true` oldu.
- Biçimi `retire-authoritative-zone:<domainId>:<revision>:<snapshotDigest>:<evidenceDigest>:<retentionDays>:<previewDigest>` olan kesin onay dizesi (confirmation) üretildi.
- Zone için 64 karakterli SHA-256 snapshot özeti hesaplandı.

### 6. Kök-Gizli Snapshot Journal (0600) ve Genel Görünüm Maskelemesi
- `opRegistry.create(capture)` ile snapshot `/var/lib/yunpanel/control-plane/test-dns-retirement-operations.json` dosyasına yazıldı.
- Dosya izinleri `stat` ile `0600` (dizin `0700`) olarak doğrulandı.
- `dnsZoneRetirementOperationPublicView(operation)` çağrıldığında ham RRset snapshot verisinin ve özel confirmation dizesinin dışarı sızmadığı (`undefined`) doğrulandı.

### 7. Canlı Drift Tespiti ve Fail-Closed Davranışı
- Canlı PowerDNS zone'una snapshot'ta bulunmayan yabancı bir TXT kaydı eklendi.
- `inspectDeletion` çağrısı canlı drift tespit ederek `powerdns_zone_snapshot_delete_drift` (409) fırlattı.
- `deleteCapturedSnapshot` silme komutu göndermeden önce drift tespit etti ve `powerdns_zone_snapshot_delete_drift` (409) ile işlemi durdurdu; PowerDNS'e DELETE isteği gönderilmedi.
- Drift kaydı silindiğinde `inspectDeletion` başarıyla `deleteCandidate: true` raporladı.

### 8. Fiziksel PowerDNS Silme
- `deleteCapturedSnapshot` ile PowerDNS API üzerinden bölge silindi (`satisfied: true, deleted: true, changed: true`).
- Sunucu üzerinde `pdnsutil list-zone` çalıştırılarak zone'un fiziksel olarak kaldırıldığı teyit edildi.

### 9. Lost-Ack / Yokluk Uzlaşması (İkinci DELETE Olmadan)
- Zone zaten yokken `inspectDeletion` çağrıldığında `satisfied: true, deleted: true` döndü.
- İkinci kez `deleteCapturedSnapshot` çağrıldığında hata vermeden ve PowerDNS'e ikinci bir DELETE göndermeden `satisfied: true, deleted: true, changed: false` olarak kapandı.

### 10. Runtime Yaşam Döngüsü, Restart Kurtarma ve Retention Süresi
- `deleting` durumunda kesilmiş bir işlem simüle edildi.
- Runtime başlangıcında (`runtime.init()`) zone'un PowerDNS'te zaten bulunmadığı tespit edildi ve işlem ikinci bir mutasyon yapılmadan doğrudan `deleted` (`changed: false`) durumuna ulaştırıldı.
- `retainUntil` zaman damgasının `deletedAt + 30 gün` değerine milisaniyesine kadar tam denk geldiği (`diffMs === 30 * 24 * 60 * 60 * 1000`) doğrulandı.
- İşlem store'u diskten yeniden okunduğunda `snapshotDigest`, `result` ve `retainUntil` değerlerinin süreç yeniden başlatmaları arasında birebir korunduğu kanıtlandı.
- Zone halen PowerDNS'te mevcutken kesilmiş `deleting` işlemi restart sırasında otomatik DELETE çalıştırmadı; `dns_zone_retirement_retry_required` ile typed explicit retry talep etti.
- Kesilmiş işlem sırasında zone'da drift meydana geldiyse restart operasyonu fail-closed olarak `powerdns_zone_snapshot_delete_drift` ile `failed` olarak işaretledi ve yabancı kaydı ezmedi.
