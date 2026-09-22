# YunPanel — Konsol UI uygulaması

Güncel kaynak ve çalıştırılmış test raporu: [Konsol düzeltmeleri ve bileşen doğrulaması](history/console-ui-component-validation-2026-09-22.md).

Önceki `ea78293` serisi ortak tema, dashboard, site listesi ve site çalışma alanında ilk düzenlemeleri içeriyordu; bütün panelin uygulama ve canlı kabulünün tamamlandığı anlamına gelmiyordu. Sonrasında `2ca10bb` veritabanı düzenini geri aldı. Güncel seri bu regresyonu giderir; tema yükleme sırasını düzeltir, ölçüme bağlı performans grafiğini ve bölüm bazlı mail yönetimini ekler.

## Güncel dosyalar

- `apps/web/src/main.jsx`: eski stiller ve auth/app importlarından sonra konsol teması.
- `apps/web/src/workspace/ui/console-theme.css`: ortak konsol yüzeyleri, bileşenler ve mobil düzen.
- `DatabasesPage.jsx`: görünür phpMyAdmin, eksik erişim yönlendirmesi, filtre, sayfalama, oluşturma penceresi ve kapalı teknik envanter.
- `DashboardPage.jsx`, `ui/UsageHistory.jsx`, `ui/usage-history.js`: anlık durum, gerçek oturum ölçümleri ve erişilebilir sayısal veri.
- `MailDomainsPage.jsx`, `ui/mail-console.css`: okunabilir mail listesi ve ayrı yönetim bölümleri. Alt araçlar yeniden yazılmaz.

Yerel tarayıcı kontrolleri örnek API yanıtları ve React 18.2.0 harness'iyle çalıştı; repo production bağımlılıkları değiştirilmedi. Son rapordaki **54 bileşen kontrolü ve 15 kaynak/model testi**, tam monorepo build veya canlı test kabulü olarak okunmamalıdır. Sunucu dağıtımı yapılmadı.

## Kalan kapsam

`plan.md` içindeki ürün işleri ve YP-15/YP-16 bütünsel kabul hedefleri kapatılmadı. Site listesi ve site çalışma alanının önceki değişiklikleri korunur; Docker, yeni site formu, DNS/SSL, dosya/terminal ve AI uzman ekranlarının tamamı ayrı ayrı yeniden tasarlanmış sayılmaz. Gerçek Node 24/React 19 build, auth/rol ve phpMyAdmin/SMTP kabulleri `todo.md` altında açık kalır.
