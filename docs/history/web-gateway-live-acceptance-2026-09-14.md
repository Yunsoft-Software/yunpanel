# Web gateway live isolation acceptance — 2026-09-14

The restricted web gateway boundary was verified on the isolated Ubuntu 24.04 amd64 `test` host after installing `yunpanel 0.3.0-2026091406` from revision `70cfb58`. The package SHA-256 was `3538702adcf3f363c0339c724d870574b5de7db0963cb548476c126c5bb72542`.

- The web service no longer loads the private API or proxy environment files.
- The local web-to-API hop token is delivered as a read-only systemd service credential and is absent from the web process environment.
- The live process environment contained no master key, auth database, legacy agent token, local server identity, control-plane store path, DKIM root or internal proxy token variable.
- Control-plane configuration, API environment, proxy environment and credential source retained root ownership and private modes. The web sandbox kept both control-plane configuration and state inaccessible.
- The API, web gateway and MariaDB services were active. Direct API health returned `status=ok`; the retained legacy agent remained absent/inactive.
- The existing headed Owner session survived the upgrade. A database inventory job completed through HTTPS and the credential-backed gateway, reporting MariaDB `10.11.14` and zero remaining user schemas after acceptance cleanup.
- The full Node 24 workspace check and production web build passed locally and on the exact Ubuntu tree used to produce the package.

Secret values, cookies, MFA material and private state paths are intentionally excluded from this report.
