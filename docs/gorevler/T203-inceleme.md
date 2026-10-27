# T203 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T203 · Manuel test: MON-04 — Web/mail/sistem log görüntüleme, filtre/arama ve rotasyon
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/mon-04.spec.js` (Playwright E2E testi)
- `docs/manuel-test/MON-04.md` (Manuel test raporu)
- `tasks/review/T203.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock/Sahte Veri Kontrolü
- `e2e/ozellik/mon-04.spec.js` dosyası incelendi; hiçbir `page.route`, mock, stub veya sahte veri içermemektedir.
- Doğrudan canlı `.28` test sunucusuna karşı çalışmaktadır. HTTP probe istekleri doğrudan `157.180.11.28` IP'sine gönderilmektedir.

### B. Senaryo Kapsamı
1. **Mutlu Yol:**
   - Panel üzerinden yeni statik web sitesi oluşturuldu.
   - Sitenin "Günlükler / Loglar" sekmesi (`/websites/:id/logs`) üzerinde `nginx-access` ve `nginx-error` kaynakları test edildi.
   - Benzersiz HTTP probe isteği atılarak arama/filtreleme ve logların görüntülenmesi doğrulandı.
   - Ham log indirme ('İndir' bağlantısı) kontrol edildi.
   - Mail alan adı yönetimi (`/mail`) üzerinde servis logları (`Postfix`/`Dovecot`) ve `/audit` altında global denetim loglarının filtrelenmesi başarıyla test edildi.
2. **Hatalı Girdi:**
   - Geçersiz/var olmayan website kimliği ile yapılan isteklerin 404/400 ile güvenli reddedildiği ve parametre sınırlarının korunduğu doğrulandı.
3. **Fiziksel Kanıt (SSH Doğrulaması):**
   - Sunucuda SSH ile `/var/log/nginx/access.log`, `/var/log/mail.log`, `/var/log/syslog` dosyalarının ve `/etc/logrotate.d/nginx` rotasyon yapılandırmasının fiziksel mevcudiyeti doğrulandı.
4. **Plesk Eşdeğerliği:**
   - Plesk'teki site bazlı "Log Rotation" (günlük döndürme sıklığı, dosya boyutu sınırı, gzip sıkıştırma ve saklama sayısı) kullanıcı arayüzü ayarlarının eksikliği `test.fail` ile belgelendi.

### C. Temizlik (`afterAll`)
- `test.afterAll` bloğunda oluşturulan test web sitesi panel arayüzü üzerinden (`removeWebsiteById`) eksiksiz silinmektedir.

### D. Rapor ve Kurallar Uyumu
- `docs/manuel-test/MON-04.md`: 29 satır (≤40 satır kuralına uygun), yöntem şablonuna tam uyumlu.
- `npm run lint`: Repository policy validation passed.
- `python3 orkestra/tasks.py lint`: lint OK.
- `node --test apps/api/test/website-site-logs.test.js`: 5/5 geçti.

---

## 3. Karar Özeti
T203 görevinin tüm gereksinimleri ve kabul kriterleri eksiksiz karşılanmıştır. Görev ONAYLANMIŞTIR (`accept`).
