# API-04 — Tek kullanımlık oturum/SSO ve denetlenebilir bağlam değişimi
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 13:17 · Senaryo: `e2e/ozellik/api-04.spec.js` · Koşu: 2/4 geçen, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: tek kullanımlık SSO handoff token üretimi, oturum tüketimi ve fiziksel replay engellemesi | geçti | HTTP 303 signon redirect, replay anında 401 ret, host auth.sqlite audit_events kaydı |
| hatalı girdi ve sınır durumu: geçersiz token, sahte kimlik ve oturumsuz istekler reddedilir | geçti | 400/401 ret, geçersiz credential reddi, yetkisiz audit erişim engeli |
| Plesk eksikliği: Plesk harici tek kullanımlık oturum / SSO token oluşturma API (/api/v2/cli/session veya /api/v2/sessions) bulunmuyor | bilinen hata | `test.fail` BULGU API-04-A (404 Not Found) |
| Plesk eksikliği: Plesk eşdeğeri yönetici/bayi müşteri paneline geçiş (login-as / context switch) mekanizması bulunmuyor | bilinen hata | `test.fail` BULGU API-04-B (404 Not Found) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk harici tek kullanımlık oturum / SSO token oluşturma API (/api/v2/cli/session veya /api/v2/sessions) bulunmuyor | BULGU API-04-A |
| NORMAL | Plesk eşdeğeri admin/reseller login-as veya denetlenebilir bağlam değişimi (context switch / impersonation) mekanizması bulunmuyor | BULGU API-04-B |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/phpmyadmin-handoff-service.test.js` | GEÇERLİ | Kriptografik token üretimi, 30s TTL ve tek kullanım tüketimi doğrulandı |
| `apps/api/test/phpmyadmin-handoff-http.test.js` | GEÇERLİ | REST handoff endpoint ve session digest yetkilendirmesi doğrulandı |
| `apps/api/test/audit-http.test.js` | GEÇERLİ | Tenant sınırları ve denetlenebilir işlem geçmişi doğrulandı |

## Panelde olmayan
- Harici portaller (WHMCS/fatura) için tek kullanımlık Plesk CLI/REST oturum açma API'si (`POST /api/v2/cli/session` veya `/api/v2/sessions`).
- Yönetici veya bayinin müşteri paneline kimlik taklit ederek geçiş yapması (login-as / context switch).

## Temizlenemeyen kaynaklar
—
