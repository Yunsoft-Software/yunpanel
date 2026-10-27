# BAK-02 — Yapılandırma/içerik, dosya/mail/DB kapsam seçimi
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 14:40 · Senaryo: `e2e/ozellik/bak-02.spec.js` · Koşu: 2/3 geçti, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Kapsam inceleme, UI yedekleme | Geçti | `website:<id>`, `domain:<name>` etiketli Restic snapshot ve operation result |
| Hatalı girdi: Geçersiz digest/onay engeli | Geçti | 409 Conflict (`backup_preview_stale`) |
| Plesk eşdeğerliği: UI kapsam seçimi | Bilinen hata (`test.fail`) | Modalda yapılandırma vs içerik ve bileşen checkbox'ları yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk eşdeğeri yedek alma modalında dosya/mail/DB kapsam seçimi yok (yalnızca geri yüklemede var) | BULGU BAK-02 |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/site-backup-acceptance.test.js` | GEÇERLİ | Kapsam özeti ve digest doğrulama |
| `e2e/ozellik/bak-01.spec.js` | GEÇERLİ | Server/site düzeyleri ve RBAC |
| `e2e/ozellik/bak-03.spec.js` | GEÇERLİ | Tam ve artımlı yedekleme |

## Panelde olmayan
- Yedek alırken "Yalnızca yapılandırma" vs "Tüm içerik" seçimi
- Yedek alırken dosya, veritabanı ve e-posta bileşenlerini bağımsız olarak hariç tutma / dahil etme seçimi (yalnızca geri yükleme modalında seçici kapsam mevcut)

## Temizlenemeyen kaynaklar
—
