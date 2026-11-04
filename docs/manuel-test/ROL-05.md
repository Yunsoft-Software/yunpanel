# ROL-05 — Ek kullanıcılar, roller ve izin matrisi
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-11-04 10:50 · Senaryo: `e2e/ozellik/rol-05.spec.js` · Koşu: 5/5 geçti (iki kez art arda), test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| mutlu yol: Owner Kullanıcılar sayfasından Site Yöneticisi oluşturur, site yetkisi bağlar ve kullanıcı giriş yapar | geçti | `GET /api/panel/users` (role: site_manager, active: true), `PATCH /api/panel/users/:id` (websiteIds), `GET /api/auth/session` (access.mode: site_management, sites.manage) |
| hatalı girdi: mükerrer kullanıcı adı ve geçersiz parametreler reddedilir | geçti | UI 409 username_taken uyarısı; API 400 `invalid_role` ve 400 `invalid_password` |
| rol senaryosu: Read Only kullanıcısı 9 salt okunur izne sahiptir, mutasyon ve kullanıcı yönetimi engellenir | geçti | `GET /api/auth/session` (access.mode: read_only, 9 `*.read` izni); `POST /api/panel/websites` 403 ve `GET /api/panel/users` 403 |
| yetki ve koruma: bağlı sitesi olan Site Yöneticisi doğrudan silinemez (site_manager_delete_blocked) | geçti | `DELETE /api/panel/users/:id` 409 `site_manager_delete_blocked` yanıtı |
| bilinen hata: /settings/users üzerinde Kullanıcı ekle modalında web siteleri onay kutuları listelenir | bilinen hata (`test.fail`) | `workspaceResources` `/settings/users` rotasında `websites` koleksiyonunu yüklemediğinden modalda 0 checkbox görünür |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | `/settings/users` rotasında `workspaceResources` `websites` koleksiyonunu yüklemediği için modalda site onay kutuları görünmüyor | — |
| NORMAL | `userAdminMessage` içinde `site_manager_delete_blocked` ve `site_manager_update_blocked` hata kodları eşlenmemiş | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/rol-05.spec.js` | GEÇERLİ | Gerçek panel ve canlı API üzerinde 5 senaryo (iki kez art arda 5/5 geçti) |
| `apps/api/test/user-admin-store.test.js` | GEÇERLİ | 17/17 geçti; kullanıcı CRUD, rol, revizyon ve silme engelleri |
| `apps/api/test/tenant-boundary.test.js` | GEÇERLİ | 30/30 geçti; çoklu kiracı ve rol sınırları |

## Panelde olmayan
Plesk'teki granüler izin matrisi (özel permissions dizisi) ve bayi/müşteri alt kullanıcıları.

## Temizlenemeyen kaynaklar
Yok (`trol04-*`, `trol05-*` hesapları panel API üzerinden temizlendi; `REMAINING_TROL_COUNT: 0 []`).
