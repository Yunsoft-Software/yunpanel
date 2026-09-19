# Antigravity Branch İncelemesi ve Canlı Boot Kabulü — 2026-09-20

## Kapsam

`19-09-2026` branch'i yerel `main` ile karşılaştırıldı ve branch'in ilk 11 commitindeki kaynak ilerlemesi incelendi. Canlı kabul yalnız repo dışı `.local/test-server.env` dosyasında tanımlı `157.180.11.28` hostunda yapıldı. `.44` ile biten Plesk sunucusuna hiçbir bağlantı veya işlem yapılmadı.

## Branch'te gelen kaynak dilimleri

- Domain removal HTTP/production wiring ve reverse-order Website removal lifecycle.
- Certificate material retention/GC ve delete impact/evidence zincirleri.
- Transactional Website provisioning preflight, exact preview ve TLS compensation.
- Website cron durable job/receipt/reconciliation ve authenticated CRUD API.
- Site-user sınırında WP-CLI/Composer adaptörü ve API yüzeyi.
- Redis/Memcached isolation policy, registry ve API yüzeyi.
- Persisted system settings backend/API ve bağlı frontend panelleri.
- Passenger log/startup/path validation dilimi.

Branch, `main` üzerinde ilk incelemede 11 commit ve yaklaşık 9.895 eklenen satır taşıyordu. `plan.md`, P0.8 transactional provisioning ve P0.9 removal kaynak işlerini tamamlanan açıklamalara çevirmiş; P1.4 site features/settings listesini kaldırmış ve gerçek-host kabul kapılarını `todo.md` içine taşımıştı. Passenger P1.1 maddesi açık bırakılmıştı; bu doğrudur, çünkü eklenen helper gerçek Passenger paketi/Node binary health kabulünü yapmıyordu.

## İnceleme sırasında düzeltilen üretim kusurları

Kaynak testleri ilk çalıştırmada yeni Passenger testindeki reserved `PORT`, geçersiz operation kimliği, gerçek filesystem ownership varsayımı ve yanlış compensation inspector kullanımı nedeniyle geçmedi. Test gerçek kontrata düzeltildi ve Passenger history belgesindeki dependency/golden-path tamamlandı iddiası daraltıldı.

Canlı paket boot denemeleri üç ayrı production wiring kusurunu gösterdi:

1. Job-backed cron/settings servisleri `jobRegistry` initialize edilmeden kuruluyordu (`ReferenceError`).
2. PHP tools ve cache servisleri test mock'larındaki `get()` metodunu bekliyordu; gerçek registry kontratları `getWebsite()` ve `getApplication()` sunuyordu.
3. PHP/cache HTTP route'ları projede olmayan factory biçimli `operator` guard'ını bekliyor ve `core.requirePanelRouteAccess` üzerinden `undefined` alıyordu. Route'lar mevcut ortak panel guard'ına ve gerçek Owner/read-only auth modeline bağlandı.

Her sağlıksız kurulumdan sonra önceki `0.3.0-2026091903` paketi geri kuruldu ve servislerin çalıştığı doğrulandı. Son düzeltmeler production registry composition, initialization order, ortak panel guard ve gerçek `request.auth` bağlamını kapsayan regresyon testleriyle korundu.

## Build ve canlı kanıtı

- Yerel ve temiz Ubuntu build ortamında repository policy, bütün workspace testleri ve web build geçti. Vite yalnız mevcut 500 kB chunk uyarısını verdi.
- Son kaynak commit'i: `fcb3517c`.
- Son kaynak arşivi SHA-256: `d1f46601cec007d643b64768d085fb986214323158e2e243f95ca86ba57c66ba`.
- Son Debian paketi: `yunpanel 0.3.0-2026092004` (`amd64`).
- Son paket SHA-256: `37656a441b921b336158ff460acf23fdb96ce109bb9924396f2b07ba029b061d`.
- Kurulum öncesi resmi migration backup yeniden doğrulandı: `/var/backups/yunpanel/migration-2026-09-19T21-07-31-369Z`, SHA-256 `22525c9237f393053996b37bbc649e79bc2d225f01fe02b35e2ec042c530bdad`, `sourcesPresent=6`, `sourcesMissingOptional=3`.
- `yunpanel-api`, `yunpanel-web` ve `nginx` active; `/api/health` 200; `nginx -t` başarılı.
- Local runtime validation geçti: `executionMode=local`, `apiHealth=true`, `activeJobs=0`, `recoveryJobs=0`, inventory/services present.
- `yun-agent` inactive ve disabled.
- `dpkg -V yunpanel` herhangi bir paket bütünlüğü farkı bildirmedi; final API başlangıcından sonra TypeError, ReferenceError, SyntaxError veya servis crash kaydı yok.
- `https://cryptoraichu.website/` 200 ve login ekranı tarayıcıda render edildi. Public health 200; anonim `/api/panel/settings` isteği 401 döndü.

Bu kabul boot, package integrity, anonymous auth boundary ve login render smoke kapsamındadır. Branch'te eklenen destructive removal, gerçek Redis/Memcached izolasyonu, WP-CLI/Composer, Passenger migration ve transactional provisioning akışlarının tam gerçek-host/failure-injection kabulü tamamlanmış sayılmaz; ilgili kapılar `todo.md` içinde açık kalır.
