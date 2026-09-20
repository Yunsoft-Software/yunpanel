# External Mail Site Create Canlı Kabulü (2026-09-20)

**Tarih:** 2026-09-20  
**Hedef Host:** `157.180.11.28` (.28 test sunucusu, Ubuntu 24.04 LTS)  
**Kapsam:** T-MAIL `External mail site-create kabulü`.  

---

## 1. Giriş ve Amaç

YunPanel mimarisinde, dış posta servisi kullanan web siteleri (`mail.mode: 'external'`) için:
1. Mail Domain kaydının `managementMode: 'external'` ve başlangıç durumunun `status: 'unverified'` olarak oluşturulması.
2. Yerel Postfix/Dovecot/DKIM/Roundcube sistemlerinde hiçbir değişiklik ve mutasyon yapılmaması (`mail_config`, `mail_dkim_key`, `webmail_certificate`, `roundcube_mapping` vb. adımların plana dahil edilmemesi).
3. Alan adına ait DNS ve sağlayıcı gereksinimlerinin (`/api/panel/domains/:domainId/dns-requirements`) panelde eksiksiz olarak listelenmesi.

---

## 2. Çalıştırılan Kabul Testleri ve Sonuçları

### 2.1. Site Create Preview & Provisioning Adımları

`extmail.webrich.news` alan adı için `source.kind: 'new_php'`, `dns.mode: 'local'`, `httpsMode: 'managed'` ve `mail.mode: 'external'` ile `POST /api/panel/sites/create-preview` çağrıldı:
- Plana dahil edilen adımlar:
  - `application_metadata`
  - `website_metadata`
  - `primary_domain_metadata`
  - `mail_domain_metadata`
  - `unix_identity`
  - `elfinder`
  - `php_bootstrap`
  - `php_runtime`
  - `sftp`
  - `dns_zone`
  - `nginx`
  - `domain_activation`
  - `certificate`
  - `tls_activation`
- Yerel posta adımları (`mail_config`, `mail_dkim_key`, `mail_dns_reapply`, `webmail_certificate`, `mail_dkim_config`, `roundcube_mapping`, `mail_health`) plana eklenmedi.
- `POST /api/panel/sites` ile site oluşturuldu ve tüm 14 adım başarıyla tamamlanarak site `ready: true` durumuna geldi.

### 2.2. Mail Domain Metadata Doğrulaması

`GET /api/panel/mail-domains` çağrısı ile oluşturulan kayıt doğrulandı:
- `id`: `75474270-dd3c-589e-895d-59eaa85b9935`
- `domainName`: `extmail.webrich.news`
- `managementMode`: `external`
- `status`: `unverified`
- `revision`: `1`

### 2.3. Yerel Posta / Roundcube İzolasyonu

- `/etc/nginx/sites-enabled/yunpanel-roundcube.conf` kontrol edildi; `extmail.webrich.news` için hiçbir Roundcube vhost veya webmail yönlendirmesi eklenmediği doğrulandı.
- Postfix/Dovecot virtual lookup tabloları denetlendi; hiçbir mutasyon gerçekleşmediği doğrulandı.

### 2.4. DNS Requirements API Doğrulaması

`GET /api/panel/domains/7633894c-2bfd-5234-9c30-58bd3154811a/dns-requirements` çağrıldı:
- HTTP 200 OK yanıtı alındı.
- `mailDomain`: `{ id: '75474270-dd3c-589e-895d-59eaa85b9935', domainName: 'extmail.webrich.news', managementMode: 'external', status: 'unverified' }` döndü.
- Alan adına ait A ve AAAA gereksinimleri listelendi.

---

## 3. Tamamlanan Kabul Maddesi

- `External mail site-create kabulü` (`todo.md` T-MAIL).
