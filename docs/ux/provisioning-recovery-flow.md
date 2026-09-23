# RECOVERY-01–04 — Site kurulumunu güvenli devam ettirme

Başlangıç `development@2c4bd425`, 2026-09-23. Kapsam `11149ff4` ile önce yazıldı. BUG-20260923-01 ve UX-PL-06/07/08 alt dilimi. Site Genel Bakış içindeki mevcut ProvisioningRecoveryPanel, continue/retry/compensate API'leri ve sunucu motoru korunur.

## Tamamlanan kaynak

- [x] **RECOVERY-01:** `fcfb6ffc`, `provisioning-recovery.js`. Website/operation/adım ve yetenek bayrakları doğrulanır. Son doğrulanmış kayıt yenileme hatasında salt okunur kalır; 401/403 veya yönetim yetkisi kaybında eski veri ve onay temizlenir. Ham intent/evidence/yanıt/hata modele kopyalanmaz. Adım sayısı gerçek required/succeeded kayıtlarından hesaplanır, deneme bütçesi değildir.
- [x] **RECOVERY-02:** Onay işlem/adım ve görüntülenen kayıt snapshot'ına bağlanır. POST öncesi son kayıt yeniden okunur; işlem/adım/zaman/durum/yetenek değişiminde yazmadan yeni onay gerekir. Aynı controller'da çift tıklama yalnız bir POST üretir; eski onay/callback kullanılamaz. Kayıp/bozuk POST cevabı otomatik tekrarlanmaz; Durumu yenile yalnız GET yapar, ardından yeni açık onay gerekir.
- [x] **RECOVERY-03:** `f60d568c`, `b830ba39`. Mevcut istemciye isteğe bağlı AbortSignal aktarımı; mevcut URL/onay payload'ları ve otomatik ilerleme korunur. Panel Website/kullanıcı/rol/oturum nesli/yetkiye anahtarlanır; unmount/dispose ve oturum değişimi geç cevapları yeni ekrana taşımaz. Devam et, tekrar dene, geri al, adım hata/çözüm ve teknik kimlik erişimleri korunur. Güncel olmayan veri işlem açmaz; failed/blocked/interrupted sonucu başarı bildirimi üretmez. Normal metin Site kurulumu üzerinden anlatılır, tema değişmedi.
- [x] **RECOVERY-04:** `0597b94f`, `53fc70fd`. Node22.16.0/npm10.9.2 altında **70 geçti / 0 başarısız / 0 atlandı**: 64 model/controller davranışı + 6 kaynak bağlantısı kontrolü. Tek değişen JSX dosyası hazır parser/dönüştürücüyle kontrol edildi; dönüştürülmüş JS ve iki kaynak JS dosyası node --check ile geçti. TypeScript kaynak/bağımlılık/lockfile değişikliği yoktur.

```sh
node --test apps/web/test/provisioning-recovery-controller.test.js apps/web/test/provisioning-recovery-wiring.test.js
```

Beş test edilen kaynak/test dosyasının Git blob SHA'ları yerel kontrolle GitHub arasında birebir eşleşti: controller `d46b07350466264f85a842b2ac35fde5621998c3`, panel `aebd1aabe760c7bbe626e08d9270f33cd3cabcb3`, mevcut istemci `0a8dfd2a0faa0238de62832e41bfdb280a7d6047`, davranış testi `28563c53ed346cb8dce43ea2c4910cbc3949d125`, bağlantı testi `b0cc07e77d80fd71a9bd37b9a7ef8e86ff9c27e4`.

Mevcut `provisioning-recovery.test.js` korundu; yeni testler ayrı dosyadadır. Önceki create/job/Files/hosting/alias/SSL ve eski recovery regresyonları bu tur yeniden çalıştırılmış sayılmaz, 70'e eklenmez. read/execute testleri kontrollü taşıma fixture'larıdır; gerçek HTTP/auth/CSRF/React/host kabulü değildir. JSX kontrolü Vite build/import çözümlemesi veya browser render değildir. Doğrudan Git checkout denemesi github.com DNS çözümleme hatasıyla başarısız oldu; tam checkout ve Node24/npm11 tam kontrol yapılamadı.

## Sınırlar

İstemci ön kontrolü atomik sunucu revizyon kilidi değildir. Son GET ile POST arasındaki süreçler arası yarış, backend güvenli otomatik retry/backoff, kalıcı deneme bütçesi ve site-admin hata yayılımı bu dilimle kapanmaz. canRetry/canCompensate yalnız mevcut sunucu yetenek bayraklarıdır; istemci yeni yetki üretmez. Eski veya farklı pencere/controller'lar arasındaki eşzamanlılık sunucu kilidine tabidir.

Retry motoru önce hedefi yeniden beklemeye alıp runNext çağırdığından sonuç adımı aynı planın başka adımı olabilir; bu gerçek sözleşme korunur. Compensation sonucu seçilen adıma bağlıdır. Tamamlanmış başka bir adımın sessizce geriye düşmesi, planın/Website'in/operation'ın değişmesi veya hazır bayrağıyla çelişen sonuç başarı kabul edilmez. İsteği iptal etmek sunucuda uygulanmış işi geri almaz.

## T-DEV-RECOVERY — Gerçek kabul (Codex)

- [ ] Node24/npm11 tam lint/test/build; yeni iki testle birlikte mevcut `provisioning-recovery.test.js`, otomatik ilerleme/create/session regresyonları ve gerçek React/router/StrictMode. Test harness'i gerçek SessionProvider içinde çalıştırılsın.
- [ ] Owner/Site A/Site B, logout/login, yetki kaybı, siteler arası geçiş ve geç gelen GET/POST cevapları; yanlış Website/operation yanıtında yazma ve veri taşıma olmaması.
- [ ] Onay açıkken adım/son işlem değişimi, paralel yenileme, çift tıklama, 401/403/409/429/5xx ve yanıt kaybı. Eski onayla POST ve otomatik tekrar olmamalı; güncel kayıt + yeni açık onay gerekmeli. İptal edilen taşıma ile hostun devam eden işi ayrılmalı.
- [ ] Gerçek izinli hostta devam/retry/geri alma, sunucu resource-lock/idempotency/ownership ve restart kabulü. `.44` kesinlikle kullanılmaz. İki tarayıcı/prosesin aynı kaynakta yarışı ve yetki iptalinin mutation sınırında uygulanması ayrıca doğrulansın; istemci preflight bunu kanıtlamaz.
- [ ] Mobil, klavye, modal odağı, koyu tema ve hata/kayıt detayları. Sonuç failed/blocked/compensation_failed ise başarı mesajı olmamalı; gerçek adım sayısı deneme bütçesi olarak sunulmamalı. Backend izin verdiğinde yüksek geçmiş deneme sayısı tek başına manuel retry'yi kapatmamalı.

Üst BUG/UX/production kapıları açık. Files/hosting/alias ve backend motorları, main ve canlı host değiştirilmedi; GitHub Actions ve canlı deploy yok.
