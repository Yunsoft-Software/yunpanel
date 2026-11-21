import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WafPolicyTemplateError,
  nginxWafConfigPath,
  normalizeWafExcludedRoutes,
  previewCloudflareManagedWafPolicy,
  previewCrowdSecAppSecPolicy,
  previewWafPolicy,
  wafPolicyTemplatePolicy,
} from '../src/index.js';

function parseCrowdSecAcquisitionYaml(content) {
  const result = {};
  let currentMap = result;
  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    assert.ok(indent === 0 || indent === 2, `Unexpected YAML indentation: ${rawLine}`);
    const trimmed = rawLine.trim();
    const colonIndex = trimmed.indexOf(':');
    assert.ok(colonIndex > 0, `Invalid YAML mapping line: ${rawLine}`);
    const key = trimmed.slice(0, colonIndex);
    const rawValue = trimmed.slice(colonIndex + 1).trim();
    if (indent === 0) currentMap = result;
    if (!rawValue) {
      assert.equal(indent, 0, `Nested mapping only expected at top level: ${rawLine}`);
      result[key] = {};
      currentMap = result[key];
      continue;
    }
    if (rawValue.startsWith('"')) {
      assert.ok(rawValue.endsWith('"'), `Unterminated YAML quoted scalar: ${rawLine}`);
      currentMap[key] = JSON.parse(rawValue);
    } else {
      assert.doesNotMatch(rawValue, /^[\[\]{},&*!|>'"%@`]/, `Unquoted YAML indicator token would misparse: ${rawLine}`);
      assert.doesNotMatch(rawValue, /:\s/, `Unquoted colon-space inside YAML scalar: ${rawLine}`);
      if (rawValue === 'true') currentMap[key] = true;
      else if (rawValue === 'false') currentMap[key] = false;
      else currentMap[key] = rawValue;
    }
  }
  return result;
}

function assertCleanNginxSnippet(content) {
  let depth = 0;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.endsWith('{')) {
      depth += 1;
      assert.match(line, /^if \(\$uri (= "\/[^"]+"|~ "\^\/[^"]+")\) \{$/);
    } else if (line === '}') {
      depth -= 1;
      assert.ok(depth >= 0, 'Unbalanced closing brace in Nginx WAF snippet');
    } else {
      assert.match(line, /^set \$[a-z_]+ "[^"\r\n;{}]*";$/);
    }
  }
  assert.equal(depth, 0, 'Unclosed block in Nginx WAF snippet');
  assert.doesNotMatch(content, /\blocation\b/);
}

