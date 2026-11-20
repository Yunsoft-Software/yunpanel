# Linux hosting pilotu ve Plesk geçişi

20 Kasım 2026 ürün onayı. Bu dilimler yerel kaynak ve araç doğrulaması içindir. Canlı geçiş ve kurtarma ölçütleri [kabul listesinde](../../todo.md#linux-hosting-pilotu-ve-plesk-geçişi) izlenir.

## 20 Kasım yerel Ubuntu kanıtı

- **Kurtarma.** Geçici Ubuntu 24.04'te Restic 0.16.4 ve rclone 1.60.1, yerel bir rclone hedefine gerçek tar arşivi yazdı. Depo yüzde 100 okundu. Kaynak dizin taşındıktan sonra arşiv yeni dizinde açıldı. SHA-256, beklenen kaynak kimliği, dört arşiv kökü ve özel staging içindeki durum dosyası doğrulandı. Mac'te Restic 0.19.1 ile HTML ve SQLite, ayrıca gerçek cache izin hatası için 16/16 test geçti.
- **Taşıma.** Yerel PHP 8.3 ve MariaDB 10.11 ile Plesk hazırlama komutu aynı baytları kopyaladı. PHP gerçek HTTP yanıtı verdi. Operatör SQL dökümünü yalnız hedef veritabanına yetkili hesapla yükledi. İki Türkçe satır okundu, kardeş veritabanı korundu ve ikinci staging isteği reddedildi. Ubuntu ARM64 paketi çıkarılarak iki CLI giriş noktası çalıştırıldı. [Operatör adımları](../operations.md#plesk-pilotu).
- **Posta.** Dovecot gerçek Sieve motorunda Türkçe otomatik yanıt, yerel INBOX, kardeş kutu ve kendi adresinden gelen mesaj doğrulandı. Rspamd 3.8.1 gerçek taramada ilk statik liste biçimini yükledi ama puan üretmedi. Yerleşik statik haritayla tek alıcıya +5, kardeş ve çoklu alıcıya sıfır politika puanı, kimlik doğrulamalı gönderime puan dışı işaret doğrulandı. Ürün içinden ayar kaydı, uygulama ve geri alma ile SMTP/IMAP teslimatı açık.

Sieve, mevcut yönlendirmeyle zincirde çalıştı. Kopyalı yönlendirme yerel teslimatı korudu ve yalnız yönlendirme yerel teslimatı kaldırdı. Null gönderici, süre içi tekrar ve gerçek SMTP teslimi açık. DMARC olumlu izin listesi denemesinde yerel TXT sorguları zaman aşımına düştü ve Rspamd izin puanı uygulamadı. DMARC geçen iletide beklenen eksi puan ayrı doğrulanacak.

`4184ce36` için tam görev denetimi, lint, test ve derleme geçti. Aynı kaynak Ubuntu ARM64 Debian paketi `0.3.0-2026112099` olarak oluşturuldu. Paket manifesti ve Plesk/Recovery CLI girişleri çıkarılan paket içinde doğrulandı. Paket SHA-256 `2ef900fa605fa7686c954d6d47b992ddf47bf4634462f0f96ecb6fc74bd724c2`. Bu paket yerel prova çıktısıdır.

İlk canlı adım ayrı yedek hedefinde uzak depo ve kapalı kaynakla kurtarma provasıdır. Ardından yetkili Plesk dışa aktarımıyla PHP ve postalı WordPress pilotu, ayrı ağdan DNS ve WAF kabulü gelir.

## 20 Kasım ikinci çalışma ve durma noktası

- **Posta motorları.** T942 `80b09c3e` gerçek Ubuntu'da başarılı apply, bozuk Rspamd yapılandırması sonrası otomatik geri dönüş ve açık rollback senaryolarından geçti. Fiziksel içerik, sahiplik ve izinler karşılaştırıldı. Dovecot başlangıç include ayarı, geçici SMTP/IMAP fixture'ında ilk soket engelini giderdi. Yerel Postfix STARTTLS ve IMAPS ile dört ileti teslim edildi. Tek Türkçe otomatik yanıt geldi. Tekrar, boş SMTP göndereni ve kardeş posta kutusu yanıt üretmedi. Rspamd gerçek PowerDNS ile olumlu DMARC'a `-1` uyguladı, başarısız DMARC'a uygulamadı. Gerçek RSA DKIM imzası onaylandı ve gövde değişince reddedildi.
- **Panel.** T943 Owner kaydet/temizle yetkisi, gerçek HTTP/SQLite, yedek ve kayıt uyumunda 101/101 geçti. T944 gerçek Chromium, loopback API ve SQLite ile 9/9 geçti. Owner formu, 409 sonrası yenileme, kaydetme, yeniden açma, temizleme, yapılandırma önizlemesi ve site yöneticisi rolünde gizlilik doğrulandı. T945 `a9b2aa28` aynı içeriğin yeni revizyonla kaydından sonra eski uygulama onayını reddediyor. Son odak koşusu 21/21 geçti. T944 ve T945 bağımsız incelemede.
- **Kurtarma.** T947 isimli rclone hedefiyle bağlanmayı ve özel yapılandırmayı doğruluyor. Geçici Ubuntu'da 17/17 native ve 23/23 depo/HTTP testi geçti. Gerçek ayrı loopback WebDAV işlemi, kaynak yol erişilemezken veriyi geri verdi. [Yapılandırma ve kurtarma](../local-migration-backup.md).
- **DNS.** T946 iki PowerDNS süreciyle NOTIFY ve AXFR, ikincil SQLite okuması ve birincil durunca yetkili DNS yanıtı verdi. Mevcut YunPanel denetleyicisi güncel, geride ve erişilemiyor durumlarını gerçek sorguyla ayırdı.
- **WordPress.** Resmi Türkçe WordPress 7.1.5 arşivi native tar ile açıldı ve WP-CLI checksum kontrolü geçti. Geçici WordPress dosyaları ve gerçek MariaDB dökümü Plesk hazırlama komutuyla taşındı. Hedefte Türkçe HTTP içerik ve yönetici girişi doğrulandı. Hedefte geçiş sonrası oluşturulan yazı ayrı geri dönüş kopyasında korundu. Yetkili gerçek Plesk dışa aktarımı ve posta eşitlemesi canlı kabulde açık.

Kullanıcı bu noktada Codex çalışmasını durdurup Antigravity'ye devretmeyi istedi. Son kaynak dilimi için tam lint/test/build ve yeni adayın dağıtımı açık. .28 üzerinde değişiklik yapılmadı. Test sanal makinesi kaldırıldı. Bağımsız dış depo, gerçek Plesk export'u, ikinci ağ ve WAF kabulü [açık listede](../../todo.md#linux-hosting-pilotu-ve-plesk-geçişi).

**Devam sırası.** Önce T944 ve T945'i bağımsız incele. Kapalı alan adında kural kaydından sonra ekrandaki bekleme ve yeniden uygulama yolunu kontrol et. Bulgu giderilince tam görev denetimini, lint, test ve derlemeyi bir kez çalıştır. Sonra izinli paket ve .28 kabulü, gerçek dış yedek/kurtarma, Plesk taşıma ve bağımsız DNS/WAF adımlarını uygun ortam geldikçe ilerlet. Antigravity'de kullanıcı tercihi Gemini 4 Neon Extra ve aynı anda en fazla üç alt ajandır.

## 20 Kasım Antigravity devralma — T944/T945 inceleme ve yerel kapanış

- **T945 bağımsız inceleme (`KABUL`, `056d3f69`):** `6cc2c2e7` ve `a9b2aa28` `AGENT_3` tarafından doğrulandı (`21/21` yerel odak testi tekrarlandı). Etkin teslimat politikası kayıt kimliği (`[mailboxId, revision]`) `legacyPreview` ve SQL planı `sha256`'sına bağlanıyor; aynı kural yeniden kaydında eski onay `409 mail_configuration_preview_stale` ile reddediliyor; politikasız sunucu kimliği ve kapalı alan `disabled -> disabled` (`409 mail_domain_status_no_change`) sınırı korunuyor.
- **T944 bağımsız inceleme (`RET` `e6f9ee45` → düzeltme `8ab93909` → `KABUL` `d8062438`):** İlk incelemede (`AGENT_1`) dört bloklayıcı bulgu saptandı: (1) kapalı posta alan adında (`domain.status === 'disabled'`) kayıt sonrası `config-preview(disabled)` çağrısının `409 mail_domain_status_no_change` ile formu çıkmaza kilitlemesi, (2) `pending` + `stale` durumunda mesaj ezilmesi ve `reload()` sonrası formun sessizce kilitli/eski digest'a bağlı kalması, (3) Owner için `"Kota ve yönlendirme"` düğme metninin değişerek mevcut `eml-01..03.spec.js` seçicilerini kırması, (4) kapalı alan/kurtarma/doğrulama Chromium test eksikliği. `AGENT_2` düzeltmesiyle (`8ab93909`) kapalı alanda önizleme 409'u tetiklenmeden açık formla kayıt ve Türkçe bilgi mesajı, eşzamanlı kapatma yarışı ve `disabled -> enabled` temizliği, `useMailChange` `reset()`/`reapply()` ile `PUT` tekrarlamadan taze yeniden uygulama, `"Kota ve yönlendirme"` düğme uyumluluğu ve `waitForJob` abort temizliği sağlandı; gerçek Chromium/Express/SQLite/`JobRegistry` testleri `10/10` geçerek `AGENT_1` tarafından kabul edildi.
- **Yerel kaynak kapsamı tamamlandı (`T936`–`T947` tamamı `done`):** Önceki Ubuntu 24.04 posta/rollback (`T942`), Restic/rclone/WebDAV (`T937`/`T940`/`T947`), PowerDNS (`T946`), Plesk staging (`T936`/`T939`/`T941`) ve WordPress 7.1.5 yerel kanıtları geçerlidir; tüm kaynak işleri tam `tasks.py lint` ve `orchestrator.py verify` (`lint`, `test`, `build`) ile bir kez doğrulanır.
- **Açık canlı/dış ortam sınırları (yerel sonuçla ayrı tutulur):**
  - **Yeni `.28` paketi:** `.28` şu an `0.3.0-2026112003` (`fefcf567`) sürümündedir; `T936`–`T947` kaynaklarını içeren yeni `.28` paketi ve kurulumu ayrı kullanıcı onayı gerektirir (`.28`'e dokunulmadı).
  - **Dış depodan bağımsız kurtarma:** `.local/` altında izinli uzak Restic/rclone dış depo hedefi/erişim bilgisi ve boş Ubuntu 24.04 kurtarma VM'i yoktur; kaynak kapalıyken gerçek dış kurtarma ve RTO/RPO ölçümü canlı kabulde açıktır.
  - **Gerçek Plesk taşıması:** `.44`'e kesinlikle erişilmedi; izinli çevrimdışı Plesk PHP/WordPress/posta dışa aktarımı bu ortamda bulunmadığı için canlı kesim, IMAP eşitleme ve yeni veri koruyan geri dönüş provası açıktır.
  - **İkinci ağ DNS ve WAF:** Ayrı ağda ikinci PowerDNS sunucusu ve izinli Cloudflare WAF / canlı CrowdSec AppSec hedefi bulunmamaktadır (depodaki `crowdsec-manager.js` yalnızca yerel `cscli` engel/durum denetimini kapsar).
  - **WordPress seçici staging aktarımı ve T883:** Pilot kalıbı canlı doğrulandıktan sonraki fazdadır; `T883` açık bırakılmıştır.

### T936 · Dosya ve SQL taşıma paketini yerelde hazırla
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/plesk-offline-transfer.js`, `apps/api/test/plesk-offline-transfer.test.js`, `scripts/plesk-transfer.mjs`, `apps/api/test/plesk-transfer-cli.test.js`
- **İş:** Mevcut salt okunur Plesk önizlemesine gelen kontrollü JSON ile aynı operatörün çıkardığı tek PHP site dosya ağacı ve tek SQL dump’ı için yerel, doğrulanabilir operatör hazırlığı. Normal site kurulum ve SQL bağlama sözleşmelerini kullanmaya hazır, kararlı ve kaynak kimliklerine bağlı bir çıktı üret. Kaynağa/uzak makineye bağlanma, DNS veya kayıt yazma, shell komutu çalıştırma yetkisini export’a verme. Canlı uygulama sonraki kabul diliminde.
- **Kabul:** Gerçek geçici dosyalarla iki koşuda aynı girdi tekrar kullanılır. Yol kaçışı, symlink, yabancı girdi, değişmiş SQL/dosya ve dolu hedef fail-closed reddedilir. Kullanılır CLI ve okunur özet hazırdır.

### T937 · Boş sunucu kurtarması için yerel hazırlanabilirliği doğrula
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/local-migration-archive-inspection.js`, `apps/api/src/local-recovery-preflight.js`, `apps/api/test/local-recovery-preflight.test.js`, `scripts/local-migration-backup.mjs`, `apps/api/test/local-migration-backup-cli.test.js`, `docs/local-migration-backup.md`
- **İş:** Mevcut migration yedeği doğrulama ve private restore stage hattından yararlan. Dış depodan indirilmiş doğrulanmış arşivin hazırlanabilirliğini kayıtlara yazmadan, yalnız yerel geçici dizinde ve redakte biçimde kontrol et. Restic/rclone sürecini ve YunPanel anahtarlarının ayrı erişim gereğini operatör akışına yaz. Paket üretimi ve canlı restore bu dilimin dışında.
- **Kabul:** Gerçek arşiv, sahipsiz/bozuk arşiv, sürüm ya da kimlik uyuşmazlığı ve değişmeyen hedef kanıtı. Mevcut migration CLI regresyonları geçer. Canlı sunucuya başarı kaydı yazılmaz.

### T938 · Dovecot otomatik yanıt ve Rspamd politika hazırlığı
- **Bağımlı:** —
- **Dosyalar:** `packages/config-templates/src/mail-vacation.js`, `packages/config-templates/src/mail-spam-policy.js`, `packages/config-templates/src/index.js`, `packages/config-templates/test/mail-vacation.test.js`, `packages/config-templates/test/mail-spam-policy.test.js`
- **İş:** Dovecot/Pigeonhole Vacation ve Rspamd Multimap için yazılabilir, sınırlı, gerçek motorun derleyebileceği yapılandırma üret. Posta kutusu/alan adı sınırı, karakter kaçışları, olağan döngü önleme, standart DKIM/DMARC davranışı ve mevcut forwarding bozulmamalı. İlk dilim güvenli şablon ve kabul hazırlığıdır. Canlı paket kurulumu yok.
- **Kabul:** Yasak girdiler dosya üretemez. Sieve ve Rspamd yapılandırmasının normal girdi siyasetini ve mail yönlendirmesiyle birlikte kullanılabilirliğini kaynak düzeyinde doğrula. Mevcut şablon regresyonları geçer. Gerçek hizmet varsa yalnız yerel testle kullan.

### T939 · Plesk önizlemesinin Owner ve çıktı sınırını sıkılaştır
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/plesk-importer.js`, `apps/api/src/plesk-importer-http.js`, `apps/api/test/plesk-importer-local-auth.test.js`
- **İş:** Önizleme Owner yönetim erişiminde kalır. TLS özel anahtarı, cron komutu ve ham JSON hata içeriği yanıta girmez. Tekrarlanan aynı güvenli envanter için özet kimliği kararlı kalır. Mevcut dışa aktarım veya site verisine yazılmaz.
- **Kabul:** Geçici gerçek SQLite auth ve HTTP ile Owner erişimi ve site kullanıcısı reddi. Normal TLS/cron üstverisi okunabilir. Aynı girdi tekrarı aynı envanter özeti verir. Hatalı JSON ham girdi içeriğini açığa çıkarmaz.

### T940 · Restic önbelleğini güvenli geçici çalışma alanına bağla
- **Bağımlı:** —
- **Dosyalar:** `packages/host-runtime/src/restic-manager.js`, `packages/host-runtime/test/restic-manager-native.test.js`
- **İş:** Gerçek Restic 0.19.1, panelin kısıtlı alt süreç ortamında geçerli önbellek yolu bulamadığı için yedek almayı durduruyor. Süreç ortamını genişletmeden mevcut özel geçici dizinde açık cache yolu ver ve işlemden sonra kaldır.
- **Kabul:** Sürümü ve hash’i doğrulanan gerçek Restic ile ayrı geçici repo, snapshot, %100 okuma ve kaynak dosya yolu yokken HTML ve SQLite verisinin temiz dizine dönüşü geçer. Gerçek önbellek izin hatası Restic sonucunu değiştirmez ve parola dosyası kaldırılır. Mevcut Restic regresyonları geçer.

### T941 · Doğrulanmış Plesk paketini boş yerel staging alanına kopyala
- **Bağımlı:** T936, T901
- **Dosyalar:** `apps/api/src/plesk-offline-transfer.js`, `apps/api/test/plesk-offline-transfer.test.js`, `scripts/plesk-transfer.mjs`, `scripts/build-deb.sh`
- **İş:** CLI önizleme ve doğrulamayı koru. Açık staging eylemi ile yalnız doğrulanan HTML/PHP dosyaları, manifest ve SQL dump’ını sahipli boş hazırlık alanında güvenli biçimde kopyala. Kaynak dosyalar, gerçek barındırma ve veritabanı işlemleri kapsam dışı. Aynı içeriği ikinci kopya veya overwrite olmadan yönet.
- **Kabul:** Gerçek geçici dosya ve CLI ile kopya içeriği ve hash eşleşir. Yanlış beklenen hash ve dolu hedef hiçbir mevcut veriyi değiştirmez. Kısmi kopya yayınlanmaz, test sonunda dış dizinler değişmez.

### T942 · Posta kurallarını mevcut yapılandırma işlemine ekle
- **Bağımlı:** T938
- **Dosyalar:** `packages/config-templates/src/mail-forwarding.js`, `packages/config-templates/src/mail-submission.js`, `packages/config-templates/src/mail-vacation.js`, `packages/config-templates/src/mail-spam-policy.js`, `packages/config-templates/src/mail-apply-plan.js`, `packages/config-templates/src/index.js`, `packages/host-runtime/src/mail-config-manager.js`, `packages/host-runtime/src/mail-config-backup.js`, `packages/host-runtime/src/mail-config-activator.js`, `packages/host-runtime/src/mail-config-evidence-inspector.js`, `packages/config-templates/test/mail-submission.test.js`, `packages/config-templates/test/mail-apply-plan.test.js`, `packages/host-runtime/test/mail-config-activator.test.js`
- **İş:** Yönetilen posta yapılandırmasında `previewManagedMailSubmissionConfiguration({ …, vacations, spamPolicies })` kullan. Otomatik yanıt mevcut Sieve dosyası ve derleme sözleşmesiyle birlikte çalışır. Rspamd kuralları mevcut backup, apply/configtest, izinler, geri alma ve işlem kimliğine dahil edilir. Başkasına ait Rspamd kuralları korunur. Ayar yokken mevcut sunucuların davranışı korunur, son kural kaldırılınca daha önce yönetilen kural etkin kalmaz.
- **Kabul:** Yönetilen yapılandırma yalnız doğrulanmış kutular için değişir. Sieve derleme, izin, Rspamd configtest, başarısız uygulama sonrası geri dönüş ve yönetilmeyen dosya koruması kanıtlanır. Gerçek dosya ve motor testi kullan. Üretim veya .28 kurulumu bu işte yok.

### T943 · Otomatik yanıt ve spam kurallarını posta kutusuna kaydet
- **Bağımlı:** T942
- **Dosyalar:** `apps/api/src/mailbox-registry.js`, `apps/api/src/mailbox-http.js`, `apps/api/src/management-audit.js`, `apps/api/test/mailbox-registry.test.js`, `apps/api/test/mailbox-delivery-policy-http.test.js`
- **İş:** Kuralı mevcut posta kutusu kaydına geriye uyumlu olarak bağla ve normal yedek/silme yaşam döngüsünü kullan. Mevcut yerel kapsam denetimiyle yalnız Owner için `GET/PUT /api/mailboxes/:mailboxId/delivery-policy`. Yanıt `data: {mailboxId, revision, vacation, allow, deny}`, PUT `{expectedRevision, vacation, allow, deny}`. `vacation` null veya `{subject, body}`. Boş listeler ve null politikayı temizler. Mevcut revision, CSRF ve yetki korunur. `materializeEnabledDeliveryPolicies()` etkin kutular için ayrıca adresi döndürür.
- **Kabul:** Gerçek yerel HTTP/auth ve dosya registry ile kaydet, tekrar oku, stale revision, başka rol reddi, bozuk liste reddi, temizleme ve eski kayıt okuma geçer. Genel posta kutusu listesi mesaj içeriğini döndürmez.

### T944 · Posta kutusunda otomatik yanıt ve spam ayarlarını göster
- **Bağımlı:** T943, T851
- **Dosyalar:** `apps/web/src/workspace/MailboxesPanel.jsx`, `apps/web/src/workspace/MailboxDeliveryPolicyPanel.jsx`, `apps/web/src/workspace/useMailChange.js`, `apps/web/src/workspace/mail-client.js`, `apps/web/src/api.js`, `apps/web/test/mail-client.test.js`
- **İş:** Mevcut posta kutusu ayarlarına Owner için Türkçe otomatik yanıt ve gönderen listeleri ekle. Ortak bileşenler ve mevcut posta değişikliği/uygulama akışını kullan. Kuralı okumada ve kaydetmede revision, yetki, bekleme ve hata durumlarını koru.
- **Kabul:** Mevcut kota ve yönlendirme çalışır. Yeni form boş politika, mevcut kural, kaydetme ve temizlemeyi normal API ile yönetir. Derleme ve etkilenen istemci kontrolleri geçer.

### T945 · Kalıcı posta kurallarını uygulama ve geri alma işine bağla
- **Bağımlı:** T942, T943
- **Dosyalar:** `apps/api/src/mail-configuration.js`, `apps/api/test/mail-configuration-delivery-policy.test.js`
- **İş:** Posta kutusundan okunan etkin politikaları mevcut preview/apply/backup/rollback hattına ver. Ret, iş iptali, devre dışı kutu, yanlış alan adı ve stale plan korumaları kalır. Kamusal önizleme kuralın hassas içeriğini göstermeden değişikliği hash'e bağlar.
- **Kabul:** Normal e-posta yapılandırma yolu gerçek geçici veriyle yeni kuralı planlar, devre dışı kutuyu dışarıda bırakır, kaydı değişen eski onayı reddeder ve mevcut posta verisini korur.

### T946 · PowerDNS ikincil aktarımını yerelde doğrula
- **Bağımlı:** —
- **Dosyalar:** —
- **İş:** Geçici Ubuntu'da iki ayrı PowerDNS işlem ve veri diziniyle mevcut mekanizmanın yerel provasını yap. Ağ veya .28 ayarı yok. Gerçek NOTIFY ve AXFR, yeni SOA seri numarası ve birincil kapalıyken ikincilden yetkili cevap ölçülür. Ayrı ağ kabulü açık kalır.
- **Kabul:** Gerçek DNS sorgusu, ikincil kaynak dizini ve birincil işlem durumu birlikte kanıtlanır. Geçici kaynaklar temizlenir ve sonuç görev kaydına yazılır.

### T947 · İsimli rclone hedefi için özel Restic yapılandırmasını aktar
- **Bağımlı:** T893, T937, T940
- **Dosyalar:** `packages/host-runtime/src/restic-manager.js`, `packages/host-runtime/src/index.js`, `packages/host-runtime/test/restic-manager-native.test.js`, `apps/api/src/restic-repository-registry.js`, `apps/api/test/restic-repository-registry.test.js`, `docs/local-migration-backup.md`
- **İş:** Restic izinli süreç ortamında operatörün seçtiği tek isimli rclone hesabını kullanabilsin. Yalnız açık yönetici yapılandırmasına, özel dosyaya ve rclone deposuna bağlı kalsın. Kimlik bilgisi genel ortamdan veya kullanıcı isteğinden alınmaz, çıktıya girmez ve özel geçici dosya işlem sonunda silinir.
- **Kabul:** Gerçek Restic/rclone ile ayarsız ilk ret, izinli özel yapılandırmayla isimli depo init, snapshot, tam okuma ve geri yükleme. Genel izinli veya symlink dosyayı reddet. İşlem sonrası geçici parola ve yapılandırma dosyaları kalmaz. Uzak ağ kanıtı ayrı kabulde.
