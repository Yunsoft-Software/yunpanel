# Website workspace sözleşmesi

Website/Domain/Application farklı kaynak; explicit Website bağlamı bütün araçlarda korunur. Global giriş ve site girişi aynı reusable workspace'i kullanır; route reload/back/filter/draft/scroll kabulü gerekir. [UI planı](../ui-plan.md) tek tasarım kaynağıdır.

Owner-only root terminal/site create/migration sınırları backend'de; reseller/customer yalnız atanmış kaynak. Yönetim işlemleri common audit metadata taşır: actor/action/resource/time/outcome; secret veya raw terminal çıktısı tutulmaz. Audit görünürlüğü role scope'a uyar.

Kaynak/runtime, Domains/DNS/SSL, Files, DB, mail, backup, log/terminal/cron mevcut API/adapterlarla birleşir. PHP success, boş-site DB binding, SSL unchanged ve altı global route bu araştırmada açık bulundu; sekme veya catalogue varlığı bitmiş özellik değildir. [Somut analiz](audit-2026-10-09.md), [plan](../plan.md).
