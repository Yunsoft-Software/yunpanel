# T169 İnceleme Notu (DKR-06)

- **İnceleyen**: AGENT_1
- **Tarih**: 2026-10-28
- **Yapan**: AGENT_3
- **Karar**: KABUL (ACCEPTED)

## İnceleme Detayları
1. **Mock ve Sahte Veri Kontrolü**:
   - `e2e/ozellik/dkr-06.spec.js` içerisinde herhangi bir `page.route()`, mock veri, stub veya simülasyon bulunmamaktadır.
   - Doğrulamalar gerçek YunPanel arayüzü ve `.28` test sunucusu (`yunpanel-test`, `157.180.11.28`) üzerinde gerçek Docker motoru, storage-backup API ve SSH kontrolleriyle fiziksel olarak yapılmıştır.
2. **Kapsam ve Senaryo Bütünlüğü**:
   - **Hatalı Girdi**: `/api/panel/docker/projects/:id/storage-backup` uç noktasında olmayan geçerli UUID için 404 (`docker_compose_project_not_found`), geçersiz ID formatında 400 (`invalid_docker_project_id`) ve sorgu parametresi verildiğinde 400 (`docker_storage_backup_query_invalid`) döndüğü doğrulanmıştır.
   - **Mutlu Yol**: Named volume ve ephemeral storage (`tmpfs`) içeren Compose projesi arayüzden oluşturulmuş; proje detayında `Depolama` (StoragePanel) sekmesinde Manifest `v1`, Dahil `1`, Backup dışı `1` ve depolama tablosundaki politikalar (`Manifest'e dahil`, `Backup dışı`) doğrulanmıştır. Konteyner başlatılarak fiziksel olarak `docker volume inspect`, container içine veri yazma/okuma (`echo ... > /data/persistence.txt`) ve HTTP 200/nginx cevabı canlı sunucuda teyit edilmiştir.
   - **Plesk Docker Eşdeğerliği**: Konteyner yapılandırma yedeği (Compose YAML / env / port) ile kalıcı volume verisi yedeğinin ayrı ayrı seçilebilmesi ve bağımsız Docker yedekleme/geri yükleme aracının bulunmaması `test.fail` ile belgelenmiştir (`BULGU DKR-06`).
   - **Temizlik**: `afterAll` kancasında host üzerinde SSH ile `docker stop`, `docker rm -f`, `docker compose down --volumes --remove-orphans` ve `docker volume rm -f` adımları işletilmektedir. Sunucu üzerinde herhangi bir artık konteyner veya volume kalmadığı teyit edilmiştir (0 artık ilkesi).
3. **Dokümantasyon Standartları**:
   - `docs/manuel-test/DKR-06.md` dosyası 28 satır olup 40 satır kuralına ve şablona uygundur.
   - `tasks/review/T169.md` raporu eksiksiz doldurulmuş ve `accept` komutu ile `tasks/done/T169.md` konumuna taşınmıştır.
4. **Bağımsız Doğrulama**:
   - `python3 orkestra/locks.py acquire sunucu-28-1 AGENT_1` ile kilit alındı.
   - `AGENT_N=1 npx playwright test e2e/ozellik/dkr-06.spec.js --reporter=line` -> `3 passed (34.6s)` (1 test.fail dahil) başarıyla geçti.
   - `ssh yunpanel-test "docker ps -a --filter name=tdkr06 && docker volume ls --filter name=tdkr06"` -> 0 artık kaynak.
   - `python3 orkestra/locks.py release sunucu-28-1 AGENT_1` ile kilit serbest bırakıldı.
   - `python3 orkestra/tasks.py lint` -> `lint OK`.
   - `python3 orkestra/tasks.py accept T169 AGENT_1 "..."` başarıyla icra edildi.