test('crowdsec_appsec defaults to safe observe mode with passthrough failure action, safe exclusions and clean disabled rollback plan', () => {
  const policy = previewWafPolicy({
    provider: 'crowdsec_appsec',
    domain: 'Shop.Example.COM.',
    excludedRoutes: ['/wp-json/custom/v1/webhook', '/api/uploads/'],
  });

  assert.equal(Object.isFrozen(policy), true);
  assert.equal(policy.provider, 'crowdsec_appsec');
  assert.equal(policy.domain, 'shop.example.com');
  assert.equal(policy.mode, 'observe');
  assert.equal(policy.blocking, false);
  assert.equal(policy.simulation, true);
  assert.equal(policy.appsecFailureAction, 'passthrough');
  assert.equal(policy.sideEffects, false);
  assert.match(policy.sha256, /^[a-f0-9]{64}$/);

  assert.equal(policy.artifacts.nginxInclude.path, '/etc/nginx/yunpanel-waf/shop.example.com.conf');
  assert.equal(policy.artifacts.crowdsecAcquisition.path, '/etc/crowdsec/acquis.d/yunpanel-appsec.yaml');
  assert.equal(nginxWafConfigPath('Shop.Example.COM'), '/etc/nginx/yunpanel-waf/shop.example.com.conf');

  const nginx = policy.artifacts.nginxInclude.content;
  assertCleanNginxSnippet(nginx);
  assert.match(nginx, /appsec_failure_action passthrough;/);
  assert.match(nginx, /set \$yunpanel_waf_mode "observe";/);
  assert.match(nginx, /set \$yunpanel_appsec_action "log";/);
  assert.match(nginx, /set \$yunpanel_appsec_failure_action "passthrough";/);
  assert.match(nginx, /if \(\$uri = "\/wp-login\.php"\)/);
  assert.match(nginx, /if \(\$uri = "\/wp-admin\/async-upload\.php"\)/);
  assert.match(nginx, /if \(\$uri ~ "\^\/api\/auth\/"\)/);
  assert.match(nginx, /if \(\$uri = "\/wp-json\/custom\/v1\/webhook"\)/);
  assert.match(nginx, /if \(\$uri ~ "\^\/api\/uploads\/"\)/);

  const yaml = policy.artifacts.crowdsecAcquisition.content;
  assert.match(yaml, /^source: appsec$/m);
  assert.match(yaml, /^listen_addr: "127\.0\.0\.1:7422"$/m);
  assert.match(yaml, /^appsec_config: "crowdsecurity\/appsec-default"$/m);
  assert.match(yaml, /^  domain: "shop\.example\.com"$/m);
  assert.match(yaml, /^  mode: observe$/m);
  assert.match(yaml, /^  simulation: true$/m);
  assert.match(yaml, /^  inband_action: log$/m);
  const parsedYaml = parseCrowdSecAcquisitionYaml(yaml);
  assert.equal(parsedYaml.listen_addr, '127.0.0.1:7422');
  assert.equal(parsedYaml.appsec_config, 'crowdsecurity/appsec-default');
  assert.equal(parsedYaml.labels.domain, 'shop.example.com');
  assert.equal(parsedYaml.labels.simulation, true);

  const disabled = previewCrowdSecAppSecPolicy({ domain: 'shop.example.com', mode: 'disabled' });
  assertCleanNginxSnippet(disabled.artifacts.nginxInclude.content);
  assert.equal(policy.rollback.targetMode, 'disabled');
  assert.equal(policy.rollback.nginxConfigTestRequired, true);
  assert.equal(policy.rollback.reloadRequired, true);
  assert.equal(policy.rollback.artifacts.nginxInclude.sha256, disabled.artifacts.nginxInclude.sha256);
  assert.equal(policy.rollback.artifacts.nginxInclude.content, disabled.artifacts.nginxInclude.content);
  assert.equal(policy.rollback.artifacts.crowdsecAcquisition.sha256, disabled.artifacts.crowdsecAcquisition.sha256);
  assert.doesNotMatch(disabled.artifacts.crowdsecAcquisition.content, /^listen_addr:/m);
});

test('crowdsec_appsec enforce mode requires previousPolicySha256 rollback snapshot and stays deterministic', () => {
  assert.throws(
    () => previewCrowdSecAppSecPolicy({ domain: 'app.example.com', mode: 'enforce' }),
    (error) => error instanceof WafPolicyTemplateError && error.code === 'waf_rollback_precondition_missing',
  );
  assert.throws(
    () => previewCrowdSecAppSecPolicy({
      domain: 'app.example.com',
      mode: 'enforce',
      rollbackSnapshot: { previousPolicySha256: 'not-a-sha256' },
    }),
    { code: 'waf_rollback_precondition_missing' },
  );

  const observe = previewCrowdSecAppSecPolicy({ domain: 'app.example.com', mode: 'observe' });
  const enforceA = previewCrowdSecAppSecPolicy({
    domain: 'app.example.com',
    mode: 'enforce',
    excludedRoutes: ['/api/v2/', '/checkout/callback'],
    rollbackSnapshot: { previousPolicySha256: observe.sha256 },
  });
  const enforceB = previewCrowdSecAppSecPolicy({
    domain: 'APP.EXAMPLE.COM.',
    mode: 'enforce',
    excludedRoutes: ['/checkout/callback', '/api/v2/', '/wp-login.php'],
    rollbackSnapshot: { previousPolicySha256: observe.sha256 },
  });

  assert.equal(enforceA.sha256, enforceB.sha256);
  assert.equal(enforceA.blocking, true);
  assert.equal(enforceA.simulation, false);
  assertCleanNginxSnippet(enforceA.artifacts.nginxInclude.content);
  assert.match(enforceA.artifacts.nginxInclude.content, /set \$yunpanel_appsec_action "block";/);
  assert.match(enforceA.artifacts.crowdsecAcquisition.content, /^  simulation: false$/m);
  assert.match(enforceA.artifacts.crowdsecAcquisition.content, /^  inband_action: block$/m);
  assert.equal(enforceA.rollback.snapshot.previousPolicySha256, observe.sha256);
});

