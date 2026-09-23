import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aliasErrorMessage } from '../src/workspace/domain-alias-model.js';
const ui = await readFile(new URL('../src/workspace/DomainOperations.jsx', import.meta.url), 'utf8');

test('untrusted error codes cannot resolve Object prototype values as React content', () => {
  for (const code of ['__proto__', 'constructor', 'toString', 'random']) assert.equal(typeof aliasErrorMessage({ code }), 'string');
});
test('source: form is keyed by actor/site/server and actual session generation', () => {
  assert.match(ui, /const \{ session \} = usePanelSession\(\)/);
  assert.match(ui, /JSON.stringify\(\[domain.id, domain.serverId, session\?\.user\?\.id, session\?\.user\?\.role, generation\]\)/);
  assert.match(ui, /sessionVersion\(\) === generation && !sessionTransitionPending\(\)/);
  assert.match(ui, /value.active = false; value.controller.abort\(\)/);
});
test('source: common components and existing preview/job API adapters are used', () => {
  for (const symbol of ['useWorkspace', 'useUnsavedChanges', 'createDomainAliasClient', 'panelRequest', 'waitForJob', 'Modal', 'Section', 'LinkButton']) assert.ok(ui.includes(symbol));
  assert.doesNotMatch(ui, /localStorage|sessionStorage|document.cookie|dangerouslySetInnerHTML|fetch\(/);
});
test('source: alias actions and publication are visible; only diagnostics are disclosed', () => {
  assert.ok(ui.indexOf('<Section title="Ek alan adları (alias)"') < ui.indexOf('<details'));
  assert.ok(ui.indexOf('<Section title="Yayın durumu"') < ui.indexOf('<details'));
  assert.match(ui, /Taslağa ekle/); assert.match(ui, /Değişiklikleri incele/);
  assert.match(ui, /Değişiklikleri iptal et/); assert.match(ui, /<summary>Teknik yayın bilgileri<\/summary>/);
  assert.match(ui, /siteHref\(domain.id, 'dns'\)/); assert.match(ui, /siteHref\(domain.id, 'ssl'\)/);
});
test('source: SSL impact and removals require explicit target confirmation', () => {
  assert.match(ui, /plan.certificateDetached \|\| plan.removed.length > 0/);
  assert.match(ui, /mevcut SSL sertifikasının alan adıyla bağlantısını kaldırır/);
  assert.match(ui, /confirmation === plan.base.primaryDomain/);
  assert.match(ui, /Kaydet, kaydı günceller; canlı yönlendirmeyi değiştirmez/);
});
test('source: input not yet added to draft cannot silently disappear during save', () => {
  assert.match(ui, /const dirty = changed \|\| Boolean\(input.trim\(\)\)/);
  assert.match(ui, /useUnsavedChanges\(dirty\)/);
  assert.match(ui, /disabled=\{locked \|\| !changed \|\| Boolean\(input.trim\(\)\)\}/);
  assert.match(ui, /adopt\(value, dirty\)/);
});
test('source: uncertain mutations require explicit reload; stale confirmations are not replayed', () => {
  assert.match(ui, /failure.needsReload\) setReloadRequired\(true\)/);
  assert.match(ui, /\|\| reloadRequired \|\| stale \|\| resourceBusy/);
  assert.match(ui, /finally \{ if \(current\(\)\) setPlan\(null\); \}/);
  assert.match(ui, /if \(pending.current \|\| !current\(\)\) return/);
});
test('source: domain hierarchy and Owner-only create action remain in the same site scope', () => {
  assert.match(ui, /item.parentDomainId === domain.id && item.serverId === domain.serverId/);
  assert.match(ui, /actions=\{isOwner && <LinkButton to=\{`\/websites\/new\?parent=\$\{encodeURIComponent\(domain.id\)\}`\}/);
  assert.match(ui, /key=\{child.id\} to=\{siteHref\(child.id\)\}/);
});

test('source: ready background updates refresh publication baseline but not edited aliases', () => {
  assert.match(ui, /if \(domains.status === 'ready'\) setBase\(\(previous\) => refreshAliasPublication\(previous, domain\)\)/);
  assert.match(ui, /\}, \[domain, domains.status\]\)/);
  const effect = ui.slice(ui.indexOf("if (domains.status === 'ready') setBase"), ui.indexOf('const [aliases, setAliases]'));
  assert.doesNotMatch(effect, /setAliases|setInput/);
});
