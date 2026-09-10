# Domain hierarchy — current backend boundary

## Implemented scope

The domain registry supports an explicit optional `parentDomainId`. Parent/child relationships are stored as resource identity, not inferred from string suffixes at read time.

Current hierarchy rules include:

- parent and child must belong to the same server,
- the normalized child hostname must be below the parent's primary hostname at a dot boundary,
- duplicate IDs, missing parents and cycles are rejected,
- aliases remain attached names and are not silently promoted into independent parent resources,
- legacy domain records without a parent remain independent rather than receiving guessed ancestry.

Each child is still its own domain record with its own target and certificate lifecycle. Creating a domain/subdomain record does not publish external DNS and does not create a mail domain.

## Important current limitation

The current hierarchy is **not** the final Website model. There is still no independent persistent `Website` identity that owns runtime/document-root/Unix-user relationships.

The remaining model work in `plan.md` includes:

- persistent Website records separate from hostnames,
- explicit Website ↔ application/runtime/document-root/Unix-user links,
- IDN/punycode normalization,
- safe reparenting of existing records,
- dependency-aware move/delete preview,
- alias/canonical semantics in the final Website/domain model,
- versioned migration from existing domain/application records while preserving IDs, certificates, releases and traffic.

Do not treat `/websites/:id` compatibility routing or same-server/port application matching as a permanent foreign-key relationship.

## API and authentication boundary

Production enters through `apps/api/src/index.js` and `createAuthenticatedApi()`. Domain management remains behind the backend session/role/MFA/CSRF/Origin boundary. Directly mounting a lower-level app factory is not a supported alternate public listener.

The old server-enrollment HTTP path has been retired. Domain work must not reintroduce an agent enrollment or alternate unauthenticated management surface.

Nginx domain stage/activate and managed certificate issue/renew foundations already exist and are consumed through durable jobs. Their running uncertain-outcome recovery is operation-specific; do not replace it with generic retry or force-success logic.

## DNS, SSL and mail separation

The following remain distinct lifecycles:

- web hostname/domain resource,
- DNS hosting/provider state,
- certificate state,
- mail domain/mailbox state.

Creating or reparenting a web hostname must never imply that DNS propagated, a certificate is valid, or mail is configured. DNS readiness/provider mutation, DNS-01/wildcard support and full mail lifecycle remain separate implementation work.

## Deletion and migration rule

Future delete/move operations must produce an impact preview covering dependent child domains, application/Website links, certificates, mail resources and backups where applicable. Default behavior must fail closed when dependent resources would be orphaned; hidden cascade deletion is not acceptable.

Migration from the current compatibility model must be versioned, repeatable and backed up. Existing server/application/domain IDs, encrypted secrets, certificates and release relationships must not be rewritten casually.

## UI status

The existing routed workspace can render the current hierarchy, but final enterprise UI/UX design is deferred. Do not spend the current backend development phase on hierarchy visual polish. Security/browser behavior that affects authorization, destructive confirmation or stale privileged state remains subject to `todo.md` acceptance.

## Validation status

Older focused hierarchy/model test runs are historical evidence only. They do not prove the current tree after the later auth, agentless, recovery and migration changes.

Current full Node 24, browser, package, DNS/Nginx/ACME and migration acceptance requirements are tracked in `todo.md`. Do not mark the hierarchy/Website migration production-ready until the relevant current acceptance steps are actually run. GitHub Actions are not used for this project.
