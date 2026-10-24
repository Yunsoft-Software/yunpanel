# YunPanel — 12 Ekim 2026 güvenli durma ve devam kaydı

Kullanıcı çalışmanın uygun noktada sonlandırılmasını istedi. Geliştirme ve yeni native mutation burada durduruldu. Bu kayıt, plan/todo içindeki daha eski ara sonuçların güncel devam noktasıdır; bütün kabul kapılarının kapandığı anlamına gelmez.

## Durulan durum

- Kaynak dalı `development`, HEAD `156712cddc7ac0e8de2180bacbfad8bb3d622f19`. Çok sayıda önceki ve bu çalışmaya ait commitlenmemiş değişiklik var. Çalışma ağacı temiz HEAD değildir; hiçbirini reset/checkout ile ezme.
- İzinli hedef yalnız `157.180.11.28`, hostname `test`; `.local/test-server.env` ve doğrulanmış SSH host key ile teyit edildi. `.44` yasak; Ollama başlatılmaz.
- Native kurulu paket `0.3.0-2026101141`, SHA256 `96f8b1429f63fb986fab8c5e1df1893f336f2ab8b260f4fc5c9de68994b8d305`.
- Paket 2209 dosyalık dondurulmuş çalışma kaynağından üretildi. Paket/source HEAD eşitliği iddiası yok; freeze manifest bütün girdilerin hash'lerini tutuyor.
- Tam kaynak kapısı: **8143/8143 passed; 0 failed, 0 skipped, 0 cancelled**, lint ve production build geçti. API 5187, web 1722, templates 195, host-runtime 885, protocol 95, shared 59. Yeni test turu durma isteğinden sonra başlatılmadı; tamamlanmış kapının logu teyit edildi.
- Son salt okunur native kontrol: API/web/Nginx/PowerDNS/Postfix/Dovecot aktif; API health `ok`; dpkg verify boş; Nginx configtest geçti; queued/running **0**, recovery **clear / 0**.
- `webrich.news`, `yp-wp.webrich.news`, `yp-node.webrich.news` HTTPS **200**. Son kontrol yeni kurulum, silme veya sertifika işi oluşturmadı.

## Son kritik dilim: posta sertifikasının güvenli yenilenmesi

Mevcut `ssl.renew` işi `17a0a759-5a8f-4d83-957a-b7cc0a2a9099`, sertifika `efa596b7-3669-4a55-a541-a6cfb86907bc`. Source39 ile gerçek sertifika yenilendi ve Nginx/Postfix/Dovecot uygulaması geçti; askıdaki bare Domain için aynı sertifika kimliğinin tekrar bağlanması metadata uzlaştırmasını engelledi. Source41, aynı kimlikte idempotent dönüşü korurken farklı sertifika/yanlış hostname değişimini reddeder. Yeni paketin startup recovery'si **aynı işi** uzlaştırdı; yeni sertifika üretilmedi.

Son API kanıtı: job succeeded/renewed, sertifika active, `certificate_services` aggregate succeeded; Nginx ve mail consumer sonuçları succeeded; SMTP/IMAP fingerprint doğrulamaları true. Kalıcı `mail.webrich.news` Domain `a7408833-d4d8-48ba-9545-0d58377ddb6a` web rotası **suspended** olarak korundu. Bu askı posta TLS kimliğini kapatmaz.

Gerçek protokol kanıtında beta'nın zaten açık IMAP bağlantısı reload boyunca sürdü; yeni SMTP STARTTLS ve IMAPS bağlantıları yeni sertifikayı sundu; gerçek test iletisi teslim edildi/okundu ve yalnız kendi iletisi temizlendi. Source41 bağımsız salt okunur incelemede açık P1/P2 yok; 2/2 yeni regresyon ve ayrı gerçek registry fixture'ı geçti. Native sonuç ayrıca yukarıdaki son kontrolde teyit edildi.

