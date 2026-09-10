# Website workspace — current backend boundary

Visual redesign/layout/styling/component polish remains deferred. This document only describes the backend contracts the later UI must consume.

## Persistent Website resource

YunPanel now has a real persistent Website resource separate from hostname/domain records.

Implemented backend contracts:

- `GET /api/websites`
- `GET /api/websites/:websiteId`
- `GET /api/websites/:websiteId/domains`
- `POST /api/websites`

Website state is stored separately through `YUNPANEL_WEBSITE_STORE`. Production startup validates persisted Website server/application foreign keys before accepting the store.

An application-backed Website owns:

- stable Website UUID,
- server ID,
- application ID,
- runtime type,
- canonical managed document root,
- deterministic `yunapp-*` Unix user.

A proxy Website is a real resource without an invented application/document root/Unix user.

The Website ID is not a domain ID. Backend relationships must use explicit foreign keys rather than matching server/port/root heuristics.

## Domain relationship

Domain records may persist `websiteId`. The Website relationship endpoint reads only that explicit field; it does not infer membership from hostname, parent suffix, proxy port or application root.

Legacy domain state without the field opens as `websiteId=null`. A one-way migration primitive can bind an unbound legacy domain to one same-server Website without changing the active Nginx traffic revision. Rebinding an already-bound domain is deliberately blocked until impact-preview/move semantics exist.

Shared hostname validation now canonicalizes IDN input to ASCII punycode, so Unicode and punycode equivalents compare as the same hostname/alias.

## Authentication/access boundary

All Website management still enters through the authenticated API listener. Owner management requires the normal session/MFA/Origin/CSRF policy. Read Only accounts may read Website collection/detail and the explicit Website→domains relationship; Website creation/mutation remains Owner-only.

Website create is covered by the common audit mutation classifier. Caller input cannot set `documentRoot` or `unixUser`; those values are derived from managed application identity.

## Existing hosting functionality available to the future UI

The later Website UI can build on existing backend foundations for:

- server inventory and local snapshots,
- static deploy/rollback,
- Node deploy/status/restart/rollback,
- encrypted/masked application environment state,
- Nginx domain stage/activate,
- managed ACME issue/renew,
- managed-service lifecycle,
- MySQL/MariaDB inventory + DB create/delete,
- durable jobs/recovery,
- common audit history,
- Owner user administration.

A `202` response is queued/accepted work, not completion.

## Remaining backend work

See `plan.md` C/E/F/G/H/I. In particular the persistent Website foundation does **not** yet mean the migration is complete. Remaining Website/domain work includes:

- versioned migration from legacy domain/application state,
- mandatory Website binding for new managed domains only after rollback-safe migration,
- Website update/rebind lifecycle,
- reparent/move/delete impact preview,
- site-create orchestration,
- DNS/mail lifecycle separation,
- Docker/static/Node/site-resource relationships beyond the current application/domain links.

## Design status

Do not spend the current development phase on visual Website workspace polish. The existing React workspace may still use compatibility routing/data shapes until a later integration pass. The final enterprise UI/UX is intentionally assigned to a separate model after functionality is complete.

Security behavior, authenticated routing, stale privileged-data handling and destructive confirmation are not optional visual polish and remain subject to `todo.md` acceptance.

## Validation

Current full Node24/workspace, browser, package persistence, Website foreign-key, IDN and migration acceptance are tracked in `todo.md`. Historical UI/model tests are not evidence that the current tree passed. GitHub Actions are not used.
