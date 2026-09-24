# SSL-RENEW — Yenileme sonucunu gerçek sertifika kaydıyla eşitleme

2026-09-24; başlangıç `development@058e3cfc`. BUG-20260923-06 / UX-PL-06/07 alt dilimi. Mevcut ACME/Certbot, sertifika deposu ve job motoru korunur. `markActive` gerçek validFrom/validTo/fingerprint değerlerini zaten kaydeder; yeni tarih veya sabit geçerlilik süresi üretilmez.

- [ ] SR-01: Yenileme sonucunda iş/sertifika/Domain/Website/sunucu bağını doğrula. Dry-run, aynı sertifika, değişen sertifika, başarısız iş ve henüz eşleşmeyen depo sonucunu ayır.
- [ ] SR-02: Aynı mevcut renew endpoint'ine tek POST; güncel hedef/onay kontrolü, oturum/izin/abort sınırı, kayıp cevapta otomatik tekrar yok. Kuyruk kabulü başarı değildir. İş bittikten sonra yalnız GET ile kalıcı sertifika ve domain ilişkisini yeniden oku.
- [ ] SR-03: Mevcut SSL ekranında yenileme/test/sonuç ve eski-yeni gerçek tarih/parmak izi; terminal sonuç ve doğrulanmış metadata sonrası mevcut ortak koleksiyonları yenile. Önceki issuance formu, varsayılan e-posta ve taslak koruması değişmez.
- [ ] SR-04: Odaklı davranış ve bağlantı testleri; mümkün olan JSX kontrolü. Gerçek React/API/ACME/host kabulü ayrı kalır.

## T-DEV-SSL-RENEW — Açık gerçek kabul

- [ ] Node24/npm11 tam checkout/npm ci/lint/test/build; mevcut SSL formu, collection, job, certificate registry/reconciliation testleriyle yeni testleri birlikte çalıştır.
- [ ] Gerçek renewal/dry-run/aynı sertifika, failed/cancelled, gecikmiş reconciliation; beklenen fingerprint ve tarihler kalıcı depoda doğrulanmadan yenilendi denmesin. Site listesi/Genel Bakış/SSL özetleri güncellensin.
- [ ] Kayıp POST, yanlış iş/site kimliği, eşzamanlı sertifika seçimi ve logout/login; yeni siteye otomatik yazma veya tekrar renewal gönderimi olmasın.
- [ ] Gerçek TLS bağlantısında sunulan sertifika ile panel fingerprint/tarihleri karşılaştırılsın. Nginx/mail reload, DNS/provider hatası, mevcut backend kaynak kilidi ve restart ayrı doğrulansın; panel metadata eşitliği canlı TLS kanıtı değildir.
- [ ] Gerçek mobil/klavye/modal odağı/koyu tema; `.44` hariç izinli test hostu. Doğrudan Git erişimi bu ortamda DNS hatasıyla başarısız oldu; tam checkout/host kabulü yapılmış sayılmaz.

Üst BUG-06 ve production kapıları açık. GitHub Actions/main/canlı deploy yok.
