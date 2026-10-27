# T200 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T200 · Manuel test: SYS-06 — Cron/scheduled tasks; kullanıcı, zamanlama ve çıktı bildirimi
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/sys-06.spec.js` (Playwright E2E testi)
- `docs/manuel-test/SYS-06.md` (Manuel test raporu)
- `tasks/review/T200.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock/Sahte Veri Kontrolü
- `e2e/ozellik/sys-06.spec.js` dosyası incelendi; kesinlikle hiçbir `page.route`, mock, stub veya sahte veri içermemektedir.
- Doğrudan canlı `.28` test sunucusuna karşı çalışmakta ve gerçek crontab dosyalarını SSH ile fiziksel olarak doğrulamaktadır.

### B. Senaryo Kapsamı
1. **Mutlu Yol:**
   - Panel üzerinden yeni statik web sitesi oluşturuldu (`tsys06-...`).
   - Sitenin "Zamanlanmış Görevler" sekmesi (`/websites/:id/cron`) üzerinden yeni bir periyodik görev (`*/10 * * * *`, `echo ... > /tmp/...`) eklendi.
   - İki adımlı modalda "Değişikliği incele" ve "Kaydet ve sunucuya uygula" akışı doğrulandı; `cron.apply` işi başarıyla tamamlandı.
   - Sunucuda `/etc/cron.d/yunpanel-<taskId>` dosyası SSH ile fiziksel olarak okundu (`SHELL`, `PATH`, `MAILTO`, zamanlama ve komut içeriği doğrulandı).
   - API seviyesinde `cronServiceActive: true`, `hostFileExists: true`, `hostFileExact: true` doğrulandı.
   - Arayüz üzerinden görev silindi, sunucuda `/etc/cron.d/yunpanel-<taskId>` dosyasının fiziksel olarak kaldırıldığı teyit edildi.
2. **Hatalı Girdi:**
   - Arayüzde 5 alandan az cron ifadesi girildiğinde form doğrulama hatası alındığı teyit edildi.
   - API seviyesinde geçersiz sınır değerleri (`99 99 99 99 99`) için `cron_schedule_invalid` ve eksik komut için `cron_create_input_invalid` ile 400 rejection döndüğü doğrulandı.
3. **Plesk Eşdeğerliği (`test.fail`):**
   - Plesk'teki zamanlanmış görev çıktısı için e-posta bildirimi (`MAILTO` tercihi) ve kullanıcı seçimi alanlarının arayüzde bulunmadığı `test.fail` ile belgelendi.

### C. Temizlik (`afterAll`)
- `test.afterAll` bloğunda sunucuda kalan olası cron dosyası (`rm -f /etc/cron.d/yunpanel-${createdTaskId}`) ve oluşturulan test web sitesi (`removeWebsiteById`) eksiksiz temizlenmektedir.
- SSH ile `/etc/cron.d/` ve `/var/www/` dizinleri kontrol edilmiş ve hiçbir artık dosya kalmadığı fiziksel olarak doğrulanmıştır.

### D. Rapor ve Kurallar Uyumu
- `docs/manuel-test/SYS-06.md`: 28 satır (≤40 satır kuralına uygun), şablona tam uyumlu.
- `AGENT_N=1 npx playwright test e2e/ozellik/sys-06.spec.js`: 3/3 geçti (1 mutlu yol, 1 hatalı girdi, 1 test.fail bilinen eksiklik).
- `python3 orkestra/tasks.py lint`: lint OK.

---

## 3. Karar Özeti
T200 görevinin tüm gereksinimleri ve kabul kriterleri eksiksiz karşılanmıştır. Görev ONAYLANMIŞTIR (`accept`).
