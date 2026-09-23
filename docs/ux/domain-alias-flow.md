# UX-PL-04c / 06d — Site içinden ek alan adı yönetimi

2026-09-23; başlangıç `development@b83ac3e7`. Güncel kullanıcı kararı korunur: Plesk görev yerleşimi, günlük araçlar önce, mevcut Ember görsel dili ve mevcut motorlar. Bu dilim Barındırma ve DNS → Alan adları içinde web alias düzenlemesidir. Bağımsız Plesk alias DNS/mail senkronizasyonu veya yeni site oluşturma motoru değildir.

## Kaynakta doğrulanan sözleşme

`domain-http.js` mevcut `POST /domains/:id/update-preview` ve `PATCH /domains/:id` yollarını sunar. PATCH yalnız changes/previewDigest/confirmation alır; `changes.aliases` mevcut kayıt motorunca normalize edilir. `domain-registry-base.js` alias değişiminde sertifika ilişkisini ayırabilir, kayıt revizyonunu artırır ve yeni yönlendirmeyi uygulamaz. Bu etki gizlenmez. İki farklı API cevabı vardır: preview doğrudan plan; PATCH sonucu `{domain, impact, previewDigest}`. Site/Domain/Application kimlikleri karıştırılmaz.

## Kaynak işleri

- [ ] Site içindeki mevcut Alan adları ekranında ek alan adı listesi, ekleme/çıkarma, taslak iptali ve açık değişiklik önizlemesi. En fazla 20 web alias; asıl domain ayrı ve sabit. URL/port/yol veya wildcard normal alias diye kabul edilmez.
- [ ] Önizleme gerçek API'den; eski revizyon/yanlış hedef ve onay ile snapshot uyuşmazlığı reddedilir. Eklenen/çıkarılan adlar ve SSL bağlantısının ayrılması açıkça görünür. DNS kaydı ve posta alan adı otomatik oluşturulmaz.
- [ ] Kaydetme sonucu yeni kayıt ayrıca okunarak doğrulanır. Kaydedildi ve yayına uygulandı ayrılır; belirsiz mutation otomatik tekrarlanmaz. Taslak hatada korunur, farklı site/kullanıcı/oturuma taşınmaz.
- [ ] Mevcut stage/activate job'larını kullanıcı için tek Yayına uygula akışında birleştir; her adımın gerçek sonucunu ve güncel kayıt revizyonunu kontrol et. Yarım başarı/hata ve son iş bağlantısı görünür; istemci akışı yeni kalıcı backend workflow'u diye sunulmaz.
- [ ] Çalıştırılabilen davranış/HTTP-sözleşme ve kaynak kontrolleri; gerçek React/browser/host kabulü ayrı tutulur.

## Gerçek ortam TODO

Node24/npm11 tam check, gerçek React/Vite, Owner ve Site A/Site B, alias ekle/çıkar/iptal, conflict/stale/aktif iş, SSL ayrılma onayı, DNS ve HTTPS gerçek erişimi; sayfadan ayrılma/logout, tekrar tıklama, kayıp PATCH/job cevabı, refresh ve yarım uygulama. Frontend ara kontrolleri tüm süreçler arası atomik kilit veya backend reauthorization kabulü değildir. Eksik backend işlem bağlantıları mevcut RS/PROD işlerinde açık kalır.

Kaynak işleri bitince bu belgedeki alt kutular güncellenir. Üst UX-PL-04/06 ve production kabulü otomatik kapanmaz. `.44` sunucusu, main, GitHub Actions ve canlı deploy yok; development'a küçük `[skip ci]` commitleri.
