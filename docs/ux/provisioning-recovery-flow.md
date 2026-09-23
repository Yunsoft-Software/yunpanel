# RECOVERY-01–04 — Site kurulumunu güvenli devam ettirme

Başlangıç `development@2c4bd425`, 2026-09-23. BUG-20260923-01 ve UX-PL-06/07/08 alt dilimi. Site Genel Bakış içindeki mevcut ProvisioningRecoveryPanel, continue/retry/compensate API'leri ve sunucu motoru korunur.

- [ ] RECOVERY-01: Güncel Website/operation/adım yanıtını doğrula. Bekleme, hata ve belirsiz sonuçta eski kayıt salt okunur kalsın; yetki kaybında eski veri temizlensin. Onay değişmeyen hedefe bağlansın.
- [ ] RECOVERY-02: Onaydan hemen önce son kaydı yeniden oku. İşlem/adım/durum değişmişse yazmadan yeni onay iste. Çift tıklama yalnız tek POST oluştursun; ağ hatasında otomatik tekrar yapılmasın. Yenileme yalnız GET olsun.
- [ ] RECOVERY-03: Kullanıcı/rol/oturum/Website değişimi ve unmount geç cevapları engellesin. Devam et, tekrar dene, geri al ve hata/teknik ayrıntı erişimleri aynı ekranda korunsun; normal metinler kurulum görevi üzerinden anlatılsın.
- [ ] RECOVERY-04: Model/controller davranışı ve bağlantı testlerini çalıştır; mümkün olan JSX kontrollerini yap. Gerçek ortam kabullerini ayrı kaydet.

## Sınırlar

İstemci ön kontrolü atomik sunucu revizyon kilidi değildir. Son GET ile POST arasındaki süreçler arası yarış, backend güvenli otomatik retry/backoff, kalıcı deneme bütçesi ve site-admin hata yayılımı bu dilimle kapanmaz. canRetry/canCompensate yalnız mevcut sunucu yetenek bayraklarıdır; istemci yeni yetki üretmez. Retry motoru önce hedefi yeniden beklemeye alıp runNext çağırdığından sonuç adımı aynı planın başka adımı olabilir; compensation sonucu ise seçilen adıma bağlı kalmalıdır.

## T-DEV-RECOVERY — Gerçek kabul (Codex)

- [ ] Node24/npm11 tam lint/test/build; mevcut provisioning/session regresyonları ve gerçek React/router/StrictMode.
- [ ] Owner/Site A/Site B, logout/login, yetki kaybı, siteler arası geçiş ve geç gelen GET/POST cevapları; yanlış Website/operation yanıtında yazma ve veri taşıma olmaması.
- [ ] Onay açıkken adım/son işlem değişimi, paralel yenileme, çift tıklama, 401/403/409/429/5xx ve yanıt kaybı. Eski onayla POST ve otomatik tekrar olmamalı; güncel kayıt + yeni açık onay gerekmeli.
- [ ] Gerçek izinli hostta devam/retry/geri alma, sunucu resource-lock/idempotency/ownership ve restart kabulü. `.44` kesinlikle kullanılmaz. İstemci isteğinin iptali host işlemini geri almış sayılmaz.
- [ ] Mobil, klavye, modal odağı, koyu tema ve hata/kayıt detayları. Sonuç failed/blocked/compensation_failed ise başarı mesajı olmamalı; gerçek adım sayısı deneme bütçesi olarak sunulmamalı.

Üst BUG/UX/production kapıları açık; GitHub Actions ve canlı deploy yok.
