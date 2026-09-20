# External DNS Requirements ve Cloudflare Sağlayıcı Canlı Kabul Raporu

**Tarih**: 2026-09-21  
**Hedef Sunucu**: `157.180.11.28` (hostname: `test`, Ubuntu 24.04 LTS)  
**Server ID**: `99bc760a-d508-4ae6-92be-efdedee9658d`  
**Test Alan Adı / Zonu**: `extacceptance.webrich.news`  
**Kapsam**: `todo.md` `T-MAIL` satır 43 — External DNS zonu ve alan adı için exact pending DNS gereksinimleri ve Cloudflare sağlayıcı uygulamasını gerçek test sunucusunda doğrula: apex A/AAAA, CNAME, mail MX/SPF/DMARC/DKIM/webmail gereksinimlerinin eksiksiz listelendiğini; Cloudflare token eklendiğinde provider canlı snapshot'ı ile pending/fulfilled eşleşmelerinin yapıldığını; tekil gereksinim anahtarı (`key`) ile önizleme ve uygulama yapıldığında `dns.record.apply` işinin hatasız kuyruğa alınıp Cloudflare üzerinde kaydı oluşturduğunu doğrula.

---

## 1. Özet ve Kabul Sonuçları

`todo.md` dosyasındaki `T-MAIL` satır 43 maddesi doğrultusunda, hem Node 24 (`v24.21.0`) birim testlerinde hem de canlı test sunucusu (`.28`) üzerinde harici DNS modundaki alan adı ve zonlar için tam gereksinim türetimi, Cloudflare sağlayıcı canlı anlık görüntü eşleşmesi, tekil anahtar önizlemesi ve hata enjeksiyonları ile `dns.record.apply` işinin kuyruğa alınıp başarıyla yürütülmesi uçtan uca doğrulanmıştır.

### A. Alan Adı ve Zonu İçin Kanonik DNS Gereksinimlerinin Eksiksiz Listelenmesi
- Canlı sunucuda `extacceptance.webrich.news` alan adı (`aliases: ['www.extacceptance.webrich.news']`), yerel posta alanı (`extacceptance.webrich.news`, `managementMode: 'local'`) ve DKIM anahtarı (`selector: 'default'`) oluşturuldu.
- `GET /api/panel/domains/:id/dns-requirements` çağrısı ile tüm 11 kanonik DNS gereksiniminin eksiksiz ve doğru tür/içerik/kategori ile türetildiği doğrulandı:
  1. `web-apex-a` (`A`, `extacceptance.webrich.news` -> `157.180.11.28`, TTL 300, proxied: false, kategori: `web`)
  2. `web-apex-aaaa` (`AAAA`, `extacceptance.webrich.news` -> `fe80::250:56ff:fe01:2228`, TTL 300, proxied: false, kategori: `web`)
  3. `web-alias-www-extacceptance-webrich-news-cname` (`CNAME`, `www.extacceptance.webrich.news` -> `extacceptance.webrich.news`, TTL 300, proxied: false, kategori: `web`)
  4. `mail-mx` (`MX`, `extacceptance.webrich.news` -> `10 mail.extacceptance.webrich.news`, TTL 300, proxied: false, kategori: `mail`)
  5. `mail-spf` (`TXT`, `extacceptance.webrich.news` -> `v=spf1 mx -all`, TTL 300, proxied: false, kategori: `mail`)
  6. `mail-dmarc` (`TXT`, `_dmarc.extacceptance.webrich.news` -> `v=DMARC1; p=none`, TTL 300, proxied: false, kategori: `mail`)
  7. `mail-host-a` (`A`, `mail.extacceptance.webrich.news` -> `157.180.11.28`, TTL 300, proxied: false, kategori: `mail`)
  8. `mail-host-aaaa` (`AAAA`, `mail.extacceptance.webrich.news` -> `fe80::250:56ff:fe01:2228`, TTL 300, proxied: false, kategori: `mail`)
  9. `webmail-a` (`A`, `webmail.extacceptance.webrich.news` -> `157.180.11.28`, TTL 300, proxied: false, kategori: `webmail`)
  10. `webmail-aaaa` (`AAAA`, `webmail.extacceptance.webrich.news` -> `fe80::250:56ff:fe01:2228`, TTL 300, proxied: false, kategori: `webmail`)
  11. `mail-dkim-default` (`TXT`, `default._domainkey.extacceptance.webrich.news` -> `v=DKIM1; ...`, TTL 300, proxied: false, kategori: `dkim`)

### B. Harici DNS Zonu ve Sağlayıcı Kimlik Bilgisi Yapılandırması
- `POST /api/panel/dns-zones` ile harici modda zon oluşturuldu (`status: 'unverified'`).
- `PUT /api/panel/dns-zones/:id/provider-credential` ile Cloudflare sağlayıcı belirteci (`token`) eklendi.
- Belirtecin API yanıtlarında veya genel günlüklerde maskelendiği (`token` alanı dışarı sızdırılmadan) ve `0600` modlu kayıt deposunda şifreli tutulduğu doğrulandı.

