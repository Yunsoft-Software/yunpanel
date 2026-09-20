# Retired Certificate Material GC Lifecycle Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki **Retired Certificate Material GC Lifecycle** uçtan uca canlı API, dosya sistemi ve Certbot entegrasyonuyla test edilmiş ve doğrulanmıştır.

Test edilen gereksinim:
> Gerçek Ubuntu ortamında retired certificate material GC lifecycle'ını test et: 30 günlük retention süresi dolmamış emekli sertifika materyallerinin silinmediğini; aktif sertifika veya domain ile paylaşılan ACME/custom materyallerin asla kaldırılmadığını; retention süresi dolmuş ve paylaşılmayan sertifikaların sweep sonrası fiziksel olarak (`/var/lib/yunpanel/control-plane/custom-certificates/<id>` ve `/etc/letsencrypt/live/<certName>`) temizlendiğini ve registry'de `materialPurgedAt` ile işaretlendiğini doğrula.

---

## Doğrulanan Senaryolar & Kanıtlar

### 1. Retention Penceresi Koruması (Unexpired Retired Certs < 30 gün)
- **Fixture 1 (`a0000001-...`)**: Emekliye ayrılma tarihi 5 gün önce (`retiredDaysAgo: 5`), retention kuralı 30 gün.
- `GET /api/panel/certificates/gc/preview` çağrısında `retained` listesine girdi, sebep: `retention_window_active`.
- `sweep` operasyonu sırasında dosya sistemindeki `/var/lib/yunpanel/control-plane/custom-certificates/a0000001-...` dizini silinmedi, korundu.

### 2. Domain Referans Koruması (Referenced by Active Domain)
- **Fixture 2 (`a0000002-...`)**: Emekliye ayrılma tarihi 45 gün önce (süresi dolmuş), ancak aktif bir Domain kaydı (`certificateId`) tarafından referans veriliyor.
- `GET /api/panel/certificates/gc/preview` çağrısında `sharedActive` listesine girdi, sebep: `referenced_by_domain`.
- `sweep` operasyonu sırasında dosya sistemindeki `/var/lib/yunpanel/control-plane/custom-certificates/a0000002-...` dizini silinmedi, korundu.

### 3. Aktif Sertifika Paylaşım Koruması (Shared with Active Certificate)
- **Fixture 3 (`a0000003-...`)**: ACME kaynağı, emekliye ayrılma tarihi 45 gün önce, ancak `certName: 'webrich.news'` ile canlı aktif bir sertifikanın `certName` değerini paylaşıyor.
  - Önizlemede `sharedActive` listesine girdi, sebep: `shared_with_active_certificate`.
  - Canlı `/etc/letsencrypt/live/webrich.news` sertifikası hiçbir şekilde silinmedi veya değiştirilmedi.
- **Fixture 4 (`a0000004-...`)**: Custom kaynağı, emekliye ayrılma tarihi 45 gün önce, ancak `materialDigest` değeri aktif bir sertifikanın `materialDigest` değeriyle eşleşiyor.
  - Önizlemede `sharedActive` listesine girdi, sebep: `shared_with_active_certificate`.
  - Dosya sistemindeki `/var/lib/yunpanel/control-plane/custom-certificates/a0000004-...` dizini silinmedi, korundu.

### 4. Çapraz Emekli Sertifika Paylaşım Koruması (Cross-Retired Sharing)
- **Fixture 5 (`a0000005-...`)**: Emekliye ayrılma tarihi 5 gün önce (unexpired), `materialDigest: 'shared_retired_digest_56'`.
- **Fixture 6 (`a0000006-...`)**: Emekliye ayrılma tarihi 45 gün önce (expired), aynı `materialDigest: 'shared_retired_digest_56'` değerini paylaşıyor.
- Önizlemede Fixture 5 `retained` (`retention_window_active`), Fixture 6 ise `sharedRetained` (`shared_with_retained_certificate`) olarak raporlandı.
- `sweep` operasyonunda her iki sertifikanın da materyalleri silinmedi, korundu.

### 5. Süresi Dolmuş ve Paylaşılmayan Sertifikalar (Eligible for GC)
- **Fixture 7 (`a0000007-...`)**: Custom sertifika, emekliye ayrılma 45 gün önce, paylaşılmıyor.
- **Fixture 8 (`a0000008-...`)**: ACME sertifikası (`gceligible.webrich.news`), emekliye ayrılma 45 gün önce, paylaşılmıyor.
- Önizlemede `eligibleCount: 2` olarak tam ve eksiksiz tespit edildi.

### 6. Simülasyon / Kuru Çalıştırma (Dry Run Sweep)
- `POST /api/panel/certificates/gc/sweep` payload: `{"dryRun": true}`.
- Cevap: `dryRun: true`, `sweptCount: 2`, `skippedCount: 6`.
- Disk kontrolü: `/var/lib/yunpanel/control-plane/custom-certificates/a0000007-...` ve `/etc/letsencrypt/live/gceligible.webrich.news` dizinlerinin fiziksel olarak durduğu doğrulandı (kuru çalıştırmada hiçbir dosya silinmedi).
- Registry kontrolü: `materialPurgedAt` değerlerinin hâlâ `null` olduğu doğrulandı.

### 7. Gerçek Süpürme (Real Sweep) ve Fiziksel Temizlik
- `POST /api/panel/certificates/gc/sweep` payload: `{"dryRun": false}`.
- Cevap: `dryRun: false`, `sweptCount: 2`, `purgedAt: "2026-09-20T15:38:14.594Z"`.
- **Fiziksel Silme Kontrolü**:
  - `/var/lib/yunpanel/control-plane/custom-certificates/a0000007-...` dizininin `rm` ile tamamen silindiği (`ENOENT`) teyit edildi.
  - `/etc/letsencrypt/live/gceligible.webrich.news` ve archive/renewal dosyalarının Certbot entegrasyonuyla (`certbot delete --cert-name ... --non-interactive`) tamamen silindiği (`ENOENT`) teyit edildi.
- **Korumalı Materyaller Kontrolü**:
  - `a0000001-...` (retained): Duruyor.
  - `a0000002-...` (sharedActive domain): Duruyor.
  - `a0000004-...` (sharedActive digest): Duruyor.
  - `a0000005-...` (retained): Duruyor.
  - `a0000006-...` (sharedRetained): Duruyor.
  - Tüm canlı üretim sertifikaları (`webrich.news`, `cryptoraichu.website`, `mailtest.webrich.news`, `extmail.webrich.news`): Dokunulmadı, sağlam.
- **Registry Güncellemesi**:
  - Fixture 7 için `materialPurgedAt: "2026-09-20T15:38:14.594Z"`, `state: 'retired'` işaretlendi.
  - Fixture 8 için `materialPurgedAt: "2026-09-20T15:38:14.594Z"`, `state: 'retired'` işaretlendi.
  - Diğer sertifikaların `materialPurgedAt` alanı `null` olarak kaldı.

### 8. Süpürme Sonrası Önizleme ve API Yeniden Başlatma Kalıcılığı
- `GET /api/panel/certificates/gc/preview` çağrısı:
  - `eligibleCount: 0`
  - `alreadyPurgedCount: 2` (Fixture 7 ve Fixture 8)
- `systemctl restart yunpanel-api` sonrasında:
  - Tekrar oturum açılıp sorgulandığında `eligibleCount: 0` ve `alreadyPurgedCount: 2` durumunun diskten hatasız yüklendiği ve korunduğu doğrulandı.
