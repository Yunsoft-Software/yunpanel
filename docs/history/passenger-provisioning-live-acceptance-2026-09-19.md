# Passenger/provisioning canlı kabul — 2026-09-19

## Kapsam ve güvenlik sınırı

- Bütün SSH, package ve host mutation kontrolleri yalnız repo dışı `.local/test-server.env` içindeki `157.180.11.28` YunPanel test sunucusunda yapıldı. Her bağlantı öncesinde hedef yeniden doğrulandı; `.44` ile biten Plesk production sunucusuna bağlantı kurulmadı.
- Host mutation'larından önce resmi migration backup aracıyla bağımsız doğrulanan snapshot'lar alındı. Bu turdaki yeni snapshot'lar ve SHA-256 değerleri:
  - `/var/backups/yunpanel/migration-2026-09-18T22-06-54-538Z`: `615583017c01ce5778204901a11ad27f791196ce44e120cc7b3013ce7602271e`
  - `/var/backups/yunpanel/migration-2026-09-18T22-25-16-397Z`: `9b6fffa107543008331c32c59457146d58d6aeae3cc022d6113a75d4a0328502`
  - `/var/backups/yunpanel/migration-2026-09-18T22-32-15-371Z`: `9f5f74449ccf03c2dd9d34b473947a6fe1da6c8201d4c4d586fddcc0e22fc8bb`
- Secret, parola, cookie, CSRF değeri, MFA verisi veya private key çıktıya ya da repoya yazılmadı.

## Kaynak, build ve package kapısı

- Uzak `main` fast-forward ile alındıktan sonra çekilen değişikliklerin bozduğu control-plane, runtime ve gateway test kontratları düzeltildi.
- Canlı blocked-operation deneyi bir eksikliği ortaya çıkardı: Passenger düzeltildikten sonra HTTP continuation, salt-okunur inspect sonucu değişmiş olsa da eski blocker evidence'ını koruyordu. `website-provisioning-orchestrator` artık blocked step'i apply çalıştırmadan durable `blocked -> applying -> blocked` geçişiyle güncel inspect evidence'ına taşıyor. Hedefli 51 test ve Node 24 ile tam `npm run check` geçti.
- Ubuntu/amd64 üzerinde commit `31de296d` arşivinden temiz `npm ci` ve tam `npm run check` sonrası `yunpanel_0.3.0-2026091903_amd64.deb` üretildi. Kaynak arşivi SHA-256 değeri `46a1a98b28cc6c27f23c797ec1d84fb61fe499a5c2b4b7c9156fed41cd260680`, Debian paketi SHA-256 değeri `1e26714cc9c82271628337f226dc5e7444f05be26d54c000fb1278a886dd6b8f` oldu.
- Doğrulanmış backup ardından package kuruldu. `dpkg -V yunpanel` temiz kaldı; `yunpanel-api`, `yunpanel-web` ve Nginx aktif, retained `yun-agent` pasif kaldı ve `nginx -t` geçti.

## Durable restart ve receipt kabulü

- Geçici Website/Application fixture'ında identity ve workspace mutation'ı tamamlandıktan sonra operation diskte `applying` durumundayken API durduruldu. Restart reconciliation aynı UID/GID ile identity receipt hash'i `c2a0095be1d37e42aaca657fd5c3962d68dd04c375efae37296ffe916e0a1879` ve workspace receipt hash'i `f191a02528bc23e6286b6def89a9c1d5ae7efaad0b9625c1c76cc199b02d15dc` üzerinden inspect-only tamamlandı; mutation körlemesine tekrarlanmadı. İkinci restart aynı evidence'ı korudu.
- `/var/lib/yunpanel/staging/website-identities` ve `/var/lib/yunpanel/staging/website-identity-paths` root:root `0700`, receipt dosyaları root:root `0600` kaldı. Pre-existing workspace korunması, operation-created boş dizinin kaldırılması ve veri içeren HOME'un recursive silinmeden korunması doğrulandı.
- Compensation exact receipt ownership ile yapıldı. Yalnız doğrulanmış standart skeleton dosyaları temizlendikten sonra boş fixture HOME'u non-recursive kaldırıldı; fixture user/group/path kalmadığı ayrıca kontrol edildi.

