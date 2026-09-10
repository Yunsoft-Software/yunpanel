# Website workspace — current backend boundary

Visual redesign/layout/styling/component polish remains deferred. This document only describes the backend contracts the later UI must consume.

## Persistent Website resource

YunPanel has a real persistent Website resource separate from hostname/domain records.

Implemented backend contracts:

- `GET /api/websites`
- `GET /api/websites/:websiteId`
- `GET /api/websites/:websiteId/domains`
- `POST /api/websites`
- `POST /api/websites/:websiteId/update-preview`
- `PATCH /api/websites/:websiteId`
- `GET /api/websites/migration/preview`
- `GET /api/websites/migration/status`
- `POST /api/websites/migration/bind`
- `POST /api/websites/migration/finalize`
- `POST /api/websites/migration/rollback`

Website state is stored separately through `YUNPANEL_WEBSITE_STORE`. Migration enforcement state is stored through `YUNPANEL_WEBSITE_MIGRATION_POLICY_STORE`. Production startup validates persisted Website server/application foreign keys and initializes migration policy before accepting Domain state.

An application-backed Website owns stable Website UUID, server/application IDs, runtime type, canonical managed document root and deterministic `yunapp-*` Unix user. A proxy Website is a real resource without an invented application/document root/Unix user and may own one canonical host/port/WebSocket target. Website records carry a positive revision; persisted v1 state is validated and migrated once to v2 with revision `1` and no invented proxy target.

The Website ID is not a domain ID. Backend relationships use explicit foreign keys rather than permanent server/port/root heuristics.

## Domain relationship and IDN

Domain records may persist `websiteId`. `GET /api/websites/:websiteId/domains` reads only that explicit field; it does not infer membership from hostname, parent suffix, proxy port or application root.

Legacy domain state without the field opens as `websiteId=null`. A one-way registry primitive can bind an unbound legacy domain to one same-server Website without changing its current Nginx desired/applied revision. Rebinding an already-bound domain is blocked until impact-preview/move semantics exist.

Shared hostname validation canonicalizes IDN input to ASCII punycode. Unicode/punycode equivalents therefore collide as the same hostname/alias and hierarchy comparisons use one canonical form.

## Website update and rebind

`POST /api/websites/:websiteId/update-preview` accepts only a `changes` object. Name, application/runtime binding and proxy target are the only update fields. Application-backed roots and Unix users are re-derived from the selected same-server Application; caller-controlled roots/users remain impossible and one Application cannot be attached to multiple Websites.

The preview binds the proposed state to the current Website revision and to a SHA-256 digest of every explicitly linked Domain's safe traffic/certificate revision metadata. It reports whether a later Domain restage is required, but never changes Domain target, Nginx, certificate or live traffic itself. `PATCH /api/websites/:websiteId` requires that exact revision, digest and typed confirmation. Website or linked-Domain drift rejects the apply before mutation. A successful apply increments the Website revision in the private registry file.

Switching an application-backed Website to proxy is explicit: `runtimeType=proxy` and `applicationId=null` are both required. Switching back requires an exact Application ID and its matching `static` or `node` runtime. Proxy hosts accept canonical IP/DNS names only—not URL schemes or paths—and ports remain in the non-privileged `1024..65535` range.

## Migration preview, bind and enforcement

`GET /api/websites/migration/preview` is Owner-only and read-only. It examines current persisted Domain/Website/Application state and reports safe migration decisions without mutating state. Static legacy targets match applications only by exact managed web root; Node targets match only same-server loopback proxy + exact current port. Multiple matches are `ambiguous`; no safe match is `unresolved`.

A single exact application candidate produces either `bind_existing_website` or `create_website_then_bind`. These are migration suggestions only: preview returns `destructive=false`, `autoApply=false` and a deterministic SHA-256 digest.

`POST /api/websites/migration/bind` handles only the existing-Website case. It requires Domain/Website UUIDs, the exact current preview digest and typed confirmation. The server recomputes the current plan before mutation; stale or different plans fail closed. Retry of the same completed binding is idempotent.

The backend intentionally does not combine Website creation and Domain binding into one call because those registries are independent durable files. For `create_website_then_bind`, the current safe workflow is explicit Website create → new preview → guarded bind.

`GET /api/websites/migration/status` returns the current policy beside a fresh preview. The versioned policy starts in `compatibility`. `POST /api/websites/migration/finalize` can switch it to `enforced` only when the exact current preview says every managed Domain is already explicitly bound. In enforced mode new managed Domain creation requires a same-server `websiteId`.

`POST /api/websites/migration/rollback` requires the exact enforced digest and returns policy to compatibility mode. It does not rewrite Domain traffic, certificates, releases or application state. Migration-only binding rollback uses its own durable ledger/receipt and is not a general Domain unbind operation. A migration-created Website that has been revised by an ordinary update is never silently treated as the untouched rollback resource, even if its visible fields were later restored.

Migration bind/finalize/rollback are covered by common management audit without copying body, confirmation or digest material into audit metadata.

## Authentication/access boundary

All Website management enters through the authenticated API listener. Owner management requires normal session/MFA/Origin/CSRF policy. Read Only accounts may read Website collection/detail and explicit Website→domains relation; Website update preview/apply, migration preview/status and all Website/migration mutations remain Owner-only.

Caller input cannot set `documentRoot` or `unixUser`; those values are derived from managed application identity.

## Existing hosting functionality available to the future UI

The later Website UI can build on server inventory/snapshots, static and Node deployment lifecycle, masked/encrypted application env, Nginx stage/activate, managed ACME, managed services, DB inventory/create/delete, durable jobs/recovery, common audit and Owner user administration.

A `202` response is queued/accepted work, not completion.

## Remaining backend work

See `plan.md` C/E/F/G/H/I. Persistent Website foundation, IDN canonicalization, guarded existing-Website migration bind and compatibility/enforced policy are implemented. Remaining Website/domain work includes:

- move/delete impact preview beyond the hierarchy-only reparent flow,
- site-create orchestration,
- DNS/mail lifecycle separation,
- Docker/static/Node/site-resource relationships beyond current application/domain links.

## Design status

Do not spend the current development phase on visual Website workspace polish. The existing React workspace may retain compatibility routing/data shapes until a later integration pass. Final enterprise UI/UX is intentionally assigned to a separate model after functionality is complete.

Security behavior, authenticated routing, stale privileged-data handling and destructive confirmation are not optional visual polish and remain subject to `todo.md` acceptance.

## Validation

Current full Node24/workspace, browser, package persistence, Website foreign-key, migration policy, IDN and migration acceptance are tracked in `todo.md`. Historical UI/model tests are not evidence that the current tree passed. GitHub Actions are not used.