test('cloudflare_managed maps disabled/observe/enforce actions, safe skip expressions and enforces rollback snapshot precondition', () => {
  const observe = previewWafPolicy({
    provider: 'cloudflare_managed',
    domain: 'Store.Example.org',
    zoneId: '0123456789ABCDEF0123456789abcdef',
    mode: 'observe',
    excludedRoutes: ['/api/webhooks/'],
  });
  assert.equal(Object.isFrozen(observe), true);
  assert.equal(observe.domain, 'store.example.org');
  assert.equal(observe.zoneId, '0123456789abcdef0123456789abcdef');
  assert.equal(observe.action, 'log');
  assert.equal(observe.blocking, false);
  assert.equal(observe.simulation, true);
  assert.equal(observe.rules.length, 2);
  assert.equal(observe.rules[0].action, 'skip');
  assert.match(observe.rules[0].expression, /http\.host eq "store\.example\.org"/);
  assert.match(observe.rules[0].expression, /http\.request\.uri\.path eq "\/wp-login\.php"/);
  assert.match(observe.rules[0].expression, /http\.request\.uri\.path eq "\/wp-admin\/async-upload\.php"/);
  assert.match(observe.rules[0].expression, /starts_with\(http\.request\.uri\.path, "\/api\/auth\/"\)/);
  assert.match(observe.rules[0].expression, /starts_with\(http\.request\.uri\.path, "\/api\/webhooks\/"\)/);
  assert.equal(observe.rules[1].action, 'execute');
  assert.equal(observe.rules[1].actionParameters.overrides.action, 'log');

  const disabled = previewCloudflareManagedWafPolicy({ domain: 'store.example.org', mode: 'disabled' });
  assert.equal(disabled.action, 'off');
  assert.equal(disabled.rules.length, 0);

  assert.throws(
    () => previewCloudflareManagedWafPolicy({ domain: 'store.example.org', mode: 'enforce' }),
    { code: 'waf_rollback_precondition_missing' },
  );
  assert.throws(
    () => previewCloudflareManagedWafPolicy({
      domain: 'store.example.org',
      mode: 'enforce',
      rollbackSnapshot: { previousRulesetVersion: 'v42' },
    }),
    { code: 'waf_rollback_precondition_missing' },
  );

  const snapshot = { previousRulesetVersion: '2026.11.21-rev3', previousRulesetSha256: observe.sha256 };
  const enforceChallenge = previewCloudflareManagedWafPolicy({
    domain: 'store.example.org',
    mode: 'enforce',
    rollbackSnapshot: snapshot,
  });
  const enforceBlock = previewCloudflareManagedWafPolicy({
    domain: 'store.example.org',
    mode: 'enforce',
    enforceAction: 'block',
    rollbackSnapshot: snapshot,
  });
  assert.equal(enforceChallenge.action, 'managed_challenge');
  assert.equal(enforceChallenge.blocking, true);
  assert.equal(enforceBlock.action, 'block');
  assert.notEqual(enforceChallenge.sha256, enforceBlock.sha256);
  assert.deepEqual(enforceChallenge.rollback.snapshot, snapshot);
});

