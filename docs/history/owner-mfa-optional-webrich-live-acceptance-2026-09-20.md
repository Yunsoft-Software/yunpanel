# Owner MFA tercihi ve `webrich.news` canlı kabulü — 2026-09-20

## Kapsam ve güvenlik sınırı

- Yalnız `.local/test-server.env` içinde açıkça tanımlı `157.180.11.28` test hostuna SSH/package işlemi yapıldı; `.44` Plesk hostuna bağlantı veya işlem yapılmadı.
- Kullanıcının talebiyle `.28` geliştirme hostunda `YUNPANEL_OWNER_MFA_REQUIRED=false` yapıldı. Mevcut Owner MFA kaydı yerel kurtarma CLI'ı ile kaldırıldı; parola değiştirilmedi. MFA sıfırlaması önce doğrulanmış, root-private auth yedeği alınarak yapıldı. Eski MFA recovery kodları ve oturumları geçersizdir. Geliştirme sürecinde `.28` üzerinde MFA tekrar açılmayacak veya kod istenmeyecek; kural `agents.md` içindedir.
- Policy kodu Owner MFA'yı açıkça isteğe bağlı yapar. Varsayılan `true` kalır; `.28` için açık `false` kullanılır. HTTPS Owner oturumu, host-only HttpOnly Secure cookie, Origin, CSRF, rol ve yetki kontrolleri kaldırılmadı.
- Owner giriş bilgileri repoya yazılmadı. Parola teslim dosyası yalnız ignored `.local/yunpanel-owner-password-only.json` içinde `0600` modundadır. Geçici MFA erişim dosyaları kaldırıldı.

## Kod ve test kanıtı

- MFA policy, HTTP/WebSocket auth boundary, dokümantasyon ve CLI reset mesajı güncellendi. `node --test apps/api/test/mfa-cli.test.js`, Owner MFA HTTP odak testleri ve son kod için `npm run check` geçti.
- Canlı `https://server.cryptoraichu.website/` üzerinde parolalı Owner HTTPS API girişi `200`, MFA state `enabled=false`, yönetim API'si `200`, yanlış CSRF `403`, logout `204` verdi. Anonim session `401` kaldı. Bu otomasyon gerçek tarayıcı formuna parola girme testi değildir; Chromium/Firefox geniş auth kabulü `todo.md` içinde kalır.
- İlk `webrich.news` provisioning denemesinde root servis umask'ı yüzünden systemd drop-in dosyası beklenen `0644` yerine daha kısıtlı modda yazıldı. `service-umask-manager` geçici dosyaya açık `chmod` uygulayacak şekilde düzeltildi ve kısıtlı umask regresyon testi eklendi.
- İkinci denemede Nginx reload dönüşü ile elFinder Unix soketinin oluşması arasında yarış görüldü. Gateway 5 saniyeye kadar yalnız bu soketi bekleyecek şekilde düzeltildi; gecikmeli soket testi eklendi. İki başarısız adım yalnız operation-bound explicit retry üzerinden devam ettirildi.

## `.28` kurulum ve domain kanıtı

- Doğrulanmış migration yedekleri korunarak `0.3.0-2026092012` Debian paketi, kaynak commit `2ecdb4a2` ile kuruldu. Paket SHA-256: `e1704e3f7ee8b1a31d17d914bc029b5f103d93ceeed8a408395311a02f143679`. `dpkg -V`, API/web/Nginx/PowerDNS servisleri, runtime validate ve `nginx -t` geçti. `server.cryptoraichu.website` dış HTTPS isteği `200`, TLS doğrulaması başarılı.
- `cryptoraichu.website` Namecheap BasicDNS üzerinde kaldı; yalnız `server`, `ns1`, `ns2` A kayıtları `.28` adresini gösteriyor. Personal nameserver kayıtlarında `ns1.cryptoraichu.website` ve `ns2.cryptoraichu.website` IP'leri `.28` olarak düzeltildi. `webrich.news` Namecheap Custom DNS bu iki NS'ye ayarlandı; altı `.news` parent authoritative sunucusunda delegation görüldü.
- Aynı `.28` hostu iki NS adını da yanıtlıyor. Bu bir test delegasyonudur, iki bağımsız DNS ucu/failover kanıtı değildir; ilgili kabul maddesi `todo.md` içinde açık.
- PowerDNS authoritative UDP/TCP yanıtı `webrich.news` için SOA/NS/A döndürüyor; A `.28`. P0 PowerDNS paketleri, gsqlite3 veri dosyası/izinleri, `pdns_server --config=check`, servis/paket sonrası runtime doğrulaması ve site zone API apply geçti.
- `webrich.news` PHP/local-DNS Website Owner preview ve apply ile oluşturuldu. Website ID `2689cb56-55a4-50c0-a3a4-258c7f2d48dd`, Domain ID `e63c3342-787d-5222-8b24-8db2de9834cc`, provisioning operation `7658a928-be59-4d84-b297-87687d01c3b1`. Provisioning `ready 11/11`; dedicated kullanıcı `yunapp-a404896cf12e`; isolation audit `isolated`. Önceden var olan zone için persisted DNS evidence `created=false`, `changedRrsetCount=0`; zone korunarak kullanıldı. `.28` IP'ye sabitlenen dış HTTP isteği `webrich.news` için `200`, `text/html; charset=UTF-8` döndü.
- Bu test Website'i bilinçli olarak HTTP (`httpsMode=off`), mail ve veritabanı olmadan oluşturuldu. Website HTTPS/ACME, mail, backup/restore, çoklu bağımsız authoritative DNS ve tüm tarayıcı/tool kabulü bu raporla tamamlanmış sayılmaz.
