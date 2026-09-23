# MAILBOX-REMOVE — Posta kutusunu mevcut güvenli akışla silme

2026-09-24; başlangıç `development@d6c3dc34`. BUG-20260923-03 / UX-PL-06 alt işi. Posta kutuları listesine görünür silme girişi eklenir; mevcut mail data backup/delete job ve mailbox finalize motorları kullanılır. Yeni silme, yedek veya root komut motoru yazılmaz.

- [ ] MR-01: Silme etki kontrolü, güncel posta kutusu/alan adı/kimlik doğrulaması ve bağımlılıkların anlaşılır gösterimi.
- [ ] MR-02: Ayrı açık onaylarla yedekle → işi doğrula → veriyi sil → işi doğrula → kaydı kaldır. Yedek ve silme makbuzları aynı posta kutusuna bağlı olmalı; 202 veya başarısız job tamamlanma değildir.
- [ ] MR-03: Posta kutuları ekranı bağlantısı; quota/forwarding ve alias engelleri için mevcut araçlara dönüş, salt okunur yenileme, kayıp cevapta kör tekrar yapmama ve mevcut iş kimliğiyle yeniden okuma.
- [ ] MR-04: Kaynak/davranış testleri ve yapılabilen JSX kontrolleri; gerçek ortam kabulü ayrı.

## Korunan sınırlar

Mevcut `mail-data-operations.js` silmeden önce ilgili posta alan adının disabled olmasını ister. Bu diğer posta kutularını da etkiler. Arayüz alan adını kendiliğinden durdurmaz/açmaz; kullanıcı etkiyi görüp mevcut Yapılandırma ekranında açık onayla uygular. Kota, forwarding ve alias bağımlılıkları otomatik silinmez. Yedeksiz silme veya yalnız metadata silen alternatif çağrı yoktur. Veri silindikten sonra yeni yedek/silme zinciri otomatik başlatılmaz; bilinen işi okumak yazma tekrarı değildir.

## T-DEV-MAILBOX-REMOVE — Codex gerçek kabulü (açık)

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; mevcut mail-client/mailbox/impact/data/finalizer ve site-scope testleri. Bu ortamda doğrudan Git erişimi DNS hatasıyla engellendi; hedef tam kontrol yapılmış sayılmaz.
- [ ] Owner ve kendi sitesinin yöneticisiyle gerçek posta kutusu silme; başka sitenin mailbox/mail-domain/backup/job kimliğini gönderme, yetki kaybı ve logout/login reddi.
- [ ] Alan adı kapatma ve yeniden açmanın diğer hesaplara etkisi; gerçek Postfix/Dovecot/SMTP/IMAP/Roundcube ve aktif oturum davranışı. Disabled kayıt tek başına canlı erişimin kapandığının kanıtı değildir.
- [ ] Doğrulanmış yedek, değişen veri/revizyon, alias/forwarding/quota/aktif iş engelleri; 409/429/5xx/yanıt kaybı, çift tıklama, yeniden giriş ve iş kimliğiyle güvenli devam.
- [ ] Veri silme başarılı olsa bile finalize başarısızken başarı gösterilmemesi; korunmuş yedekten gerçek geri dönüş ve kalan hesapların çalışması. Mobil/klavye/odak/koyu tema kabulü. `.44` hostu kapsam dışı; GitHub Actions/canlı deploy yok.

Üst BUG-03 ve production kabulü kapanmaz. Website silme/askı ve backend ortak kilit işleri bu posta kutusu diliminden ayrıdır.
