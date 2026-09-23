# MR-SINGLE — Diğer hesapları kapatmadan tek posta kutusu silme

2026-09-24; başlangıç `development@5f4ce0c6`. Kullanıcının son kararı: tek posta kutusu silmek için alan adını kapatma zorunluluğu kaldırılacak. Önceki MR-01–04 kaynakları ve yedek/veri silme/finalize motorları korunur.

- [ ] MS-01: Mailbox silmede yalnız seçilen hesabın disabled olması; domain-scope silmede mevcut alan adı kapatma şartı. Kota/forwarding/yerel ve yabancı alias engelleri, yedek hash/revizyon/onay korunur.
- [ ] MS-02: Sunucu mutasyonundan önce seçilen hesabın gerçekten teslimat ve oturum erişiminden çıkarıldığını doğrula; yalnız bu kullanıcının cache/oturumlarını temizle. Canlı kontrol başarısızsa dosya silme başlamasın. Etkin komşu hesap ve alan adı durdurulmasın.
- [ ] MS-03: Mevcut Sil… ekranında seçili hesabı kapatma ve mevcut yapılandırmayı alan adı durumunu koruyarak uygulama yolu. Eski bütün-alan-adı uyarısı değişir; yedek/silme/son kayıt onayları ve belirsiz sonuç korumaları kalır.
- [ ] MS-04: Mevcut ve yeni davranış testleri, yapılabilen sözdizimi kontrolleri; gerçek posta hostu ve üretim derlemesi ayrı kabul.

Silme yetkisi mevcut backend sınırından gelir. Etkin hesabın verisini silme veya sırf desired kayıt disabled diye canlı hizmetin kapandığını varsayma yoktur. Yeni genel root shell, servis durdurma veya ikinci yedek/silme motoru eklenmez.

## T-DEV-MR-SINGLE — Açık gerçek kabul

- [ ] Node24/npm11 tam repo lint/test/build ve gerçek React/API/auth/CSRF kabulü.
- [ ] Aynı etkin alan adında A hesabını kapat/uygula/yedekle/sil; B hesabı SMTP/IMAP/webmail ile çalışmaya devam etsin. A'nın mevcut IMAP/POP3/webmail bağlantısı ve yeni auth/teslimat reddi doğrulansın.
- [ ] Eski yapılandırma, cache, yeni mesaj, eşzamanlı yeniden etkinleştirme, aktif job ve yabancı alias değişimi güvenli biçimde engellensin. İşlem sonucu belirsizken otomatik veri silme tekrarı yapılmasın.
- [ ] Yedekten geri dönüş, yarım finalize, restart, iki süreç/tarayıcı yarışı ve yalnız yetkili site hesabı kapsamı. `.44` sunucusu kesinlikle hariç.

Kaynak alt işleri tamamlandıkça işaretlenir; canlı posta kabulü olmadan üst BUG-03/production kapanmaz. GitHub Actions ve canlı deploy yok.
