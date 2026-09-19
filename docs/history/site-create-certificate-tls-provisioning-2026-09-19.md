# 2026-09-19 — Fresh Website certificate/TLS provisioning ilerlemesi

Bu dilim managed HTTPS seçilen yeni Website provisioning operation'ındaki eski placeholder certificate adımını mevcut durable SSL job/reconciliation altyapısına bağlar ve certificate attachment sonrasında Nginx'i exact TLS material ile yeniden aktive eden ayrı bir TLS step'i ekler.

## Kaynakta tamamlananlar

- Yeni `website-certificate-provisioning-handler`, exact Website/Domain/routed-name ownership'ini doğrular ve yalnız initial HTTP route gerçekten active iken HTTP-01 issuance açar.
- Fresh Website certificate kaydı mevcut `certificateRegistry.createForDomain` primitive'iyle `provisioningOperationId` sahibi olarak yaratılır; başka lifecycle'a ait canlı certificate state fail-closed bloklanır.
- Certificate issuance mevcut `SSL_ISSUE` durable job kuyruğunu kullanır. Child job operation+certificate kimliğine bağlı idempotency key taşır; yeni bir certbot yolu veya ikinci recovery motoru yazılmadı.
- Handler successful child job sonrasında existing job reconciliation'ın `markActive → Domain attach → commitSelection` evidence'ını bekler. Public Website provisioning evidence certificate/private-key path'i taşımaz; certificate ID, issue job ID, fingerprint, validity ve operation identity ile sınırlıdır.
- Production bootstrap server default ACME hesabı için optional `YUNPANEL_ACME_EMAIL` alır. Değer yoksa startup bozulmaz; managed Website certificate apply açık `website_certificate_acme_email_required` failure bırakır ve sonradan explicit retry edilebilir.
- Certificate attachment Domain desired revision'ını ilerlettiği için ayrı required `tls_activation` step'i eklendi. Local mail adımları artık certificate kaydından hemen sonra değil, TLS activation tamamlandıktan sonra başlayacak şekilde sıralanır.
- Base Website Nginx provisioning spec'i internal TLS material + current redirect policy kabul edecek şekilde genişletildi; normal ilk HTTP activation hâlâ TLS'siz kalır.
- Yeni TLS handler exact operation-owned active certificate materialini ve ilk Nginx step'inin runtime evidence'ını kullanarak Nginx TLS config'ini stage/activate eder, ardından exact host checksum/config evidence'ıyla Domain revision'ını staged/applied olarak reconcile eder.
- Restart/lost-ack sırasında TLS host config zaten exact expected checksum ile aktifse `inspect` ikinci Nginx mutation göndermez; yalnız Domain control-plane state'i exact certificate+host evidence'a göre ilerletir.
- Certificate ve TLS handler, runtime wiring, plan ordering ve Nginx TLS spec davranışları için source test kontratları eklendi.

## Açık kalanlar

- Bu sohbet ortamında Node 24 runner bulunmadığından yeni testler ve `npm run check` çalıştırılmadı; `todo.md` T-CODEX-SOURCE altında açık tutulur.
- Gerçek Ubuntu 24.04 Certbot HTTP-01, process-kill/lost-ack, Nginx configtest/reload ve browser HTTPS acceptance yapılmadı.
- Fresh local-mail Website için `webmail.<domain>` certificate coverage + shared Roundcube bind/apply step'i henüz Website provisioning journal'ına bağlı değildir.
- Certificate/TLS step'lerinin downstream failure için operation-owned reverse compensation/retirement zinciri henüz tamamlanmamıştır; mevcut Nginx rollback/certificate retirement primitive'leri üst provisioning compensation contract'ına ayrıca bağlanmalıdır.
- Server default ACME email gelecekte Settings/control-plane state'ine taşınmalıdır; env yalnız mevcut source/bootstrap kapısıdır.
