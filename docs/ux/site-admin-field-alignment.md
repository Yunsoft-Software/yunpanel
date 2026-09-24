# BUG-20260923-07 — Site yöneticisi e-posta/parola hizası

2026-09-24; `development`. Mevcut `NewWebsitePage.jsx` yönetici alanları için dar yerleşim düzeltmesidir; görsel dil, bütün formların CSS'i, site oluşturma motoru ve kullanıcı doğrulaması değiştirilmedi.

- [x] **BUG-07a kaynak — `3b7bf8b0`:** yalnız `ws-site-admin-fields` grubu üstten hizalanır (`alignItems: start`). Mevcut responsive iki kolon, ortak input stili, label sırası ve boşluklar korunur. Açıklama satırlarının farklı yüksekliği komşu alanı gereksiz yere esnetmemelidir; sabit piksel yüksekliği veya taşan metni gizleme eklenmedi.
- [x] **BUG-07b açıklama/erişilebilirlik:** e-posta ve parola alanlarının ikisinde de kontrolün altında ayrı `ws-field-hint` vardır. `aria-describedby` her inputu kendi açıklamasına bağlar. E-posta inputu email, parola inputu password/required/minLength12/new-password kalır; mevcut value/onChange bağlantıları, oturum kapsamı ve sonuç sonrası parola temizleme değişmez.
- [x] **BUG-07c seçili kontrol — `f5f374c4`:** `new-website-admin-layout.test.js` dört kaynak testi geçti. `NewWebsitePage.jsx` sözdizimi/dönüşümü ve üretilen JavaScript kontrolü geçti. Önceki dosyanın tamamı blob `24b65dd7490549c8e2f6e85ee15698fe24ec0595` ile eşleştirildi; yalnız yönetici alan bloğu değişti. Son kaynak blob `1e2193f3306a2e7e0d2e773af3792ef9338e7eed` test edilen yerel dosyayla aynıdır.
- [ ] **BUG-07 üst görsel kabulü:** gerçek React/Vite ve tüm Ember CSS katmanlarıyla mobil/masaüstü, klavye, validation mesajı ve uzun açıklamalar doğrulanmadı. Kaynak testi gerçek hizalama ölçümü değildir; üst BUG-07 kapanmaz.

Node22.16.0/npm10.9.2 son ortak koşusu mail 105 + bu dört kaynak testi = **109 geçti / 0 başarısız / 0 atlandı**. Bu sayı önceki oturum raporlarının toplamı değildir. Komut ve ortam sınırları `mailbox-single-removal.md` içindedir.

## T-DEV-ADMIN-LAYOUT — Codex görsel kabulü

- [ ] Node24/npm11 tam lint/test/build ve mevcut form/create/host-account regresyonları; gerçek fontlarla 320/390/834/1440 px ve yüzde200 zoom.
- [ ] E-posta/parola label ve input üst/alt hizasını, iki kolon/tek kolon geçişini, native email/parola hatalarını, uzun açıklama ve otomatik doldurma durumlarını ölç. Yardım metni input yüksekliğini değiştirmemeli; kesilmemeli.
- [ ] Tab/Shift+Tab ve ekran okuyucuda her alan yalnız kendi açıklamasını okumalı. Parola maskelemesi ve kaydedilmemiş form/başarı sonrası temizleme korunmalı; gerçek şifreyi görüntü/rapora yazma.

Yeni canlı ekran görüntüsü veya deployment üretilmedi. GitHub Actions yok; `main` ve mevcut tema tokenları değişmedi.
