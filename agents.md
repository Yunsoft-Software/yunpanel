# YunPanel — Geliştirici ve Kodlama Ajanı Kuralları

Bu dosya repoda çalışan geliştirici ve kodlama ajanlarının kurallarını tanımlar. Dosyanın adı, kaldırılacak `yun-agent` sunucu daemon'ıyla karıştırılmamalıdır.

## 1. Ürün hedefi ve karar önceliği

YunPanel, Yunsoft'un Ubuntu sunucularını Plesk'e bağımlı olmadan yöneteceği site merkezli hosting/server panelidir. Kullanıcı bir web sitesine girdiğinde Node.js, Git/deploy, domain/subdomain, SSL, mail, dosya, veritabanı, log, cron, yedek ve terminal işlemlerini o bağlamdan yapabilmelidir.

2026-09-09 ürün kararı: gerçek kullanıcı authentication, enterprise UI/UX, kalıcı domain/subdomain hiyerarşisi ve agentsiz, tam yetkili yerel yönetim backend'i uygulanacaktır. Bu karar eski planın ayrı privileged agent, non-root yönetim backend'i ve terminal yasağı hükümlerinin yerine geçer. Mevcut kodun henüz bu mimariye taşınmış olduğu varsayılmayacaktır.

Kapsam Yunsoft'un gerçek kullanım ihtiyaçlarıdır; reseller, faturalama, hosting paketleri, tüm dağıtımlara destek ve Plesk'in bütün özellikleri bu değişikliğin önkoşulu değildir.

## 2. Teknoloji ve destek matrisi

- Frontend React, JavaScript/JSX olacak. TypeScript, `.ts` veya `.tsx` eklenmeyecek.
- Backend Node.js olacak; mevcut workspace/adapter/test altyapısı mümkün olduğunca kullanılacak.
- Ubuntu 24.04 LTS, Nginx, Node.js LTS ve systemd ilk destek hedefidir. Çalışan projenin Node/npm sürüm gereksinimleri doğrulanmadan düşürülmeyecek.
- Docker Engine/Compose, MySQL/MariaDB, ACME, Postfix/Dovecot/Rspamd ve Roundcube ilgili modüller kapsamında desteklenecek. Passenger, eski uygulamalar için compatibility adapter'ıdır.
- Yeni dependency yalnızca somut ihtiyaçla eklenecek; terminal ve auth gibi alanlarda bakımı yapılan uygun kütüphaneler değerlendirilecek. Güvenlik mekanizmaları sırf dependency azaltmak için el yordamıyla icat edilmeyecek.

## 3. Agentsiz yönetim mimarisi

- Hedef kurulum sunucu başına yerel paneldir. Yönetim backend'i host üzerinde root yetkili systemd servisi olarak çalışacak; ayrı `yun-agent` servisi olmayacak.
- Nginx/systemd/ACME/deploy/env/backup/mail/paket operasyonları aynı panel backend'inin dahili adapter ve job katmanında yürütülecek. Farklı isim altında ikinci bir privileged daemon veya yeniden agent enrollment/credential exchange kurulmayacak.
- Kurulum Owner'a tüm sunucu yönetim yetkilerini hazır sunacak. Normal yönetim için her operasyonda ayrı sudoers/polkit/agent capability onayı istenmeyecek.
- Root yetkisi frontend'e veya barındırılan uygulamalara verilmez. React arayüzü yalnızca authenticated backend'i çağırır. Public reverse proxy/static serving katmanı root yapmak zorunlu değildir.
- Node/static build, npm lifecycle scriptleri, Git hook'ları, uygulama süreçleri, site cron'u ve site terminali dedicated site kullanıcısıyla çalışacak. Owner Sunucu terminalinde root shell kullanabilecek.
- API oturum/yetki doğrulaması, girdilerin doğrulanması, secret koruması, config testleri ve kaynak kilitleri kaldırılmayacak. Bunlar agent'a tek tek yetki verme mekanizması değildir.
- Root backend'in ele geçirilmesinin hostun ele geçirilmesi anlamına geldiği kabul edilerek auth, bağımlılıklar, ağ yüzeyi ve dosya yazma yolları gözden geçirilecek. Authentication kapısı geçilmeden full yetkili sürüm/terminal public olarak yayınlanmayacak.

