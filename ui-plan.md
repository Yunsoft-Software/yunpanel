# YunPanel — Plesk UX Geçişi

**Güncel karar: 2026-09-23. Dal: `development`. Plesk görev düzeni korunur; reseller ilk sürümü sadeleştirilir.**

Önceki aaPanel/Plesk/CyberPanel birleşimi ve özel altı-gruplu workspace yaklaşımı iptal edilmiştir. Mevcut Ember renkleri, fontlar, radius/element biçimleri ve ortak bileşenler korunur. Neyin nerede olduğu ve nasıl yönetildiği Plesk'e taşınır; marka/CSS kopyalanmaz. Global Dosyalar ve domain File Manager girişleri kaldırılmaz.

## Son karar — daha az reseller ekranı ve katmanı

Owner için mevcut sunucu/site araçlarına Bayiler ve Müşteriler; bayi için **Müşterilerim / Sitelerim / Hesabım** yeterlidir. Müşteri mevcut kendi-site araçlarını kullanır. Yeni dashboard veya tema, ayrı paket editörü, add-on, zorunlu abonelik seçimi, overselling ve login-as bu sürümde yapılmaz. Aynı müşteri/site listesi, basit form ve mevcut araçlar yeniden kullanılır.

Sahiplik: Owner → isteğe bağlı tek Reseller → Customer → mevcut Website. Site oluştururken önce paket/abonelik açtırılmaz. Mevcut site_manager otomatik reseller olmaz; ilişkiler ve backend yetkisi RS-02'de bağlanmadan yeni rol görünür veya kullanılabilir yapılmaz. Müşteri/site toplam adet sınırı yeterlidir; gerçek disk/mail/DB/site limitleri ayrıca korunur.

Önceki tam reseller/paket/abonelik şartı son kullanıcı kararıyla değiştirilmiştir. Ayrıntı [RS sözleşmesi](docs/ux/plesk-full-scope.md) ve [faz ayrımlı envanter](docs/plesk-feature-parity.md). Reseller dışındaki site/OS/premium yol haritası iptal değildir. Service Provider/Power User ayrımı uzun vadeli UX referansıdır; sade reseller için iki yeni yönetici paneli gerekmez.

## Okuma ve uygulama sırası

1. [Aktif plan](plan.md): kaynak alt işleri ve açık UX/BUG/PROD/PAR işleri.
2. [Güncel özellik kapsamı](docs/plesk-feature-parity.md) ve [RS-00–05](docs/ux/plesk-full-scope.md).
3. [Site UX sözleşmesi](docs/ux/plesk-ux-spec.md), [resmî ekran atlası](docs/ux/plesk-reference-atlas.md) ve [rota matrisi](docs/ux/plesk-route-matrix.md). Eski reseller sınırları yerine son karar geçerlidir.
4. [Tarayıcı kabulü](docs/ux/plesk-browser-acceptance.md), [development TODO](docs/ux/development-todo.md) ve kök `todo.md`.

## Değişmeyen kullanım sözleşmesi

Global Dosyalar ve domain File Manager aynı yetkili siteye gider. Birden fazla site varsa seçim yapılır; açık seçilmiş kimlik bulunamadığında başka siteye düşülmez. Loading, eksik ilişki, yetki kaybı veya desteklenmeyen runtime farklı durumlardır. Ctrl+K veya terminal, görünür Files girişinin yerine geçmez.

Domain görevlerinde Dashboard / Hosting & DNS / Mail grupları ve doğrudan araç girişleri korunur. Aynı sitedeki dosya/mail/SSL işi gereksiz müşteri/paket katmanlarına taşınmaz. Siteye bağlanmış müşteri/bayi bilgisi görünür olabilir; abonelik nesnesi zorunlu değildir.

Mevcut API/kimlik/auth/CSRF/gateway/Unix izolasyonu ve kalıcı iş/onay/rollback korunur. SFTP FTP diye, Nginx Apache diye, Ubuntu Windows eşdeğeri diye sunulmaz. Sahte çalışan buton veya salt frontend yetkisi üretilmez.

## Kaynak ilerlemesi

- [x] Global `/files`, görünür Owner/site-manager menüsü ve mevcut FilesPanel rotasına güvenli giriş: `256d991f`; 31 kaynak testi. [Rapor](docs/history/development-files-entry-2026-09-23.md).
- [x] Site Files sekmesinde görünür ve doğrulanmış erişim: `72a16712`; 22 kaynak testi. [Rapor](docs/history/site-files-visible-access-2026-09-23.md).
- [x] Sade reseller kapsamı ve kaynak sahiplik/adet politikası: `5ac33c10`, `6efc5038`, `cd89f8d8`, `87a23c2a`; 107 Node22 testi. Bu UI veya gerçek auth entegrasyonu değildir.
- [ ] Hedef Node24/npm11 tam React/Vite build; gerçek tarayıcı/host kabulü; dosya yolu/taslak korunması ve bütün dosya yönetim davranışları.
- [ ] RS-02–05: canlı sahiplik bağlantısı, hesap API'si, sade UI ve tenant izolasyonu kabulü.

Sonraki dilimler: RS-02 güvenli auth/state entegrasyonu ve mevcut UX-PL işleri → basit hesap API'si → mevcut site/liste/form bileşenlerini bağlama → gerçek regresyon. Ertelenmiş paket/abonelik/markalama işleri ilk sürüme sessizce geri eklenmez.

Önceki belgenin eksiksiz kopyası: [2026-09-21 UI planı](docs/history/ui-plan-before-plesk-ux-80f3d1c4.md). Arşiv güncel UX talimatı değildir.
