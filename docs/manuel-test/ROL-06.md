# ROL-06 — Ek yönetici hesapları ve yönetim yetkileri
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-11-04 11:02 · Senaryo: `e2e/ozellik/rol-06.spec.js` · Koşu: 5/5 geçti (iki kez art arda: 56.1s / 1.1m, 2 test.fail)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| mutlu yol: Owner ek yönetici oluşturur, ek yönetici ile oturum açılır, tam yönetim yetkileri ve denetim kaydı doğrulanır | geçti | `GET /api/auth/session` (`mode: "management"`, `permissions: ["*"]`), `GET /api/panel/audit` |
| hatalı girdi ve korumalar: geçersiz kullanıcı adı, mükerrer kullanıcı, kaydedilmemiş değişiklik onayı ve silme onay kilidi | geçti | UI `3–128 karakter` uyarısı, `409 username_taken`, `disabled` silme butonu, fiziksel API silme doğrulaması |
| rol ve yetki sınırları: read_only rolünün yetkisiz API ve rotalara erişememesi, devre dışı bırakılınca anında oturum iptali | geçti | `GET /api/auth/session` (`mode: "read_only"`), `POST /api/panel/users` 403, `active: false` sonrası `401 Unauthorized` |
| bilinen hata: /settings/users üzerinde Kullanıcıyı düzenle modalında parola sıfırlama/değiştirme alanı bulunmuyor | bilinen hata (`test.fail`) | `input[name="new-password"]` mevcut kullanıcı düzenleme modalında render edilmiyor (`!user` koşulu) |
| bilinen hata: ReadOnlyServersPage ve ReadOnlyDashboardPage rotaları OwnerRoute ile korunduğu için read_only hesaplar /websites adresine yönlendiriliyor | bilinen hata (`test.fail`) | `WorkspaceApp.jsx` içinde `OwnerRoute` sarmalaması nedeniyle read_only kullanıcının `/websites` adresine yönlendirilmesi |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | `/settings/users` üzerindeki `Kullanıcıyı düzenle` modalında parola sıfırlama/değiştirme alanı bulunmuyor (`UsersPage.jsx:144`) | — |
| NORMAL | `ReadOnlyDashboardPage` ve `ReadOnlyServersPage` bileşenleri `WorkspaceApp.jsx` `OwnerRoute` nedeniyle `read_only` için erişilemez (`WorkspaceApp.jsx:76,89`) | — |
| NORMAL | `/settings/users` üzerinde `Kullanıcı ekle` modalında sunucu MFA politikasından bağımsız sabit Owner MFA uyarısı yer alıyor (`UsersPage.jsx:176`) | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/rol-06.spec.js` | GEÇERLİ | Mocksuz gerçek tarayıcı ve gerçek API e2e testi (iki kez art arda 5/5 geçti). |
| `apps/api/test/user-admin-store.test.js` | GEÇERLİ | 17/17 geçti; SQLite üzerinde ek yönetici, son aktif Owner koruması ve oturum iptali. |
| `apps/api/test/user-admin-http.test.js` | GEÇERLİ | 9/9 geçti; HTTP uçlarında rol/yetki sınırları ve CSRF doğrulamaları. |

## Panelde olmayan
- Kısıtlı yönetici yetki matrisi (Plesk Custom Administrative Permissions).
- Ek yönetici profil ve iletişim alanları (Ad-Soyad, E-posta, Açıklama).

## Temizlenemeyen kaynaklar
Yok — `trol06-*` test hesapları `afterAll` ile arayüz/API üzerinden temizlendi (`0` kalan).
