# MR-SINGLE — Diğer hesapları kapatmadan tek posta kutusu silme

2026-09-24. İlk kapsam `development@5f4ce0c6`; bu devam turunda bulunan başlangıç `ff824077`. Kullanıcının son kararı: tek posta kutusu silmek için alan adını kapatma zorunluluğu kaldırılır. Önceki MR-01–04 yedek/veri silme/finalize motorları korunur. Eski `mailbox-removal-flow.md`, plan ve TODO içindeki bütün-alan-adı kapatma notları, mailbox kapsamı için bu güncel kararla değiştirilmiştir; domain kapsamındaki toplu veri silme farklıdır.

## Tamamlanan kaynak işleri

- [x] **MS-01 — API/worker kapsamı:** başlangıç `ff824077` içinde bulunan tek-hesap kaynakları korundu ve yeniden okundu. `mail-data-operations.js` mailbox için yalnız seçilen hesabın `enabled === false` olmasını ister; domain-scope silmede domain disabled şartı sürer. İstemci `mailbox-removal-model.js` aynı ayrımı kullanır. Kota, forwarding, yerel/yabancı alias, aktif iş, yedek özeti, revizyon ve son onay kontrolleri kaldırılmadı. Bu mevcut parçalar bu turun yeni commitleri olarak sayılmaz.
- [x] **MS-02 — Seçilen hesabın canlı erişim kontrolü kaynağı:** mevcut `mail-data-delete-manager.js`, `createMailboxAccessGuard` üzerinden seçilen adresin teslimat/auth ve Dovecot oturum durumunu kontrol eder. Komutlar sabit executable/argümanlarla sınırlıdır; shell, wildcard kullanıcı veya bütün kullanıcıları atma yoktur. `71b7edc3` ile Dovecot user lookup yalnız `-f uid` kullanır; dokümanda birbirini dışlayan `-u` ve `-f` birlikte gönderilmez. Çıkış kodu/çıktısı doğrulanmamış hata yokluk kanıtı değildir. `89f65502` bu katmanın kontrollü komut koşucusu testidir; gerçek posta hizmeti testi değildir.
- [x] **MS-03 — Tek hesabı kapatma ve uygulama:** `306a9b8d`, `df5a8268`, `2dc18d12`. Yeni dar `mailbox-access-preparation.js` ve `MailboxAccessPreparation.jsx` mevcut Sil… ekranına bağlıdır. Yalnız seçilen mailbox mevcut PATCH ile kapatılır. Sonra mevcut config-preview/config-apply aynı güncel domain status değeriyle kullanılır; etkin domain kapatılmaz, önceden kapalı domain de açılmaz. Queued/running uygulama başarısı değildir; doğru iş/alan adı/revizyon/yapılandırma özeti doğrulanır. Eski bütün-domain kapatma uyarısı kaldırıldı; yedek/silme/finalize, politika ve alias dönüşleri korundu.
- [x] **MS-03 — Belirsizlik ve oturum:** tek scope içinde çift yazma, eski onay ve oturum/unmount sonrası geç cevap engellenir. Kayıp PATCH sonucu GET ile okunur; kayıp apply POST otomatik tekrarlanmaz ve beklenen yapılandırma kanıtı taşıyan mevcut iş okunur. `af8f1700`, `ed5ca574` ile kayıp silme isteği beklenen action/backup/revizyon kanıtını saklar; kullanıcı eski yedek işini elle açarak belirsiz silmeyi çözüldü saydıramaz. Bilinen çalışan iş başka tarihsel işle değiştirilemez.
- [x] **MS-04 — Seçili kaynak kontrolü:** `2433da7d`, `89f65502`, `ed5ca574`, `1650a019`. Mail grubunda **105 geçti / 0 başarısız / 0 atlandı**: 35 erişim hazırlığı, 38 silme davranışı ve 26 komut-adapter davranışı, 6 kaynak bağlantısı. Eski 35 silme davranışı etkin domain/kapalı seçilen hesap fixture'ıyla yeniden çalıştı; üç ek kayıp-iş regresyonuyla 38 oldu. Önceki farklı turların test sayıları toplanmadı.

## Akış ve kapsam

**Yalnız hesabı kapat → domain durumunu değiştirmeden yapılandırmayı uygula → yedekle → doğrulanmış veriyi sil → hesap kaydını kaldır.** Her yazma mevcut açık onay sözleşmesini kullanır. Bu ekran alan adının veya komşu hesapların etkinlik tercihini değiştiren bir yazma göndermez. Silme makbuzu oluşunca erişim hazırlığı yeni bir yedek/silme zinciri başlatmaz.

