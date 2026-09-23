# Barındırma yönlendirme ayarları — kaynak ve kabul durumu

Tarih: 2026-09-23. Dal: `development`. İlgili üst işler: UX-PL-04 / UX-PL-06. İki yönlendirme tercihinin model, istemci ve site ekranı bağlantısı kaynakta tamamlandı. Gerçek React/Vite, HTTP, tarayıcı ve canlı sunucu kabulü açık; bütün hosting özelliği tamamlandı değildir.

## Önceki turun kontrolü

`plan.md` başındaki UX-PL-04c / 06d bölümü önceki alias kaynak aktarımını (`027b664f`, `e3ac0fc9`), kaydetme/yayına uygulama ayrımını ve seçili kaynak testlerini işaretli tutuyordu. Gerçek Node24/npm11, API/browser/host ve T-DEV-DOMAIN-ALIASES kabulü açık kaldı. Önceki alias testlerinin bu tur yeniden çalıştırıldığı iddia edilmez; eski ZIP patchleri tekrar uygulanmaz.

## Tamamlanan model ve istemci kaynağı

- [x] `apps/web/src/workspace/domain-hosting-model.js` — `cdd25bdd`: yalnız `httpsRedirect` ve `canonicalRedirect` boolean tercihleri için taslak, değişiklik farkı, SSL uyarısı ve önizleme doğrulaması. Ek alan adı, ana alan adı, HTTPS modu, Nginx ayarı, hedef, Website veya sertifika değişikliği bu dilimin kapsamı değildir. HTTPS kapalıyken HTTPS yönlendirmesi ve değişikliksiz/askıda/geçersiz kayıt engellenir.
- [x] `apps/web/src/workspace/domain-hosting-client.js` — `4fa4ac36`: mevcut `/domains/:id`, `/domains/:id/update-preview` ve PATCH sözleşmesiyle dar istemci. Önizleme ve kaydetme öncesinde güncel hedef/revizyon kontrolü, istemciye ait değiştirilemez önizleme, tek kullanımlık kaydetme, oturum/site değişimi ve eşzamanlı aynı-istemci isteği koruması. PATCH sonrası hem dönen Domain hem yeniden okunan kayıt doğrulanır. Belirsiz sonuç başarı sayılmaz; otomatik tekrar yoktur. Bu bir backend yetki veya süreçler arası kilit uygulaması değildir.
- [x] `apps/web/test/domain-hosting.test.js` — `e4575721`: önceki dilimde 49 model/istemci testi geçti. Bu form diliminde aynı 49 test yeniden çalıştırıldı; aşağıdaki 85 toplamının içindedir. Bunlar alias raporundaki ayrı 49 test değildir.

### Doğrulanan model/istemci davranışları

Yalnız değişen tercih PATCH'e girer. Yanlış domain/sunucu/Website, değişen revizyon/alias/sertifika, askı durumu ve beklenmeyen önizleme engellenir. Önizlemenin hash/onay, sonraki revizyon, korunan alanlar ve sertifika etkisi kontrol edilir. Ağ hatası veya sonuç doğrulama hatası aynı planı tekrar göndermeye izin vermez. Kaydetmek stage/activate, DNS, posta veya sertifika işi başlatmaz. Sertifika bağlı değilken HTTPS hazır mesajı verilmez.

## Tamamlanan form kaynağı — HST-UI-01–04

- [x] **HST-UI-01 / ekran:** `DomainHostingPanel.jsx` (`0dee00ab`) ve `SiteDetailPage.jsx` bağlantısı (`353ff13e`). Mevcut Site → Barındırma ve DNS → Barındırma ayarları, `/websites/:domainId/settings` rotasında iki tercihli form bulunur. PanelKit, mevcut form/tema sınıfları, bilgi görünümü ve WebsiteIsolationPanel korunur. Files/SSL/alias motorları ve girişleri kaldırılmadı; yeni tema veya bağımlılık eklenmedi.
- [x] **HST-UI-02 / işlem sınırları:** form site/sunucu/Website/parent, kullanıcı/rol, session generation ve canManage bağlamıyla anahtarlanır. Component ömrü, session transition ve AbortController bağlanır. Aynı istemci örneği korunur; önizleme veya PATCH'ten hemen önce canlı domain/job güncelliği, resourceBusy, askı ve reload gereksinimi tekrar kontrol edilir. Çift gönderim ref kilidiyle engellenir. `91957be5`, settings deep linkinde eksik olan jobs veri talebini ekler; Files, hosting hub ve global settings veri talebi değişmedi. Backend yetki ve ortak kilit sorumluluğu devam eder.
- [x] **HST-UI-03 / taslak ve sonuç:** `domain-hosting-form.js` (`fdb4b0f5`) yalnız kullanıcının değiştirdiği tercihleri açık yeniden yüklemede korur; dokunulmayan alanlar yeni kayıttan alınır. Böylece başka operatörün dokunulmayan tercihleri geri alınmaz. Aynı sürüm yayın durumu yenilemesi taslağı silmez; eski koleksiyon yanıtı doğrulanmış kaydı geri götürmez. Farklı site ilişkisi, eski/tutarsız yeniden yükleme ve güncelliğini yitirmiş review engellenir. Önizleme, açık kaydetme onayı, iptal, mevcut useUnsavedChanges ve belirsiz sonuçta zorunlu yeniden okuma bağlandı. Başarıda yeni baseline ve refreshAll kullanılır; otomatik PATCH tekrarı yoktur.
- [x] **HST-UI-04 / yayın ayrımı:** form kaydetme ile yayına uygulamayı ayrı anlatır. Açık Yayın yönetimine git bağlantısı mevcut Alan adları ekranındaki Yayına uygula akışına götürür; yeni stage/activate workflow'u eklenmedi. SSL kapalı veya sertifika bağlı değilse açıklama gösterilir. İki tercih dışındaki alan adı/HTTPS modu/sertifika/Nginx ayrıntılı düzenlemeleri tamamlandı sayılmaz.