test('rejects invalid providers, domains, modes, listen addresses, route injections and root bypass fail-closed', () => {
  assert.throws(() => previewWafPolicy({ provider: 'modsecurity', domain: 'example.com' }), { code: 'waf_provider_invalid' });
  assert.throws(() => previewWafPolicy(null), { code: 'waf_input_invalid' });

  for (const invalidDomain of ['', '127.0.0.1', '*.example.com', 'bad domain.com', 'evil.com;\nreturn 200;']) {
    assert.throws(
      () => previewCrowdSecAppSecPolicy({ domain: invalidDomain }),
      (error) => error instanceof WafPolicyTemplateError && error.code === 'waf_domain_invalid',
    );
  }

  for (const invalidMode of ['monitor', 'block', '', null]) {
    assert.throws(
      () => previewCrowdSecAppSecPolicy({ domain: 'example.com', mode: invalidMode }),
      { code: 'waf_mode_invalid' },
    );
  }

  for (const invalidRoute of [
    '/',
    'wp-login.php',
    '/wp-login.php\nreturn 200;',
    '/wp-login.php\r\nset $x 1;',
    '/api/; return 200;',
    '/api/{bad}',
    '/api/"quote"',
    "/api/'single'",
    '/api/$host',
    '/api/../admin',
    '/api//double',
    '/api/space path',
  ]) {
    assert.throws(
      () => normalizeWafExcludedRoutes([invalidRoute]),
      (error) => error instanceof WafPolicyTemplateError && error.code === 'waf_route_invalid',
    );
  }

  for (const invalidListen of ['0.0.0.0:7422', '127.0.0.1:80', '127.0.0.1:7422\nfoo: bar', 'example.com:7422']) {
    assert.throws(
      () => previewCrowdSecAppSecPolicy({ domain: 'example.com', listenAddr: invalidListen }),
      { code: 'waf_listen_addr_invalid' },
    );
  }

  assert.throws(
    () => previewCrowdSecAppSecPolicy({ domain: 'example.com', appsecConfig: 'crowdsecurity/appsec\nlisten_addr: 0.0.0.0:80' }),
    { code: 'waf_appsec_config_invalid' },
  );
  assert.throws(
    () => previewCloudflareManagedWafPolicy({ domain: 'example.com', enforceAction: 'allow' }),
    { code: 'waf_action_invalid' },
  );
  assert.throws(
    () => previewCloudflareManagedWafPolicy({ domain: 'example.com', zoneId: 'not-hex' }),
    { code: 'waf_zone_id_invalid' },
  );

  const overflowRoutes = Array.from({ length: wafPolicyTemplatePolicy.maxExcludedRoutes + 1 }, (_, i) => `/route-${i}`);
  assert.throws(() => normalizeWafExcludedRoutes(overflowRoutes, { includeDefaults: false }), { code: 'waf_routes_limit_exceeded' });
  const duplicateOverflow = Array.from({ length: wafPolicyTemplatePolicy.maxExcludedRoutes + 1 }, () => '/wp-login.php');
  assert.throws(() => normalizeWafExcludedRoutes(duplicateOverflow, { includeDefaults: false }), { code: 'waf_routes_limit_exceeded' });
});

test('crowdsec_appsec quotes IPv6 loopback listen_addr and string scalars as valid YAML', () => {
  const ipv6Policy = previewCrowdSecAppSecPolicy({
    domain: 'ipv6.example.com',
    mode: 'observe',
    listenAddr: '[::1]:7422',
    appsecConfig: 'true',
  });
  const yaml = ipv6Policy.artifacts.crowdsecAcquisition.content;
  assert.match(yaml, /^listen_addr: "\[::1\]:7422"$/m);
  assert.match(yaml, /^appsec_config: "true"$/m);
  assert.match(yaml, /^  domain: "ipv6\.example\.com"$/m);
  const parsed = parseCrowdSecAcquisitionYaml(yaml);
  assert.equal(parsed.listen_addr, '[::1]:7422');
  assert.equal(typeof parsed.appsec_config, 'string');
  assert.equal(parsed.appsec_config, 'true');
  assert.equal(parsed.labels.domain, 'ipv6.example.com');
  assertCleanNginxSnippet(ipv6Policy.artifacts.nginxInclude.content);
});
