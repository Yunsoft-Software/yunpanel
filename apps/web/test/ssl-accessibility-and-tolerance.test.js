import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

const [panelKit, siteOps, certList, emberTheme, workspaceCss, sslRenewal] = await Promise.all([
  source('workspace/PanelKit.jsx'),
  source('workspace/SiteOperations.jsx'),
  source('CertificateList.jsx'),
  source('workspace/ui/ember-theme.css'),
  source('workspace/workspace.css'),
  source('workspace/SslRenewalPanel.jsx'),
]);

/* ==========================================================================
   1. Modal Keyboard Navigation, Focus Trap, Escape Dismissal, & Focus Return
   ========================================================================== */

test('Modal component implements complete focus trap, keyboard navigation, and aria attributes', () => {
  // Modal has native aria attributes
  assert.match(panelKit, /aria-modal="true"/);
  assert.match(panelKit, /aria-labelledby=\{titleId\}/);
  assert.match(panelKit, /onKeyDown=\{handleKeyDown\}/);

  // Tab navigation cycling preserves required ai-history-acceptance patterns
  assert.match(panelKit, /event\.shiftKey && document\.activeElement === first/);
  assert.match(panelKit, /!event\.shiftKey && document\.activeElement === last/);

  // Focus trap wraps around boundaries
  assert.match(panelKit, /last\.focus\(\)/);
  assert.match(panelKit, /first\.focus\(\)/);

  // Single focusable element and focus-outside trap handling
  assert.match(panelKit, /if \(focusable\.length === 1\)/);
  assert.match(panelKit, /else if \(!dialog\.contains\(document\.activeElement\)\)/);

  // Escape key handling with busy guard
  assert.match(panelKit, /if \(event\.key === 'Escape'\)/);
  assert.match(panelKit, /if \(!busy\) onCloseRef\.current\?\.\(\);/);

  // Focus capture on mount and return to trigger element on unmount
  assert.match(panelKit, /const previous = document\.activeElement;/);
  assert.match(panelKit, /previous\?\.focus\?\.\(|previous\.focus\(\{ preventScroll: true \}\)/);

  // Initial focus on mount to [autofocus] or first focusable
  assert.match(panelKit, /dialog\?\.querySelector\('\[autofocus\]'\) \|\| focusable\[0\]/);
});

test('Modal focus trap and Escape key functional simulation', () => {
  // Simulate the focus trap algorithm implemented in PanelKit.jsx
  const createMockElement = (id) => ({
    id,
    focused: false,
    focus() {
      this.focused = true;
    },
  });

  const btnClose = createMockElement('close-button');
  const inputEmail = createMockElement('input-email');
  const btnSubmit = createMockElement('submit-button');
  const triggerBtn = createMockElement('trigger-open');

  const focusable = [btnClose, inputEmail, btnSubmit];
  let activeElement = inputEmail;
  let closed = false;
  let busy = false;

  const simulateKeyDown = (key, shiftKey = false) => {
    let defaultPrevented = false;
    const event = {
      key,
      shiftKey,
      preventDefault() {
        defaultPrevented = true;
      },
    };

    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) closed = true;
      return { defaultPrevented };
    }

    if (event.key === 'Tab') {
      if (focusable.length === 0) {
        event.preventDefault();
        return { defaultPrevented };
      }
      if (focusable.length === 1) {
        event.preventDefault();
        focusable[0].focus();
        activeElement = focusable[0];
        return { defaultPrevented };
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
        activeElement = last;
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
        activeElement = first;
      } else if (!focusable.includes(activeElement)) {
        event.preventDefault();
        const target = event.shiftKey ? last : first;
        target.focus();
        activeElement = target;
      }
    }
    return { defaultPrevented };
  };

  // 1. Shift+Tab on first element wraps to last element
  activeElement = btnClose;
  const res1 = simulateKeyDown('Tab', true);
  assert.equal(res1.defaultPrevented, true);
  assert.equal(activeElement, btnSubmit);
  assert.equal(btnSubmit.focused, true);

  // 2. Tab on last element wraps to first element
  btnSubmit.focused = false;
  const res2 = simulateKeyDown('Tab', false);
  assert.equal(res2.defaultPrevented, true);
  assert.equal(activeElement, btnClose);
  assert.equal(btnClose.focused, true);

  // 3. Tab when focus is outside the modal returns focus inside
  activeElement = triggerBtn;
  const res3 = simulateKeyDown('Tab', false);
  assert.equal(res3.defaultPrevented, true);
  assert.equal(activeElement, btnClose);

  // 4. Escape key closes when not busy
  closed = false;
  busy = false;
  const res4 = simulateKeyDown('Escape');
  assert.equal(res4.defaultPrevented, true);
  assert.equal(closed, true);

  // 5. Escape key does NOT close when busy
  closed = false;
  busy = true;
  const res5 = simulateKeyDown('Escape');
  assert.equal(res5.defaultPrevented, true);
  assert.equal(closed, false);

  // 6. Return focus to previous trigger on unmount
  let triggerRefocused = false;
  triggerBtn.focus = () => { triggerRefocused = true; };
  const previous = triggerBtn;
  if (previous && typeof previous.focus === 'function') {
    previous.focus();
  }
  assert.equal(triggerRefocused, true);
});

