# Certificate import and selection

YunPanel supports two production certificate sources for a local managed Domain:

- `acme`: Certbot-issued material with automatic renewal;
- `custom`: Owner-supplied material with manual renewal.

The feature does not add DNS-01 or wildcard issuance. A custom wildcard certificate can cover an ordinary current hostname when X.509 wildcard matching permits it, but DNS-01 issuance/renewal remains in `plan.md`.

## Guarded Owner flow

Custom import is a two-step operation. `POST /api/domains/:domainId/certificates/custom-preview` accepts exactly `certificatePem`, `chainPem` and `privateKeyPem`. The leaf certificate must be current, cover the Domain's exact primary hostname and aliases, begin the supplied full chain, and match the unencrypted private key. The response returns only bounded certificate metadata, an SHA-256 preview digest and typed confirmation; it never echoes PEM, key or material paths.

`POST /api/domains/:domainId/certificates/custom` accepts the same material plus that exact `previewDigest` and `confirmation`. The API repeats every inspection after obtaining a Domain-scoped operation lock. Domain revision, selected certificate, material or active work drift makes the preview stale before installation. Concurrent import/selection requests for one Domain are serialized.

An existing active or superseded production certificate can be reselected with `POST /api/domains/:domainId/certificates/:certificateId/select-preview`, using an empty JSON object, followed by `POST /api/domains/:domainId/certificates/:certificateId/select` with the returned digest and confirmation. Selection is limited to the same local Server and Domain. The API re-opens the exact fixed material paths and verifies certificate/key identity, chain leaf, validity, hostname coverage and persisted fingerprint before changing the Domain reference.

Both successful operations attach the selected certificate to desired Domain state. They do not claim that Nginx has changed: the Owner must run the ordinary Domain stage and activation jobs. Only after attachment succeeds are other production records for that Domain marked `superseded`. Manual custom certificates never enter the automatic renewal sweep or ACME renew route.

## Material boundary and recovery

Custom material is installed by the packaged root API below `/var/lib/yunpanel/control-plane/custom-certificates/<certificate-uuid>` when the standard certificate store path is used. The root directory and certificate directory are `0700`; `cert.pem`, `fullchain.pem` and `privkey.pem` are `0600`. IDs and paths are deterministic registry metadata, symlinked custom files are rejected, and an installation whose registry write fails is cleaned up. If later Domain attachment fails, the registered certificate remains visible and selectable rather than deleting operator-supplied material during an uncertain outcome.

Certbot paths remain fixed below `/etc/letsencrypt/live/<cert-name>`. Certbot symlinks are allowed only at those exact paths. Production issue/renew inspection now reads both `cert.pem` and `privkey.pem` and rejects a mismatch before returning a successful result. Domain staging repeats stored-material inspection for the local Server, including custom material, so post-import file replacement fails before a TLS job is queued.

Public import/selection responses omit PEM, private-key paths and material digests. Common management audit records only the bounded Domain-scoped action and outcome; request bodies are not audit metadata. Certificate registry state upgrades in memory from version 1 ACME records to version 2 source/renewal metadata and is written only on the next mutation.

Source tests use real short-lived OpenSSL certificates to cover matched and mismatched keys, wildcard hostname coverage, private file modes, concurrent import, selection, store migration, ACME inspection and post-import tamper rejection. The required packaged Ubuntu, Nginx, HTTPS, permission, restart, upgrade and backup/restore acceptance remains in `todo.md`.
