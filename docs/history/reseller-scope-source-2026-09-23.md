# RS-01a — Sade reseller sahiplik politikası

2026-09-23; `development`. Önce kapsam `5ac33c10`, ana plan `6efc5038` ile sadeleştirildi; sonra kaynak kod yazıldı.

- [x] `apps/api/src/reseller-scope.js`: tek bayi seviyesi, açık müşteri/site bağı, Owner yönetimi, kendi müşterisine erişim, doğrudan Owner müşterisi, pasif hesap/üst bayi reddi. `site_manager` otomatik reseller yapılmaz.
- [x] `apps/api/test/reseller-scope.test.js`: **41 geçti / 0 başarısız**, yerel **Node v22.16.0** ile `node --test apps/api/test/reseller-scope.test.js`.
- [ ] RS-01b müşteri/site adet politika kaynağı ve testleri.
- [ ] RS-02 auth/state/transaction/migration ve API/job/tool/gateway/WS entegrasyonu.
- [ ] RS-03–05 API, UI ve gerçek kabul.

Bu saf ve durum tutmayan bir kaynak politikasıdır. Fonksiyonlar sunucunun güncel depodan yüklediği actor/hesap/Website kayıtları için tasarlanmıştır; request body veya eski oturum alanları yetki kaynağı olamaz. Yerel test bu kayıtlar üzerinden politika davranışını kanıtlar; gerçek session iptali veya HTTP tenant izolasyonunun tamamlandığını kanıtlamaz.

Repo kopyası/bağımlılıklar ağ kısıtı nedeniyle tam kurulamadı. Connector'dan okunan mevcut `auth-error.js` ve yeni iki dosya yerel çalışma dizininde sınandı. Node24/npm11 hedefi değiştirilmedi; tam `npm run check`, migration, browser ve host testi yapılmadı. API/router/auth şeması ve UI bu commit'te değişmedi; reseller login açılmadı. GitHub Actions, deploy ve `.44` erişimi kullanılmadı.
