import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSrc = (file) => readFile(new URL(`../src/workspace/${file}`, import.meta.url), 'utf8');

test('SiteMailPanel integrates real MailboxesPanel and MailAliasesPanel with site-scoped role separation', async () => {
  const panel = await readSrc('SiteMailPanel.jsx');

  // Embeds real MailboxesPanel and MailAliasesPanel
  assert.match(panel, /import MailboxesPanel from '\.\/MailboxesPanel\.jsx'/);
  assert.match(panel, /import MailAliasesPanel from '\.\/MailAliasesPanel\.jsx'/);
  assert.match(panel, /<MailboxesPanel domain=\{domain\} mailboxes=\{state\.mailboxes\} onChanged=\{load\} \/>/);
  assert.match(panel, /<MailAliasesPanel domain=\{domain\} aliases=\{state\.aliases\} onChanged=\{load\} \/>/);

  // Role separation: Site managers use SiteMailApplyPanel and SiteWebmailAccess; Owner gets configuration & diagnostics
  assert.match(panel, /import SiteMailApplyPanel from '\.\/SiteMailApplyPanel\.jsx'/);
  assert.match(panel, /import SiteWebmailAccess from '\.\/SiteWebmailAccess\.jsx'/);
  assert.match(panel, /configuration:\s*isOwner \? <MailConfigurationPanel/);
  assert.match(panel, /: <SiteMailApplyPanel domain=\{domain\} onChanged=\{load\} \/>/);
  assert.match(panel, /webmail:\s*isOwner \? <MailWebmailPanel/);
  assert.match(panel, /: <SiteWebmailAccess domain=\{domain\} \/>/);

  // DNS / DKIM diagnostics exposed strictly to Owner, never to Site Manager
  assert.match(panel, /\.\.\.\(isOwner \? \[\['dns', 'DNS \/ DKIM', 'shield'\]\] : \[\]\)/);

  // Domain filtering and site-scoping
  assert.match(panel, /siteMailDomains\(values, knownDomains, website\.id\)/);
  assert.match(panel, /Posta kaynakları bu alan adıyla eşleşmiyor\./);

  // External mail handling without pretending local mailbox is available
  assert.match(panel, /Harici posta sağlayıcısı/);
});

test('MailboxesPanel provides full mailbox lifecycle: creation, quota, password rotation, forwarding and diagnostics', async () => {
  const mailboxes = await readSrc('MailboxesPanel.jsx');

  // Mailbox creation
  assert.match(mailboxes, /createMailbox\(\{ mailDomainId: domain\.id, address: `\$\{localPart\}@\$\{domain\.domainName\}`, password \}\)/);
  assert.match(mailboxes, /MailboxCreateModal/);

  // Password rotation with expectedRevision
  assert.match(mailboxes, /rotateMailboxPassword\(mailbox\.id, \{ expectedRevision: mailbox\.revision, password \}\)/);
  assert.match(mailboxes, /PasswordModal/);

  // Quota configuration and removal
  assert.match(mailboxes, /setMailboxQuota\(mailbox\.id, \{ expectedRevision: quota\?\.revision \?\? 0, quotaBytes: bytes \}\)/);
  assert.match(mailboxes, /clearMailboxQuota\(mailbox\.id, \{ expectedRevision: quota\.revision \}\)/);

  // Forwarding configuration and removal
  assert.match(mailboxes, /setMailboxForwarding\(mailbox\.id, \{ expectedRevision: forwarding\?\.revision \?\? 0, mode, destinations: destinationList\(destinations\), enabled: true \}\)/);
  assert.match(mailboxes, /clearMailboxForwarding\(mailbox\.id, \{ expectedRevision: forwarding\.revision \}\)/);

  // Mailbox enable/disable toggle
  assert.match(mailboxes, /setMailboxEnabled\(mailbox\.id, \{ expectedRevision: mailbox\.revision, enabled: !mailbox\.enabled \}\)/);

  // Delivery diagnostics modal and authentic test delivery
  assert.match(mailboxes, /MailboxDiagnosticsModal/);
  assert.match(mailboxes, /getMailboxDeliveryDiagnostics\(mailbox\.id\)/);
  assert.match(mailboxes, /sendMailboxTestDelivery\(mailbox\.id/);
});

test('MailAliasesPanel provides full alias lifecycle: creation, revisioned update, and safe deletion', async () => {
  const aliases = await readSrc('MailAliasesPanel.jsx');

  // Alias creation with destinations
  assert.match(aliases, /createMailAlias\(\{ mailDomainId: domain\.id, source: `\$\{source\}@\$\{domain\.domainName\}`, destinations: values \}\)/);

  // Alias update with expectedRevision
  assert.match(aliases, /updateMailAlias\(alias\.id, \{ expectedRevision: alias\.revision, destinations: values, enabled \}\)/);

  // Alias deletion with expectedRevision and source confirmation
  assert.match(aliases, /deleteMailAlias\(removing\.id, \{ expectedRevision: removing\.revision, source: removing\.source \}\)/);

  // Destination parsing and validation
  assert.match(aliases, /parseDestinations/);
});

test('SiteMailApplyPanel performs site-scoped config preview, preserves disabled state, and observes durable jobs', async () => {
  const apply = await readSrc('SiteMailApplyPanel.jsx');

  // Verification that disabled status is preserved and cannot be inadvertently activated
  assert.match(apply, /const status = current\.status === 'disabled' \? 'disabled' : 'enabled';/);
  assert.match(apply, /previewMailConfiguration\(domain\.id, \{ expectedRevision: current\.revision, status \}\)/);
  assert.match(apply, /applyMailConfiguration\(domain\.id, \{ expectedRevision: target\.revision, status: target\.status, preview: target\.preview \}\)/);

  // Strict preview requirement checks before allowing apply
  assert.match(apply, /preview\?\.readyToApply/);
  assert.match(apply, /preview\.configuration\?\.sha256/);
  assert.match(apply, /preview\.confirmation/);
  assert.match(apply, /preview\.previewDigest/);

  // Durable job observation and progress update
  assert.match(apply, /observe\(job\)/);
  assert.match(apply, /waitForJob\(job\.id\)/);
  assert.match(apply, /updateJob\(terminal\)/);

  // Prevents blind re-apply if job already exists
  assert.match(apply, /let job = target\.job;\s*if \(!job\) \{/);

  // Explicit confirmation dialog matching the domain name
  assert.match(apply, /confirmation=\{domain\.domainName\}/);
  assert.match(apply, /confirmLabel="Değişiklikleri uygula"/);

  // Does not expose global server logs or raw filesystem paths
  assert.doesNotMatch(apply, /getServerMailLog|systemctl|postfix|dovecot/i);
});

test('SiteWebmailAccess separates webmail link from live SMTP/IMAP delivery and Roundcube session proof', async () => {
  const webmail = await readSrc('SiteWebmailAccess.jsx');

  // Scoped inspection without exposing global Roundcube setup or cert reassignment
  assert.match(webmail, /inspectMailWebmail\(domain\.id\)/);
  assert.match(webmail, /webmailMappingUrl\(mapping\)/);
  assert.doesNotMatch(webmail, /prepareRoundcube|applyRoundcube|installRoundcube|certificateId/);

  // Separation: sample webmail card is not proof of live delivery or authenticated session
  assert.match(webmail, /Site managers open an existing mapping/);
  assert.match(webmail, /Global Roundcube installation and/);
});
