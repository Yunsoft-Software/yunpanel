# phpMyAdmin browser handoff UI progress — 2026-09-18

Bu kayıt P0.5 Website-scoped **Open phpMyAdmin** browser akışının main branch kaynak durumunu özetler. Gerçek Ubuntu/package/browser kabulü geçmeden phpMyAdmin production-ready sayılmaz.

## Tamamlanan browser akışı

- `apps/web/src/workspace/phpmyadmin-client.js` eklendi.
  - Handoff protokolü `yunpanel-phpmyadmin-signon-v1` olarak pinlenir.
  - Capability 43 karakter base64url contract'ına, expiry'ye ve exact Server/Website/database credential target'ına karşı fail-closed doğrulanır.
  - Capability query string'e konmaz; yalnız same-origin `POST /tools/phpmyadmin/__yunpanel/signon` form body alanı olarak gönderilir.
  - Signon fetch `credentials: same-origin`, `mode: same-origin`, `cache: no-store` ve `referrerPolicy: no-referrer` kullanır.
  - Form içindeki capability fetch tamamlanınca silinir; local/session storage, history veya React persistent state kullanılmaz.
  - Signon sonrası final response yalnız aynı origin ve `/tools/phpmyadmin/` gateway scope'u içindeyse top-level navigation yapılır.
  - 401/403/503, expired handoff, target drift, network ve invalid redirect durumları secret-free panel hatasına çevrilir; response body veya capability hata metnine/loga taşınmaz.

- `SiteResourcesPanel.jsx` Website database tablosuna credential-bound `phpMyAdmin aç` aksiyonu eklendi.
  - Credential olmayan schema için aksiyon gösterilmez.
  - Read Only / `canManage=false` ve busy database resource durumunda aksiyon kapalıdır; backend Owner gate yine nihai authorization sınırıdır.
  - UI state yalnız açılmakta olan credential kimliğini tutar; capability değeri component state'ine girmez.
  - Loading ve hata durumu mevcut YunPanel component yüzeyinde gösterilir; native alert/confirm/prompt kullanılmaz.

- Mevcut `createPhpMyAdminHandoff(serverId, websiteId, credentialId)` API helper'ı browser akışına bağlandı.
  - İstek yalnız `credentialId` taşır.
  - DB password/root credential browser request'ına eklenmez.

## Kaynak test kapsamı

- `apps/web/test/phpmyadmin-client.test.js`
  - capability'nin URL'ye konmaması,
  - same-origin POST contract'ı,
  - target drift,
  - local expiry,
  - consumed/expired 401,
  - cross-origin redirect rejection,
  - pinned gateway/protocol contract'ını kapsar.
- `apps/web/test/database-client.test.js` handoff API helper'ının exact same-origin route/body/CSRF sözleşmesini kapsayacak şekilde genişletildi.
- `apps/web/test/database-site-ui-wiring.test.js` Website action, management gate ve storage/query leak guard'ını kapsayacak şekilde genişletildi.
- Bu çalışma turunda seçili browser-handoff unit testi yerel Node runner ile çalıştırıldı: **6/6 geçti**.
- Full repository test suite çalıştırılmış değildir. GitHub Actions kullanılmadı.

## Kaldığımız exact nokta

P0.5'te sıradaki kod işi:

1. phpMyAdmin import/export operasyonlarını Website database binding/credential scope'una bağlamak.
2. Vendor import/export'un başka Website schema'sına hedef seçememesini backend ownership contract'ıyla garanti etmek.
3. Mevcut database dump/restore lifecycle'ıyla scope ve evidence modelini tekleştirmek.
4. Sonrasında Database delete'i backup requirement, ownership evidence ve retryable P0.9 compensation lifecycle'ına bağlamak.

## Gerçek ortam acceptance

`todo.md` içindeki T-TOOLS ve T-DATABASE kapıları geçerlidir. Özellikle gerçek HTTPS browser akışında capability'nin URL/storage/referrer'a düşmediği, expiry/replay/logout davranışı, direct phpMyAdmin URL rejection ve Site A -> Site B schema izolasyonu doğrulanmadan özellik production-ready sayılmaz.
