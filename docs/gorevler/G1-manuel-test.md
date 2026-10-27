# G1 — Manuel test (1. dalga)

> Senior üretti (2026-10-26). 124 özellik: `docs/plesk-feature-parity.md` içindeki "Sonraki faz" ve "Ayrı hat" dışındakiler; önce kritik, sonra kısmi, sonra incelenmemiş. Yöntem ve rapor şablonu: `docs/manuel-test/YONTEM.md`. Bu dalgada test kodu yazılmaz, kritik olmayan hata düzeltilmez.

> 2026-10-27: Kalan görevler Playwright senaryosu yöntemine geçti ve günlük kullanılan 33 özellik öne alındı (DECISIONS.md). Bitmiş görevlerin metni değişmedi.

### T100 · Manuel test hazırlığı: tarayıcı girişi ve sunucu durumu
- **Bağımlı:** —
- **Dosyalar:** `docs/manuel-test/HAZIRLIK.md`
- **İş:** `sunucu-28-1` kilidiyle tarayıcıda panele `.local/yunpanel-owner-password-only.json` bilgileriyle giriş yap. Panel sürümünü, sol menüdeki bütün sayfaların açılıp açılmadığını (HTTP/JS hatası, boş ekran) ve `.local/test-server.env` ile SSH erişimini (salt okuma: `uptime`, disk, servis durumu) kaydet. Mevcut sitelerin ve kullanıcıların listesini (yalnız ad) yaz ki testler onlara dokunmasın. Gizli bilgi yazma.
- **Kabul:** `HAZIRLIK.md` giriş başarılı/başarısız, panel sürümü, menü sayfaları tablosu (açılıyor/hata), SSH ve servis durumu, dokunulmayacak mevcut kaynaklar listesini içeriyor. Giriş başarısızsa görev `block` edilir ve sebep yazılır.

