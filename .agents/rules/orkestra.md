---
trigger: always_on
description: Orkestra bağlayıcı çalışma kuralları (her ajan, her tur)
---

# Orkestra

Başlatma ve her kesinti sonrası tek giriş: **`/orkestra-devam`** (junior) veya **`/orkestra-senior`** (senior).
Bağlayıcı kurallar: `docs/orkestra/KURALLAR.md` (ortak) ve `docs/orkestra/PROJE.md` (projeye özel; çelişirse geçerli). Hafızadan hiçbir şey varsayma; durum diskte (`python3 orkestra/tasks.py status`).
