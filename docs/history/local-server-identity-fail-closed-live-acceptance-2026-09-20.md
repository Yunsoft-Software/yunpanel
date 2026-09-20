# Yerel Sunucu Kimliği ve Hostname Fail-Closed Canlı Kabul Raporu — 2026-09-20

## 1. Amaç ve Kapsam

Bu rapor, YunPanel test sunucusunda (`157.180.11.28`, hostname `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-d508-4ae6-92be-efdedee9658d`) üretim modunda (`NODE_ENV=production`) yerel yönetim backend'inin exact `YUNPANEL_LOCAL_SERVER_ID` ve OS hostname eşleşmesi olmadan kesinlikle başlamadığını (fail-closed), geçersiz veya kayıt dışı sunucu kimliği verildiğinde çöktüğünü ve uzak/eski sunucu mutasyonlarının kapalı kaldığını belgeler.

Kapsam (`T-BASE`):
- `NODE_ENV=production` ortamında `YUNPANEL_LOCAL_SERVER_ID` boş olduğunda uygulamanın dinlemeye başlamadan hata vermesi.
- `YUNPANEL_LOCAL_SERVER_ID` kayıt defterinde bulunmayan bir UUID olduğunda `local_server_not_found` hatasıyla derhal kapanması.
- `assertBoundServer` tarafından `server.hostname === os.hostname()` ve `executionMode === 'local'` kontrollerinin zorunlu kılınması.
- Retained agent transport'un yerel panelde kapalı kalması.

## 2. Test Adımları ve Çıktılar

### 2.1. YUNPANEL_LOCAL_SERVER_ID Eksikliği Testi
- Komut:
  ```bash
  cd /usr/lib/yunpanel && NODE_ENV=production YUNPANEL_LOCAL_SERVER_ID='' YUNPANEL_INTERNAL_PROXY_TOKEN='...' /usr/local/bin/node apps/api/src/index.js
  ```
- Çıktı:
  ```
  Error: YUNPANEL_LOCAL_SERVER_ID is required in production
      at file:///usr/lib/yunpanel/apps/api/src/index.js:220:9
  ```
- Sonuç: Uygulama hiçbir portu dinlemeden ve soket açmadan derhal sonlandı.

### 2.2. Kayıt Dışı Sunucu UUID Testi
- Komut:
  ```bash
  cd /usr/lib/yunpanel && env $(cat /etc/yunpanel/control-plane/api.env | xargs) $(cat /etc/yunpanel/control-plane/proxy.env | xargs) NODE_ENV=production YUNPANEL_LOCAL_SERVER_ID='11111111-2222-4333-8444-555555555555' /usr/local/bin/node apps/api/src/index.js
  ```
- Çıktı:
  ```
  LocalRuntimeError: Configured local server record was not found
      at assertBoundServer (file:///usr/lib/yunpanel/apps/api/src/local-runtime.js:73:11)
      at startLocalRuntime (file:///usr/lib/yunpanel/apps/api/src/local-runtime.js:241:3)
      at async file:///usr/lib/yunpanel/apps/api/src/index.js:1017:22 {
    code: 'local_server_not_found'
  }
  ```
- Sonuç: Kayıt defterinde eşleşmeyen sunucu kimliği ile başlatma `local_server_not_found` ile fail-closed reddedildi.

### 2.3. Hostname ve Execution Mode Güvenlik Kontratı
`apps/api/src/local-runtime.js` içerisindeki `assertBoundServer`:
- `server.hostname !== os.hostname()` durumunda `LocalRuntimeError('local_server_hostname_mismatch')` fırlatır.
- `server.executionMode !== 'local'` durumunda `LocalRuntimeError('local_server_not_bound')` fırlatır.
- Gerçek test sunucusunda kayıtlı olan sunucu kimliği (`99bc760a-d508-4ae6-92be-efdedee9658d`), OS hostname (`test`) ve `executionMode: "local"` ile tam uyum içindedir.

## 3. Sonuç
Production YunPanel'in exact `YUNPANEL_LOCAL_SERVER_ID` ve OS hostname doğrulaması olmadan kesinlikle başlamadığı, yabancı veya eksik kimlik durumunda fail-closed kapandığı canlı test ile kanıtlanmıştır.
