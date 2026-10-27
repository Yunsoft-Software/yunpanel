# T144 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T144 · Manuel test: WEB-08 — Önizleme, geçici domain ve site açma bağlantıları
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/web-08.spec.js`
- `docs/manuel-test/WEB-08.md`
- `tasks/review/T144.md` (ve `tasks/done/T144.md`)

---

## 2. Doğrulama ve Bulgular

### A. Playwright Test Koşusu
`AGENT_N=2 npx playwright test e2e/ozellik/web-08.spec.js --reporter=line` çalıştırıldı:
- 4 test çalıştı ve başarıyla geçti (28.1s).
- Mutlu yol senaryosunda: Site oluşturuldu, liste kartında (`WebsiteTaskCard`) ve site detayında (`SiteDetailPage`) 'Siteyi aç' dış bağlantısının `target="_blank"`, `rel="noopener noreferrer"` ve `http(s)://${domain}/` adresleri doğrulandı. Canlı Nginx vhost'undan HTTP 200 yanıtı ve gövdesi alındı.
- Askıya alınmış site senaryosunda: Site askıya alındığında kart üzerinde 'Yayını Etkinleştir' butonu belirdi ve Nginx vhost'unun pasife alındığı canlı HTTP yanıtı ile doğrulandı.
- Hatalı girdi ve güvenlik senaryosunda: `externalSiteUrl` fonksiyonunun geçersiz / zararlı girdilerde (XSS, javascript: vb.) güvenli şekilde `null` döndüğü kanıtlandı.
- Bilinen eksiklik senaryosu: Plesk eşdeğeri DNS öncesi Site Önizleme (Site Preview / Geçici Domain URL) mekanizmasının panelde henüz bulunmadığı `test.fail` ile doğru şekilde işaretlenerek doğrulandı.

### B. Sıfır Mock ve Temizlik (`afterAll`)
- Kodda herhangi bir `page.route`, mock, stub veya sahte veri bulunmamaktadır.
- Testler doğrudan canlı backend API, gerçek veritabanı, gerçek UI ve canlı Nginx sunucusuna karşı çalışmaktadır.
- `afterAll` hook'unda `removeWebsiteById` ile oluşturulan test sitesi temizlenmektedir.

### C. Rapor Formatı ve Orkestra Kontrolleri
- `docs/manuel-test/WEB-08.md`: 25 satır (≤40 satır kuralına tam uyumlu), şablona uygun, fiziksel kanıtları ve panelde olmayan özellikleri eksiksiz içeriyor.
- `npm run lint` & `python3 orkestra/tasks.py lint`: Başarılı (`lint OK`, `Repository policy validation passed`).

---

## 3. Karar Özeti
AGENT_3 tarafından teslim edilen iş ve testler eksiksiz incelenmiş, canlı ortamda koşturularak başarıyla doğrulanmıştır. Görev ONAYLANMIŞTIR (`accept`).
