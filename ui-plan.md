# YunPanel — Plesk UX Geçişi

**Güncel karar: 2026-09-23. Dal: `development`. Durum: ilk Files giriş dilimi kodlandı; tam UX ve canlı kabul açık.**

Önceki aaPanel/Plesk/CyberPanel birleşimi ve özel altı-gruplu workspace yaklaşımı iptal edilmiştir. Mevcut Ember renkleri, fontlar, radius/element biçimleri ve ortak bileşenler korunur. Neyin nerede olduğu ve nasıl yönetildiği Plesk'e taşınır; marka/CSS kopyalanmaz. İlk iş Dosyalar erişimi, ardından Plesk görev hiyerarşisidir.

## Kapsam genişlemesi — eski sınırlamaları geçersiz kılar

Kullanıcı artık Plesk'in bütün kullanıcı/reseller/paket/abonelik davranışlarını istiyor. **Service Provider yönetici, Power User, Reseller ve Customer panellerinin tamamı hedefte.** Eski UX sözleşmesi/atlas/matrisin yalnız Power User ve site-manager ile sınırlı veya reseller/Windows/toolkit kapsam dışı ifadeleri bu konuda geçersizdir. Önceki kaynak/görsel kanıtları korunur; kapsam [tam özellik envanteri](docs/plesk-feature-parity.md) ve [yeni rol/ekran sözleşmesi](docs/ux/plesk-full-scope.md) ile genişletilir. Henüz uygulanmamış özellik sahte çalışan düğme olarak sunulmaz.

## Okuma ve uygulama sırası

1. [Aktif plan](plan.md): tamamlanan kaynak alt işleri, açık UX/BUG/PROD/PAR işleri.
2. [Tam Plesk özellik envanteri](docs/plesk-feature-parity.md): çekirdek, OS, eklenti ve ticari servis farkları.
3. [Genişletilmiş rol/ekran sözleşmesi](docs/ux/plesk-full-scope.md), ardından [site UX sözleşmesi](docs/ux/plesk-ux-spec.md).
4. [Resmî ekran atlası](docs/ux/plesk-reference-atlas.md): ekranlar ve sürüm/inceleme sınırları; Service Provider görseli artık ayrı yönetici bağlamı için hedef referanstır.
5. [Rota matrisi](docs/ux/plesk-route-matrix.md): mevcut→hedef yerler; yeni `/files` girişi kaynakta uygulandı, tam kabul açık.
6. [Tarayıcı kabulü](docs/ux/plesk-browser-acceptance.md), [development ek TODO](docs/ux/development-todo.md) ve kök `todo.md`.

## Değişmeyen kullanım sözleşmesi

Global Dosyalar ve domain File Manager aynı yetkili siteye gider. Birden fazla site varsa seçim yapılır; açık seçilmiş kimlik bulunamadığında başka siteye düşülmez. Loading, eksik ilişki, yetki kaybı veya desteklenmeyen runtime farklı durumlardır. Ctrl+K veya terminal, görünür Files girişinin yerine geçmez.

Domain görevlerinde Dashboard / Hosting & DNS / Mail grupları ve doğrudan araç girişleri korunur. Hosting/provider nesneleri ayrı yönetici/reseller bağlamında yönetilir; aynı sitedeki dosya/mail/SSL işi gereksiz müşteri/paket katmanlarına taşınmaz. Site çalışma ekranında abonelik/sahip bağlamı görünür ve yetkilidir.

Mevcut API/kimlik/auth/CSRF/gateway/Unix izolasyonu ve kalıcı iş/onay/rollback korunur. SFTP FTP diye, Nginx Apache diye, Ubuntu Windows eşdeğeri diye sunulmaz. Windows ve premium işlevler kapsamdan çıkarılmadan ayrı geliştirme/kabul hattında tutulur.

## İlk kaynak ilerlemesi

- [x] Global `/files`, görünür Owner/site-manager menüsü ve mevcut FilesPanel rotasına güvenli giriş: `256d991f`.
- [x] 31 bağımlılıksız model/kaynak-bağlantı testi; Node22 ortamında 31 geçti.
- [ ] Hedef Node24/npm11, tam React/Vite build, gerçek tarayıcı ve host dosya işlemleri.
- [ ] Koşullu site tabı, dosya yolu/taslak korunması ve bütün Plesk dosya yönetim davranışları.

Ayrıntı: [kaynak raporu](docs/history/development-files-entry-2026-09-23.md). Bu işaretler dosya yöneticisinin bütününün veya yeni UX'in production kabulü değildir.

Sonraki dilimler: ana kabuk/görünüm bağlamı → domain kartı → Files çalışma düzeni → mail/DB/SSL/DNS → runtime/Git/log/cron/backup → provider/reseller/customer/paket/abonelik → bütün görevlerin regresyonu. Kaynak sahipliği/abonelik modeli, provider ekranları hayata geçmeden backend'de tasarlanır; salt UI rol etiketiyle reseller oluşturulmaz.

Önceki belgenin eksiksiz kopyası: [2026-09-21 UI planı](docs/history/ui-plan-before-plesk-ux-80f3d1c4.md). Arşiv yeni UX için talimat kaynağı değildir.
