# ROL-04 — Müşteri paneli ve abonelik/site seçimi
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-11-04 10:35 · Senaryo: `e2e/ozellik/rol-04.spec.js` · Koşu: 5/5 geçti (3 geçti, 2 test.fail)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| mutlu yol: Owner müşteri oluşturur, müşteri paneline giriş yapar ve 0 siteli araçları doğrular | geçti | API `GET /api/panel/users/hosting/accounts` ve `GET /api/auth/session` |
| hatalı girdi ve sınır durumlar: geçersiz veya boş ?site= parametrelerinde fail-closed davranışı | geçti | DOM `İstenen siteye erişilemiyor` fail-closed ekranı |
| rol ve kiracı sınırı: Müşteri hesabı Owner/Reseller sayfalarına ve yabancı kaynaklara erişemez | geçti | UI `/websites` yönlendirmesi + API `403 Forbidden` (`websites`, `files`, `users`) |
| bilinen hata: üst oturum çubuğunda rol rozeti Müşteri yerine Site Manager görünüyor | bilinen hata (`test.fail`) | DOM `.auth-sessionbar .auth-role` rozetinde `Site Manager` |
| bilinen hata: WebsitesPage veritabanı kotasında JSX boolean hatası yüzünden payda render edilmiyor | bilinen hata (`test.fail`) | DOM `.ws-section` kotalar kartında `Veritabanları — /` |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | Üst oturum çubuğunda rol rozeti Müşteri yerine Site Manager görünüyor (`AuthGate.jsx:133`) | — |
| NORMAL | WebsitesPage veritabanı kotasında JSX boolean hatası yüzünden payda render edilmiyor (`WebsitesPage.jsx:103`) | — |
| NORMAL | Müşteri oturumunda gerçek kaynak kullanımı (`usage`) dönmüyor (`auth-store.js:244`) | — |
| NORMAL | `/files?site=` ve `/mail?site=` rotaları `domainId` parametresini kabul etmiyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/rol-04.spec.js` | GEÇERLİ | Mocksuz gerçek tarayıcı ve gerçek API e2e testi (5/5 yeşil). |
| `apps/web/test/site-tool-entry-model.test.js` | GEÇERLİ | Müşteri araç giriş modeli (0 site, 1 site redirect, 2+ site chooser). |
| `apps/api/test/customer-quota-tenant.test.js` | GEÇERLİ | Gerçek SQLite üzerinde müşteri kota ve kiracı sınırları. |

## Panelde olmayan
- Üst/yan barda kalıcı aktif site/abonelik bağlam seçicisi (Plesk Subscription Switcher).
- Müşteri oturumunda gerçek zamanlı Disk/Trafik/DB kullanım telemetrisi (`usage` null dönüyor).

## Temizlenemeyen kaynaklar
Yok — `trol04-*` test hesapları (profiller ve kullanıcı kayıtları) `afterAll` ile temizlendi (`0` kalan).
