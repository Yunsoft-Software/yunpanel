# SYS-05 — Yönetici terminali, olay tetikleyicileri ve onarım araçları
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 15:02 · Senaryo: `e2e/ozellik/sys-05.spec.js` · Koşu: 5/5, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol 1: Yönetici kök terminali (WebSocket xterm PTY) | geçti | Sunucuda PTY shell prosesi ve xterm çıktısında root / uid 0 |
| mutlu yol 2: ttyd oturumu başlatma ve sonlandırma | geçti | Sunucuda `/run/yunpanel/ttyd/<id>.sock` soketi oluşumu ve silinmesi |
| yetki ve sınır kontrolleri: sahte capability & site_manager | geçti | Sahte capability 401, site_manager sunucu terminali 403 / gizli |
| onarım araçları: site health repair API ve hatalı girdi | geçti | `repair_permissions` HTTP 200, geçersiz action HTTP 400 |
| Plesk UI eşdeğerliği: Olay Tetikleyicileri & Repair Kit | bilinen hata | Araçlar ve Ayarlar'da Event Handlers & Repair Kit UI eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk eşdeğeri merkezi Olay Tetikleyicileri (Event Manager) ve Sistem Onarım Araçları UI eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `e2e/05-native-terminal.spec.js` | GEÇERLİ | Panel terminal açma ve PTY execution testleri mevcut |
| `apps/api/test/ttyd-session-http.test.js` | MOCK | Express/registry stub'ları ile birim testi |
| `apps/api/test/terminal-websocket-policy.test.js` | GEÇERLİ | WebSocket yetki ve hedef doğrulama testleri |

## Panelde olmayan
- Plesk Tools & Settings eşdeğeri Olay Tetikleyicileri (Event Handlers / Olay Yöneticisi) arayüzü
- Plesk Repair Kit eşdeğeri merkezi Sistem Onarım Araçları (Self-Repair / Diagnose & Repair) ekranı

## Temizlenemeyen kaynaklar
—
