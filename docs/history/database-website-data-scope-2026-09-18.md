# Website database data scope progress — 2026-09-18

Bu kayıt P0.5'te phpMyAdmin vendor import/export sınırı ile YunPanel vendor dump/restore lifecycle'ının aynı Website ownership kimliğine bağlandığı source durumunu özetler. Gerçek Ubuntu/MariaDB/phpMyAdmin/browser kabulü geçmeden production-ready sayılmaz.

## Tamamlanan ownership sınırı

- phpMyAdmin signon bridge yalnız short-lived capability kabul eder; request'ten schema adı almaz.
- Consume edilen handoff içindeki doğrulanmış `databaseName`, phpMyAdmin signon session'ında `only_db` olarak materyalize edilir.
- phpMyAdmin root ve passwordless login kapalı kalır; signon credential Website database credential/grant kapsamıdır.
- Böylece vendor phpMyAdmin import/export yüzeyi Site A handoff'ıyla Site B schema seçimini kullanıcı inputundan türetemez.

## Website-scoped vendor backup/restore

Yeni canonical route'lar:

- `POST /api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId/backup`
- `POST /api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId/restore-preview`
- `POST /api/servers/:serverId/websites/:websiteId/database-bindings/:bindingId/restore`

Bu route'larda:

- `databaseName` request body'den alınmaz; Server -> Website -> DatabaseBinding zincirinden backend'de türetilir.
- Binding'in `serverId`, `websiteId`, `applicationId` ve `revision` ownership state'i exact doğrulanır.
- Browser mutation yalnız `bindingId + expectedBindingRevision` ve restore için backup/digest confirmation taşır.
- Password, root credential, SQL, dump path veya caller-selected schema request/public result yüzeyine eklenmez.
- Backup job payload'ı durable ownership evidence olarak `websiteId + databaseBindingId + expectedBindingRevision` taşır.
- Restore preview aynı ownership scope'unu deterministic digest'e dahil eder.
- Restore, seçilen backup job'ın exact aynı Website/binding/revision evidence'ına sahip olmasını zorunlu tutar; başka Website veya stale binding backup'ı 409 ile reddedilir.
- Global `/databases/:name/backup|restore*` route'ları managed Website binding'i olan schema için 409 ile scoped route kullanımını zorunlu tutar. Unbound/admin database yönetimi için legacy global yüzey korunur.
- Read-light job adapter'ında scoped backup route'u mount olmaya devam eder; durable backup evidence lookup bulunmuyorsa restore route'ları fail-closed biçimde mount edilmez.

## Website UI

- `SiteResourcesPanel` artık backup ve restore için yalnız Website-scoped client'ı kullanır.
- UI backup listesi yalnız aynı `serverId + databaseName + websiteId + bindingId + bindingRevision` payload evidence'ına sahip successful backup job'ları gösterir.
- Unscoped eski job, başka Website backup'ı veya önceki binding revision restore seçeneği olarak gösterilmez.
- Restore preview response'u top-level ownership evidence + backend `scope` objesiyle tekrar doğrulanır.
- Eski global `createDatabaseBackup / previewDatabaseRestore / restoreDatabase` çağrıları Website kaynak panelinde kalmamıştır.

## Protocol ve source test kontratı

- `database.backup` legacy payload'ı korunur; Website scope kullanıldığında `websiteId + databaseBindingId + expectedBindingRevision` üçlüsü all-or-none zorunludur.
- `database.restore` aynı optional ownership üçlüsünü taşır.
- Partial scope, invalid UUID ve non-positive revision protokol katmanında reddedilir.
- phpMyAdmin template testi signon POST'un yalnız capability kabul ettiğini, `databaseName` POST alanı bulunmadığını ve `only_db` değerinin consume edilmiş handoff data'sından üretildiğini pinler.

## Bu çalışma turunda geçirilen Actions'sız kapılar

- Güncel main'deki 6 kritik düz-JS source modülü V8 parser ile yeniden derlendi: syntax temiz.
- İlgili backend/client/model/protocol test source'ları parser kapısından geçirildi; `import.meta.url` kullanan UI static test modül bağlamı nötrlenerek ayrıca syntax temiz doğrulandı.
- Database model scope mantığı doğrudan çalıştırıldı:
  - exact binding backup -> 1 restore seçeneği,
  - stale revision -> 0,
  - unscoped eski backup -> 0,
  - exact scoped restore preview -> kabul,
  - revision veya backend scope drift -> reject.
- Protocol validator doğrudan çalıştırıldı:
  - legacy backup -> kabul,
  - exact scoped backup/restore -> kabul,
  - partial scope -> reject,
  - revision 0 -> reject.
- Website data route doğrudan fake registry/job adapters ile çalıştırıldı:
  - exact scope backup -> 202,
  - stale binding revision -> 409,
  - cross-Website binding -> 404,
  - restore preview ownership argümanları exact Website/binding/revision taşıdı.
- Website API client doğrudan çalıştırıldı; scoped URL/body contract'ında caller-selected `databaseName`, password, SQL veya dump path bulunmadığı doğrulandı.
- GitHub Actions kullanılmadı.
- Container'ın `github.com` DNS erişimi kapalı olduğu için full repository checkout/suite bu turda koşturulamadı.

## Gerçek ortam acceptance

`todo.md` içindeki T-DATABASE kapıları geçerlidir. Özellikle:

- gerçek phpMyAdmin import/export ile Site A session'ı Site B schema'yı görememeli/seçememeli,
- Website-scoped vendor dump job'ı durable ownership evidence'ını korumalı,
- stale/cross-site backup gerçek HTTP akışında restore edilememeli,
- checksum/consistency/pre-restore snapshot/rollback gerçek MariaDB/MySQL hostunda doğrulanmalı,
- restart/upgrade sonrası binding/job evidence korunmalı.

## Kaldığımız exact nokta

P0.5'te sıradaki kod işi Database delete lifecycle'ıdır:

1. delete eligibility için latest backup'ın **current Website binding revision** ownership evidence'ını zorunlu kıl,
2. credential revoke -> binding lifecycle -> schema drop sırasını explicit durable step'lere ayır,
3. host mutation/evidence kesintilerini P0.9 retryable compensation modeliyle fail-closed yönet,
4. pre-existing/unmanaged schema ve başka Website ownership state'ine destructive cascade yapılmasını engelle.
