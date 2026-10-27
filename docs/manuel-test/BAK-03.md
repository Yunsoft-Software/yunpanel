# BAK-03 — Tam ve artımlı yedekleme
Sonuç: ÇALIŞIYOR
Ajan: AGENT_4 · Tarih: 2026-10-27 12:35 · Senaryo: `e2e/ozellik/bak-03.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: tam ve ardışık artımlı (deduplicated) site yedeği oluşturma, job takibi ve fiziksel restic snapshot kanıtı | geçti | Restic API'de 2 ayrı snapshot (64-char hex id, tags: website/domain), 2. yedekte filesUnmodified>0 deduplication kanıtı |
| hatalı girdi: geçersiz depo ID veya sahte operasyon türü ile yedekleme başlatma 400/404 hatasıyla reddedilir | geçti | HTTP 400 (`invalid_repository_id`), HTTP 400 (`invalid_operation_kind`) |
| Plesk eşdeğerliği: UI üzerinde tam vs artımlı yedekleme tipi seçimi modalı | bilinen hata (`test.fail`) | Plesk modalındaki Full vs Incremental radyo butonu seçimi YunPanel'de yok (Restic otomatik deduplication kullanır) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Backup Manager'daki Full vs Incremental yedekleme türü seçim radyo butonu eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/restic-repository-registry.test.js` | GEÇERLİ | Restic repo yönetimi, snapshot listeleme ve şifreleme |
| `apps/api/test/website-backup-acceptance.test.js` | GEÇERLİ | Restic snapshot, tenant izolasyonu ve durable job doğrulaması |
| `apps/web/test/site-backup-acceptance.test.js` | MOCK | İstemci backup/restore durum geçişleri ve hata kodları |

## Panelde olmayan
Plesk'te "Backup Type: Full / Incremental" radyo buton seçimi yer alır; YunPanel Restic'in içerik tabanlı blok deduplication mekanizmasına dayanarak her yedeği otomatik artımlı depolar.

## Temizlenemeyen kaynaklar
—
