# Fresh Website shared Roundcube provisioning progress — 2026-09-19

Bu kayıt, fresh local-mail Website oluşturma zincirinde shared Roundcube `webmail.<domain>` mapping'inin durable provisioning operation'a bağlandığı kaynak dilimini özetler.

## Kaynakta tamamlananlar

- Local mail planı artık required `roundcube_mapping` step'ini exact Server/Website/Web Domain/Mail Domain ownership intent'iyle üretir.
- Website provisioning runtime shared Roundcube mapping registry/service, endpoint resolver ve durable job registry ile `roundcube_mapping` handler'ını production bootstrap'ta bağlar.
- Handler yalnız enabled local Mail Domain + exact Website-owned Web Domain altında çalışır; mapping bind/apply operation ID sahipliğini korur.
- Pending mapping inspect yolu başarılı shared apply job evidence'ını mutation replay etmeden reconcile eder.
- Apply job hiç dispatch edilmemiş veya terminal failure/cancel durumundaysa inspect açık `retryable` evidence üretir; generic provisioning orchestrator yalnız inspect'in retry güvenliğini açıkça kanıtladığı durumda step'i explicit retry bekleyen failed state'e geçirir.
- Local authoritative mail DNS planı shared Roundcube mapping sonrasında ayrı required `webmail_dns_reapply` step'i üretir. Böylece `webmail.<domain>` DNS desired state'i Roundcube apply evidence'ından önce hazır sayılmaz.
- Certificate registry artık `purpose: web|webmail` ayrımını taşır. Domain'in normal seçili web sertifikası yalnız `web` purpose ile yönetilir; `webmail` purpose kaydı Domain selection'ını bozmaz.
- Fresh Website ana certificate handler'ı da yalnız `web` purpose sertifikalarını sahiplenir/çatışma olarak değerlendirir ve yeni kaydı explicit `purpose: web` ile üretir.

## İlgili commitler

- `47a64cd` — Website Roundcube provisioning handler.
- `894ca29` — fresh local-mail plana shared Roundcube mapping.
- `a22c1f7` — Roundcube sonrası webmail DNS re-apply.
- `27da195`, `7e844c9` — runtime ve production bootstrap wiring.
- `99668ef`, `7616eed`, `3f46ca1` — inspect-proven explicit retry semantics.
- `8704e1a`, `87586a7`, `cb304ef` — web/webmail certificate-purpose ayrımı ve legacy web compatibility.
- `1714148` — fresh Website certificate handler'ını web purpose sınırına alma.
- `f9e79a5` — web/webmail purpose regression testi.

## Açık kalan sınır

Fresh local-mail journal artık shared Roundcube bind/apply ve webmail DNS re-apply step'lerini içerir; ancak dedicated `webmail.<domain>` certificate selection/issuance lifecycle'ı henüz ayrı durable step değildir. Mevcut Roundcube handler operation-owned certificate evidence'ı ister ve mapping service hostname coverage fence'i uygular; ana Website sertifikası `webmail.<domain>` kapsamıyorsa flow açık blocker ile durur.

Sıradaki kaynak işi, `purpose: webmail` sertifikasını ana Domain web certificate selection'ından bağımsız şekilde provision/reconcile edip Roundcube mapping evidence'ına bağlamaktır. Ardından cross-service SMTP/IMAP/webmail health postcondition'ları ve gerçek Ubuntu/Certbot/Nginx/Roundcube kabulü tamamlanmalıdır.

Bu sohbet ortamında repository checkout/Node runner bulunmadığından hedefli Node 24 testleri ve full `npm run check` çalıştırılmadı; ilgili doğrulamalar `todo.md` T-CODEX-SOURCE altında açık tutulur.