**Sınırlar:** Tarihsel terminal mail renewal kaydında canonical consumer proof yoksa recovery fail-closed kalır; geçmiş kanıt üretilmez. Zaten mail servisine bağlı sertifikada SSL_ISSUE sonucu consumer proof taşımıyorsa görünür partial sonuç ve mail TLS apply gereksinimi kalır. Normal renewed kabulü geçti; takvimle zamanı gelmiş gerçek otomatik unchanged/renewal native senaryosu ayrıca açıktır.

## Bu çalışmada fiziksel olarak geçen önemli akışlar

Bunlar senaryo sonuçlarıdır; ilgili geniş T-* kapısının tamamı değildir.

| Alan | Gerçek doğrulanan sonuç | Kalan sınır |
| --- | --- | --- |
| DNS/NS | webrich.news gerçek delegasyon; child TXT/mail off-on; ana bölge kayıtları korundu. | İki NS aynı `.28` IP'sinde; yüksek erişilebilirlik kanıtı yok. DNSSEC/secondary/provider kapsamı ayrı. |
| Site ve Docker | Normal site oluşturma/silme düzeltmeleri; Docker pull/start/stop/restart, bağlı HTTP, in-use 409, normal project remove; env değişimi ve named-volume verisinin korunması. | Son adayda kalan farklı kaynak bağımlılıklarının site cleanup ve cold-start kabulü açık. |
| WordPress | Gerçek DB ile kurulum/login/parola, plugin/theme/update/kaldır; dosya+SQL iki restore; fresh staging clone ve staging HTTPS/admin. | İlk restore sonrası browser login turu failed kaldı; ayrı 05b login tekrar testi passed. Eski rapor tümü passed diye çevrilmez. |
| Node/Passenger | Dedicated Unix UID/process cwd/private env hash; Git deploy ve retained rollback; ikinci Domain üzerinden gerçek HTTPS; aynı snapshot'tan iki dosya/env restore; interrupted preparing job aynı journal ile recovery. | Günlük Passenger entegrasyonunun seçici Git kapanışı ve son site temizliği açık. |
| SSL | Ana web sertifikası dry-run/force renewal; disk/registry/SNI eşitliği; mail Nginx+SMTP+IMAP reload ve mevcut oturumun korunması. | Bütün failed/cancelled/timer/restart kombinasyonları tamamlandı sayılmaz. |
| Mail | SMTP/IMAP/Roundcube gerçek teslimat; alpha disable/backup/delete/finalize sırasında beta oturumu/teslimatı sürer; mail dosyası/UID/hash gerçek restore. | Kalan beta/domain temizliği ve mail test yedeklerinin sahiplik kontrollü temizliği açık. |
| Files | Gerçek 13,418,072 byte upload/download/delete `.28` üzerinde private panel ingress 16m ile geçti. | Public installer ingress/upload limitinin ürün kurulumuna taşınması açık; portable fresh install fix iddiası yok. |
| Browser | Source38 gerçek bundle Chromium/Firefox son salt okunur 4/4 tur: 16 Owner rota, site görevleri, 320/390/834 ve 1440 px kontrolleri. Önceki kapsamda gerçek roller/Files/terminal/phpMyAdmin alt testleri var. | Source41 son bütün rol/hata/restart/browser matrisi ve 162 özelliğin tam kabulü yok. Source41 web kaynağı aynı olsa da yeni tam browser turu çalıştırıldı denmez. |

## Kalan test kaynakları — durma sırasında silinmedi

Silme için normal panel/API preview-confirm-job akışı ve yalnız kaydı tutulan kaynaklar kullanılacak. Domain/Website/Application kimlikleri birbirinin yerine kullanılmaz.

