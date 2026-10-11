# Passenger Git yayınlama ve geri alma

İlk Website kurulumu ve ortam yeniden başlatma çalışır; normal Git deploy/rollback eski direct-systemd sözleşmesine bağlıdır. Passenger günlük Git akışı tamamlanmış sayılmaz. 11 Ekim devam dilimi aynı ekran/API üzerinden, mevcut dedicated-site Unix release manager, Nginx, environment/process/HTTP inspector ve runtime-binding motorlarıyla yürütülecek.

Yeni açık Passenger deploy/rollback operasyonları backend adapter seçimiyle çalışacak; eski systemd işi Passenger'a dönüşmez. Backend uygulama adapterından operasyonu seçer. Tek Website/Application/sunucu/Unix bağı, kuyruktaki yapılandırma ve önceki release, kaydedilmiş ortam revision'ı, aktif runtime binding ve tam Domain routing kanıtı yürütme başında ve native değişiklikler öncesinde doğrulanır. Aynı site kilidi ve tenant reauthorization korunur.

Yayın, dedicated Unix kullanıcıyla hazırlanır. Yeni fiziksel release/commit, ortam ve Nginx trafiği doğrulanmadan başarılı olmaz. Application release, Domain checksum ve runtime binding birlikte aynı gerçek hedefe uzlaştırılır. Hata veya kayıp cevapta kalıcı iş/receipt aynı operation'a bağlanır; eski route/release/ortam geri alınır. Aktif süreç salt geçen süreyle sonlandırılmaz. Native phase, config rollback ve recovery kayıtları rutin tedbir yedeği değildir.

Geri alma yalnız aynı uygulamanın retained ve fiziksel sahipliği doğrulanan release'ine yapılır. Eski veya yabancı Unix/root yoluna geçmez. Geri alınan runtime, gerçek process cwd/UID ve HTTP sonucu metadata/binding ile eşleşir. Yeni veri/env drift'i veya belirsiz receipt varsa mutasyon durur.

Kabul kapıları: kaynak başarı/hata/idempotency/tenant/revision/rollback ve crash recovery senaryoları; bağımsız inceleme; `.28` üzerinde ikinci Git release, fiziksel eski/yeni içerik ve process/HTTP/env karşılaştırması, gerçek rollback, iki backup restore ve ardından yalnız test kaynaklarının temizliği. Bu belge uygulamanın tamamlandığına dair kanıt değildir.