## 4. Geçiş ve veri koruma

- Çalışan Nginx/ACME/static/Node/deploy/rollback algoritmaları sırf agent taşınıyor diye yeniden yazılmayacak. Transport bağımlılığı ayrılacak, yöneticiler dahili modüllere ve testleri uygun workspace'e taşınacak.
- Job queue, resource lock, reconciliation, secret store ve deterministic release/service kimlikleri korunacak. Servis restartında işlemin iki kez uygulanması veya sessiz kaybolması engellenecek.
- `/etc/yunpanel`, `/var/lib/yunpanel`, master key, uygulama release'leri, Unix kullanıcıları, vhost ve sertifikalar korunacak. Var olan server/application/domain kimlikleri sebepsiz değiştirilmeyecek.
- State migration sürümlü ve yeniden çalıştırılabilir olacak; gerçek değişiklikten önce doğrulanmış yedek ve rollback yolu bulunacak. Yerel olmayan eski server kayıtları yanlışlıkla bu hosta atanmayacak.
- Eski agent ancak işler durultulduktan ve yeni yürütücü doğrulandıktan sonra durdurulup devre dışı bırakılacak. Paket/unit/env/install/dev dokümanı aynı değişimle uyumlu hale getirilecek.
- `chmod -R 777`, genel sahiplik değişikliği veya güvenlik kontrollerini topluca kapatma çözüm kabul edilmez. Gereken sistem yetkisi servis kurulumuyla sağlanırken uygulama izolasyonu korunur.

## 5. Kullanıcı girişi ve güvenlik sınırı

- İlk kullanıcı Owner olacak; public kayıt ve varsayılan parola olmayacak. İlk kurulum sadece yerel sunucu yöneticisinin başlattığı, süreli ve tek kullanımlık akışla yapılacak.
- Kullanıcı oturumu IP allowlist veya ortak bootstrap bearer token ile ikame edilmeyecek. Bootstrap normal yönetim API'sinde kalıcı arka kapı olarak tutulmayacak.
- Bütün veri/işlem API'leri, log akışları ve terminal WebSocket'leri backend'de authenticated olacak. Frontend route guard yeterli değildir. Development veya alternatif port/rota aynı korumayı atlayamayacak.
- Parolalar Argon2id ile hash'lenecek; oturumlar sunucu tarafında, cookie'ler `HttpOnly`, `Secure`, açık `SameSite` ve host-only kapsamıyla yönetilecek. CSRF, login rate limit, oturum yenileme/iptali ve trusted proxy politikası uygulanacak.
- TOTP ve recovery akışı root yönetiminin dış erişim sürümünde bulunacak. Owner her sıradan işlem için tekrar giriş yapmayacak; yetkili yönetim kullanılabilir kalacak.
- Owner tüm yönetim işlemlerini yapabilir. Ek kısıtlı roller gerekirse backend'de uygulanır; normal kullanıcıya UI butonu gizleyerek yetki kontrolü yapıldığı varsayılmaz. Son aktif Owner silinemez.
- Secrets loglara, URL'lere, localStorage'a, frontend bundle'a ve genel job kayıtlarına yazılmaz. Şifreleme anahtarı repo dışında tutulur; restore/rotation yolu test edilir.
- Etkisi büyük silme/restore işlemlerinde hedef ve veri kaybı açıkça gösterilir. Root terminale komut allowlist'i getirilmez; bu terminal yalnızca authenticated Owner'a açılır.

## 6. Website, domain ve subdomain modeli

