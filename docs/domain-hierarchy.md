# Domain hierarchy — current backend boundary

## Current model

Domains and Websites are now separate persistent backend resources.

A `Website` has its own stable UUID and owns the server/application/runtime/document-root/Unix-user binding. A domain record owns hostname-oriented state and may carry an explicit `websiteId` foreign key plus an explicit `parentDomainId`.

Current Website rules:

- Website identity is independent from hostname/domain IDs,
- application-backed static/Node Websites derive canonical document root and deterministic `yunapp-*` user from the application ID,
- one application cannot be silently bound to multiple Websites,
- persisted Website records revalidate server/application references at startup,
- missing/cross-server/runtime/root drift fails closed,
- proxy Websites remain valid without inventing an application or Unix user,
- `/api/websites`, `/api/websites/:id` and `/api/websites/:id/domains` read real Website state rather than same-server/port inference.

Current domain hierarchy rules:

- `parentDomainId` is explicit; ancestry is never guessed from the final two labels,
- parent/child must share a server,
- the normalized child hostname must be below the parent's primary hostname at a dot boundary,
- duplicate IDs, missing parents and cycles fail closed,
- aliases remain attached names and are not silently promoted into independent parent resources,
- `websiteId` is optional only for legacy/migration compatibility,
- an explicit Website binding requires an existing Website on the same server,
- a legacy unbound domain can migrate one-way from `websiteId=null` to one exact Website; changing an existing binding requires a future impact-preview path.

## Hostname normalization

Shared hostname validation canonicalizes internationalized domain names through Node's UTS-46/ASCII conversion. Unicode and equivalent punycode forms therefore persist and compare in one ASCII representation. Unicode dot variants are normalized before conversion.

Duplicate domain/alias and parent-boundary checks operate on that canonical ASCII form. Wildcards remain outside the ordinary hostname validator and are a separate DNS/certificate feature.

## Migration boundary

Existing domain files with no `websiteId` still open as `websiteId=null`; startup does not invent bindings from hostname, server or port. This is intentional.

The remaining migration work must:

- produce a versioned/read-only mapping preview,
- create/reuse Websites without changing current traffic targets,
- bind legacy domains through the one-way migration primitive,
- preserve domain/application IDs, certificate links, encrypted secrets and release history,
- provide rollback before `websiteId` becomes mandatory for new managed domain creation.

Until that migration is accepted, do not globally require `websiteId` on legacy domain state.

## Website/domain relationship reads

`GET /api/websites/:websiteId/domains` returns only domains whose persisted `websiteId` equals that Website ID. It does not infer a relationship from proxy ports, static roots or hostname suffixes. Read Only accounts may use this safe relationship read because they already have domain inventory access; unrelated nested Website management remains Owner-only.

## DNS, SSL and mail separation

Website/domain identity, DNS hosting/provider state, certificate state and mail-domain/mailbox state remain separate lifecycles. Creating or binding a hostname does not mean DNS propagated, a certificate exists or mail is configured.

Nginx stage/activate and managed certificate issue/renew continue through durable jobs and operation-specific recovery. Do not replace them with generic retry/force-success behavior.

## Delete/move/reparent rule

Future reparent/move/delete operations require a backend impact preview covering at least child domains, Website/application bindings, certificates, mail resources, backups and later cron/Docker dependencies. Default behavior must fail closed when dependent resources would be orphaned; hidden cascade deletion is not acceptable.

## Design status and validation

Visual hierarchy/site-detail redesign is deferred until backend functionality is complete. Do not spend this phase on layout/styling polish.

Current Node24/full-workspace, authenticated API, package persistence, IDN, Website/domain migration and real DNS/Nginx/ACME acceptance requirements are in `todo.md`. Source implementation is not production acceptance. GitHub Actions are not used.
