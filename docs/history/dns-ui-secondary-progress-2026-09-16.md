# DNS UI ve Secondary DNS İlerleme Kaydı — 2026-09-16

Bu kayıt, 2026-09-16 turunda YunPanel DNS tarafında yapılan source değişikliklerini ve kaldığımız exact noktayı tutar. `plan.md` güncel kalan işleri, gerçek Ubuntu/browser/provider kabul işleri `todo.md` içindedir.

## Bu turda tamamlanan source işleri

### Site Detail DNS paneli

- `apps/web/src/workspace/dns-client.js`: Domain authoritative zone read, manual RRset create/update/delete, Zone Template re-apply preview/apply/operation status ve DNSSEC status/preview/apply/operation client contract'ları eklendi.
- `apps/web/src/workspace/dns-model.js`: root-zone ownership, manual-vs-managed edit policy, canonical RRset payload/draft, operation ve DNSSEC presentation modeli eklendi.
- `apps/web/src/workspace/DnsPanel.jsx`: Site Detail altında gerçek DNS sekmesi eklendi.
  - root zone authoritative kayıtları gösterilir;
  - `template`, `mail`, `runtime` managed kayıtlar read-only;
  - yalnız `manual` RRset add/edit/delete edilir;
  - subdomain için sahte ayrı authoritative zone üretilmez, parent/root zone'a link verilir;
  - re-apply diff/conflict/blocker/serial/template-version görünür;
  - durable re-apply ve DNSSEC operation history görünür;
  - DNSSEC local signing, local DS ve parent DS ayrı state olarak gösterilir;
  - native `window.alert/confirm/prompt` yerine typed-confirmation modal kullanılır.
- `SiteDetailPage.jsx` DNS tabını gerçek panele bağladı; overview'da hızlı DNS linki eklendi.
- `dns-panel.css` ile responsive tablo/diff/DS/operation düzeni eklendi.
- Source-level client/model/wiring test kontratları eklendi. Bu ortamda local repo/test runner olmadığı için testlerin çalıştığı iddia edilmedi.

### Settings > Network / DNS

- `network-dns-client.js`: server DNS identity, PowerDNS authoritative ve delegation API client'ları eklendi.
- `network-dns-model.js`: form serialization ve local/public/delegation state presentation modeli eklendi.
- `NetworkDnsSettingsPanel.jsx` Settings ekranına bağlandı.
  - OS/server hostname yalnız referans authority olarak kalır; ikinci hostname authority yaratılmaz;
  - public IPv4/IPv6, ns1/ns2, SOA, DNSSEC default ve secondary transfer target'ları preview + typed confirmation ile yönetilir;
  - PowerDNS local health ayrı gösterilir;
  - public UDP/TCP 53 readiness ayrı gösterilir;
  - registrar/delegation inspector observed/expected NS, glue gereksinimi ve exact NS/IP talimatı gösterir;
  - registrar hesabında otomatik düzeltme yapılmış gibi davranılmaz.
- İlk component sürümündeki nested `<dialog>` problemi source review sırasında yakalanıp düzeltildi; form preview sonrası kapanır ve tek typed-confirmation dialog'a geçer.
- `network-dns.css` ve source wiring/model/client test kontratları eklendi.

### Public DNS reachability ayrımı

- `apps/api/src/public-dns-reachability.js` ile local socket health ve public DNS reachability semantik olarak ayrıldı.
- PowerDNS authoritative state artık:
  - `ready` / `localReady`: local PowerDNS health;
  - `publicReady`: yalnız external-vantage UDP+TCP 53 evidence;
  - `overallReady`: local + public birlikte;
  - `publicReachability.status=unverified`: external probe configure edilmemiş;
  - `publicReachability.status=unverifiable`: probe çalıştı fakat güvenilir sonuç üretilemedi.
- Loopback/same-host probe public-ready evidence olarak kabul edilmez.

### Secondary DNS provisioning / NOTIFY

PowerDNS davranışı incelenirken kritik bir eksik bulundu: zone create path'i `kind: Native` kullanıyordu. PowerDNS NOTIFY davranışı primary/master zone lifecycle'ına bağlı olduğundan secondary configured olsa bile gerçek NOTIFY garanti değildi.

Yapılan değişiklikler:

- `site-create-dns-provisioning.js` exact `secondaryDns` topology snapshot'ını durable `dns_zone` intent'ine ekliyor.
- `powerdns-zone-manager.js`:
  - yeni zoneları `Primary` oluşturuyor;
  - secondary configured iken mevcut `Native` zone'u doğrulanmış `Primary` state'e geçirebiliyor;
  - `Secondary/Slave` gibi ters authority kind'larını sessizce dönüştürmeyip fail-closed kalıyor;
  - explicit PowerDNS `/notify` endpoint'ini tetikleyebiliyor;
  - `notified_serial` metadata'sını okuyor;
  - `notified_serial` yalnız NOTIFY dispatch/state evidence olarak tutuluyor, AXFR transfer completion kanıtı sayılmıyor.
- `website-dns-zone-provisioning-handler.js` secondary topology'yi validate edip worker apply/inspect çağrılarına `notifySecondaries` olarak taşıyor; public evidence'a zone kind, observed/notified serial ve notify state ekliyor.

## Kaldığımız exact nokta

Secondary DNS lifecycle henüz tamamlanmış değildir.

Sıradaki source işleri:

1. Zone Template re-apply path'inin current DNS identity içindeki configured secondary topology'yi alıp mutation sonrası NOTIFY tetiklemesi.
2. Manual RRset CRUD path'inin aynı secondary NOTIFY contract'ını kullanması.
3. Configured secondary IP'lere TCP SOA sorgusuyla `observedSecondarySerial` evidence üretmek.
4. Primary serial / PowerDNS `notified_serial` / her secondary observed SOA serial'ını ayrı status olarak API ve Network/DNS paneline taşımak.
5. Timeout/unreachable/serial-lag secondary durumunu `ready` saymamak.
6. Daha sonra PowerDNS config/package upgrade/rollback lifecycle'ını durable operation evidence ile transactional hale getirmek.

## Gerçek ortam kabulü

`todo.md` içindeki T-DNS kapıları geçmeden DNS P0 kapısı DONE değildir. Özellikle:

- public UDP ve TCP 53 dış vantage point'ten doğrulanmalı;
- Network/DNS ve Site Detail DNS UI Chromium/Firefox'ta gerçek backend ile denenmeli;
- iki authoritative endpoint veya onaylı secondary ile delegation, NOTIFY, AXFR ve failover gözlenmeli;
- `notified_serial` ile remote secondary SOA serial birbirinden ayrı evidence olarak doğrulanmalı;
- `.44` ile biten Plesk sunucusuna kesinlikle dokunulmamalıdır.

## Commit zinciri

Bu turdaki ilgili küçük commitler:

- `8ba6a07` feat: add DNS workspace client
- `3169fe7` feat: add DNS workspace model
- `f3927e0` test: cover DNS workspace model
- `ae1c41d` test: cover DNS workspace client
- `cd10d46` feat: add site DNS workspace panel
- `172221a` style: add DNS workspace panel styles
- `9ffcbcc` feat: wire DNS tab into site detail
- `0723502` feat: link DNS from site overview
- `1862d11` test: guard DNS workspace wiring
- `5532126` feat: add Network DNS workspace client
- `1ec7e4e` test: cover Network DNS client
- `d2cf3a4` feat: add Network DNS workspace model
- `ee244a6` test: cover Network DNS model
- `b1e3b92` feat: add Network DNS settings panel
- `12e7d36` fix: avoid nested DNS confirmation dialogs
- `4c80ad0` style: add Network DNS settings styles
- `23c4054` feat: wire Network DNS settings
- `2ab6ef1` test: guard Network DNS wiring
- `5631b65` feat: model public DNS reachability evidence
- `652db4e` test: cover public DNS reachability
- `87abe6b` feat: separate PowerDNS local and public readiness
- `6ee505e` test: cover PowerDNS public readiness state
- `f01ba2a` feat: present PowerDNS public readiness
- `252b037` feat: show public DNS reachability in settings
- `911885d` test: cover Network DNS public readiness presentation
- `eb3efce` feat: snapshot secondary DNS targets in zone intent
- `d2e80f3` feat: manage PowerDNS primary zone notifications
- `00fd284` feat: carry secondary DNS notify evidence through provisioning
- `ce5d410` docs: sync DNS panel and secondary notify progress

GitHub Actions kullanılmadı.