- Website kaynak kimliği ile hostname ayrı kavramlardır. Domain, subdomain ve alias türleri; açık parent ve hedef referanslarıyla modellenir.
- Subdomain bağımsız runtime, document root, env, SSL ve loglara sahip olabilir. Alias başka siteye işaret eder; otomatik bağımsız uygulama veya mailbox oluşturmaz.
- Parent son iki domain parçasını keserek tahmin edilmez. FQDN/IDN normalizasyonu, label sınırı, duplicate hostname ve döngü kontrolleri uygulanır.
- DNS hosting, web hostname ve mail domaini ayrı yaşam döngüleridir. Panelde domain yaratılması dış DNS'in değiştiği veya mailin hazır olduğu anlamına gelmez.
- Domain/subdomain silmede bağımlılıklar ve etki gösterilir; örtülü cascade yapılmaz. Migration mevcut trafik ve sertifika ilişkilerini bozmamalıdır.

## 7. Enterprise UI/UX standardı

- Günlük giriş noktası Web Siteleri ve domain ağacıdır. Site detaylarında breadcrumb, kalıcı başlık, hızlı eylemler ve runtime'a uygun sekmeler bulunur.
- Gerçek URL routing, deep link, reload ve tarayıcı geri/ileri desteklenir. Tek `activeView` state'ine bağlı tüm-uygulama bileşeni büyütülmez.
- Ortak tasarım tokenları ve erişilebilir bileşenler kullanılır. Kompakt ama okunabilir tablolar; arama, filtreleme, sıralama ve sayfalama sunar. Uzun domain ve mobil görünüm test edilir.
- Loading, empty, authentication, authorization, missing dependency, unimplemented feature ve runtime error ayrı durumlardır. `404` genel olarak “protected” diye çevrilmez; bilinmeyen ölçüm 0 gösterilmez.
- Bir ekranın veri hatası diğer ekranın verisini silmez. Arka plan refresh açık formu/sekmesini bozmaz. Form doğrulama hatasında girişler korunur.
- İnert buton, placeholder veya sahte verili ekran tamamlanmış modül sayılmaz. Eksik servis için gerçek teşhis/kurulum; kodu olmayan özellik için dürüst durum gösterilir.
- Browser `prompt`/`alert` ile ana yönetim akışı yapılmaz. Uzun işlem job drawer/progress üzerinden izlenir; 202 kabul cevabı başarı diye sunulmaz.

## 8. Terminal ve dosya erişimi

- Terminal gerçek PTY + xterm.js olacak. WebSocket oturum ve Origin kontrolünden geçecek; başka kullanıcı/oturum terminali devralamayacak.
- Site terminali site kullanıcısı ve dizininde; Sunucu terminali Owner için root olarak çalışacak. Host/kullanıcı/dizin bağlamı görünür olacak.
- Resize, kontrol karakterleri, Unicode ve interaktif programlar desteklenecek. Idle/output/session limitleri ve process-group temizliği uygulanacak.
- Logout, oturum iptali ve kullanıcı kapatma açık bağlantının yetkisini kaldıracak. Uzun deploy/backup işlemleri terminal yerine kalıcı job ile yürütülecek.
- Terminal çıktısı güvenilmeyen içeriktir; HTML olarak işlenmez. Ham keystroke, çıktı ve shell history varsayılan olarak merkezi audit'e yazılmaz; oturum açılış/kapanış metadata'sı yazılır.
- Site dosya görünümünde path traversal ve symlink kaçışı engellenir. Host dosyalarına erişim Owner'ın açık Sunucu bağlamında yapılır; uygulama kullanıcılarına yayılmaz.

## 9. Operasyon, konfigürasyon ve audit

- Deploy, build, SSL, backup/restore, Docker ve paket işlemleri kalıcı async job modeliyle yürütülür; queued/running/succeeded/failed/cancelled durumları korunur.
- Aynı kaynağa zarar verecek işler kilitlenir. Nginx activation ve paket değişimi gerektiğinde serialize edilir; tekrar deneme idempotency dikkate alınarak yapılır.
- Nginx/systemd/mail konfigürasyonları adapter/template üzerinden üretilir. Uygulanmadan test edilir; başarısız reload/health durumunda önceki çalışan config/sürüm geri alınır.
- Normal formlar shell string birleştirmez; doğrulanmış argümanlar kullanır. Yetkili interaktif shell ayrı, kasıtlı bir özelliktir; onu sağlamak form inputlarını shell'e birleştirmeyi meşru kılmaz.
- Audit actor, action, resource, zaman ve güvenli sonuç metadata'sı tutar. Parola/token/env değerleri ve ham terminal kayıtları audit'e kopyalanmaz.
- Panel kesilince hosted uygulamalar, Nginx ve mail servisleri çalışmayı sürdürmelidir.

