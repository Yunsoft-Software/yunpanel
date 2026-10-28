# EML-06 — Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 12:12 · Senaryo: `e2e/ozellik/eml-06.spec.js` · Koşu: 4/4, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol 1: Harici posta sağlayıcısı ile mail domain oluşturma ve Postfix izolasyonu | geçti | UI harici sağlayıcı rozeti, virtual_domains tablosuna yazılmadığı (count=0) fiziksel doğrulandı |
| mutlu yol 2: Yerel mail alan adında posta servisini açma/kapatma ve virtual_domains yansıması | geçti | Deactivate ile virtual_domains count=0, Reactivate ile count=1 ve Postfix reload kanıtlandı |
| hatalı girdi: Harici alan adında yerel konfigürasyon reddi ve geçersiz durum geçişleri | geçti | Harici domain config-preview 409 (mail_domain_not_locally_managed), sahte ID 404, UI graceful hata |
| Plesk Parity: Bulunmayan alıcı politikası (Bounce / Reject / Forward / Catch-all) | bilinen hata (test.fail) | Panelde ve host config motorunda Catch-all / Bounce / Reject politikası arayüzü ve alanı yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk eşdeğeri Mail for non-existent users (Catch-all, Bounce, Reject) politikası arayüzü ve konfigürasyonu eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/mail-configuration-http.test.js` | GEÇERLİ | Mail configuration preview, apply, rollback ve RBAC doğrulamaları |
| `apps/api/test/mail-domain-lifecycle.test.js` | GEÇERLİ | Mail domain yerel/harici durum geçişleri ve kısıtlamaları |
| `apps/web/test/mail-change-controller.test.js` | GEÇERLİ | UI tarafında mail apply mutation controller ve durable job takibi |

## Panelde olmayan
- Alan adı bazında bulunmayan alıcı politikası (What to do with mail for non-existent users: Bounce / Forward to catch-all address / Reject)
- Harici mail seçildiğinde DNS MX kayıtları entegrasyonu (Google Workspace, Microsoft 365 hazır MX şablonları)

## Temizlenemeyen kaynaklar
—
