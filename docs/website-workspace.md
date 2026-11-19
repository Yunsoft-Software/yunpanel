# Website workspace sözleşmesi

Website/Domain/Application farklı kaynak; explicit Website bağlamı bütün araçlarda korunur. Global giriş ve site girişi aynı reusable workspace'i kullanır; route reload/back/filter/draft/scroll kabulü gerekir. [UI planı](../ui-plan.md) tek tasarım kaynağıdır.

Owner-only root terminal/site create/migration sınırları backend'de; reseller/customer yalnız atanmış kaynak. Yönetim işlemleri common audit metadata taşır: actor/action/resource/time/outcome; secret veya raw terminal çıktısı tutulmaz. Audit görünürlüğü role scope'a uyar.

Kaynak/runtime, Domains/DNS/SSL, Files, DB, mail, backup, log/terminal/cron mevcut API/adapterlarla birleşir. PHP success, boş-site DB binding, SSL unchanged ve altı global route bu araştırmada açık bulundu; sekme veya catalogue varlığı bitmiş özellik değildir. [Somut analiz](audit-2026-10-09.md), [plan](../plan.md).

## PHP sitesi ve veritabanı kopyalama

1. Aynı sunucuda etkin iki PHP sitesi hazırlayın. Kaynağın yayın dizininde uygulamanın tek giriş dosyası `index.php` bulunmalı. Kaynağa bağlı MariaDB veritabanında desteklenen en az bir InnoDB tablosu bulunmalı.
2. Kaynak sitenin ev dizininde `$HOME/.yunpanel/database.json` oluşturun. `.yunpanel` dizini için `0700`, dosya için `0600` izinlerini kullanın. İkisi de sitenin Unix kullanıcısına ait olmalı. JSON tam olarak `version`, `bindingId`, `credentialId`, `databaseName`, `host`, `username` ve `password` alanlarını içermeli. `version` değeri `1`, `host` değeri `localhost` olmalı. Kalan alanlara kaynak siteye bağlı veritabanının bilgilerini yazın. Uygulamanın `index.php` dosyasını bu özel dosyayı okuyarak bağlanacak şekilde hazırlayın. Parolayı site ev dizinindeki bu dosyada saklayın.
3. Hedef olarak yeni açılmış, başlangıç `index.php` dosyası duran bir PHP sitesi kullanın. Hedefe kendine ait boş bir MariaDB veritabanı ve veritabanı kullanıcısı bağlayın. Hedefin bağlantı dosyasını panel oluşturur.
4. Kaynak sitede **Siteyi kopyala** seçeneğini açın. Hedefi seçip **Önizle** ile dosya ve tablo sayısını kontrol edin. Kopyalama başlatıldıktan sonra **Kopyalama durumu** üzerinden sonucu okuyabilirsiniz.
