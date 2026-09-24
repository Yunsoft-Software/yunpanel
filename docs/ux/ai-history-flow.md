# AI-HISTORY — Sohbet geçmişi ve bağımsız kaydırma

2026-09-24; başlangıç `development@f6df0401`. BUG-20260923-08 / UX-PL-08. Mevcut AI sağlayıcı/tool/policy motorları ve Ember görsel dili korunur.

- [ ] AH-01: Konuşma listesi/detayı/silme/mesaj işlemlerini sunucuda oturumun actorId'sine bağla. Site hesabında güncel Website yetkisini kontrol et; istemciden actorId kabul etme. Sahibi bilinmeyen eski kayıtları otomatik sahiplenme veya silme.
- [ ] AH-02: Mevcut liste endpoint'ine sınırlı sayfa ve kullanıcı/site kapsamına bağlı imzalı cursor ekle. Değişmeyen oluşturulma zamanı + kimlikle kararlı sıralama; mesaj gelmesi sonraki sayfada atlama üretmesin. Eski dizi cevabı yalnız eski çağrı biçimi için korunur.
- [ ] AH-03: Geçmiş, mesajlar ve mesaj yazma alanını ayrı tut. Kaydırma sonunda veya erişilebilir düğmeyle eski sohbetleri yükle; aktif sohbet/taslak/scroll bozulmasın. Domain URL kimliğini Website kimliği yerine kullanma. Oturum/site değişimi ve geç cevapları sınırla.
- [ ] AH-04: Yapılabilen davranış/depolama/HTTP bağlantısı ve layout kontrollerini çalıştır; gerçek React/auth/provider/host kabulünü ayrı tut.

## Veri koruma

Eski dosyada actorId bulunmayan konuşmalar korunur; kullanıcıya otomatik atanmaz. Güvenilir eski sahiplik kanıtına dayalı açık migration ayrı iştir. Mevcut 100 konuşmalık sınır geçmişi sessizce budama gerekçesi değildir; yeni oluşturma sınırı aştığında mevcut kayıtlar silinmeden görünür hata dönmelidir. Cursor oturum açma veya yetki belgesi değildir; her istek güncel auth ve kapsam filtresinden geçer.

## T-DEV-AI-HISTORY — Gerçek kabul

- [ ] Node24/npm11 tam checkout, lint/test/build; gerçek React/SessionProvider/router ve HTTP/auth/CSRF ile iki kullanıcı ve iki Website sınırları.
- [ ] 20'den fazla konuşma, eşit zaman damgası, eski sayfa sırasında yeni mesaj/yeni sohbet/silme; yinelenen sayfa, cursor değişimi, son sayfa ve hata sonrası açık yeniden deneme.
- [ ] Oturum/yetki/site değişimi, liste/detay geç cevapları, unmount ve kayıp mutation cevapları; başka kullanıcının geçmişi veya yanlış Website bağlamı görünmemeli.
- [ ] 320/390/834/1440 px, yüzde200 zoom, uzun başlık/mesaj, klavye/ekran okuyucu, mobil modal ve arka sayfanın sabitliği; gerçek üretim React/Vite ile doğrula.
- [ ] Sahibi bilinmeyen eski kayıtlar yedeklenip korunmalı; açık sahiplik migration'ı doğrulanmadan erişim açılmamalı. Gerçek provider/tool kabulü bu dilimden ayrı; `.44` hostu hariç, GitHub Actions/canlı deploy yok.