## Passenger blocker, continuation ve izolasyon

- Operation `88888888-8888-4888-8888-888888888888`, Passenger yokken `passenger_runtime_unavailable` ve `ready=false` kaldı. Yanlış typed confirmation `400 website_provisioning_confirmation_required` döndürdü.
- `libnginx-mod-http-passenger`/Passenger `1:6.2.0-1~noble1build3` manager üzerinden kuruldu. Canlı inspect sonraki gerçek blocker'ı `passenger_node_unavailable` olarak buldu; kurulan package ile güncellenen orchestrator aynı durable operation evidence'ını bu değere taşıdı.
- Resmi checksum akışıyla managed Node `v24.21.0`, `/opt/yunpanel/node-runtimes/v24/bin/node` altına kuruldu; npm, pnpm ve yarn hazırlandı. Nginx Passenger service drop-in'i effective `UMask=0027` yaptı.
- Exact `continue-site-provisioning:88888888-8888-4888-8888-888888888888` confirmation sonrasında operation kaldığı step'ten `ready` durumuna geçti. Kabul için mevcut MFA-enrolled Owner'a beş dakikalık, rastgele ve yalnız server-side geçici session satırı üretildi; token/CSRF yazdırılmadı ve session `finally` içinde silindi. Bu kontrol headed browser authentication kabulü sayılmaz.
- İki bağımsız geçici Passenger Website gerçek UID/GID `994/994` ve `993/993` altında cevap verdi. Nginx config'lerindeki `passenger_user`, `passenger_group` ve managed Node binary exact eşleşti; A→B ve B→A home/release okumaları gerçek `runuser` kimliklerinde reddedildi.
- İki vhost, application tree, Unix identity ve HOME receipt-bound cleanup ile kaldırıldı. Nginx/API aktif kaldı; yalnız `.28` adresine local DNS pinleyen istekle `https://cryptoraichu.website` `200` döndürdü.

## Static canonical/legacy deploy ve rollback

- Canonical fixture mevcut provisioned `yunapp-95ec3d08ddbd` hesabıyla iki gerçek Git deploy'u ve rollback yaptı. HOME deploy öncesi ve sonrası `/var/lib/yunpanel/data/c2000000-0000-4000-8000-000000000001` kaldı; build HOME'a çevrilmedi.
- Ayrı migration fixture'ı yalnız önceden oluşturulmuş `yunapp-3a5c8cbb9de2` ve HOME=`/var/lib/yunpanel/build/d2000000-0000-4000-8000-000000000001` kanıtıyla legacy fallback üzerinden iki deploy ve rollback yaptı.
- Eksik identity `website_static_identity_missing`; canonical HOME ve group drift'i `website_static_identity_drift` ile mutation başlamadan kapandı. Deploy başlangıcında identity'nin kaldırıldığı failure-injection `deployment_command_failed` olarak fail-closed kaldı; sonrasında rollback `website_static_identity_missing` ile reddedildi. Bütün negatif durumlarda `current` symlink aynı kaldı ve deployment yolunda gerçek `useradd` çağrısı sayısı sıfırdı.
- `/var/lib/yunpanel/backups/resources` root:root `0700` olarak initialize edildi; statik deploy/rollback boyunca UID, GID, mode ve inode değişmedi, site user'a chown edilmedi.
- Bütün geçici static build/data/publish tree'leri ve user/group'lar exact fixture marker kontrolünden sonra temizlendi. API health tekrar `200` verdi.

Bu rapor Passenger/provisioning handoff kabulünü kapatır; genel Owner browser, DNS/provider, mail, backup/restore ve diğer gerçek-host kapıları `todo.md` içinde açık kalır.