## Bu form diliminin yerel kanıtı

- [x] `apps/web/test/domain-hosting-form.test.js` — `9289a0ba`: **36 yeni test**; 31 form durumu/veri talebi testi ve 5 JSX kaynak bağlantısı kontrolü. Taslak/üç yönlü yeniden yükleme, güncel hedef, eski cevap, oturum bağlantısı, askı/read-only/işlem kilidi, review eşleşmesi ve eski araçların mount noktaları kapsanır. Kaynak bağlantısı kontrolleri React render testi değildir.
- [x] Node **v22.16.0** altında `node --test apps/web/test/domain-hosting.test.js apps/web/test/domain-hosting-form.test.js`: **85 geçti / 0 başarısız / 0 atlandı**. Önceki hosting 49 + yeni 36; tekrar koşular ayrı test olarak eklenmez. Proje geneli hazır olma yüzdesi çıkarılmaz.
- [x] `DomainHostingPanel.jsx` ve `SiteDetailPage.jsx` JSX sözdizimi/dönüşüm kontrolünden geçti. Ortamdaki TypeScript 5.8.3 yalnız harici JSX kontrol aracı olarak kullanıldı; repoya TypeScript kaynağı veya bağımlılığı eklenmedi. Bu kontrol modül çözümleme, lint, Vite build veya React davranışı kabulü değildir.
- [x] Yerelde test edilen beş yeni/değişmiş kaynak/test dosyasının Git blob SHA'ları `development` içeriğiyle eşleşti. Mevcut alias modeli ve hosting model/istemci/test kopyaları da dal SHA'larıyla doğrulandı. Tam git clone GitHub DNS erişimi nedeniyle alınamadığından seçili connector dosyalarıyla çalışıldı; npm ci, tam check, browser ve host çalıştırılmadı.

## T-DEV-HOSTING — Codex / gerçek checkout kabulü

Bu liste kök `todo.md` ve `docs/ux/development-todo.md` içindeki açık kapıları tamamlar; onların yerine geçmez.

- [ ] Node >=24.11.1 ve npm >=11 ile gerçek checkout'ta paket kurulumu ve repodaki tam lint/test/build çalıştırılsın. `domain-hosting.test.js` ve `domain-hosting-form.test.js` dahil olsun. Gerçek React/Vite bağımlılıkları, module resolution ve hook lint denetlensin. Buradaki Node22 ve JSX ayrıştırması hedef araç zinciri kabulü değildir. GitHub Actions kullanılmasın.
- [ ] Gerçek Domain registry + HTTP/`panelRequest` zinciriyle iki yönlendirme değişikliği için preview/save response uyumu doğrulansın. Önizlemeden PATCH'e kadar kayıt/hiyerarşi/certificate/job değişimi ve backend digest kontrolü gerçek entegrasyonda test edilsin. Transport fixture'ı backend çalıştırma kanıtı değildir.
- [ ] Bağlanan formda Owner / Site A / Site B / salt-okunur hesapla yetki iptali, session rotation, doğrudan API, başka site kimliği, çift tıklama, timeout/403/409/500 ve PATCH sonrası başarısız GET denensin. GET sürerken yeni iş, modal açıkken revizyon değişimi ve StrictMode mount/unmount sınansın. Yerel client lock'u backend'in ortak resource lock açığını kapatmış sayılmasın.
- [ ] Yalnız izin verilen YunPanel test hostunda (asla `.44` Plesk sunucusunda değil) kaydetmenin tek başına Nginx'i değiştirmediği; kullanıcı onaylı mevcut stage/activate sonrası gerçek HTTP→HTTPS ve alias→primary davranışı, sertifika kapsamı ve yönlendirme döngüsü kontrol edilsin. Kaynak testi yayındaki davranışın kanıtı değildir.
- [ ] Gerçek React/Vite ve mevcut bütün CSS katmanlarıyla 320/390/834/1440 px, %200 zoom, klavye/focus, error/review modal, refresh/back/forward kabulü. Değişiklik yapmadan çıkış uyarısız; kirli taslakta iptal/kal/git; yeniden yüklemede yalnız değiştirilen tercihin korunması; belirsiz kayıt zaten uygulanmışsa taslağın temizlenmesi; eski koleksiyonun yeni kaydı ezmemesi ve mevcut Files/alias/SSL girişleri doğrulansın. UX-PL-04/06 üst kutuları açık kalır.

Main'e yazılmadı; GitHub Actions veya canlı host işlemi yapılmadı. Önceki model dilimindeki UI bağlantısı engeli bu tur kapandı; canlıya dağıtım ve gerçek kabul kapıları kapanmadı.
