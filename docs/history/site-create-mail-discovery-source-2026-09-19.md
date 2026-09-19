# Fresh Website mail discovery source lifecycle — 2026-09-19

Bu kayıt, local-mail Website için autodiscover/autoconfig source lifecycle'ının ana Website TLS route'una, private Unix-socket servisine, DNS readiness evidence'ına ve final mail health gate'ine bağlandığı dilimi özetler.

## Kaynakta tamamlananlar

- Local-mail Website Nginx intent'i sabit `/run/yunpanel-mail-discovery/discovery.sock` upstream ownership'ini taşır; external/none mail modları bu route'u üretmez.
- Nginx template yalnız TLS Website server block'unda exact discovery yollarını application route'unun önüne alır:
  - `/autodiscover/autodiscover.xml`
  - `/mail/config-v1.1.xml`
  - `/.well-known/autoconfig/mail/config-v1.1.xml`
- HTTP tarafı normal ACME/redirect ownership'ini korur; discovery servisi doğrudan public TCP port açmaz.
- Public discovery response service exact enabled local Mail Domain + active managed-TLS Web Domain + ready shared mail-service identity scope'unda Thunderbird autoconfig ve Outlook-style autodiscover XML üretir. İstenen email adresi exact domain ile eşleşmeden response dönmez.
- Discovery HTTP runtime root-owned `/run/yunpanel-mail-discovery` altında, `www-data` group erişimli, bounded request/body ve strict path/method/content-type kurallarıyla Unix socket üzerinde çalışır.
- Endpoint resolver discovery socket health'ini, service state'ini ve exact succeeded Website `nginx + tls_activation` provisioning evidence'ını birlikte doğrular.
- Discovery endpointleri ana Website hostname'i üstünde HTTPS path olarak resolve edilir; bu nedenle `autodiscover.<domain>` / `autoconfig.<domain>` için ayrı sertifika bootstrap döngüsü gerekmez.
- DNS mail desired-state apex discovery readiness evidence'ını kabul eder ve apex Website A/AAAA kayıtlarını duplicate etmez. Dedicated discovery hostname ancak resolver gerçekten o hostname'i döndürürse ayrı A/AAAA üretilebilir.
- Production bootstrap discovery service/socket/resolver'ı kurar, DNS mail intent resolver'a bağlar ve shutdown'da socket'i güvenli kapatır. Socket açılamazsa fallback resolver `null` döndürür.
- Final required `mail_health` gate artık Roundcube yanında exact autodiscover + autoconfig endpoint readiness evidence'ını da zorunlu tutar; discovery runtime unavailable ise Website `ready` olmaz.

## İlgili commitler

- `79a4b96`, `5be4984`, `949dca3`, `b477072`, `38fd1f0`, `cce93e9`, `01c60c1`, `0a58913` — TLS-only Nginx discovery route contract ve provisioning ownership.
- `05c981f`, `311ad3d`, `0afe4e0` — discovery response service.
- `65e1f6e`, `b1fbfc1` — managed Unix-socket runtime.
- `bcb7d5d`, `34c4ad7` — discovery endpoint readiness resolver.
- `60ddbb9`, `a107743`, `0f21a7a` — apex discovery DNS readiness semantics.
- `10a80e6` — production discovery runtime wiring.
- `6a9ea54`, `c86c7d9`, `29edbaf`, `859f11a`, `42bba1f` — discovery readiness'ı final `mail_health` gate'ine bağlama.

## Açık kalan kabul sınırı

Source lifecycle tamamlandı; ürün kabulü için gerçek Ubuntu/public network üzerinde şu doğrulamalar hâlâ gereklidir:

- gerçek Nginx → Unix socket proxy üzerinden Thunderbird autoconfig response,
- gerçek Outlook/mail-client autodiscover davranışı,
- ana Website managed certificate ile public HTTPS discovery erişimi,
- enabled mailbox ile IMAP/submission authentication,
- Roundcube login, inbound/outbound delivery, DKIM/SPF/DMARC ve failure/restart acceptance.

Bu sohbet ortamında repository checkout/Node 24 runner olmadığı için hedefli testler ve full `npm run check` çalıştırılmadı; ilgili kapılar `todo.md` içinde açık tutulur.