### C. Sağlayıcı Canlı Anlık Görüntü (Snapshot) Eşleşmesi ve Durum Sınıflandırması
- `GET /api/panel/dns-zones/:id/requirements` çağrısı ile sağlayıcı canlı durumu incelendi (`providerConfigured: true`, `provider: 'cloudflare'`):
  - **Eksik Kayıt (create/pending)**: `web-apex-a` sağlayıcıda bulunmadığından `status: 'pending'`, `effect: 'create'`, `reason: 'missing'` olarak tespit edildi.
  - **Eşleşen Kayıt (no_change/fulfilled)**: `web-alias-www-extacceptance-webrich-news-cname` sağlayıcıdaki mevcut kayıtla tam eşleştiğinden `status: 'fulfilled'`, `effect: 'no_change'` olarak doğrulandı.
  - **Uyumsuz İçerikli Kayıt (update/pending)**: `mail-spf` kaydı sağlayıcıda farklı içerikle (`v=spf1 ~all`) mevcut olduğundan `status: 'pending'`, `effect: 'update'`, `reason: 'mismatch'` olarak tespit edildi.
  - **Çakışan Çoklu Kayıt (conflict/pending)**: `mail-dmarc` için sağlayıcıda birden fazla kayıt bulunduğundan `status: 'pending'`, `effect: 'conflict'`, `reason: 'ambiguous'` olarak işaretlendi.

### D. Tekil Anahtar Önizlemesi ve Hata Enjeksiyonları
- **Bayat Zon Revizyonu**: `expectedRevision: 9999` ile yapılan istek HTTP 409 `dns_zone_revision_conflict` ile reddedildi.
- **Bilinmeyen Gereksinim Anahtarı**: `key: 'invalid-nonexistent-key'` ile yapılan istek HTTP 400 `dns_requirement_key_unknown` ile reddedildi.
- **Geçerli Tekil Anahtar Önizlemesi**: `key: 'web-apex-a'` seçilerek oluşturulan önizleme:
  - `operation: 'dns_requirements_apply'`
  - `readyToApply: true`
  - `items`: 1 adet (`web-apex-a`, action: `upsert`, effect: `create`)
  - Deterministik `previewDigest` (64 karakter sha256) ve `confirmation` (`apply-dns-requirements:${zoneId}:${previewDigest}`) üretildi.

### E. Uygulama Hata Enjeksiyonları ve `dns.record.apply` İş Kuyruğu
- **Bayat Önizleme Özeti**: `previewDigest: '0'.repeat(64)` ile yapılan uygulama HTTP 409 `dns_requirements_preview_stale` ile reddedildi.
- **Geçersiz Onay Dizgisi**: Hatalı `confirmation` ile yapılan istek HTTP 400 `dns_requirements_confirmation_required` ile fail-closed durduruldu.
- **Onaylı Uygulama**: Doğru özet ve onay ile yapılan `POST /requirements/apply`:
  - HTTP 202 Accepted yanıtı döndü (`count: 1`, `itemKey: 'web-apex-a'`).
  - `dns.record.apply` işi `resourceType: 'dns_zone'`, `resourceId: zone.id` ve tekil `idempotencyKey` ile kuyruğa alındı (İş ID: `d9955949-c9fa-4e98-93f3-1f4134522c1f`).

### F. Arka Plan Yürütümü, Sağlayıcıda Kayıt Oluşumu ve İadesi
- Yerel ana makine iş yürütücüsü (`local-host-operations`) işi devralarak `cloudflareDnsManager.applyRecord` çağırdı.
- Sağlayıcı üzerinde `POST /zones/:zoneId/dns_records` çağrısı yürütüldü ve yeni kayıt oluşturuldu (`changed: true`, `state: 'present'`).
- İş başarıyla kapandı (`status: 'succeeded'`).
- Uygulama sonrası yeniden yapılan gereksinim incelemesinde (`GET /api/panel/dns-zones/:id/requirements`):
  - `web-apex-a` kaydının durumu `status: 'fulfilled'` ve `effect: 'no_change'` olarak güncellendi.
  - `currentRecords` dizisinde oluşturulan `157.180.11.28` IP adresli `A` kaydı doğrulandı.

### G. Güvenli Temizlik ve Geri Alma
- Test sağlayıcı kimlik bilgisi silindi (`DELETE /api/panel/dns-zones/:id/provider-credential`).
- Test zonu, yerel posta alanı ve web alanı kontrol düzleminden temizlendi.
- Mock sağlayıcı durduruldu, `/etc/yunpanel/control-plane/api.env` orijinal haline döndürüldü ve `yunpanel-api` sağlıklı şekilde yeniden başlatıldı.

---

## 2. Test Doğrulama ve Kanıt

- **Doğrulama Aracı**: `.local/verify-external-dns-requirements-live-acceptance.mjs`
- **Mock Sağlayıcı**: `.local/mock-cloudflare-api.mjs`
- **Node Sürümü**: Node 24 (`v24.21.0`)
- **Birim Testleri**: 2,956 / 2,956 test geçti (0 hata).
- **Canlı Sunucu Çıktısı**: Sıfır hata ile `🎉 EXTERNAL DNS REQUIREMENTS & CLOUDFLARE LIVE ACCEPTANCE PASSED!` raporlandı.
