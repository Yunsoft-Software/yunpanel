# YunPanel — Onaylanan koyu konsol uygulaması

Tarih: 22 Eylül 2026. Başlangıç: `main@af18dd015570eacfbd43bcc3e6b23e67a55d4c1f`.

Kullanıcının son onayladığı koyu lacivert/mavi panel görseli bu uygulamanın görsel yönüdür. Bu not çalışan production ekranı veya tüm sayfalar için tamamlanma raporu değildir. Kod güncel `main` üzerine küçük commitlerle yazıldı; branch oluşturulmadı, force-push veya GitHub Actions kullanılmadı.

## Uygulanan kaynak değişiklikleri

- `workspace/ui/console-theme.css`: ortak gece yüzeyleri, tipografi, kenarlık/boşluk sistemi, tek mavi birincil işlem rengi, sade durum rozetleri, modal/form/tablo ve responsive panel kabuğu. `workspace.css` ve `ux-theme.css` sonrasında yüklenir; hazır araçların iframe içi tasarımını değiştirmez.
- `WorkspaceLayout.jsx`: daha dar yan menü, görünüm tercihleri için açılır bölüm, mobilde adlandırılmış ikon eylemleri, arama ve aktif iş erişimi. Mevcut auth, menü focus trap, AI drawer ve job bileşenleri korunur. AI klavye kısayolu Owner/canManage koşuluna ve açık modal kontrolüne bağlanır.
- `Preferences.jsx`: ilk kullanımda Gece teması. Önceden saklanmış açık/sistem/koyu seçimleri zorla değiştirilmez. Storage erişimi kapalıysa oturum içi kullanım sürer.
- `DashboardPage.jsx`: bağımsız Website sayısı, uygulama/iş/SSL özeti; gerçek CPU/RAM/disk halkaları ve yüksek disk uyarısı; site/DB/mail/sunucu hızlı erişimi. Büyük tekrarlı Website kartı ve uzun işlem listesi yerine kompakt özet. Geçmiş metrik API'si varmış gibi 24 saatlik uydurma grafik eklenmez; bilinmeyen ölçüm sıfır veya sağlıklı gösterilmez.
- `DatabasesPage.jsx`: doğrudan phpMyAdmin düğmesi; eksik kullanıcı veya site bağlantısında görünür açıklama/yönlendirme; site adı, kullanıcı ve veritabanı araması; URL tabanlı erişim filtresi ve sayfalama. Oluşturma formu sürekli açık olmak yerine odaklı native modal içindedir. Teknik envanter ayrıntıları açılır bölümdedir. Failed/cancelled işlemde başarı bildirimi verilmez ve form kapatılmaz; stale/refreshing envanterle mutation/handoff yapılmaz.
- `ui/SiteNavigation.jsx` ve `SiteDetailPage.jsx`: mevcut Domain-ID tabanlı URL'leri/application query'sini koruyan altı grup; runtime'a göre filtrelenmiş araçlar; sık araçlara doğrudan erişim. Provisioning recovery genel bakışta kalır; izolasyon audit/migration/rollback Site Ayarları altında aynı bileşenle sürer. Kimlik/transport/back-end mimarisi değiştirilmez.
- `WebsitesPage.jsx` ve `ui/console-lists.css`: açık parent/subdomain ağacı ve grup bazlı sayfalama korunur; arama/durum dışındaki filtreler isteğe bağlıdır. Aynı yerel sunucunun her satırda tekrarı kaldırılır. Runtime etiketi mevcut Website–Application bağıyla çözümlenir. Mobilde okunabilir kayıtlar, SSL/Yönet eylemleri ve gerçek tablo rolleri kullanılır.
- `ui/console-model.js` ve testi: bilinmeyen ölçüm, açık ownership ile phpMyAdmin erişimi, Domain/Website kimlik ayrımı, filtre ve sayfalama projeksiyonları. Bunlar yetkilendirme sınırı değildir; API ve gateway denetimleri korunur.

## Test ve doğrulama kanıtı

Bu ortamın komut satırı GitHub DNS'ine erişemedi; tam checkout ve npm bağımlılık kurulumu yapılamadı. Kullanılabilir Node sürümü 22.16.0; projenin Node >=24.11.1 / npm >=11 gereksinimi düşürülmedi. Repo okuma/yazma işlemleri bağlı GitHub aracıyla yapıldı.

`console-model.test.js` içindeki sekiz test, aynı yardımcı kodun yerel kopyası üzerinde Node test runner ile 8/8 geçti: 0/91%/bilinmeyen ölçüm, readable/stale ayrımı, açık kimlik bağı, eksik kullanıcı, bağlı olmayan DB, okunamayan domain envanteri, filtreleme ve pagination. Bu sonuç JSX render, tüm frontend, monorepo veya production acceptance sonucu değildir.

Yeni koyu tema normal metin çiftleri için hesaplanan kontrastlar: ana metin/yüzey 15.39:1, ikincil metin/yüzey 8.05:1, bağlantı/yüzey 8.49:1, beyaz/mavi birincil düğme 4.61:1. Başarı/uyarı/hata rozetlerinin metin–zemin çiftleri 7.88:1 veya üzerindedir. Bunlar seçili renk çiftlerinin sayısal kontrolüdür; bütün arayüzün erişilebilirlik sertifikası değildir.

## Tamamlandı sayılmayan işler

`plan.md` içindeki YP-15/YP-16 ve `ui-plan.md` bütünsel kabul hedefleri kapatılmadı. Bu seri ortak görünüm ile dashboard, Website listesi, site workspace ve global veritabanı ekranının ilk uygulamasıdır. Mail/Docker/DNS/SSL dosya/terminal/AI gibi sayfalar ortak temayı alır; her uzman ekranın bilgi mimarisi bu seride ayrı ayrı yeniden yazılmadı. Yeni site formu çok adımlı wizard'a çevrilmedi. Backend'i hazır olsa bile ayrı Yedekler ekranı bu seriyle çalışıyormuş gibi gösterilmez.

Tam Node 24 test/build, canlı phpMyAdmin signon, Owner/site-admin/read-only roller, uzun domain/veri, 320/390/834/1440 px Chromium/Firefox, klavye ve gerçek ekran görüntüsü kabulü `todo.md > T-VISUAL > Onaylanan koyu konsol` altında açık kalır. Bu turda sunucuya bağlanılmadı, deploy yapılmadı; `.44` Plesk sunucusuna dokunulmadı.