Önemli: `mail.config.apply` mevcut ortak yapılandırma motorudur. Başka kaydedilmiş fakat uygulanmamış posta düzenlemeleri varsa önizlenen yapılandırmaya dahil olabilir; bu durum arayüzde açıkça yazılıdır ve mevcut Yapılandırma ekranına bağlantı vardır. Yeni gizli tek-kayıt SQL yazıcısı veya alternatif root taşıması kurulmadı. Kaynakta komşu hesaplara disable gönderilmemesi, canlı hostta sıfır kesinti ölçüldüğü anlamına gelmez.

Sunucuda zaten authenticate olmuş SMTP oturumları, devam eden LMTP teslimi, önbellekte açık webmail HTTP sayfası ve mutation anındaki yeniden etkinleştirme/alias yarışı ayrıca incelenmelidir. Dovecot `kick` veya yeni auth reddi bunların tümünü tek başına kanıtlamaz. İstemci ön okuması süreçler arası kilidin yerine geçmez. Bu yüzden MS kaynak işaretleri üst BUG-03/production kabulünü kapatmaz.

## Gerçek çalıştırılan kontrol

Node **22.16.0**, npm **10.9.2**. Aynı son koşuda aşağıdaki beş dosya **109 geçti / 0 başarısız / 0 atlandı**: mail 105 + ayrı BUG-07 için dört kaynak testi.

```sh
node --test \
  apps/web/test/mailbox-access-preparation.test.js \
  apps/web/test/mailbox-removal.test.js \
  apps/web/test/mailbox-removal-wiring.test.js \
  packages/host-runtime/test/mailbox-access-guard.test.js \
  apps/web/test/new-website-admin-layout.test.js
```

Üç JSX dosyası (`MailboxAccessPreparation`, `MailboxRemovalPanel`, `NewWebsitePage`) hazır parser/dönüştürücüyle kontrol edildi; dönüştürülmüş JavaScript ve dört ilgili kaynak JS dosyası `node --check` ile geçti. Parser kullanımı repoya TypeScript veya bağımlılık/lockfile değişikliği eklemez. JSX dönüşümü gerçek React render, import çözümü, Vite derlemesi veya tarayıcı kabulü değildir.

`f5f374c4` son kaynaklarında test edilen 11 yeni/değişmiş kaynak/test dosyası ve iki değişmemiş bağımlılık (`MailboxesPanel.jsx`, `mailbox-removal-model.js`) Git blob SHA ile yereldeki dosyalarla birebir eşleştirildi. Testler request ve komut runner fixture'larıdır; gerçek Express/auth/CSRF, Postfix/Dovecot, SQL, filesystem silme veya host kabulü çalıştırılmadı. API/worker'ın önceki tam test grupları yeniden çalıştırılmış sayılmaz. Tam Git checkout ve raw dosya indirme denemeleri DNS çözümleme hatasıyla başarısız oldu; Node24/npm11 tam kontrol yoktur.

## T-DEV-MR-SINGLE — Açık gerçek kabul

- [ ] Node24/npm11 tam repo lint/test/build; gerçek React/SessionProvider/router/StrictMode ve HTTP/auth/CSRF. Yukarıdaki testlerle mevcut mail data API/worker/delete-manager/finalizer/impact ve site-scope regresyonlarını birlikte çalıştır.
- [ ] Aynı etkin alan adında A hesabını kapat/uygula/yedekle/sil; B hesabı SMTP/IMAP/webmail ile çalışmaya devam etsin. A'nın mevcut IMAP/POP3/ManageSieve bağlantısı, yeni auth/teslimat reddi ve etkin SMTP oturumları ayrı doğrulansın. Alan adı status/revizyonu ve komşu hesapların kayıtları değişmemeli.
- [ ] Kullanılan Dovecot/Postfix sürümünde field-only lookup, beklenen yokluk exit/çıktısı, cache flush, seçilen kullanıcı kick/who davranışını doğrula. Eksik binary, servis/veritabanı hatası veya eski/unmanaged config yok hesap diye kabul edilmemeli. Gerçek config reload etkisini ve başka bekleyen ayarların görünürlüğünü ölç.
- [ ] Yeni mesaj/LMTP teslimi, eşzamanlı yeniden etkinleştirme, aktif job ve yabancı alias değişimi; eski yedek veya yanlış işlemi resume ederek kayıp POST çözülmüş sayılmamalı. İki süreç/tarayıcı ve worker mutation anı yetki/kilit kontrolü ayrı zorunludur.
- [ ] Yedekten gerçek geri dönüş, yarım finalize, restart, kayıp finalize cevabı/404 uzlaştırması; başka Website/posta kutusu kimliği ve yetki iptali reddi. Mobil, klavye, modal odağı ve tema kabulü. `.44` sunucusu kesinlikle hariç.

BUG-07 kaynak ve gerçek görsel kabulü `site-admin-field-alignment.md` içindedir. Planın Website silme/askı, SSL senkronizasyonu, phpMyAdmin site-session, reseller runtime, firewall ve diğer açık kaynak işleri bu tur tamamlanmış sayılmaz. `development` dışında yazma, GitHub Actions veya canlı deploy yapılmadı.
