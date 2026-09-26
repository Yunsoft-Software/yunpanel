# Reseller scoped account self-service — source slice

Date: 2026-09-26  
Branch: `development`

## Completed source work

- `232d119e`: hosting sidecar schema v3. The lifecycle intent trigger still accepts an active Owner, and now additionally accepts only the active persisted reseller that is the direct parent of the target customer. It does not permit reseller self-suspension, another reseller, another reseller's customer, or a direct Owner customer.
- `79fa3c64`: v1→v2→v3 and v2→v3 migration plus lifecycle trigger source tests were updated/written.
- `4c9f80d7`: the hosting-account store derives a logical reseller actor only from a live `site_manager` session plus the current persisted reseller profile. A reseller can read its own profile and direct customers, list only its own customers, and suspend/reactivate only those customer login accounts.
- `39463109`: authenticated hosting-account HTTP exposes scoped GET/list and customer `/status` to that persisted reseller actor. Registration, limits and profile unlink remain Owner-only.
- `ed4a0079`, `17bdd187`, `8b196f5f`: store, route and full auth-boundary regression tests were added for cross-reseller/direct-customer denial, server-side list filtering, child lifecycle, session revocation and Owner-only mutation guards.

## Security / product boundary

This does not add a new login role. Auth rows remain `site_manager`; reseller authority is derived from the live sidecar profile. Request roles, query ownership and client-supplied parent IDs are not authority.

Website allocation/provisioning, reseller/customer creation, limit changes, unlink/transfer, site tool scope, jobs/logs/backups/AI/tool gateway/WebSocket scope and reseller UI/menu remain closed or unchanged. Account suspension still changes login access only; it does not suspend Website host processes.

## Verification status

The source tests above were written but were **not executed in this session**. The environment could not resolve GitHub for a checkout, so Node 24/npm 11 full install/check/suite and browser/host acceptance remain open. No production host was touched and `.44` was not used.

This slice advances RS-02e / RS-03 reseller self-service source work only. RS-02, RS-03, RS-04 and RS-05 remain open until the remaining runtime/UI/tenant-isolation and real acceptance gates pass.
