# DKIM Rotation & Local PowerDNS Retirement Live Acceptance (2026-09-20)

## 1. Summary
Verified the complete end-to-end DKIM key rotation and local PowerDNS retirement lifecycle on the authorized test server (`157.180.11.28`).

## 2. Issue Identified & Resolved
- In `apps/api/src/mail-dkim-dns.js`: `mailDkimDnsService.reconcileRetirement` was throwing `mail_dkim_dns_zone_required` or `mail_dkim_dns_credential_required` when invoked for domains that do not use external Cloudflare DNS automation (such as domains using local PowerDNS).
- Fixed `reconcileRetirement` to catch `MailDkimDnsError` for unmanaged/local DNS zones (`mail_dkim_dns_zone_required`, `mail_dkim_dns_credential_required`, `mail_domain_not_locally_managed`) and safely return `{ pending: true, cleared: false, unmanaged: true }` without crashing the rotation or deletion flow.
- Added unit tests in `apps/api/test/mail-dkim-dns.test.js` verifying graceful handling of unmanaged DNS zones.

## 3. Real Server Verification Steps on .28
Target Mail Domain: `mailtest.webrich.news` (`0fa91f02-e2f9-5519-8be3-0e1072dfa41f`), webDomainId: `ecca97c9-9a98-5e67-9b7e-a0423e0bc0ab`.

1. **Initial State**:
   - Mail Domain: `mailtest.webrich.news` (status: `enabled`, revision: 4).
   - Initial DKIM selector: `yp-rot-mu9e2qwe` (revision 2).
   - Pending retirement: `yp-ddec59b2ba0e42ed84b97820` (revision 2).

2. **DNS Zone Reapply (Dual-Publishing during Transition)**:
   - `POST /api/panel/domains/ecca97c9-9a98-5e67-9b7e-a0423e0bc0ab/dns/reapply-preview`:
     - Changes: `replace SOA`, `add yp-rot-mu9e2qwe._domainkey.mailtest.webrich.news`.
     - Preserved: `yp-ddec59b2ba0e42ed84b97820._domainkey.mailtest.webrich.news`.
   - `POST /api/panel/domains/ecca97c9-9a98-5e67-9b7e-a0423e0bc0ab/dns/reapply`:
     - Succeeded (serial incremented to 2026092003).
     - Verified with `pdnsutil list-zone mailtest.webrich.news`: both selectors present in PowerDNS.

3. **Retirement of Previous Selector**:
   - `POST /api/panel/mail-domains/0fa91f02-e2f9-5519-8be3-0e1072dfa41f/dkim/local-dns-retirement-preview`:
     - `readyToApply: true`, `blocker: null`.
     - Changes: `replace SOA`, `delete yp-ddec59b2ba0e42ed84b97820._domainkey.mailtest.webrich.news`.
   - `POST /api/panel/mail-domains/0fa91f02-e2f9-5519-8be3-0e1072dfa41f/dkim/local-dns-retirement-apply`:
     - `completed: true`, `retirementCleared: true`, `status: succeeded`.
   - Verified via `pdnsutil list-zone mailtest.webrich.news`:
     - `yp-ddec59b2ba0e42ed84b97820` completely absent.
     - Only `yp-rot-mu9e2qwe` remains in PowerDNS.
   - Verified via `GET /api/panel/mail-domains/0fa91f02-e2f9-5519-8be3-0e1072dfa41f/dkim/retirement`:
     - Returned `{ data: null }`.

4. **Second Full Lifecycle Rotation Verification**:
   - `POST /api/panel/mail-domains/0fa91f02-e2f9-5519-8be3-0e1072dfa41f/dkim/rotate` with `expectedRevision: 2`, `selector: 'yp-rot-second'`:
     - Succeeded (200 OK).
     - New key revision: 3, selector: `yp-rot-second`.
     - Retirement recorded: `previousSelector: 'yp-rot-mu9e2qwe'`, `phase: 'dns_retirement_pending'`, `revision: 2`.
   - Reapplied DNS zone:
     - `POST /api/panel/domains/:id/dns/reapply`: succeeded.
   - Applied local DNS retirement:
     - `POST /api/panel/mail-domains/:id/dkim/local-dns-retirement-preview`: `readyToApply: true`.
     - `POST /api/panel/mail-domains/:id/dkim/local-dns-retirement-apply`: `completed: true`, `retirementCleared: true`.
   - Verified via `pdnsutil list-zone mailtest.webrich.news`:
     - `yp-rot-mu9e2qwe` absent.
     - Only `yp-rot-second._domainkey.mailtest.webrich.news` present.
   - Verified via `GET /api/panel/mail-domains/:id/dkim/retirement`:
     - Returned `{ data: null }`.
