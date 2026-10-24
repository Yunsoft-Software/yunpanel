# Yerel executor güvenlik sözleşmesi

Production enters through `apps/api/src/index.js`. Production YUNPANEL_LOCAL_SERVER_ID, exact OS hostname ve executionMode=local olmadan privileged listener açılmaz. Local identity'de ikinci agent consumer/enrollment/remote command yolu kullanılmaz; migration rollback uyumluluğu ayrı korunur.

API root; Git/build/runtime/cron/file/terminal dedicated site kullanıcısında. Root PTY authenticated Owner-only; site PTY site scope. Process capability/write-path sınırlaması, session/WS revoke, resource lock ve durable intent/receipt zorunlu.

Bilinmeyen child-process sonucu execution_state_unknown; job kör yeniden oynatılmaz. Mutating recovery exact persisted payload, dış host kanıtı veya private receipt ister. There is no generic `force-success`, force-failed, journal-clear veya sınırsız retry.

Snapshot yalnız hostname/ID/mode/version/service/inventory metadata; environment/private file çıktı değildir. Public diagnostics kontrollü hata kataloğundan, raw stdout/stack/token'dan gelmez. validate, clear recovery ve aktif iş olmaması ownership migration kapısıdır. [Operasyon](operations.md), [migration](local-runtime-migration.md), [güvenlik](security.md).
