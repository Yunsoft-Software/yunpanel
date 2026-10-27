# BAK-01 — Server, reseller/customer, subscription ve site düzeyleri
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 14:36 · Senaryo: `e2e/ozellik/bak-01.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Server depoları listesi, site yedek arayüzü ve backup-set | geçti | `/api/panel/websites/:id/backups` HTTP 200, backupSet nesnesi (veritabanı, posta, dosya yolları) ve depo listesi |
| Yetki/sınır: site_manager rolünün sunucu depolarına ve yedeklemeye müdahalesi engellenir | geçti | `POST /api/panel/backups/repositories` ve `POST /api/panel/websites/:id/backup-operations` HTTP 403 Forbidden |
| Eksiklik: Plesk eşdeğeri server-wide ve müşteri/abonelik düzeyinde toplu yedekleme UI | bilinen hata | `test.fail` — Panelde sunucu geneli tek tıkla tam yedekleme veya müşteri aboneliği toplu yedekleme arayüzü yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | BULGU BAK-01: Plesk eşdeğeri sunucu geneli ve müşteri/abonelik düzeyinde toplu yedekleme arayüzü eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-backup-http.test.js` | GEÇERLİ | Site yedek seti ve izin kontrollerini gerçekçi API ile test ediyor |
| `apps/api/test/backup-repository-http.test.js` | GEÇERLİ | Server düzeyindeki Restic depo yönetimini ve yetkilerini sınıyor |
| `e2e/ozellik/bak-03.spec.js` | GEÇERLİ | Restic snapshot deduplication ve site yedeği akışını sınıyor |

## Panelde olmayan
- Tools & Settings altında tek tıkla tüm sunucuyu (server config + all accounts) tek arşivde yedekleme arayüzü
- Müşteri veya Bayi paneli altında tüm aboneliğe/müşteriye ait siteleri tek tıkla topluca yedekleme arayüzü

## Temizlenemeyen kaynaklar
—
