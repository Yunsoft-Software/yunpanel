# SSL-RENEW — Yenileme sonucunu gerçek sertifika kaydıyla eşitleme

2026-09-24; başlangıç `development@058e3cfc`. BUG-20260923-06 / UX-PL-06/07 alt dilimi. Kapsam önce `464f32b8` ile yazıldı. Mevcut ACME/Certbot, sertifika deposu ve job motoru korundu. `certificate-registry.js` markActive ve `job-reconciliation.js` gerçek validFrom/validTo/fingerprint değerlerini zaten kaydeder; bu tur yeni geçerlilik süresi veya ikinci sertifika motoru eklenmedi.

## Tamamlanan kaynak

- [x] **SR-01 — `3d06db13`:** `ssl-renewal.js` iş/sertifika/Domain/Website/sunucu ve sertifika adı bağlarını doğrular. Gerçek yenileme sonucu ancak public job tarih/parmak izi ile aktif kalıcı sertifika kaydı eşleşince doğrulanır. Dry-run/test, aynı sertifika, farklı sertifika, failed/cancelled ve henüz eşleşmeyen kayıt ayrıdır. Aynı parmak izine farklı tarih atfedilemez; aynı sertifikaya hayali gün eklenmez. Farklı sertifikanın süresi kısalmışsa da gerçek tarih korunur.
- [x] **SR-02:** mevcut `/certificates/:id/renew` endpoint'ine yalnız `{ dryRun }` ile tek POST; öncesinde aynı hedefin güncel kaydı ve onay snapshot'ı kontrol edilir. Çift gönderim, eski onay, oturum/yetki değişimi ve unmount sonrası geç yanıt sınırları vardır. Kayıp POST otomatik tekrar üretmez. Bilinen iş aynı kimlikle GET üzerinden izlenir; iş kabulü başarı sayılmaz. Kuyruk takibi 120 okumada duraklar, gecikmiş metadata için sekiz okuma sonrası görünür doğrulanmamış durum kalır; elle yeniden okuma yine yalnız GET'tir.
- [x] **SR-03 — `eb788819`, `0ac00991`:** mevcut SSL ekranında `SslRenewalPanel`; yenileme/test onayı, sonucu yeniden okuma, mevcut JobDrawer, eski/yeni gerçek tarihler ve parmak izi. Bileşen sertifika state'i veya koleksiyon güncelliğine göre yeniden kurulmaz; hedef/site/kullanıcı/oturum değişiminde kapsam yenilenir. Custom sertifikaya ACME yenilemesi açılmaz. İlk issuance formu, e-posta varsayılanı, taslak ve stage/activate yolları korunur.
- [x] **SR-03 ortak veri — `ea0ed310`, `40532f89`:** takip edilen ssl.issue/ssl.renew işi terminal duruma geldiğinde Domain/Website/certificate koleksiyonları yenilenir; JobDrawer açık olmasına bağlı değildir. Tekrarlanan terminal poll tekrar tekrar invalidation üretmez; takipten çıkan işin deduplikasyon kaydı tutulmaz. Yenileme ekranında metadata eşleşince mevcut refreshAll da çağrılır. `useCollection` mevcut run/scope ve abort korumasını kullanır; yeni API verisi iyimser yerel tarih değişikliğiyle taklit edilmez.
- [x] **SR-04 — `7d190650`, `11a6cfae`, `ff69521a`:** son aynı koşuda **73 geçti / 0 başarısız / 0 atlandı**: 59 yenileme/model/controller davranışı, 8 ortak koleksiyon yenileme davranışı ve 6 kaynak bağlantısı kontrolü. Aşağıdaki sekiz dosya test edilen yerel içerikle GitHub blob düzeyinde birebir eşleşti.

## Gerçek çalıştırılan kontroller

Node **22.16.0**, npm **10.9.2**:

```sh
node --test apps/web/test/ssl-renewal.test.js apps/web/test/ssl-job-refresh.test.js apps/web/test/ssl-renewal-wiring.test.js
node --check apps/web/src/workspace/ssl-renewal.js
node --check apps/web/src/workspace/ssl-job-refresh.js
```

Üç JSX dosyası (`SslRenewalPanel`, `SiteOperations`, `WorkspaceContext`) ortamda hazır parser/dönüştürücüyle parse/transpile edildi; çıkan JavaScript node --check ile geçti. Repoya TypeScript, paket veya lockfile değişikliği eklenmedi. Bu JSX kontrolü gerçek React rendering, Vite build veya import çözümleme değildir. Davranış testlerinin request/registry/job sonuçları kontrollü fixture'lardır; gerçek HTTP/auth/CSRF/ACME/host çalıştırılmadı. Altı kaynak testi component kodundaki bağlantıları denetler.

