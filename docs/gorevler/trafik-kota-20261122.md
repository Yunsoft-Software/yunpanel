# .28 trafik ölçümü ve müşteri kotaları kabulü

22 Kasım 2026. Çalışan paket `0.3.0-2026112104`, kaynak `6708dc0753bc8a85f24621c202819670bf79c7ba`. Paket SHA-256 `0fff1b4394707cc37df51e5197011f687969e290787f798cd64a03a8579046c8`. Uygulama ve bağımsız inceleme Antigravity’de Gemini 4 Neon Extra High ile en fazla üç eşzamanlı alt ajan kullanılarak tamamlandı.

## Kaynak ve paket doğrulaması

- İlk tam doğrulamadaki on hata Orkestra T949 kaydında. `DOMAIN_STAGE` doğrulayıcısı yeni Website kimliğini kabul edecek şekilde güncellendi. Site oluşturma sonrası kurtarma ve boş kota tablosunun geri alma işlemi düzeltildi. Odak koşusu ve son tam lint, test ve build geçti. Tam koşu kaydı `9447ff49`, test edilen kaynak `6708dc07`.
- Temiz Ubuntu 24.04 amd64 üzerinde paket kuruldu. API, web ve ters vekil sağlık yanıtları 200 döndü. Yetkisiz yönetim istekleri 401 döndü. Paket içi kaynak kimliği, dosya bütünlüğü ve node-pty ikili mimarisi eşleşti.
- .28 üzerinde aynı paket kuruldu. dpkg denetimi, Nginx yapılandırma testi ve 11 mevcut hizmetin durumu geçti. Panel dışı paketler, Docker envanteri, sekiz uygulama kayıt dosyasının özeti, WAF dosyaları ve nftables kural özeti eşleşti. Sunucu durum kayıt dosyasının özeti değişti. Aktif site, alan adı, uygulama, sertifika, posta ve veritabanı kayıtları kurulumda eşleşti.

## Çalışan paneldeki doğrulama

- `webrich.news` altındaki altı mevcut HTTPS yayını 200 döndü ve her isteğin yanıt baytı ilgili site sayacında görüldü. Mevcut Nginx blokları ve TLS ayarları korunarak erişim günlüklerinde kurulum anından itibaren ölçüm başladı. AppSec sayacı 170’ten 177’ye çıktı.
- Owner oturumuyla geçici statik site açıldı. Nginx 524.288 baytlık CSS dosyasını 200 ile döndürdü. Kasım 2026 sayacı aynı miktarda arttı ve Chrome’da Site Kaynakları ekranı doğrulandı. Site kaydı, fiziksel dizin, site Unix hesabı ve Nginx dosyası silindi.
- Chrome’da panel sağlığı ve CrowdSec engelleme listesi 200 döndü. CrowdSec verisinde bir aktif karar vardı. Mevcut yayınlardaki WAF gözlemde kaldı. Zararsız test kuralının 403 tepkisi ve ayarın geri alınması [CrowdSec ve WAF kabulünde](crowdsec-waf-20261121.md) kayıtlı.

## Kurulu paketten izole gerçek Linux kabulü

- Nginx 1.24, yönetilen ana alan adı ve aliası doğru siteye yazdı. Diğer site ayrı sayıldı. Günlük döndürüldüğünde baytlar eksiksiz korundu. Kota ana alan ve aliasta 429, diğer sitede ve ACME doğrulama yolunda 200 üretti. UTC ay değişiminde ve el ile kapatmada erişim tekrar 200 döndü.
- MariaDB 10.11.14 üzerinde farklı iki siteden eşzamanlı kurulum isteği yapıldı. Biri 202 aldı ve gerçek iş veritabanını oluşturdu. Diğeri kota nedeniyle 409 aldı. Kaybetmiş isteğin veritabanı oluşmadı. Kullanıcı erişimi ve bağlantı kaldırılıp veritabanı silindikten sonra yeni tahsis geçti. Geçici veritabanı kalmadı.
- Gerçek site Unix hesaplarıyla iki eşzamanlı dosya yüklemesinden biri 201, diğeri 409 döndü. Boyutu değişmeyen düzenleme, yer açmak için silme ve sonrasında yükleme geçti. Seyrek dosya ve hard link boyutları hesaba katıldı. Paylaşımlı kökte kota ölçülemediğinde yazma 503 ile durdu. İzole işletim sistemi ve veritabanı alanı temizlendi.
- İlk izole koşular test düzeneğinin WAF nesnesi, MariaDB soket kimlik doğrulaması, bağlantı silme onayı ve özel `/etc` dizin izinleri düzeltilerek tekrarlandı. Kabul çalışması geçici bir veritabanı örneği ve ayrı ağ, işlem ve bağlama ad alanları kullandı. Panelin aktif lisansı ve site verileri bu kabulün dışında kaldı.

## Uygulama kapsamı

Disk kotası paneldeki Dosya Yöneticisi yazmalarını kapsar. .28 ext4 üzerinde işletim sistemi kotası etkin değil. Yeni Nginx yapılandırmaları statik dosyaları ölçer ve isteğe bağlı trafik sınırını uygular. Önceki site yapılandırmaları mevcut erişim günlüklerinden ölçülür. Statik dosyaları saymak ve yeni trafik limitini uygulamak için site yapılandırması panelde yeniden uygulanır. Sayaç geçmiş trafik için doldurulmaz.

Ölçüm ve kotalar yalnız .28 üzerinde doğrulandı. İkinci sunucu isteyen kurtarma, DNS ve geçiş kabulleri [pilot listesinde](../../todo.md#linux-hosting-pilotu-ve-plesk-geçişi) açık. Ham kanıtlar `.local/traffic-quota-20261121/` altında, temiz paket provası `.local/p0-20261121/amd64-candidate-2104/summary.json` içinde.
