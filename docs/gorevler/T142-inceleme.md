# T142 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T142 · Manuel test: PLN-08 — Disk, trafik, domain, mailbox, DB ve kullanıcı adet limitleri
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/pln-08.spec.js`
- `docs/manuel-test/PLN-08.md`
- `tasks/review/T142.md` (ve `tasks/done/T142.md`)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Koşusu
`AGENT_N=4 npx playwright test e2e/ozellik/pln-08.spec.js --reporter=line` çalıştırıldı:
- 3 test çalıştı ve başarıyla geçti (19.9s).
  - 01. Mutlu yol: Müşteriye disk, trafik, domain/website ve veritabanı limitlerinin atanması ve arayüzde gösterimi: GEÇTİ
  - 02. Sınır ve aşım senaryosu: Tanımlanan adet limitine ulaşıldığında yeni kaynak oluşturma engeli (UI uyarısı ve 409 customer_quota_exceeded): GEÇTİ
  - 03. Bilinen Bulgu: Reseller rolü servers.read iznine sahip olmadığı için AllocateSiteDialog serverId yükleyemiyor ve form kilitli kalıyor: GEÇTİ (`test.fail` beklenen hata)
- Gerçek API ve gerçek panel UI doğrulandı; mock veya `page.route` kullanılmadı.

### B. Temizlik (`afterAll`) ve İzolasyon
- `afterAll` bloğunda oluşturulan site (`/api/websites/{id}`), müşteri (`/api/panel/users/hosting/accounts/{id}/login`), reseller hosting profili ve kullanıcısı sırasıyla güvenle temizlenmektedir.
- Tarayıcı bağlamları `finally` içinde kapatılmaktadır.

### C. Rapor Formatı ve Orkestra Kontrolleri
- `docs/manuel-test/PLN-08.md`: 28 satır (≤40 satır kuralına uygun), standart tablolu YONTEM şablonunda.
- `python3 orkestra/tasks.py lint`: `lint OK`
- `python3 orkestra/tasks.py accept T142 AGENT_4`: Başarıyla tamamlandı.

---

## 3. Karar Özeti
AGENT_1 tarafından hazırlanan testler, rapor ve belgeler incelenmiş, tüm kabul kriterlerinin sağlandığı doğrulanmıştır. Görev ONAYLANMIŞTIR (`accept`).
