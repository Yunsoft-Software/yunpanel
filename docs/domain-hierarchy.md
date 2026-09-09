# Domain hierarchy: implementation and validation boundary

## Implemented scope

The domain registry accepts an explicit optional `parentDomainId`. Reads return that reference and a derived `kind` (`domain` or `subdomain`). Parent and child must share a server, the normalized child hostname must be below the parent's primary hostname at a dot boundary, and persisted links must not contain missing ancestors, duplicate IDs or cycles. Aliases remain attached names; an alias is not implicitly promoted to a parent resource.

Each child remains its own domain record with its own static/proxy target and certificate lifecycle. This does not yet create a separate Website/application/Unix-user model. IDN/punycode input, reparenting existing domains, full website migration, per-site runtime tabs and dependency-aware deletion remain in `plan.md`.

The additive field uses the existing version-1 registry. Reading legacy records neither rewrites the file nor guesses parentage from hostname suffixes. Existing records without a parent remain independent. This compatibility step is not the planned versioned Website migration. Older code does not enforce hierarchy, so package rollback still requires explicit operational validation.

The domain view has expandable branches, domain/alias search with ancestor context and an Add subdomain form. Subdomain creation uses the selected parent's server rather than the first server in the collection. Inputs survive failed submission. Existing staging, activation and certificate controls remain. Creating a record does not publish DNS or configure mail.

`apps/api/src/app.js` composes the parent-aware POST handler from `domain-http.js` ahead of the legacy core. `core-app.js` preserves the original core handler from commit `2571d221425e16398131dd5bb085004115bdb606`, blob `77cdeef5130a0ac5384473fadc6c59728f154e54`, byte-for-byte. Production must continue entering through `createAuthenticatedApi` in `index.js`; neither factory is a new public listener. The in-process compatibility guard remains until the planned authentication refactor. Do not start `core-app.js` or `createApp().listen()` as an alternative production entry point.

## Focused validation — 2026-09-09

Command, from the repository root after the normal workspace dependencies are available:

```bash
node --test \
  apps/api/test/domain-hierarchy.test.js \
  apps/api/test/domain-parent-registry.test.js \
  apps/api/test/domain-http.test.js \
  apps/web/test/domain-tree.test.js
```

Result in this development environment: **29 tests passed, 0 failed, 0 skipped**.

Coverage:

- 9 hierarchy checks: explicit parents, nested children, dot boundaries, unrelated names, aliases, invalid/missing IDs, cross-server ownership, cycles and non-mutation.
- 7 registry checks: reopen/persistence, independent targets/certificates, rejected requests leaving disk unchanged, legacy read compatibility, corrupt-state rejection, defensive copies and existing staging lifecycle.
- 3 HTTP mapping checks using the real registry and an in-memory response recorder: parent forwarding/201, failure propagation, and legacy defaults. These are not network or authenticated-listener tests.
- 10 tree/form checks: stable hierarchy order, collapse, matching ancestors, aliases, orphan/cycle handling, no mutation, correct parent-server selection, no fallback for a missing parent/server, prefix and port validation.

Environment qualification: these focused tests ran under Node 22.16.0 against a locally assembled subset because Git/network dependency installation was unavailable. `@yunpanel/shared` was resolved locally to the repository's unchanged domain validation source; no replacement validation algorithm was used. This is not a full workspace installation and does not establish compatibility for the repository's required Node 24.11.1+ auth/SQLite runtime. No engine requirement or dependency policy was lowered.

`DomainList.jsx` and `DomainManager.jsx` also passed a JSX syntax-transpilation check, and the new composition module passed `node --check`. No TypeScript source or dependency was added to the project. Syntax checks do not establish React rendering, accessibility, layout quality, Vite resolution or browser behavior.

## Not validated here

The full `npm run check`, actual Express composition/authentication boundary, package build/upgrade, React browser rendering and responsive interactions, real DNS/Nginx/ACME, and live `cryptoraichu.website` deployment were not run in this environment. Required acceptance checks are in `todo.md` T1a/T3a. Existing systemd/agent/terminal behavior was not migrated by this feature. No GitHub Actions or production mutations were performed.