| Manifest anahtarı | Kaynak | Devam kararı |
| --- | --- | --- |
| `main` | webrich.news; Website `7fe9a711-a5b0-550e-a5e5-49fee4c66a73` | **Koru (keep=true)**. |
| `mailService` | mail.webrich.news; bare Domain `a7408833-d4d8-48ba-9545-0d58377ddb6a` | **Koru (keep=true)**; global posta TLS kimliği. Web rotasının suspended hali korunur. |
| `wp` | yp-wp.webrich.news; Website `af2e0dfc-2e63-5bdb-b6f2-68bee01bafa7`; DB ypaccept_wp_20261011 | Normal kaldırma ve fiziksel yokluk kontrolü bekliyor. |
| `node` | yp-node.webrich.news; Website `a3615185-d9a1-5f43-9adf-7ebed45ee8f0` | Normal kaldırma, süreç/env/release/Unix temizliği bekliyor. |
| `nodeRoute` | git-route.yp-node.webrich.news; Domain `20ce7670-bde8-4ade-b710-315eb5009385` | Node ile aynı Website; ayrı Website sanıp ikinci site silme başlatma. |
| `staging` | yp-staging.webrich.news; Website `171da678-3833-59d1-a861-392fcae7f24a`; DB ypaccept_staging_20261011 | Normal kaldırma ve fiziksel yokluk kontrolü bekliyor. |
| `form` | yp-form.webrich.news; Website `34711cd4-080d-5eae-82bb-1d823e59360b` | Beta mailbox ve mail domain bağımlılığıyla birlikte normal cleanup bekliyor. |
| `docker` | Eski Docker test Website/projeleri; ypacceptdata20261012 fixture | Website/project/container/network ve sahipliği doğrulanan test volume temizlendi. Yeniden cleanup yapılmaz. |

Mail test Domain `c46068e1-82f3-4956-aa3f-f1e04d7ff9ee` / yp-form.webrich.news: alpha kaldırıldı; beta ve parent enabled. Global Roundcube/posta servisleri korunur. Kendi test iletileri temizlendi.

Node/WP/staging testlerinin **23 Restic snapshot / 3 repository** metadata ve fiziksel temizliği tamamlandı. Test mail backup'ları **henüz temizlenmedi**: alpha `eb581781-6e84-471d-849c-28af0c453ad6`, alpha `9118932d-c88d-46dd-bfc6-b6ab6c31a4b1`, domain `6ece7394-7265-4b01-b121-d8c8ca6c885b`, beta `00e80b7a-8eda-479f-93a8-28d015f368dc`; restore işi `24bae155-7b2a-4510-9779-7c6136aa93c7` için oluşturulan pre-restore backup'ın exact kimliği job/proof kaydından alınmalı. Mail backup kökü `/var/lib/yunpanel/backups/mail-data`, gerçek mail veri kökü `/var/lib/yunpanel/mail`. Sonradan site removal'ın ürettiği yalnız bu teste ait backup'lar da kayıtla izlenir. Global silme/GC uygulanmaz; ilgisiz backup/config rollback/recovery kayıtları korunur. Kullanıcının durma isteğiyle bu temizlik devam işine bırakıldı.

## Kaynak/Git kapanışı

Son küçük commitler: `f3bc59f9` Passenger journal; `df34a886` environment CAS/recovery; `476954a2` Domain route recovery; `1737aa3e` Nginx SSL reload; `6076724e` public reload outcome projection; `765bc12c` scoped mailbox removal/sibling preservation; `156712cd` SSL UI jobs context/SSR regresyonu. Commitlerde `[skip ci]` var.

Günlük Passenger runtime wiring modülleri, Source39 mail certificate reload + API composition/reconciliation/test dilimi ve Source41 `domain-registry-base.js` guard sırası + `certificate-suspended-renewal.test.js` **henüz seçici Git entegrasyonundan geçirilmedi**. Karışık dosyalarda önceki kullanıcı/WIP hunks korunmalı; toplu stage/commit yapılmamalı. Source40 yerel ara fixture başarısızdı, native kurulu değildi; final Source41 tam kapı geçti. Review/native/source kanıtlarını birbirinin yerine kullanma.

## Yeniden başlama sırası

