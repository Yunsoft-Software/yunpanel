# Dosya Yönetimi

> **Sürüm:** YunPanel `0.3.0` · **Doğrulanmış kaynak revizyonu:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Doğrulanmış Linux `.deb` paket tabanı:** `0.3.0-2026112301` (`f13b2b78`) · **Arayüz dili:** Türkçe (`tr`)

YunPanel tüm dosya işlemlerini sitenin kendi yalıtılmış Linux kullanıcısı (`yunapp-<ozet>`) ve kendi kök dizini içinde yürütür. Sol menüdeki **Dosyalar** (`/files`) girişi ve site detayındaki **Dosya Yöneticisi** (`/websites/<id>/files`) sekmesi aynı güvenli dosya altyapısını kullanır.

## Alan adı → alt alan adı ortak dosya kökü

Alt alan adlarının dosya kökleri ana alan adından kopuk üst dizinlerde açılmaz; ana alan adının çalışma alanı içinde (`subdomains/<alt-alan>`) konumlanır. Böylece ana alan adının Dosya Yöneticisi içinden alt alan adlarının klasörlerine doğrudan erişebilirsiniz.

## Dahili Dosya Yöneticisi ve kod editörü

Dosya yöneticisi ekranında:

- Klasör ve dosya oluşturma, yeniden adlandırma, kopyalama, taşıma, ZIP arşivleme, arşiv çıkarma, dosya yükleme ve indirme işlemleri yapılabilir.
- İzin (chmod) değişikliklerinde güvenliği zayıflatan herkese yazılabilir (`world-writable` / `777`) izinler reddedilir.
- **Dahili kod editörü:** Herhangi bir metin/kod dosyasına tıkladığınızda veya doğrudan `?file=index.html` / `?path=public&file=notes.txt` bağlantısıyla açtığınızda satır numaralı editör penceresi açılır (`Ctrl/Cmd + S` ile kayıt, eşzamanlı sunucu değişikliği koruması).
- **Kaydedilmemiş değişiklik koruması ve temiz kapanış:** Değişiklik yapılmış bir dosyayı kapatmaya çalıştığınızda ortak **Kaydedilmemiş değişiklikler var** uyarısı açılır (**Düzenlemeye dön** / **Değişiklikleri bırak**). Editör kapatıldığında URL'deki `?file=` parametresi temizlenir ve sayfa yenilendiğinde kendiliğinden yeniden açılmaz.

![Site Dosya Yöneticisi ve açık dahili kod editörü](assets/tr/11-files-editor.png)

## Gelişmiş araçlar: elFinder, SFTP ve Terminal

- **elFinder ile Aç:** Oturuma bağlı tek kullanımlık devir (handoff) mekanizmasıyla elFinder arayüzü sitenin kendi sistem kullanıcısı bağlamında açılır.
- **Erişim Hesapları (SFTP / SSH anahtarları):** Site detayındaki **Erişim Hesapları** (`/websites/<id>/access`) sekmesinden site kullanıcısına SSH/SFTP açık anahtarı ekleyebilir, döndürebilir veya iptal edebilirsiniz. Tek Owner bu yeteneği ücretsiz sürümde de kullanabilir.
- **Site Terminali (`ttyd`):** Site detayındaki **Terminal** sekmesi, sitenin kendi yalıtılmış kullanıcısı altında tarayıcı terminali açar (Owner root sunucu terminali ayrı olarak **Sunucu** sayfasındadır).

## İlgili kılavuzlar

- Site ve alt alan adı hiyerarşisi için [Temel Site ve Rol İşlemleri](doc:sites-and-roles)
- Dosya yedekleme ve geri yükleme için [Yedekleme ve Kurtarma](doc:backups-and-recovery)