### T101 · Manuel test: RUN-02 — PHP sürümü/handler, php.ini ve PHP-FPM ayarları
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/RUN-02.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/RUN-02.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T102 · Manuel test: TLS-01 — Ücretsiz ACME issue, renew ve otomatik yenileme
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/TLS-01.md`
- **İş:** Grup 10 Sertifikalar ve TLS; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/TLS-01.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T103 · Manuel test: TLS-06 — Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/TLS-06.md`
- **İş:** Grup 10 Sertifikalar ve TLS; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/TLS-06.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T104 · Manuel test: DB-01 — MySQL/MariaDB oluşturma, silme, site ilişkisi ve boyut
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/DB-01.md`
- **İş:** Grup 12 Veritabanları; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/DB-01.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T105 · Manuel test: DB-02 — DB kullanıcıları, parolalar, roller ve grant yönetimi
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/DB-02.md`
- **İş:** Grup 12 Veritabanları; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/DB-02.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T106 · Manuel test: DB-03 — Uzak erişim, izinli kaynaklar ve bağlantı bilgileri
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/DB-03.md`
- **İş:** Grup 12 Veritabanları; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/DB-03.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T107 · Manuel test: BAK-08 — Gerçek kurtarma, hata bildirimi ve yedek sahipliği
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/BAK-08.md`
- **İş:** Grup 13 Yedek ve kurtarma; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/BAK-08.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T108 · Manuel test: UX-01 — Plesk görev yerleşimi ve tüm rollerin doğru menüsü
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/UX-01.md`
- **İş:** Grup 20 Arayüz, marka ve hesap deneyimi; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/UX-01.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T109 · Manuel test: UX-06 — İş ilerlemesi, güvenli yeniden deneme ve gerçek durum
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/UX-06.md`
- **İş:** Grup 20 Arayüz, marka ve hesap deneyimi; parity durumu: Kritik açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/UX-06.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T110 · Manuel test: ROL-01 — Yönetici Service Provider görünümü
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/ROL-01.md`
- **İş:** Grup 01 Paneller, roller ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/ROL-01.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T111 · Manuel test: ROL-03 — Reseller paneli ve kendi kaynak/kullanıcı sınırı
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/ROL-03.md`
- **İş:** Grup 01 Paneller, roller ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/ROL-03.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T112 · Manuel test: ROL-04 — Müşteri paneli ve abonelik/site seçimi
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/ROL-04.md`
- **İş:** Grup 01 Paneller, roller ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/ROL-04.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T113 · Manuel test: ROL-05 — Ek kullanıcılar, roller ve izin matrisi
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/ROL-05.md`
- **İş:** Grup 01 Paneller, roller ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/ROL-05.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T114 · Manuel test: ROL-06 — Ek yönetici hesapları ve yönetim yetkileri
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/ROL-06.md`
- **İş:** Grup 01 Paneller, roller ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/ROL-06.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T115 · Manuel test: ROL-07 — Profil, iletişim bilgisi, parola, oturum ve MFA
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/ROL-07.md`
- **İş:** Grup 01 Paneller, roller ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/ROL-07.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T116 · Manuel test: HSP-01 — Müşteri oluştur/düzenle/askıya al/etkinleştir/sil
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/HSP-01.md`
- **İş:** Grup 02 Müşteri ve bayi yaşam döngüsü; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/HSP-01.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T117 · Manuel test: HSP-02 — Reseller oluştur/düzenle/askıya al/etkinleştir/sil
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/HSP-02.md`
- **İş:** Grup 02 Müşteri ve bayi yaşam döngüsü; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/HSP-02.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T118 · Manuel test: HSP-03 — İletişim, şirket, açıklama ve hesap erişim bilgileri
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/HSP-03.md`
- **İş:** Grup 02 Müşteri ve bayi yaşam döngüsü; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/HSP-03.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T119 · Manuel test: WEB-01 — Domain ekleme ve amaca göre site oluşturma sihirbazı
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/WEB-01.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/WEB-01.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

### T124 · Manuel test: WEB-07 — Domain kartı/liste, arama, filtre ve doğru araç grupları
- **Bağımlı:** T100
- **Dosyalar:** `docs/manuel-test/WEB-07.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md`'ye göre önce bu özelliğin mevcut testlerini bul, çalıştır ve sınıflandır (test dosyasını değiştirme); sonra özelliği `.28`'de gerçek tarayıcıda son kullanıcı gibi test et. Kritik hatayı hemen bulgu görevi yap; diğerlerini rapora yaz. Kaynak kodu değiştirme.
- **Kabul:** `docs/manuel-test/WEB-07.md` YONTEM.md şablonunda; Sonuç satırı dolu; mutlu yol, hatalı girdi ve (ilgiliyse) rol senaryolarının her biri için adım/beklenen/gerçek/kanıt var; fiziksel sonuç en az bir senaryoda doğrulanmış; oluşturulan kaynaklar temizlenmiş veya listelenmiş; KRİTİK hatalar için bulgu görevi kimliği yazılı; "Mevcut testler" tablosunda bulunan her dosya çalıştırma sonucu ve sınıfıyla (GEÇERLİ/YÜZEYSEL/MOCK/YANLIŞ/KIRMIZI) yer alıyor, EKSİK senaryolar listelenmiş (hiç test yoksa bu açıkça yazılı).

## Öncelikli çekirdek (2026-10-27): günlük kullanılan özellikler

### T120 · Manuel test: WEB-02 — Subdomain ve ayrı document root
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/web-02.spec.js`, `docs/manuel-test/WEB-02.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/web-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WEB-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T121 · Manuel test: WEB-03 — Domain alias; web/mail/DNS ve yönlendirme tercihleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/web-03.spec.js`, `docs/manuel-test/WEB-03.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/web-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WEB-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T122 · Manuel test: WEB-05 — Tercih edilen domain, HTTP→HTTPS ve yönlendirmeler
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/web-05.spec.js`, `docs/manuel-test/WEB-05.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/web-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WEB-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T123 · Manuel test: WEB-06 — Domain askıya alma, kapatma, etkinleştirme ve güvenli silme
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/web-06.spec.js`, `docs/manuel-test/WEB-06.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/web-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WEB-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T143 · Manuel test: WEB-04 — Hosting, forwarding ve hosting olmadan domain davranışı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/web-04.spec.js`, `docs/manuel-test/WEB-04.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/web-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WEB-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T125 · Manuel test: DOS-01 — Global Files ve domain File Manager girişleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-01.spec.js`, `docs/manuel-test/DOS-01.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T146 · Manuel test: DOS-03 — Dosya/klasör oluşturma, yeniden adlandırma ve silme
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-03.spec.js`, `docs/manuel-test/DOS-03.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T147 · Manuel test: DOS-04 — Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-04.spec.js`, `docs/manuel-test/DOS-04.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T150 · Manuel test: DOS-07 — Arşiv oluşturma/açma ve güvenli overwrite
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-07.spec.js`, `docs/manuel-test/DOS-07.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-07.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-07.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T151 · Manuel test: DOS-08 — Kod/metin/HTML düzenleme, kaydetme ve değişiklik uyarısı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-08.spec.js`, `docs/manuel-test/DOS-08.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-08.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-08.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T126 · Manuel test: DOS-11 — SSH/SFTP/shell erişimi ve anahtarlar; kullanıcı izolasyonu
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-11.spec.js`, `docs/manuel-test/DOS-11.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-11.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-11.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T127 · Manuel test: RUN-01 — Document root, sistem kullanıcısı ve hosting ayarları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/run-01.spec.js`, `docs/manuel-test/RUN-01.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/run-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/RUN-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T128 · Manuel test: RUN-05 — Node.js sürümü, app root, startup dosyası ve environment
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/run-05.spec.js`, `docs/manuel-test/RUN-05.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/run-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/RUN-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T129 · Manuel test: RUN-06 — Node paket kurulumu, script, restart ve loglar
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/run-06.spec.js`, `docs/manuel-test/RUN-06.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/run-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/RUN-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T130 · Manuel test: DB-04 — phpMyAdmin geçişi ve oturum/yetki izolasyonu
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/db-04.spec.js`, `docs/manuel-test/DB-04.md`
- **İş:** Grup 12 Veritabanları; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/db-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DB-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T131 · Manuel test: DB-05 — Dump import/export, kopyalama ve backup/restore
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/db-05.spec.js`, `docs/manuel-test/DB-05.md`
- **İş:** Grup 12 Veritabanları; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/db-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DB-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T135 · Manuel test: BAK-03 — Tam ve artımlı yedekleme
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/bak-03.spec.js`, `docs/manuel-test/BAK-03.md`
- **İş:** Grup 13 Yedek ve kurtarma; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/bak-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/BAK-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T136 · Manuel test: BAK-06 — Seçici geri yükleme, indir/yükle ve parola koruması
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/bak-06.spec.js`, `docs/manuel-test/BAK-06.md`
- **İş:** Grup 13 Yedek ve kurtarma; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/bak-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/BAK-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T191 · Manuel test: BAK-04 — Zamanlama, rotasyon, saklama ve hariç tutmalar
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/bak-04.spec.js`, `docs/manuel-test/BAK-04.md`
- **İş:** Grup 13 Yedek ve kurtarma; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/bak-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/BAK-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T170 · Manuel test: DNS-01 — Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dns-01.spec.js`, `docs/manuel-test/DNS-01.md`
- **İş:** Grup 09 DNS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dns-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DNS-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T178 · Manuel test: TLS-04 — Panel, website ve mail servisine doğru sertifika atama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/tls-04.spec.js`, `docs/manuel-test/TLS-04.md`
- **İş:** Grup 10 Sertifikalar ve TLS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/tls-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/TLS-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T179 · Manuel test: TLS-05 — HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/tls-05.spec.js`, `docs/manuel-test/TLS-05.md`
- **İş:** Grup 10 Sertifikalar ve TLS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/tls-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/TLS-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T180 · Manuel test: EML-01 — Mailbox oluşturma/düzenleme/silme, parola ve kota
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-01.spec.js`, `docs/manuel-test/EML-01.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T181 · Manuel test: EML-02 — Alias, forwarding ve yerel kopya tercihleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-02.spec.js`, `docs/manuel-test/EML-02.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T186 · Manuel test: EML-07 — Webmail, mail istemci ayarları ve otomatik yapılandırma
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-07.spec.js`, `docs/manuel-test/EML-07.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-07.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-07.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T188 · Manuel test: EML-09 — SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-09.spec.js`, `docs/manuel-test/EML-09.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-09.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-09.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T165 · Manuel test: DKR-02 — Container oluşturma, başlatma, durdurma, yeniden oluşturma/silme
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dkr-02.spec.js`, `docs/manuel-test/DKR-02.md`
- **İş:** Grup 08 Docker; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dkr-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DKR-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T167 · Manuel test: DKR-04 — Domain reverse-proxy bağlantısı ve container log/terminal
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dkr-04.spec.js`, `docs/manuel-test/DKR-04.md`
- **İş:** Grup 08 Docker; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dkr-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DKR-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T168 · Manuel test: DKR-05 — Compose stack oluşturma/yükleme/güncelleme/up/stop/down
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dkr-05.spec.js`, `docs/manuel-test/DKR-05.md`
- **İş:** Grup 08 Docker; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dkr-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DKR-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T205 · Manuel test: WP-01 — WordPress kurma, tarama, bağlama ve admin girişi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/wp-01.spec.js`, `docs/manuel-test/WP-01.md`
- **İş:** Grup 16 WordPress araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/wp-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WP-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T200 · Manuel test: SYS-06 — Cron/scheduled tasks; kullanıcı, zamanlama ve çıktı bildirimi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sys-06.spec.js`, `docs/manuel-test/SYS-06.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sys-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SYS-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T203 · Manuel test: MON-04 — Web/mail/sistem log görüntüleme, filtre/arama ve rotasyon
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mon-04.spec.js`, `docs/manuel-test/MON-04.md`
- **İş:** Grup 15 İzleme, log ve istatistik; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mon-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MON-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T153 · Manuel test: DOS-10 — FTP/FTPS hesapları, dizin kapsamı ve kota
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-10.spec.js`, `docs/manuel-test/DOS-10.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-10.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-10.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