1. Bu kayıt, AGENTS/inherited kurallar, plan/todo ve private manifest okunur. `development` ve güncel HEAD/WIP doğrulanır; `.28` hedefi, kurulu sürüm, servisler ve queue/recovery tekrar salt okunur teyit edilir. Eski loglara dayanarak bugünün durumu varsayılmaz.
2. Tamamlanmış renewal işi tekrar gönderilmez. Source/Git entegrasyonu küçük ve seçici dilimlerle kapanır; frozen archive ile current worktree farkları incelenir.
3. Node (+ secondary Domain), WP, staging, form (+ beta/mail/DB) normal API ile kaldırılır; Unix/files/process/FPM/SQL/credentials/env/DNS/SSL routing yokluğu ve main/mailService korunması fiziksel doğrulanır. `.local/reinstall-20261011/completion-remove-site.mjs` mevcut kayıtları kullanır; keep=false ve exact ID guard'ları korunur.
4. Sahipliği ve successful restore kanıtı teyit edilen kalan mail test backup/pre-restore çıktıları temizlenir ve yokluğu doğrulanır. Zaten temiz 23 Restic snapshot tekrar işleme alınmaz.
5. Public ingress upload limitinin fresh install entegrasyonu tamamlanır. Son aday için açık normal/hata/rol/restart/cleanup/cold-start testleri çalıştırılır; son çıktısı alınmadan kabul yazılmaz.
6. `plan.md`, `todo.md`, `ui-plan.md` ve 162 ID parity envanteri source/native/browser/Git sınırlarıyla eşlenir. Büyük T-* kapıları birkaç geçen alt test nedeniyle işaretlenmez. Windows/vendor/gelişmiş reseller-paket işleri mevcut ayrı/ertelenmiş fazında kalır.

## Kanıt adresleri ve gizlilik

Private kanıt kökü `.local/reinstall-20261011/completion/`; manifest exact resource/job kimlikleri ve devam durumunu tutar. Önemli dosyalar: `source-gate-41-proof.json`, `mail-certificate-renew-public-proof.json`, `mail-certificate-ssl-native-protocol-proof.json`; ilk Source39 başarısız metadata çıktıları ayrıca korunur. Frozen inputs `.local/reinstall-20261011/completion-source-41-manifest.json`; native gate `/var/tmp/yunpanel-completion-20261011/completion-check-v41.log`; install log `/root/yunpanel-reinstall-20261011/completion-install-41.log`. Önceki browser/native çıktılar private acceptance/completion kayıtlarında.

Kimlik bilgisi/cookie/private key/private env bu dokümana konmaz. Strict SSH helper `.local/reinstall-20261011/host.py` kullanılmalı. Rutin backup/snapshot alınmaz; yalnız açık backup/restore feature testi ve ardından sadece kendi test çıktılarının temizliği geçerli.

## Kalan iş ve süre değerlendirmesi

**Kesin ölçülen oran:** Bu adayın kaynak test kapısı 8143/8143 (%100) geçti. Bu oran ürünün %100 çalıştığını göstermez. 162 özellik envanteri ve açık T-* kapıları güncel, ağırlıklı, tam native/browser kabul sayacına dönüşmediği için bütün ürün için net bir çalışırlık yüzdesi verilemez.

**Mühendislik tahmini:** Günlük kullanılabilir Ubuntu çekirdeğinin tamamlanması yaklaşık **%75–85** düzeyinde; bu ölçülmüş test kapsamı veya hatasızlık garantisi değildir. Çalışan gerçek senaryolar yukarıda sayıldı. Kalan iş yalnız test çalıştırmak değildir: seçici kaynak/Git kapanışı, fixture/mail-backup cleanup, public installer ingress ve final negatif/rol/restart/native kabul işleri var.

Mevcut hız ve yeni büyük mimari sorun çıkmaması varsayımıyla bu Ubuntu sürümünü kabul noktasına getirmek için yaklaşık **40–80 saat / 5–10 tam çalışma günü** öngörülüyor. Aralıksız aynı tempoda yaklaşık **1–2 hafta**; günlük çalışma süresi daha kısa olduğunda takvim uzar. Native hata kuyruğu nedeniyle bu bir teslim tarihi taahhüdü değildir. Tam 162 özellik/Plesk eşdeğerliği, ertelenmiş gelişmiş reseller/paket, ayrı OS ve vendor işleri açılırsa farklı kapsamdır: kaba planlama bandı **2–4 ay ve üzeri**, bağımlılık/öncelik/kabul derinliğine göre yeniden tahmin gerekir.
