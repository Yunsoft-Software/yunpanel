# phpMyAdmin protected signon / gateway progress — 2026-09-18

Bu kayıt, P0.5 `Open phpMyAdmin` akışının mevcut main branch durumunu özetler. Bu dilim **tam ürün kabulü değildir**; gerçek Ubuntu/package/browser kabulü geçmeden phpMyAdmin production-ready sayılmaz.

## Tamamlanan kaynak katmanları

- Website-bound database credential için ayrı `phpmyadmin-handoff-service` eklendi.
  - Capability 32-byte random base64url değerdir.
  - Default TTL 30 saniyedir.
  - Tek kullanımlıdır; consume denemesinde kayıt silinir.
  - Owner session/user kimliğine ve exact Server/Website/database credential/binding revision state'ine bağlanır.
  - Credential rotation/binding revision drift'i ve latest verified database credential apply evidence uyuşmazlığı fail-closed olur.
  - DB password capability kaydında tutulmaz; yalnız consume anında encrypted credential registry'den materialize edilir.
  - Unused capability live session registry'ye bağlıdır; logout/session revoke ile retire olur.

- Owner-only handoff HTTP boundary eklendi.
  - `POST /api/servers/:serverId/websites/:websiteId/phpmyadmin-handoffs` yalnız authenticated Owner management context'inde capability üretir.
  - Response `Cache-Control: no-store` / `Pragma: no-cache` taşır.
  - Password veya root credential browser response'una girmez.
  - Read Only bu mutation'ı kullanamaz.

- phpMyAdmin vendor gateway için Owner access gate eklendi.
  - `GET /api/phpmyadmin-gateway-access` yalnız canlı Owner management session'ını kabul eder.
  - Web gateway her `/tools/phpmyadmin/...` isteğinden önce bu gate'i kontrol eder.
  - Direct vendor TCP portu açılmaz; upstream `/run/yunpanel/phpmyadmin-http.sock` Unix socket'idir.
  - Mutating proxy istekleri same-origin kontrolünden geçer.
  - Vendor redirect/location ve cookie path davranışı `/tools/phpmyadmin/` scope'una rewrite edilir.

- DB secret consumer public HTTP ağacından ayrıldı.
  - API process `/run/yunpanel-phpmyadmin/handoff.sock` üzerinde private Unix socket consumer başlatır.
  - Runtime directory `root:yunpanel-phpmyadmin 0750`, socket `root:yunpanel-phpmyadmin 0660` sınırındadır.
  - phpMyAdmin runtime user genel `/run/yunpanel` grubuna eklenmez.
  - Socket runtime ayağa kalkamazsa public handoff issuance route mount edilmez; özellik fail-closed kalır.
  - Debian postinst ve tmpfiles policy reboot/install sırasında runtime dizinini aynı metadata ile hazırlar.

- Supported phpMyAdmin signon template/bridge eklendi.
  - `auth_type = signon`.
  - `AllowRoot = false`, `AllowNoPassword = false`.
  - Signon session ayrı isim ve `/tools/phpmyadmin/` cookie path kullanır.
  - Exact internal signon ve logout route'ları vardır.
  - PHP bridge capability'yi private handoff socket'e POST ederek tüketir.
  - phpMyAdmin session'ına yalnız scoped DB user/password/host ve `only_db` restriction yazılır.
  - Root credential signon session'a verilmez.
  - Logout bridge signon session/cookie state'ini temizler.

- Nginx phpMyAdmin template'i signon/logout bridge contract'ını içerir.
  - Signon exact route yalnız POST.
  - Logout exact route yalnız GET.
  - Bridge document root dışında sabit managed path'ten FPM'e verilir.
  - Genel PHP route'u ayrı kalır.

- phpMyAdmin staging / backup / activation transaction'ı signon artifact'larına genişletildi.
  - FPM, Nginx, signon config ve signon bridge deterministic preview/staging contract'ına dahildir.
  - Backup manifest dört artifact'ın previous presence/content/uid/gid/mode state'ini kapsar.
  - Activation PHP syntax + FPM/Nginx config validation, reload, socket/HTTP health ve rollback zincirine signon artifact'larını dahil eder.
  - Signon bridge directory permission contract'ı ayrıca doğrulanır.

- Web client katmanında `createPhpMyAdminHandoff(serverId, websiteId, credentialId)` helper'ı eklendi.

## Kaynak test kapsamı

Main branch'te handoff service, Owner HTTP boundary, private socket consumer, signon template, signon staging, four-artifact rollback/activation, Owner-gated reverse proxy, scoped cookie ve logout contract'ı için test dosyaları bulunmaktadır.

Bu oturumda full repository test suite çalıştırıldığı iddia edilmez. GitHub Actions kullanılmadı.

## Kaldığımız exact nokta

Kod tarafındaki bir sonraki küçük dilim:

1. Website Databases UI'daki **Open phpMyAdmin** aksiyonunu mevcut `createPhpMyAdminHandoff(...)` helper'ına bağlamak.
2. Browser'a yalnız capability döndürmek.
3. Capability'yi GET/query string'e koymadan `/tools/phpmyadmin/__yunpanel/signon` adresine POST etmek.
4. Başarılı signon sonrası `/tools/phpmyadmin/` vendor UI'ını açmak.
5. Error/loading/expired handoff durumlarını özel panel UI ile göstermek; native alert/confirm kullanmamak.
6. DB password, root credential veya private handoff payload'ını React state persistence, URL, local/session storage, audit veya loga sokmamak.

Bundan sonra P0.5'te kalan ürün işleri phpMyAdmin import/export scope binding ve Database delete backup/ownership/compensation lifecycle'ıdır.

## Gerçek ortam acceptance

`todo.md` içindeki T-DATABASE/phpMyAdmin kabul kapıları halen geçerlidir. Özellikle gerçek Ubuntu 24.04 üzerinde package/FPM/Nginx/socket permissions, Owner gate, capability expiry/replay/logout, direct URL rejection, Site A -> Site B schema isolation ve secret leakage kontrolleri geçmeden bu capability `DONE` veya production-ready sayılmaz.
