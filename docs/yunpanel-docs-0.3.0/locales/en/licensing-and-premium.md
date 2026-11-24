# Licensing and Three-Month Premium

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel includes unlimited website management for a single Owner permanently in the **Free** edition, and unlocks multi-tenant roles (Resellers, Customers, Site Managers) and AI operations via offline cryptographically verified **YunPanel Premium** licensing.

## Free vs. Premium capability matrix

| Capability | Free | YunPanel Premium |
| :--- | :---: | :---: |
| Single Owner managing unlimited websites and subdomains | Included | Included |
| Per-site isolated Linux user, Site Terminal, and SFTP key management | Included | Included |
| Web server (Nginx), PHP/Node/Python/Static, Docker, SSL, DNS, Mail, Databases, Backups | Included | Included |
| AI management assistant and automation tools (`aiOperations`) | Premium | Included |
| Reseller and reseller customer management (`resellerAccounts`) | Premium | Included |
| Separate Customer, Site Manager, and additional panel accounts (`perSiteIsolatedUsers`) | Premium | Included |

## Credit-card-free 3-month Premium campaign (Yunsoft Website)

> **Live campaign status:** The 3-month free Premium campaign on Yunsoft Website is not yet live; it is currently awaiting SMTP verification and launch acceptance on Yunsoft Website. The offer visibility and activation workflow described below applies **once the campaign opens on Yunsoft Website**. The campaign offer and active-campaign screenshots shown on this page are technical verification captures from the local `0.3.0` (`f30fd779`) candidate build and are not evidence of live production campaign usage.

Once the campaign is live on Yunsoft Website, fresh installations and Free-tier panels will be able to opt into the credit-card-free **3-month YunPanel Premium** offer via Yunsoft email subscription:

- **First-Time Setup and License settings entry points:** An optional **Teklifi Yunsoft'ta incele** (View offer on Yunsoft) link appears during [First-Time Setup](doc:first-time-setup) and on **Ayarlar → Lisans** (Settings → License, `/settings?section=license`) when no Premium license is active, and applies once the campaign opens on Yunsoft Website.
- **Strict privacy boundary:** Campaign registration is managed solely by **Yunsoft Website**. The customer panel never stores a newsletter or subscriber email list. The referral link is a static HTTPS URL without query strings or fragments (`referrerPolicy="no-referrer"`); recovery email, domain name, and installation ID are never appended to the URL.
- **One grant per email or domain:** Once live, the same normalized email address or domain cannot claim a second 3-month promotional grant.
- **Single campaign record covering YunPanel and YunCMS:** A single campaign record on Yunsoft Website carries YunPanel and YunCMS entitlements together; once the campaign is active, YunPanel activation sends `productCode: "yunpanel_premium"` to activate only the YunPanel entitlement for the verified installation. Tokens issued for another product (`yuncms_premium`) are strictly rejected with `PRODUCT_MISMATCH`.

![YunPanel License settings screen showing Free tier and local candidate 3-month Premium offer view (Turkish UI)](assets/en/16-license-free-offer.png)

## Offline Ed25519 verification and activation

YunPanel verifies entitlements locally using the `YUNSOFT-ENTITLEMENT+JWT` contract signed with **Ed25519**:

- **Zero manual key setup:** The official Yunsoft Commerce public key (`kid: 1cbcc4d3173d0c15`) ships inside the package (`/usr/share/yunpanel/trust/entitlement-public.pem`) and is seeded automatically to `/etc/yunpanel/control-plane/entitlement-public.pem` on install (preserving any operator-customized key file).
- **Private keys strictly forbidden:** Signing private keys (`PRIVATE KEY`) or payment provider keys are never placed on a YunPanel host.
- **Two activation methods (Owner only, `/settings?section=license`):**
  1. **Lisans anahtarı** (License key): Exchanges the key with `POST /v1/entitlements/activate` bound to the panel domain and `instanceId`; the key is stored encrypted with `AES-256-GCM`.
  2. **İmzalı jeton** (Signed token): Paste a signed entitlement JWT directly for 100% offline activation.
- **Zero routine remote calls:** Once activated, every status and capability check runs offline against local disk state, so temporary upstream outages never disrupt an active license.

![YunPanel License settings screen showing local candidate 3-month Campaign Premium view, applicable once live on Yunsoft Website (Turkish UI)](assets/en/17-license-campaign-active.png)

## Paid / permanent entitlement protection and non-destructive lifecycle

- **Protecting paid and permanent entitlements:** An active paid (`paid`, monthly/yearly) license cannot be replaced by a promotional campaign entitlement (`409 paid_or_permanent_entitlement_protected`). An active permanent (`permanent` / `lifetime`) entitlement cannot be overwritten by any term or promotional entitlement. Upgrading from a 3-month campaign grant to a paid or permanent license works seamlessly, and the promotional referral card automatically hides while any Premium license is active.
- **Anti-rollback protection:** Replaying older `entitlementVersion` tokens or shorter-expiry tokens is blocked via persisted `licenseWatermarks` (`409 stale_license_token`).
- **Non-destructive expiration and deactivation:** When a license expires, is revoked, or is deactivated by the Owner with explicit confirmation (`deactivate-license`), existing websites, databases, SSL certificates, files, and dedicated site Unix users are **never deleted or disrupted**; the panel gracefully returns to Free baseline capabilities.

## Related environment variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `YUNPANEL_LICENSE_STORE` | `/var/lib/yunpanel/control-plane/license/entitlement.json` | Signed token, watermarks, and encrypted license key store (`0600`). |
| `YUNPANEL_LICENSE_COMMERCE_URL` | `https://yunsoft.com/api/commerce` | HTTPS Commerce endpoint for activation, refresh, and deactivation. |
| `YUNPANEL_ENTITLEMENT_PUBLIC_KEY_FILE` | `/etc/yunpanel/control-plane/entitlement-public.pem` | Optional custom Ed25519 SPKI public key file path. |
| `YUNPANEL_PREMIUM_OFFER_URL` | `https://yunsoft.com/kampanya/premium-3-ay` | Static query-free HTTPS URL for the 3-month Premium campaign. |
| `YUNPANEL_DOCS_URL` | `https://yunsoft.com/docs/yunpanel` | Static query-free HTTPS URL for official YunPanel documentation. |

## Related guides

- Optional 3-month Premium referral during setup: [First-Time Setup](doc:first-time-setup)
- Reseller, Customer, and Site Manager roles: [Basic Site and Role Operations](doc:sites-and-roles)