Son kaynak/test sürümü `ff69521a`:

| Dosya | Git blob SHA |
| --- | --- |
| `ssl-renewal.js` | `bf1544ec73ead66956bb1e94bfb2c15ed89d3faa` |
| `ssl-job-refresh.js` | `322457dabd9a5cdab9a91fb2538dde6cff4baf98` |
| `SslRenewalPanel.jsx` | `909fa9b026f3bfe47a630ead85e61698ed4abc12` |
| `SiteOperations.jsx` | `a5bf0a4cbf1ac1f7fe135b4370c06e2f63f84a3f` |
| `WorkspaceContext.jsx` | `dcd067d261764f26132ba64de6c0cc1175bfac4a` |
| `ssl-renewal.test.js` | `c5b98e3d8fe920799739c0e851b9dc2b535a6755` |
| `ssl-job-refresh.test.js` | `5aab28d7c5b29cb928b2fa122759a1ba4b797d54` |
| `ssl-renewal-wiring.test.js` | `0271b5d0738e2d35eeb9902694257a8a39ca5a8c` |

İki değişen mevcut dosyanın düzenleme öncesi yerel kopyası da başlangıç blob'larıyla eşleştirildi. Önceki SSL formu, mail, Files, hosting ve backend test sayıları 73'e eklenmez; eski test grupları bu tur yeniden çalıştırılmadı. Doğrudan Git erişimi `Could not resolve host: github.com` ile başarısız olduğundan tam checkout ve hedef Node24/npm11 tam build alınmadı.

## Sınırlar ve kalan kaynak işleri

Paneldeki kalıcı metadata ile job sonucu eşitliği, gerçek TLS bağlantısında aynı sertifikanın sunulduğunu kanıtlamaz. Nginx/posta reload ve dışarıdan sunulan fingerprint ayrıca doğrulanmalıdır. API/worker'ın süreçler arası kilit, güncel yetki ve recovery atomik sınırları bu istemci çalışmasıyla kapanmaz. İlk issuance sonrası mail-service-identity bind hata yayılımı ve stage/activate kısmi başarıları değiştirilmedi; PROD-06 kapsamında açık kalır.

POST cevabı iş kimliği alınmadan kaybolursa bu açık panel yeniden renewal göndermez. Mevcut İşlem geçmişinden kontrol gerekir; yeni kalıcı istemci işlem deposu veya otomatik job tahmini eklenmedi. Sayfadan ayrılmak host işini iptal etmez. Otomatik yenilemeler mevcut depo/koleksiyon okumasını sürdürür; yeni terminal invalidation yalnız çalışma alanında takip edilen SSL işlerine aittir.

## T-DEV-SSL-RENEW — Açık gerçek kabul

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; mevcut SSL formu, collection, job, certificate registry/reconciliation testleriyle yeni üç testi birlikte çalıştır. Gerçek React/SessionProvider/router/StrictMode kullan.
- [ ] Gerçek renewal/dry-run/aynı sertifika, failed/cancelled, gecikmiş reconciliation; beklenen fingerprint ve tarihler kalıcı depoda doğrulanmadan yenilendi denmesin. Site listesi/Genel Bakış/SSL kalan gün özetleri yenilensin; eski poll son tarihi geri almasın. Pencere kapalıyken terminal geçişini de test et.
- [ ] Kayıp POST, yanlış iş/site kimliği, eşzamanlı sertifika seçimi, yerinde değişen Website bağı, logout/login ve yetki iptali; yeni hedefe otomatik yazma veya tekrar renewal olmasın. Takip sınırı sonrası manuel GET ve yarım kayıt durumları doğrulansın.
- [ ] Gerçek TLS bağlantısında sunulan sertifika ile panel fingerprint/tarihleri karşılaştırılsın. Nginx/mail reload, DNS/provider hatası, backend ortak kaynak kilidi ve restart ayrı doğrulansın; metadata eşitliği canlı TLS kanıtı değildir.
- [ ] Gerçek mobil/klavye/modal odağı/koyu tema; `.44` hariç izinli test hostu. Kaynak ve canlı dağıtım kimlikleri kaydedilsin.

Üst BUG-06 ve production kapıları açık. Files/mail/hosting/alias motorları, görsel tokenlar, main ve paket pinleri değişmedi. GitHub Actions ve canlı deploy yapılmadı.