## 10. Git, test ve otomasyon

- Kullanıcı açıkça ayrı branch istemedikçe yeni branch oluşturma veya başka branch üzerinde geliştirme yapma. Doğrudan güncel `main` üzerinde küçük commitlerle ilerle; bu kural kodlama araçları için de geçerlidir.
- Mevcut branch birleştirmelerinde iki tarafın commit geçmişini ve değişikliklerini koru. Force push, geçmiş silme, reset veya tek tarafı seçerek içerik ezme yapma. Eşzamanlı değişiklikte güncel `main` tekrar okunup kayıpsız birleştirilir; branch silme kendiliğinden yapılmaz.
- Küçük, tek amaçlı commitlerle ilerle; refactor ve özellik geliştirmesini mümkün olduğunca ayır. İlgisiz dosyaları değiştirme; eşzamanlı kullanıcı değişikliklerini ezme.
- GitHub Actions KULLANILMAYACAK. `.github/workflows/` eklenmeyecek. Test/build/deploy yerel komutlar veya YunPanel job sistemiyle yürütülecek.
- Auth/session/CSRF, WebSocket yetkisi, site izolasyonu, domain hiyerarşisi/migration, config validation, deploy state, rollback, secret masking, duplicate resource, concurrency ve destructive işlemler test edilir.
- UI için tarayıcı, responsive, klavye ve deep-link akışları doğrulanır. Gerçek host bağımlı testler `todo.md` içinde takip edilir.
- Çalıştırılmayan test, açılmayan canlı site ve uygulanmayan migration yapılmış gibi raporlanmaz. Kod testi gerçek Ubuntu/DNS/mail/restore kanıtının yerine geçmez.

## 11. `plan.md` ve `todo.md`

- `plan.md` yalnızca kalan ürün/kod işlerini ve kabul kriterlerini içerir. Tamamlanan alt maddeler çıkarılır; geçmiş Git'te kalır. Bitmiş milestone, `[x]` listesi veya eski başarı raporu tutulmaz.
- `todo.md` bu ortamda yapılamayan gerçek sunucu/SSH, DNS/provider, Plesk, private credential, production-like tarayıcı ve uçtan uca doğrulama işlerini içerir. Normal geliştirilebilir kod işleri `plan.md` içinde kalır.
- Kod bitip dış doğrulama bekleniyorsa kod maddesi buna göre daraltılır ve kalan doğrulama `todo.md` içinde tutulur. Kısmen biten maddede sadece açık alt işler bırakılır.
- Tamamlanan dış test maddesi `todo.md` listesinden çıkarılır; güvenli kanıt/tarih commit mesajı veya uygun test raporuyla kaydedilir. Secret'lar rapora alınmaz.
- İki belge kodla aynı çalışma turunda güncellenir. Hedef mimari ile halen çalışan eski mimari açıkça ayrılır; plan değişikliği kod tamamlanması sayılmaz.

## 12. Her işin uygulanma sırası

1. Güncel branch, ilgili kod, bu kurallar, `plan.md` ve `todo.md` okunur.
2. En küçük mantıksal değişiklik ve test/kabul koşulu belirlenir.
3. Değişiklik uygulanır; mümkün olan testler çalıştırılır.
4. Aynı turda tamamlanan plan alt maddeleri çıkarılır; yeni dış bağımlılık/kontrol `todo.md` dosyasına eklenir.
5. Küçük commit oluşturulur; çalıştırılan/çalıştırılamayan kontroller açıkça raporlanır.
6. Kod, paket, doküman ve yeni mimari uyumu kontrol edilerek sonraki işe geçilir.
