# YunPanel — Plesk UX Geçişi

**Karar tarihi: 2026-09-23. Durum: uygulanacak sözleşme; uygulama tamamlanmadı.**

Kullanıcı mevcut görsel dili koruyarak neyin nerede bulunduğunun ve nasıl yönetildiğinin Plesk'e geçirilmesini istedi. Önceki aaPanel/Plesk/CyberPanel birleşimi ve özel altı-gruplu workspace yaklaşımı iptal edilmiştir. Önce backend, en son UX ertelemesi de geçersizdir. **İlk kod işi Dosyalar erişimi; ardından Plesk görev hiyerarşisi.**

## Okuma ve uygulama sırası

1. [Aktif plan](plan.md): UX-PL-01–09, sekiz kullanıcı regresyonu, onaylanmış PROD-01–15 ve önceki açık işler.
2. [Plesk UX sözleşmesi](docs/ux/plesk-ux-spec.md): görünüm/rol, ana menü, domain kartı, araçların yeri, sayfa ve işlem akışları.
3. [Resmî ekran atlası](docs/ux/plesk-reference-atlas.md): gerçek Plesk görselleri, kaynak ve sürüm sınırlamaları; neyin referans alındığı.
4. [Rota ve işlev eşleme matrisi](docs/ux/plesk-route-matrix.md): mevcut kaynak, korunacak deep link, yeni giriş, rol ve kabul ölçütü.
5. [Gerçek tarayıcı kabulü](docs/ux/plesk-browser-acceptance.md): bulma, kullanma, geri dönüş, güvenlik ve görsel regresyon kapıları; kök `todo.md` T-VISUAL/T-SITE-WORKSPACE'i tamamlar.

## Sabit kararlar

- Owner için Plesk **Power User** görev düzeni; kısıtlı kullanıcı için izinli site kapsamındaki **Customer Panel** düzeni. Service Provider müşteri/reseller/paket/faturalama menüleri aynı ekrana karıştırılmaz.
- Hedef domain yüzeyi genişleyen domain kartı; `Dashboard`, `Hosting & DNS`, `Mail` görev yerleri resmî belgelerle eşlenir. Eski ikon ızgarası görselleri yalnız kalıcı araç kimlikleri ve bağlam için kullanılır.
- Global **Dosyalar** ve domain içindeki **Dosya Yöneticisi** aynı yetkili dosya yüzeyine açılır. Yükleme/eksik ilişki yüzünden araç sessizce kaybolmaz. Ctrl+K, terminal veya gizli Diğer menüsü temel erişimin yerine geçmez.
- Mevcut Ember renk/font/radius/element biçimleri, tema tercihleri ve ortak bileşenler korunur. Plesk'in markası, CSS'i veya mavi teması taşınmaz; navigasyon ve çalışma düzeni taşınır.
- Mevcut motorlar, API kimlikleri, auth/CSRF, Website izolasyonu, gateway, kalıcı işler, onay ve geri alma korunur. UI yerleşimi değişiyor diye çalışan FilesPanel/terminal/DB/mail kapasitesi kaldırılmaz.
- Desteklenen işlevlerin Plesk'teki yeri uygulanır. Üründe olmayan WordPress Toolkit, Sitejet, reseller veya Windows araçları sahte düğme olarak üretilmez. SFTP, FTP diye; Nginx, Apache diye etiketlenmez. Bu farklar matriste açıktır.

## En küçük ilk teslim

`WorkspaceApp.jsx`, `ui/ux-model.js`, `SiteDetailPage.jsx`, `ui/SiteNavigation.jsx` ve mevcut FilesPanel birlikte incelenir. Global `/files` girişinin eksikliği ve koşullu site araç filtresi çözülür. Yeni route bir klasör motoru değil, mevcut yetkili Website dosya yönetimine bağlanan bağlam çözücüdür. Owner ve site hesabı ile gerçek dosya işlemleri geçmeden sonraki büyük yerleşim temizliğine gidilmez.

Sonraki dilimler: ana kabuk → domain kartı → Files çalışma düzeni → mail/DB/SSL/DNS → runtime/Git/log/cron/backup → Owner araçları → bütün görevlerin regresyonu. Güvenlik ve production kapıları bu sırayla ertelenmiş veya kaldırılmış sayılmaz.

Bu tur araştırma/dokümantasyon turudur. Resmî referans ekranları YunPanel canlı ekranı değildir. Bitmişlik, mock görsel veya bu belgenin yazılmış olmasıyla değil gerçek görev kabulüyle ölçülür.

Önceki belgenin eksiksiz kopyası: [2026-09-21 UI planı](docs/history/ui-plan-before-plesk-ux-80f3d1c4.md). Bu arşiv yeni UX için talimat kaynağı değildir.
