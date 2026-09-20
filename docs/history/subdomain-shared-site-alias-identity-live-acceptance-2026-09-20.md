# Subdomain Shared-Site & Alias Identity Semantics Live Acceptance — 2026-09-20

## Özet

Ubuntu 24.04 LTS kurulu YunPanel test sunucusunda (`157.180.11.28` — `.28`, hostname `test`), `T-PROVISIONING` kapsamındaki **Independent subdomain, shared-site ve alias kimlik ayrımı ve izolasyonu** uçtan uca canlı API, `/etc/passwd`, Nginx vhost, runtime ve mail kayıtlarıyla doğrulanmıştır.

Test edilen gereksinim:
> Independent subdomain ayrı identity alırken `shared-site` açık seçimi parent identity'yi paylaşsın; alias user/runtime/mailbox üretmesin.

---

## Doğrulanan Senaryolar & Kanıtlar

### 1. Independent Subdomain Ayrı Identity
- Parent alan adı: `webrich.news` (`e63c3342-787d-5222-8b24-8db2de9834cc`), Website: `2689cb56-55a4-50c0-a3a4-258c7f2d48dd`, Unix kullanıcısı: `yunapp-a404896cf12e` (UID: 994).
- Bağımsız child subdomain: `mailtest.webrich.news` (`ecca97c9-9a98-5e67-9b7e-a0423e0bc0ab`), `parentDomainId: e63c3342-787d-5222-8b24-8db2de9834cc` hiyerarşik bağına sahip.
- Subdomain ayrı ve bağımsız bir Website kimliği (`2c4ba551-df97-58e6-9bff-36a0e79c7b4e`) ve tamamen ayrı bir Unix kullanıcısı (`yunapp-71355c1cda8a`, UID: 993) almıştır.
- Benzer şekilde `extmail.webrich.news` (`7633894c-2bfd-5234-9c30-58bd3154811a`) de ayrı bir Website (`99f4ac32-f671-5d94-a14a-8f93ca04286b`) ve ayrı bir Unix kullanıcısı (`yunapp-54259e4e7f5f`, UID: 992) ile çalışmaktadır.
- Kanıt: Bağımsız alt alan adları parent kimliğini paylaşmaz; dedicated UID/GID ve release/data kapsamı alır.

### 2. Shared-Site Açık Seçimi ile Parent Identity Paylaşımı
- `POST /api/panel/domains` endpoint'i üzerinden parent alan adı `webrich.news` altına `sharedtest.webrich.news` alt alan adı oluşturuldu.
- Bu işlemde `parentDomainId: e63c3342-787d-5222-8b24-8db2de9834cc` ve `websiteId: 2689cb56-55a4-50c0-a3a4-258c7f2d48dd` (parent Website ID) ve `target: { applicationId: "a5e1f251-4594-5996-b402-47a2ad7f55a0" }` açıkça seçildi.
- Sonuçlar:
  - Domain kaydı oluşturuldu (`websiteId: 2689cb56-55a4-50c0-a3a4-258c7f2d48dd`).
  - `/etc/passwd` kontrol edildi: Sıfır yeni Unix kullanıcısı oluşturuldu; parent kullanıcısı (`yunapp-a404896cf12e`) paylaşıldı.
  - `website-registry.json` kontrol edildi: Sıfır yeni Website oluşturuldu; parent Website yeniden kullanıldı.
  - `application-registry.json` kontrol edildi: Sıfır yeni runtime oluşturuldu; parent PHP runtime yeniden kullanıldı.
- Test tamamlandıktan sonra geçici shared-site alan adı temizlendi.

### 3. Alias Alan Adı: No User, No Runtime, No Mailbox
- `webrich.news` alan adı üzerinde `POST /api/panel/domains/:id/update-preview` ve `PATCH /api/panel/domains/:id` ile `aliases: ['aliastest.webrich.news']` alias kaydı eklendi.
- Doğrulamalar:
  - `/etc/passwd`: Hiçbir yeni Unix kullanıcısı oluşturulmadı.
  - `application-registry.json`: Hiçbir yeni uygulama veya runtime süreci oluşturulmadı.
  - `mail-domain-registry.json`: Hiçbir yeni mail alan adı üretilmedi.
  - `mailbox-registry.json`: Hiçbir yeni posta kutusu üretilmedi.
- Alias temizlendi ve parent alan adı eski haline döndürüldü.
