# DEV-01 — Uzak Git repository ve yerel Git repository
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 16:01 · Senaryo: `e2e/ozellik/dev-01.spec.js` · Koşu: 2/4 geçen, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Uzak Git deposu ile site oluştur, incele ve kanıtla | geçti | Nginx vhost, `/var/lib/yunpanel/apps/*/releases/*`, HTTP yanıtı |
| hatalı girdi: Git repository alanı boş/geçersiz engellenir | geçti | Form HTML5/state validasyonu Adım 2 engeli |
| eksiklik: Yerel Git repository (Local Git repo) panelde yok | bilinen hata | `test.fail` BULGU DEV-01-A |
| eksiklik: PHP ve Statik sitelerde sonradan Git aracı yok | bilinen hata | `test.fail` BULGU DEV-01-B (409 deployment_not_supported) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Yerel Git repository (`git init --bare` / push deploy) desteği yok | BULGU DEV-01-A |
| NORMAL | PHP sitelerinde Git deploy desteği ve sonradan Git bağlama yok | BULGU DEV-01-B |

## Mevcut testler
| Dosya | Sınıf | Not |
| `packages/host-runtime/test/git-deployment.test.js` | GEÇERLİ | Git fetch, commit parse, askpass doğruluyor |
| `apps/web/test/jamstack-presets-and-git-dx.test.js` | GEÇERLİ | JAMstack preset ve git form eşleştirmeleri |
| `apps/api/test/github-webhook-production-wiring.test.js` | GEÇERLİ | GitHub webhook production route bağlantısı |

## Panelde olmayan
- Yerel Git repository oluşturma ve doğrudan sunucuya push ile dağıtım (Plesk Local Git repo).
- PHP ve mevcut sitelerde sonradan Git repository bağlama / değiştirme arayüzü.

## Temizlenemeyen kaynaklar
—
