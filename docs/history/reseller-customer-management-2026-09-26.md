# Reseller customer account management — source slice

Date: 2026-09-26  
Branch: `development`

## Completed source work

- `237e7e07`, `2c69aa33`, `779f3db3`: the existing auth password hasher and username normalizer are reused inside the hosting account store. An active persisted reseller can create a new direct customer login/profile atomically and can update only that direct customer's username/password. The login row remains the existing `site_manager` role; no reseller/customer auth role was added.
- `0caec918` → `57224efc`: dedicated authenticated HTTP surfaces were added: `POST /api/users/hosting/accounts/self/customers` and `PATCH /api/users/hosting/accounts/:id/login`. Generic profile registration, reseller limits, unlink/transfer and Website allocation remain outside the reseller surface. The intermediate route-regex corruption was detected during diff review and fixed in `57224efc`.
- `47437d72`, `88ebb636`, `688afe2b`, `58e2c4dc`: source tests cover KDF-time session reauthorization, username race, customer-count quota, mass-assignment denial, direct-child scope, session revocation, cross-reseller denial and full auth-boundary composition.
- `c0be050c` → `d1fa8140`: authenticated sessions expose only bounded hosting context `{kind,resellerId}` for profiled site-manager accounts. Legacy site-manager sessions without a hosting profile remain unchanged. The web session protocol validates this context fail-closed and derives `isReseller` / `isCustomer`.
- `345b1ef8` → `4919d574`, `3337488e`: a real `/customers` / **Müşterilerim** reseller workspace is mounted only when the server-derived session says the current hosting profile is a reseller. It lists only the reseller's own direct customers and supports create, username/password edit, suspend and reactivate.
- `bed56615` → `9b496d2f`: the web client whitelists customer credential payloads, requires explicit `siteAccessGranted: false`, preserves single-flight/session-generation behavior and uses fresh scoped reads to reconcile uncertain writes before replay can occur.
- `cc8411a2`, `ab17180a`: navigation/source tests preserve the Owner and ordinary site-manager menus while adding **Müşterilerim** only for a reseller session. The reseller page intentionally has no unlink/delete, ownership transfer, limit editor, site grant, login-as or package/subscription UI.

## Security and product boundary

Customer creation writes the login and hosting profile in the same auth transaction after a current reseller/profile/quota/username recheck. Password hashing happens outside the write transaction, and authority is checked again afterward. Request fields cannot select role, active state, parent reseller or Website grants.

Customer login edits require the current hosting profile revision and are reauthorized before and after asynchronous password hashing. Successful login changes revoke the target customer's sessions and pending MFA state while preserving enrolled MFA. A reseller cannot edit itself, another reseller, another reseller's customer or a direct Owner customer.

The new customer has **no Website access merely because the login/profile exists**. API and client results explicitly carry `siteAccessGranted: false`. Website ownership/allocation, Files, databases, mail, jobs, logs, backup, AI, tool gateways and WebSocket tenant scope are still separate open work.

## Verification status

The new/updated source tests were written but were **not executed in this session**. A real checkout was retried and failed with `Could not resolve host: github.com`, so Node >=24.11.1/npm >=11 install/check/build and real React/browser/host acceptance remain open.

No GitHub Actions were used, no production deployment was performed, and the prohibited `.44` host was not touched.

This slice advances RS-02e / RS-03 / RS-04 source work only. RS-05 and the remaining Website/tool tenant-isolation and real acceptance gates stay open.
