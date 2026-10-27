# DEV-02 — Branch, deployment path, manuel/otomatik deployment
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 16:05 · Senaryo: `e2e/ozellik/dev-02.spec.js` · Koşu: 2/5 geçen, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Git deposu ile site kur, branch/yol doğrula, manuel deploy tetikle, webhook incele | geçti | Nginx vhost, HTTP yanıtı (200/404/502/503), webhook endpoint |
| hatalı girdi: Form doğrulamasında boş GitHub repository ile ilerleme engellenir | geçti | HTML5 form validation (checkValidity === false), Adım 2 engeli |
| eksiklik: Panelde dal değiştirme (Switch Branch) ve depodaki dalları seçme arayüzü bulunmuyor | bilinen hata | `test.fail` BULGU DEV-02-A |
| eksiklik: Panelde dağıtım yolu (Deployment Path / Target Directory) düzenleme arayüzü bulunmuyor | bilinen hata | `test.fail` BULGU DEV-02-B |
| eksiklik: Panelde Dağıtım Modu (Otomatik vs Manuel Dağıtım / Webhook toggle) seçimi bulunmuyor | bilinen hata | `test.fail` BULGU DEV-02-C |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Dal (Branch) değiştirme ve depodaki dalları listeleme (Switch Branch) arayüzü yok | BULGU DEV-02-A |
| NORMAL | Dağıtım yolu (Deployment Path / Target Directory) düzenleme arayüzü yok | BULGU DEV-02-B |
| NORMAL | Dağıtım modu seçimi (Automatic / Manual / None) ve webhook açma/kapama seçeneği yok | BULGU DEV-02-C |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/web/test/jamstack-presets-and-git-dx.test.js` | GEÇERLİ | JAMstack preset ve git webhook CI/CD UI özeti testi |
| `apps/api/test/github-webhook-http.test.js` | GEÇERLİ | GitHub webhook push imza doğrulaması ve deploy kuyruklama |
| `apps/api/test/git-deployment-packaging.test.js` | GEÇERLİ | Git askpass ve SSH istemci bağımlılık kontrolü |

## Panelde olmayan
- Plesk Git eşdeğeri dal değiştirme (Switch branch) ve depodaki remote dalları listeleme arayüzü.
- Hedef dağıtım dizini (Deployment directory / Target path) değiştirme arayüzü.
- Dağıtım modunu (Automatic vs Manual deployment) arayüzden seçme / webhook devre dışı bırakma seçeneği.

## Temizlenemeyen kaynaklar
—