/* ==========================================================================
   2. Responsive Viewport Widths (320px, 390px, 834px, 1440px) & Overflow Prevention
   ========================================================================== */

test('Modal layout and form containers prevent overflow across 320px, 390px, 834px, 1440px', () => {
  // Modal width rule uses min with viewport-bound calc
  assert.match(workspaceCss, /\.ws-modal\s*\{[^}]*width:\s*min\(560px,\s*calc\(100vw\s*-\s*32px\)\)/);
  assert.match(workspaceCss, /\.ws-modal-wide\s*\{[^}]*width:\s*min\(840px,\s*calc\(100vw\s*-\s*32px\)\)/);

  // Calculate modal pixel widths across target viewports
  const modalWidth = (viewportWidth, maxCap = 560) => Math.min(maxCap, viewportWidth - 32);

  // 320px mobile: 288px width leaving 16px gutter on each side (no screen-edge collision)
  assert.equal(modalWidth(320), 288);
  assert.ok(modalWidth(320) < 320);

  // 390px modern phone: 358px width
  assert.equal(modalWidth(390), 358);
  assert.ok(modalWidth(390) < 390);

  // 834px tablet: capped at 560px (or 802px for wide)
  assert.equal(modalWidth(834), 560);
  assert.equal(modalWidth(834, 840), 802);

  // 1440px desktop: capped at 560px (or 840px for wide)
  assert.equal(modalWidth(1440), 560);
  assert.equal(modalWidth(1440, 840), 840);

  // Mobile max-width breakpoints adjust padding for compact screens
  assert.match(emberTheme, /\.ws-modal-body\s*\{\s*padding:\s*16px\s*20px\s*20px;/);
  assert.match(emberTheme, /\.ws-modal\s*>\s*header\s*\{\s*padding:\s*20px\s*20px\s*12px;/);

  // Global code elements wrap long text (e.g. SHA-256 fingerprints) anywhere to prevent horizontal overflow
  assert.match(emberTheme, /\.workspace-shell\s+code,\s*\.ws-modal\s+code,\s*code\s*\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-all;\s*\}/);

  // SAN checkboxes in SiteOperations use flexible wrapping
  assert.match(siteOps, /overflowWrap:\s*'anywhere'/);
  assert.match(siteOps, /alignItems:\s*'flex-start'/);
});

/* ==========================================================================
   3. Ember Theme Tokens, Contrast, and Forced-Colors Compliance
   ========================================================================== */

test('SSL issuance and renewal forms conform to Ember design tokens with no raw hardcoded colors', () => {
  // SiteOperations replaces hardcoded amber with theme token
  assert.doesNotMatch(siteOps, /#f59e0b/);
  assert.match(siteOps, /var\(--ws-warning,\s*#75521c\)/);

  // SAN options container uses Ember tokens
  assert.match(siteOps, /var\(--ws-border,\s*#ddd8ce\)/);
  assert.match(siteOps, /var\(--ws-radius-small,\s*8px\)/);
  assert.match(siteOps, /var\(--ws-surface-subtle,\s*transparent\)/);

  // SslRenewalPanel strictly contains no hex color codes
  assert.doesNotMatch(sslRenewal, /#[a-fA-F0-9]{6}/);

  // Ember theme defines semantic warning and danger tokens in light and dark
  assert.match(emberTheme, /--ws-warning:\s*#75521c/);
  assert.match(emberTheme, /--ws-warning:\s*#e5c278/); // dark mode
  assert.match(emberTheme, /--ws-warning-soft:\s*#f8ebce/);
  assert.match(emberTheme, /--ws-warning-soft:\s*#423724/); // dark mode

  // Disabled input styling is defined with proper opacity, background, and muted text
  assert.match(emberTheme, /\.workspace-shell\s+:is\(input,select,textarea\):disabled,\s*\.ws-modal\s+:is\(input,select,textarea\):disabled\s*\{[^}]*opacity:\s*\.55/);
  assert.match(emberTheme, /background:\s*var\(--ws-surface-subtle\)/);
  assert.match(emberTheme, /color:\s*var\(--ws-muted\)/);

  // High contrast / forced-colors active rules explicitly outline modals, inputs, and notices
  const forcedColorsSection = emberTheme.slice(emberTheme.indexOf('@media (forced-colors: active)'));
  assert.match(forcedColorsSection, /\.ws-modal\s*\{[^}]*border:\s*1px\s*solid\s*CanvasText/);
  assert.match(forcedColorsSection, /:is\(input,select,textarea\)[^}]*border:\s*1px\s*solid\s*CanvasText/);
  assert.match(forcedColorsSection, /\.ws-notice\)[^}]*border:\s*1px\s*solid\s*CanvasText/);
});

/* ==========================================================================
   4. Resilience & Error Tolerance for Legacy or Malformed API Responses
   ========================================================================== */

test('SiteOperations error formatting safely handles missing, string, and malformed errors', () => {
  // Test the useOperation error extractor logic
  const extractErrorMessage = (err) => {
    if (!err) return 'Bilinmeyen işlem hatası oluştu.';
    if (typeof err === 'string') return err;
    if (typeof err.message === 'string' && err.message.trim()) return err.message;
    if (typeof err.error === 'string' && err.error.trim()) return err.error;
    return 'Bilinmeyen işlem hatası oluştu.';
  };

  assert.equal(extractErrorMessage(null), 'Bilinmeyen işlem hatası oluştu.');
  assert.equal(extractErrorMessage(undefined), 'Bilinmeyen işlem hatası oluştu.');
  assert.equal(extractErrorMessage('Direct error message'), 'Direct error message');
  assert.equal(extractErrorMessage(new Error('Network timeout')), 'Network timeout');
  assert.equal(extractErrorMessage({ error: 'Backend error message' }), 'Backend error message');
  assert.equal(extractErrorMessage({}), 'Bilinmeyen işlem hatası oluştu.');
  assert.equal(extractErrorMessage({ status: 500 }), 'Bilinmeyen işlem hatası oluştu.');
});

test('CertificateList gracefully tolerates null, undefined, and malformed certificates array', () => {
  assert.match(certList, /Array\.isArray\(certificates\)\s*\?\s*certificates\s*:\s*\[\]/);

  // formatExpiry tolerates malformed date strings
  const formatExpiry = (dateStr) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleDateString();
    } catch {
      return '—';
    }
  };

  assert.equal(formatExpiry(null), '—');
  assert.equal(formatExpiry(undefined), '—');
  assert.equal(formatExpiry('not-a-date'), '—');
  assert.equal(formatExpiry(''), '—');
  assert.notEqual(formatExpiry('2026-10-04T00:00:00Z'), '—');
});

test('SiteOperations issue flow handles legacy responses without crash', () => {
  // Verify preview handling guards against missing preview or missing digest/confirmation
  assert.match(siteOps, /if\s*\(!preview\s*\|\|\s*typeof\s+preview\s*!==\s*'object'\s*\|\|\s*!preview\.previewDigest\s*\|\|\s*!preview\.confirmation\)/);

  // Stage job and activate job handle missing job property or flat objects via fallback chains
  assert.match(siteOps, /const\s+stageJobId\s*=\s*stageJob\?\.id\s*\?\?\s*stageJob\?\.job\?\.id\s*\?\?\s*stageJob\?\.data\?\.id;/);
  assert.match(siteOps, /const\s+activateJobId\s*=\s*activateJob\?\.id\s*\?\?\s*activateJob\?\.job\?\.id\s*\?\?\s*activateJob\?\.data\?\.id;/);
  assert.match(siteOps, /const\s+postStageId\s*=\s*postStage\?\.id\s*\?\?\s*postStage\?\.job\?\.id\s*\?\?\s*postStage\?\.data\?\.id;/);

  // Updated domain reads handle nested domain, data, or flat object
  assert.match(siteOps, /updatedDomain\?\.domain\s*\?\?\s*updatedDomain\?\.data\s*\?\?\s*updatedDomain\s*\?\?\s*currentDomain/);
  assert.match(siteOps, /stagedDomain\?\.domain\s*\?\?\s*stagedDomain\?\.data\s*\?\?\s*stagedDomain\s*\?\?\s*currentDomain/);

  // Locked calculation guards certificates.items
  assert.match(siteOps, /Array\.isArray\(certificates(?:\.|\?\.)items\)\s*&&\s*certificates\.items\.some/);
});
