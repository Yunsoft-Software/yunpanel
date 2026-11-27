# Test kalıntısı temizliği — 28 Kasım 2026

Kapsam: kullanıcının açıkça istediği eski e2e test kalıntılarının test sunucusundan (`.28`) temizlenmesi. Plesk sunucusuna dokunulmadı. Kilit: `sunucu-28-2` (CLEANUP). O sırada çalışan senior denetiminin (`sunucu-28-3`) kaynaklarına ve 27 Kasım ve sonrasında oluşan hiçbir şeye dokunulmadı.

## Sonuç özeti

| Kategori | Önce | Sonra | Yöntem |
|---|---|---|---|
| Docker Compose projeleri (`tdkr0x_a*`, `ypaudit_mw*`) | 29 | 0 | Panel (önizleme + onay ile kaldırma) |
| Durmuş `ypaudit_mw*-web-1` konteynerleri | 6 | 0 | Panel kaldırmasıyla gitti |
| `ypaudit_mw*_default` ağları | 6 | 0 | Panel kaldırmasıyla gitti |
| Sahipsiz `tdkr03_*` / `tdkr06_*` volume'ları | 16 | 0 | Docker CLI, yalnız tam adlarla |
| `tdb04_*` veritabanları (şema + kayıt) | 24 | 3 | Panel silme akışı; kalan 3 T968'e bağlı |
| `tdb04_*` MariaDB kullanıcıları | 21 (3'ü zaten yoktu) | 0 | Panel kimlik bilgisi silme akışı |
| Bağlantısız alan adları (`dom-test-6792.site`, `dom-test-6704.site`) | 2 | 0 | Panel kaldırma akışı (senior, kilit boşalınca) |
| Sahipsiz etkin Nginx dosyaları | 18 | 0 | Yedek sonrası kaldırma, `nginx -t` + reload (senior) |
| `staging/nginx` kök `.conf` dosyaları | 987 | 204 | Yedek sonrası tek tek silme |

## Ayrıntılar

### Docker
- 29 projenin hepsi panelden kaldırıldı ve kayıttan düştü (404 doğrulandı). Sunucuda bu adlarla konteyner ve ağ kalmadı.
- 16 volume bu 29 projeye ait değildi. 6 Kasım'da panelden kaldırılan başka `tdkr03_*`/`tdkr06_*` projelerinden kalmışlardı. Kullanan konteyner yoktu. Proje kaydı silindiği için panelde bunları silecek yol yoktu, Docker CLI ile tam adlarıyla silindiler.
- **Ürün bulgusu:** Compose projesini kaldırma adlandırılmış volume'ları bırakıyor. Volume silme yalnız proje içinden yapılabildiği için proje kaldırıldıktan sonra volume'lar panelden görünmüyor ve silinemiyor.

### Veritabanları
- 21 veritabanı panelin akışıyla silindi: kimlik bilgisi silme ve sonlandırma, ardından veritabanı yedeği, silme ve sonlandırma. Şema, MariaDB kullanıcısı, bağlantı ve kimlik bilgisi kayıtlarının gittiği sunucuda doğrulandı.
- 3 veritabanında panel reddetti ve orada durdum: `tdb04_a3_mvqgctuk`, `tdb04_a3_mw50g4j5`, `tdb04_a3_mw518gcu`. Hata: kimlik bilgisi silme isteği `409 job_authorization_conflict`. Neden: 6 Kasım'da başka bir oturum aynı kimlik bilgisi silme işini çalıştırmış ve iş başarıyla bitmiş, ama sonlandırma yapılmamış. Aynı iş anahtarı başka oturuma bağlı olduğu için yeni oturum işi yeniden başlatamıyor. MariaDB kullanıcıları zaten yok, şemalar ve kayıtlar duruyor. Eski işten sonlandırma denemesi yapılmadı. Senior kararı gerekiyor.
- Silme akışı her veritabanı için önce panel yedeği alıyor. Bu yedekler panelin kendi kayıtlarında duruyor.
- Bu kapsam dışında kalan `tdb02_*` (17) ve `tdb03_*` (6) veritabanları da aynı sitede duruyor. Dokunulmadı.

### Alan adları
- Depoda `dom-test-6792.site` veya `dom-test-6704.site` bekleyen bir test yok; yalnız `tasks/done/T872.md` notunda geçiyor. Önizlemede engel yoktu.
- T883 koşusu bitip kilit boşalınca ikisi de panelin kaldırma akışıyla silindi (`removed`).

### Sahipsiz etkin Nginx dosyaları (18): kaldırıldı
- Alan adları yalnız tamamlanmış (`removed`) kaldırma günlüklerinde, `retired` sertifika kayıtlarında ve geçmiş envanterde geçiyor; canlı alan adı veya site kaydında yok. Senior ön koşulu "canlı alan adı/site kaydında yok" olarak daralttı ve hemen öncesinde yeniden doğruladı.
- Önce yedeklendi (`nginx-enabled/sites-enabled-orphans.tar.gz`, sha256 `98bb94f5b45308d585bfdbe62367f1143338320b206b685728aa4d432a04025b`), sonra kaldırıldı; `nginx -t` başarılı, `nginx` yeniden yüklendi. Ana siteler ve panel öncesinde ve sonrasında 200.
- **Ürün bulgusu (T970):** Bu sitelerin kaldırılması panelde `removed` olarak bitmiş, ama etkin Nginx dosyası `sites-enabled` içinde kalmıştı (2–9 Kasım sürümleri).

### Ayrıca
- 26 Kasım'da kopan tls-01 koşusunun bıraktığı `ttls01-a1-mwxqi5xm` sitesi ve senior'ın durdurduğu ilk T883 koşusunun bıraktığı `ypaudit-t887-dns-hosting-cr-w1-…` sitesi panelin silme akışıyla kaldırıldı.
- Son okumada `ypaudit-` önekli site, alan adı, uygulama, DNS bölgesi, posta alan adı, yedek deposu, nginx dosyası ve Unix kullanıcısı 0.
- Ürün bulguları: T968 (başka oturumda başlayan kimlik bilgisi silmesi sonlandırılamıyor), T969 (Compose volume'ları), T970 (nginx hazırlık ve etkin dosya artıkları).

### Nginx hazırlık dizini
- Ürün bu dizini etkinleştirme için okuyor. `deactivation/` ve `rollback/` alt dizinleri olduğu gibi kaldı. Alan adı kaldırılınca hazırlık dosyası silinmiyor. Bu da birikmenin nedeni (**ürün bulgusu**).
- Tutulanlar: etkin olan 27 dosya, kayıttaki 1 hazırlık dosyası, 27 Kasım ve sonrasında değişen 11 dosya ve senior denetimine ait 164 dosya.
- Silinenler: kalan 784 dosya. Hiçbiri canlı bir alan adı, site veya açık işlemle ilişkili değil. Silinen dosya listesi yedek klasöründe.
- Bu adım Nginx'i yeniden yüklemiyor. `nginx -t` başarılı.

## Yedek
- Klasör: `/var/backups/yunpanel-leftovers-20261128/` (yalnız root)
- `staging-nginx.tar.gz` — sha256 `b44a7f249a890fde39262acb9f9c09a86a562687665ebc65d8c5603f2a039394` (dizinin tamamı, 3585 kayıt)
- `staging-removed-list.txt` — silinen 784 dosyanın adı

## Sağlık kontrolleri
- Önce: `yunpanel-api`, `yunpanel-web` ve `nginx` servisleri `active`, `nginx -t` başarılı. webrich.news, yp-node, yp-wp ve panel `/api/health` 200.
- Sonra: servisler `active`, `nginx -t` başarılı, dört adres de 200.

## db-04 testi
- Neden kalıntı bırakıyordu: temizlik kodu var olmayan `/api/panel/servers/:id/websites` yolunu kullanıyordu (404). Bu yüzden hiçbir siteyi bulamıyor ve hiçbir şey silmiyordu. Bulsa bile yalnız kimlik bilgisi silme işini kuyruğa koyuyordu. Sonlandırma, yedek ve veritabanı silme adımları yoktu. Değişiklik isteklerinde `Origin` başlığı da gönderilmiyordu. Ayrıca ikinci test sunucu kimliği olarak bu yolların kabul etmediği `local` değerini saklıyordu.
- Düzeltme (`e2e/ozellik/db-04.spec.js`, yalnız `afterAll`): çalışmanın oluşturduğu tam veritabanı adını, seçilen siteden ya da `/api/panel/websites` listesinden buluyor. Sonra panelin silme akışını uyguluyor: kimlik bilgisi silme ve sonlandırma, yedek, veritabanı silme ve sonlandırma. Başarısız adım uyarı olarak loglanıyor. Testlerin doğrulamaları değişmedi.
- `npm run lint` geçti. `node --check` ve `playwright --list` sorunsuz. Test `.28` üzerinde koşulmadı. phpMyAdmin kurulum adımı olduğu için senior kilidinin boşalması bekleniyordu.
