# First-Time Setup

> **Version:** YunPanel `0.3.0` · **Verified source revision:** `f30fd779` (`f30fd779293ad96f83e7a76846fa70e71562730b`) · **Verified Linux `.deb` package baseline:** `0.3.0-2026112301` (`f13b2b78`) · **Web UI language:** Turkish (`tr`; verified in Chromium with both `tr-TR` and `en-US` browser locales)

YunPanel ships with no default password and no public signup endpoint. Creating the initial **Owner (Sunucu Yöneticisi)** account requires a single-use, 10-minute setup token generated directly on the host.

## 1. Generate a single-use setup token

Run the packaged authentication CLI on the server:

```bash
# Packaged Linux installation
sudo /usr/local/bin/node /usr/lib/yunpanel/scripts/auth.mjs setup-token

# Local source development
npm run auth -- setup-token
```

The generated token is valid for 10 minutes and is permanently consumed once the Owner account is created.

## 2. Create the Owner account

Opening the panel URL on an unconfigured installation displays the **İLK KURULUM · Owner hesabını oluşturun** (First-Time Setup · Create Owner Account) screen.

![YunPanel first-time setup screen in dark theme (Turkish UI)](assets/en/01-first-time-setup-dark.png)

Complete the form fields:

1. **Kurulum anahtarı** (Setup token): The single-use token generated on the server.
2. **Kullanıcı adı** (Username): Initial server owner username (minimum 3 characters).
3. **Kurtarma e-postası (isteğe bağlı)** (Optional recovery email): Stored strictly for local password recovery; never used as a marketing or newsletter list.
4. **Parola / Parolayı tekrar girin** (Password and confirmation): Strong password of at least 12 characters.

You can switch between dark and light themes at any time using the top-right theme icon button:

![YunPanel first-time setup screen in light theme (Turkish UI)](assets/en/02-first-time-setup-light.png)

## 3. Optional 3-month free Premium offer

> Visit [Yunsoft's three-month Premium campaign page](https://yunsoft.com/campaign/premium-3-months) for the application and current terms. Campaign screenshots were captured in the local `0.3.0` (`f30fd779`) candidate build.

Below the setup form, YunPanel displays an optional **3 aylık ücretsiz Premium teklifi** (3-Month Free Premium Offer) card:

- **Completely optional:** You can complete Owner setup and run YunPanel Free without opening the offer link.
- **No credit card required** — Eligible applicants can verify their email subscription on the Yunsoft website to receive three months of YunPanel Premium.
- **Privacy boundary:** The customer panel does not store any newsletter subscriber list. The external link (**Teklifi Yunsoft'ta incele**, `referrerPolicy="no-referrer"`) is a static HTTPS URL with no query parameters or fragments; neither your recovery email, domain name, nor installation ID is appended to the link.
- **One claim per email or domain** — The same email address or domain may be used once. One application covers YunPanel and YunCMS. Use **Ayarlar → Lisans** (Settings → License) to activate the YunPanel key for your verified installation.

See [Licensing and Three-Month Premium](doc:licensing-and-premium) for full offline verification and paid/permanent entitlement protection details.

## 4. Sign in and enroll two-factor authentication (MFA)

After creating the Owner account, YunPanel redirects to the sign-in screen (**YunPanel'e giriş yapın**).

![YunPanel sign-in screen (Turkish UI)](assets/en/03-login.png)

On HTTPS production installations (`YUNPANEL_OWNER_MFA_REQUIRED=true`), the first sign-in opens **Hesap Güvenliği** (Account Security):

1. Add the 6-digit, 30-second TOTP setup key to your authenticator app and confirm the code.
2. Save and confirm your single-use recovery codes.
3. Click **Yönetim paneline geç** (Continue to panel) to open [Basic Site and Role Operations](doc:sites-and-roles).