## Kalan özellikler

### T132 · Manuel test: DB-06 — Veritabanı denetimi/onarımı; desteklenen engine sınırı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/db-06.spec.js`, `docs/manuel-test/DB-06.md`
- **İş:** Grup 12 Veritabanları; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/db-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DB-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T133 · Manuel test: BAK-01 — Server, reseller/customer, subscription ve site düzeyleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/bak-01.spec.js`, `docs/manuel-test/BAK-01.md`
- **İş:** Grup 13 Yedek ve kurtarma; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/bak-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/BAK-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T134 · Manuel test: BAK-02 — Yapılandırma/içerik, dosya/mail/DB kapsam seçimi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/bak-02.spec.js`, `docs/manuel-test/BAK-02.md`
- **İş:** Grup 13 Yedek ve kurtarma; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/bak-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/BAK-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T137 · Manuel test: SEC-04 — Oturum/MFA/parola politikası ve API erişim sınırı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sec-04.spec.js`, `docs/manuel-test/SEC-04.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sec-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SEC-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T138 · Manuel test: SYS-05 — Yönetici terminali, olay tetikleyicileri ve onarım araçları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sys-05.spec.js`, `docs/manuel-test/SYS-05.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sys-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SYS-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T139 · Manuel test: MON-03 — Domain web istatistikleri, trafik ve kullanım raporları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mon-03.spec.js`, `docs/manuel-test/MON-03.md`
- **İş:** Grup 15 İzleme, log ve istatistik; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mon-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MON-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T140 · Manuel test: UX-02 — Global Files + domain File Manager; kaynaklar saklanmaz
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/ux-02.spec.js`, `docs/manuel-test/UX-02.md`
- **İş:** Grup 20 Arayüz, marka ve hesap deneyimi; parity durumu: Kısmi / kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/ux-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/UX-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T141 · Manuel test: HSP-04 — Hesap altında domain, müşteri ve abonelik listeleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/hsp-04.spec.js`, `docs/manuel-test/HSP-04.md`
- **İş:** Grup 02 Müşteri ve bayi yaşam döngüsü; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/hsp-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/HSP-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T142 · Manuel test: PLN-08 — Disk, trafik, domain, mailbox, DB ve kullanıcı adet limitleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/pln-08.spec.js`, `docs/manuel-test/PLN-08.md`
- **İş:** Grup 03 Hizmet paketleri ve abonelikler; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/pln-08.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/PLN-08.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T144 · Manuel test: WEB-08 — Önizleme, geçici domain ve site açma bağlantıları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/web-08.spec.js`, `docs/manuel-test/WEB-08.md`
- **İş:** Grup 04 Siteler ve domainler; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/web-08.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WEB-08.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T145 · Manuel test: DOS-02 — Klasör ağacı, yol, liste, seçim, sıralama ve arama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-02.spec.js`, `docs/manuel-test/DOS-02.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T148 · Manuel test: DOS-05 — Dosya indirme ve URL'den içe aktarma; SSRF koruması
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-05.spec.js`, `docs/manuel-test/DOS-05.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T149 · Manuel test: DOS-06 — Kopyalama ve taşıma; çakışma/onay davranışı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-06.spec.js`, `docs/manuel-test/DOS-06.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T152 · Manuel test: DOS-09 — Dosya adı/içerik araması, gizli dosyalar, izinler
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dos-09.spec.js`, `docs/manuel-test/DOS-09.md`
- **İş:** Grup 05 Dosyalar ve erişim; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dos-09.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DOS-09.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T154 · Manuel test: RUN-03 — Apache/Nginx ayarları, ek direktifler ve testli uygulama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/run-03.spec.js`, `docs/manuel-test/RUN-03.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/run-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/RUN-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T155 · Manuel test: RUN-04 — MIME, index, hata sayfaları ve parola korumalı dizinler
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/run-04.spec.js`, `docs/manuel-test/RUN-04.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/run-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/RUN-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T156 · Manuel test: RUN-07 — Composer bağımlılık yönetimi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/run-07.spec.js`, `docs/manuel-test/RUN-07.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/run-07.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/RUN-07.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T157 · Manuel test: RUN-08 — Dil/runtime eklentilerinin kurulum ve erişim politikası
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/run-08.spec.js`, `docs/manuel-test/RUN-08.md`
- **İş:** Grup 06 Hosting ve çalışma ortamları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/run-08.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/RUN-08.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T158 · Manuel test: DEV-01 — Uzak Git repository ve yerel Git repository
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dev-01.spec.js`, `docs/manuel-test/DEV-01.md`
- **İş:** Grup 07 Git ve framework araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dev-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DEV-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T159 · Manuel test: DEV-02 — Branch, deployment path, manuel/otomatik deployment
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dev-02.spec.js`, `docs/manuel-test/DEV-02.md`
- **İş:** Grup 07 Git ve framework araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dev-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DEV-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T160 · Manuel test: DEV-03 — Deploy anahtarı/webhook/ek komut ve işlem sonucu
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dev-03.spec.js`, `docs/manuel-test/DEV-03.md`
- **İş:** Grup 07 Git ve framework araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dev-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DEV-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T161 · Manuel test: DEV-04 — Laravel oluşturma, repository'den kurma ve mevcut app tarama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dev-04.spec.js`, `docs/manuel-test/DEV-04.md`
- **İş:** Grup 07 Git ve framework araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dev-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DEV-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T162 · Manuel test: DEV-05 — Laravel environment, Artisan, Composer ve Node komutları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dev-05.spec.js`, `docs/manuel-test/DEV-05.md`
- **İş:** Grup 07 Git ve framework araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dev-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DEV-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T163 · Manuel test: DEV-06 — Laravel scheduled task, log ve deployment senaryosu
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dev-06.spec.js`, `docs/manuel-test/DEV-06.md`
- **İş:** Grup 07 Git ve framework araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dev-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DEV-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T164 · Manuel test: DKR-01 — Registry/image arama, indirme ve image yönetimi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dkr-01.spec.js`, `docs/manuel-test/DKR-01.md`
- **İş:** Grup 08 Docker; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dkr-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DKR-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T166 · Manuel test: DKR-03 — Port, environment, volume ve restart politikası
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dkr-03.spec.js`, `docs/manuel-test/DKR-03.md`
- **İş:** Grup 08 Docker; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dkr-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DKR-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T169 · Manuel test: DKR-06 — Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dkr-06.spec.js`, `docs/manuel-test/DKR-06.md`
- **İş:** Grup 08 Docker; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dkr-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DKR-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T171 · Manuel test: DNS-02 — TTL, SOA, zone şablonu ve şablon değişimini uygulama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dns-02.spec.js`, `docs/manuel-test/DNS-02.md`
- **İş:** Grup 09 DNS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dns-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DNS-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T172 · Manuel test: DNS-03 — Master/secondary, DNS aç/kapat ve harici DNS davranışı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dns-03.spec.js`, `docs/manuel-test/DNS-03.md`
- **İş:** Grup 09 DNS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dns-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DNS-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T173 · Manuel test: DNS-04 — DNSSEC anahtar/DS/rollover ve güvenli kapatma
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dns-04.spec.js`, `docs/manuel-test/DNS-04.md`
- **İş:** Grup 09 DNS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dns-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DNS-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T174 · Manuel test: DNS-05 — Zone transfer yetkileri ve secondary doğrulama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dns-05.spec.js`, `docs/manuel-test/DNS-05.md`
- **İş:** Grup 09 DNS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dns-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DNS-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T175 · Manuel test: DNS-06 — Harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/dns-06.spec.js`, `docs/manuel-test/DNS-06.md`
- **İş:** Grup 09 DNS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/dns-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/DNS-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T176 · Manuel test: TLS-02 — Wildcard/DNS-01, SAN ve www/mail/webmail kapsamı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/tls-02.spec.js`, `docs/manuel-test/TLS-02.md`
- **İş:** Grup 10 Sertifikalar ve TLS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/tls-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/TLS-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T177 · Manuel test: TLS-03 — Sertifika/anahtar/chain yükleme, CSR ve envanter
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/tls-03.spec.js`, `docs/manuel-test/TLS-03.md`
- **İş:** Grup 10 Sertifikalar ve TLS; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/tls-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/TLS-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T182 · Manuel test: EML-03 — Otomatik yanıt/tatil mesajları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-03.spec.js`, `docs/manuel-test/EML-03.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T183 · Manuel test: EML-04 — Spam filtre, allow/deny list ve antivirüs politikası
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-04.spec.js`, `docs/manuel-test/EML-04.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T184 · Manuel test: EML-05 — Mailing list ve üyelik yönetimi; OS/eklenti matrisi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-05.spec.js`, `docs/manuel-test/EML-05.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T185 · Manuel test: EML-06 — Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-06.spec.js`, `docs/manuel-test/EML-06.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T187 · Manuel test: EML-08 — SMTP/IMAP/POP3 ve TLS port politikası; kurulum bileşenine göre
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-08.spec.js`, `docs/manuel-test/EML-08.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-08.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-08.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T189 · Manuel test: EML-10 — Giden posta limitleri, kuyruk ve teslimat tanılama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-10.spec.js`, `docs/manuel-test/EML-10.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-10.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-10.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T190 · Manuel test: EML-11 — Mail servisi sertifikası ve hostname/SNI davranışı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/eml-11.spec.js`, `docs/manuel-test/EML-11.md`
- **İş:** Grup 11 E-posta; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/eml-11.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EML-11.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T192 · Manuel test: BAK-05 — Yerel ve uzak FTP/cloud/object storage hedefleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/bak-05.spec.js`, `docs/manuel-test/BAK-05.md`
- **İş:** Grup 13 Yedek ve kurtarma; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/bak-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/BAK-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T193 · Manuel test: SEC-01 — Firewall aç/kapat, kurallar, portlar ve güvenli geri dönüş
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sec-01.spec.js`, `docs/manuel-test/SEC-01.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sec-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SEC-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T194 · Manuel test: SEC-02 — IP erişim kısıtları, brute-force koruması ve ban/unban
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sec-02.spec.js`, `docs/manuel-test/SEC-02.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sec-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SEC-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T195 · Manuel test: SEC-03 — ModSecurity/WAF policy, ruleset ve domain istisnaları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sec-03.spec.js`, `docs/manuel-test/SEC-03.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sec-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SEC-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T196 · Manuel test: SYS-01 — IP havuzu, IPv4/IPv6, shared/dedicated ve remap
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sys-01.spec.js`, `docs/manuel-test/SYS-01.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sys-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SYS-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T197 · Manuel test: SYS-02 — Sistem servislerini kurma/başlatma/durdurma/yeniden başlatma
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sys-02.spec.js`, `docs/manuel-test/SYS-02.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sys-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SYS-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T198 · Manuel test: SYS-03 — Hostname, saat/saat dilimi ve sistem ayarları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sys-03.spec.js`, `docs/manuel-test/SYS-03.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sys-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SYS-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T199 · Manuel test: SYS-04 — Sistem/PHP/panel güncellemeleri ve bileşen yönetimi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/sys-04.spec.js`, `docs/manuel-test/SYS-04.md`
- **İş:** Grup 14 Güvenlik ve sunucu; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/sys-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/SYS-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T201 · Manuel test: MON-01 — CPU/RAM/disk/ağ/servis ölçümleri ve geçmiş grafikler
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mon-01.spec.js`, `docs/manuel-test/MON-01.md`
- **İş:** Grup 15 İzleme, log ve istatistik; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mon-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MON-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T202 · Manuel test: MON-02 — Eşik/teslim alıcısı/bildirim tercihleri ve teslim kanıtı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mon-02.spec.js`, `docs/manuel-test/MON-02.md`
- **İş:** Grup 15 İzleme, log ve istatistik; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mon-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MON-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T204 · Manuel test: MON-05 — Servis watchdog/yeniden başlatma ve disk izleme
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mon-05.spec.js`, `docs/manuel-test/MON-05.md`
- **İş:** Grup 15 İzleme, log ve istatistik; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mon-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MON-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T206 · Manuel test: WP-02 — Core/plugin/theme kurma, güncelleme, etkinleştirme/silme
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/wp-02.spec.js`, `docs/manuel-test/WP-02.md`
- **İş:** Grup 16 WordPress araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/wp-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WP-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T207 · Manuel test: WP-03 — Toplu yönetim ve plugin/theme setleri
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/wp-03.spec.js`, `docs/manuel-test/WP-03.md`
- **İş:** Grup 16 WordPress araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/wp-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WP-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T208 · Manuel test: WP-04 — Klonlama, staging ve veri senkronizasyonu
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/wp-04.spec.js`, `docs/manuel-test/WP-04.md`
- **İş:** Grup 16 WordPress araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/wp-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WP-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T209 · Manuel test: WP-05 — Yedek/restore, bakım ve arama motoru indeksleme ayarları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/wp-05.spec.js`, `docs/manuel-test/WP-05.md`
- **İş:** Grup 16 WordPress araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/wp-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WP-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T210 · Manuel test: WP-06 — Güvenlik denetimi/sıkılaştırma ve zafiyet görünürlüğü
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/wp-06.spec.js`, `docs/manuel-test/WP-06.md`
- **İş:** Grup 16 WordPress araçları; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/wp-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/WP-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T211 · Manuel test: EKL-01 — Uygulama kurucu/katalog; site ve DB kurulum bütünlüğü
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/ekl-01.spec.js`, `docs/manuel-test/EKL-01.md`
- **İş:** Grup 17 Uygulama ve eklenti ekosistemi; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/ekl-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EKL-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T212 · Manuel test: EKL-02 — Eklenti kur/güncelle/kaldır ve paket bağımlılıkları
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/ekl-02.spec.js`, `docs/manuel-test/EKL-02.md`
- **İş:** Grup 17 Uygulama ve eklenti ekosistemi; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/ekl-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/EKL-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T213 · Manuel test: API-01 — REST işlevleri ve yetkili API anahtarı yaşam döngüsü
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/api-01.spec.js`, `docs/manuel-test/API-01.md`
- **İş:** Grup 18 API, otomasyon ve ticari entegrasyon; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/api-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/API-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T214 · Manuel test: API-02 — XML API'deki kapsam için uyumluluk/eşdeğer işlem matrisi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/api-02.spec.js`, `docs/manuel-test/API-02.md`
- **İş:** Grup 18 API, otomasyon ve ticari entegrasyon; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/api-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/API-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T215 · Manuel test: API-03 — CLI, olay handler'ları ve otomatik provisioning
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/api-03.spec.js`, `docs/manuel-test/API-03.md`
- **İş:** Grup 18 API, otomasyon ve ticari entegrasyon; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/api-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/API-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T216 · Manuel test: API-04 — Tek kullanımlık oturum/SSO ve denetlenebilir bağlam değişimi
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/api-04.spec.js`, `docs/manuel-test/API-04.md`
- **İş:** Grup 18 API, otomasyon ve ticari entegrasyon; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/api-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/API-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T217 · Manuel test: MIG-01 — Plesk'ten müşteri/reseller/paket/abonelik kaynaklarını içe aktarma
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mig-01.spec.js`, `docs/manuel-test/MIG-01.md`
- **İş:** Grup 19 Taşıma ve yaşam döngüsü; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mig-01.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MIG-01.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T218 · Manuel test: MIG-02 — Desteklenen diğer hosting panellerinden taşıma
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mig-02.spec.js`, `docs/manuel-test/MIG-02.md`
- **İş:** Grup 19 Taşıma ve yaşam döngüsü; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mig-02.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MIG-02.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T219 · Manuel test: MIG-03 — Site/mail/DB/DNS/SSL/kullanıcı verisi ve IP eşleme
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mig-03.spec.js`, `docs/manuel-test/MIG-03.md`
- **İş:** Grup 19 Taşıma ve yaşam döngüsü; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mig-03.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MIG-03.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T220 · Manuel test: MIG-04 — Ön kontrol, tekrar senkronizasyon ve taşıma sonrası doğrulama
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mig-04.spec.js`, `docs/manuel-test/MIG-04.md`
- **İş:** Grup 19 Taşıma ve yaşam döngüsü; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mig-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MIG-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T221 · Manuel test: MIG-05 — Site/mail import; kısıtlar ve veri kaybı uyarısı
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mig-05.spec.js`, `docs/manuel-test/MIG-05.md`
- **İş:** Grup 19 Taşıma ve yaşam döngüsü; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mig-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MIG-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T222 · Manuel test: MIG-06 — Panel güncellemesi/OS migration/rollback ve kurtarma
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/mig-06.spec.js`, `docs/manuel-test/MIG-06.md`
- **İş:** Grup 19 Taşıma ve yaşam döngüsü; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/mig-06.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/MIG-06.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T223 · Manuel test: UX-04 — Dil, tema, marka/logo/giriş ekranı ve özel bağlantılar
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/ux-04.spec.js`, `docs/manuel-test/UX-04.md`
- **İş:** Grup 20 Arayüz, marka ve hesap deneyimi; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/ux-04.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/UX-04.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T224 · Manuel test: UX-05 — Arama, filtre, sıralama, sayfalama ve toplu eylemler
- **Bağımlı:** T100
- **Dosyalar:** `e2e/ozellik/ux-05.spec.js`, `docs/manuel-test/UX-05.md`
- **İş:** Grup 20 Arayüz, marka ve hesap deneyimi; parity durumu: İnceleme/kabul açık. `docs/manuel-test/YONTEM.md` (2026-10-27) yöntemiyle: mevcut testlere kısa bak (en fazla 3 dosya), sonra özelliği gerçek panele karşı çalışan Playwright senaryosu olarak yaz ve `sunucu-28-n` kilidiyle koştur: 1 mutlu yol, 1 hatalı girdi, yalnız yetki içeren özellikte rol senaryosu; en az bir fiziksel sonuç. Gerçek hatayı `test.fail` ile işaretle; KRİTİK olanı hemen bulgu görevi yap. Uygulama kodunu değiştirme.
- **Kabul:** `e2e/ozellik/ux-05.spec.js` gerçek panele karşı koşuyor ve beklenmeyen düşüş yok (bilinen hatalar `test.fail` ile); mock/`page.route`/sahte veri yok; en az bir fiziksel sonuç doğrulanıyor; `afterAll` oluşturulan kaynakları siliyor. `docs/manuel-test/UX-05.md` ≤40 satır, YONTEM şablonunda; KRİTİK hata varsa bulgu görevi kimliği yazılı.

### T299 · Manuel test özeti
- **Bağımlı:** T100, T101, T102, T103, T104, T105, T106, T107, T108, T109, T110, T111, T112, T113, T114, T115, T116, T117, T118, T119, T120, T121, T122, T123, T124, T125, T126, T127, T128, T129, T130, T131, T132, T133, T134, T135, T136, T137, T138, T139, T140, T141, T142, T143, T144, T145, T146, T147, T148, T149, T150, T151, T152, T153, T154, T155, T156, T157, T158, T159, T160, T161, T162, T163, T164, T165, T166, T167, T168, T169, T170, T171, T172, T173, T174, T175, T176, T177, T178, T179, T180, T181, T182, T183, T184, T185, T186, T187, T188, T189, T190, T191, T192, T193, T194, T195, T196, T197, T198, T199, T200, T201, T202, T203, T204, T205, T206, T207, T208, T209, T210, T211, T212, T213, T214, T215, T216, T217, T218, T219, T220, T221, T222, T223, T224
- **Dosyalar:** `docs/manuel-test/OZET.md`
- **İş:** Bütün `docs/manuel-test/*.md` raporlarını oku. Tek tablo: ID, özellik, sonuç, kritik/normal hata sayısı, bulgu görevleri. Altına: kritik bulguların durumu (düzeltildi mi), en sık tekrar eden NORMAL hata kalıpları, "panelde olmayan" listesinin birleşimi (3. dalga girdisi), mevcut test sınıflarının toplamı ve 2. dalga için ID başına "koru / düzelt / yaz" önerisi, test edilemeyenler ve nedenleri. `plesk-feature-parity.md`'yi değiştirme; senior günceller.
- **Kabul:** `OZET.md` 124 ID'nin hepsini içeriyor; sayılar raporlarla tutuyor; kritik bulguların hepsi listelenmiş.
