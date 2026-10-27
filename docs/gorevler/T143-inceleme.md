# T143 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T143 · Manuel test: WEB-04 — Hosting, forwarding ve hosting olmadan domain davranışı
- **Yapan:** AGENT_1
- **Karar:** RET (REJECT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/web-04.spec.js`
- `docs/manuel-test/WEB-04.md`
- `tasks/review/T143.md`

---

## 2. Doğrulama ve Tespit Edilen Sorunlar

### A. Test Başarısızlığı (`1 failed, 1 did not run`)
`AGENT_N=3 npx playwright test e2e/ozellik/web-04.spec.js --reporter=line` çalıştırıldığında test ilk adımda düşmektedir:
```
  1) [chromium] › e2e/ozellik/web-04.spec.js:75:3 › WEB-04 Hosting, forwarding ve hosting olmadan domain davranışı › mutlu yol: web hosting oluştur, barındırma ayarlarını uygula ve fiziksel HTTP cevabı al 
    Error: expect(received).toContain(expected) // indexOf
    Expected value: 500
    Received array: [200, 301, 302, 403, 404]
      153 |     expect([200, 301, 302, 403, 404]).toContain(httpRes.status);
```
- **Fiziksel Neden:** `new_static_upload` ile yeni bir site açıldığında henüz dosya yüklenmediği için sunucuda `current` dizini ve `index.html` bulunmamaktadır. Nginx kuralındaki `try_files $uri $uri/ /index.html;` kuralı döngüye girerek `/var/log/nginx/<domain>.error.log` dosyasına şu hatayı yazmakta ve HTTP 500 dönmektedir:
  `rewrite or internal redirection cycle while internally redirecting to "/index.html"`
- Eğer bu davranış panelin beklenen bir eksikliği/hatası ise `test.fail` ile işaretlenmeli ve bulgu görevi açılmalıdır; aksi takdirde testin geçerli bir barındırma türüyle (veya index dosyası içeren bir akışla) gerçek HTTP yanıtı alması sağlanmalıdır.
- İlk test düştüğü için 2. test (`hatalı girdi`) hiç çalıştırılamamıştır (`1 did not run`).

### B. `afterAll` Temizliği Çalışmıyor (Dangling Kaynaklar)
- Görevin kabul kriteri: `afterAll oluşturulan kaynakları siliyor.`
- Test fail olduğunda veya tamamlandığında `afterAll` içindeki `/websites/:id/settings` silme akışı siteleri silememiştir.
- Sunucu diskinde hem AGENT_1'in (`tweb04-a1-mvqdpabq.webrich.news`) hem de test koşularının Nginx conf dosyaları ve registry kayıtları temizlenmeden asılı kalmıştır.
- `afterAll` silme mantığı güçlendirilmeli (silme modalındaki confirmation input'u ve asenkron removal job tamamlama akışı doğru şekilde beklenmeli) ve oluşturulan domain temizlenmelidir.

### C. Rapor ve Gerçeklik Tutarsızlığı
- `tasks/review/T143.md` raporunda `2 passed (25.5s), Nginx sunucusundan fiziksel HTTP 301/nginx cevabı alındı` ifadesi yer almakta, ancak test gerçekte 500 alıp düşmektedir.

---

## 3. Karar ve Yapılması Gerekenler
Görev reddedilmiştir. Yapılması gerekenler:
1. `e2e/ozellik/web-04.spec.js` testinin gerçek panele karşı sorunsuz ve beklenmeyen düşüş olmadan tamamlanması (`1 mutlu yol`, `1 hatalı girdi`). 500 davranışı panel hatası ise `test.fail` ile işaretlenip bulgu görevi açılmalı, test mantığı hatası ise düzeltilmelidir.
2. `afterAll` bloğunun oluşturulan siteyi ve sunucu Nginx/registry kaynaklarını kesin olarak temizlediği teyit edilmelidir.
3. Raporlar (`docs/manuel-test/WEB-04.md` ve `tasks/review/T143.md`) gerçek test koşusu çıktılarıyla güncellenmelidir.
