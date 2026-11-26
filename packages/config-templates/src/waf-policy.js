import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { DomainValidationError, normalizeDomainSet } from '@yunpanel/shared';

const WAF_PROVIDERS = Object.freeze(['crowdsec_appsec', 'cloudflare_managed']);
const WAF_MODES = Object.freeze(['disabled', 'observe', 'enforce']);
const CLOUDFLARE_ENFORCE_ACTIONS = Object.freeze(['managed_challenge', 'block']);
const NGINX_WAF_DIRECTORY = '/etc/nginx/yunpanel-waf';
const CROWDSEC_APPSEC_ACQUISITION_PATH = '/etc/crowdsec/acquis.d/yunpanel-appsec.yaml';
const CROWDSEC_APPSEC_OBSERVE_CONFIG_PATH = '/etc/crowdsec/appsec-configs/yunpanel-appsec-observe.yaml';
const CROWDSEC_APPSEC_DEFAULT_LISTEN = '127.0.0.1:7422';
const CROWDSEC_APPSEC_DEFAULT_CONFIG = 'crowdsecurity/appsec-default';
const CROWDSEC_APPSEC_OBSERVE_CONFIG_NAME = 'yunpanel/appsec-observe';
const CROWDSEC_APPSEC_OBSERVE_INBAND_RULES = Object.freeze([
  'crowdsecurity/base-config',
  'crowdsecurity/vpatch-*',
  'crowdsecurity/generic-*',
]);
const CROWDSEC_APPSEC_OBSERVE_OUTOFBAND_RULES = Object.freeze([
  'crowdsecurity/experimental-*',
  'crowdsecurity/appsec-generic-test',
]);
const MAX_EXCLUDED_ROUTES = 64;
const DEFAULT_SAFE_ROUTE_EXCLUSIONS = Object.freeze([
  '/api/auth/',
  '/wp-admin/async-upload.php',
  '/wp-json/wp/v2/media',
  '/wp-login.php',
]);

const SAFE_ROUTE_PATTERN = /^\/[A-Za-z0-9._/-]{1,127}$/;
const SAFE_APPSEC_CONFIG_PATTERN = /^[a-z0-9][a-z0-9._/-]{1,95}$/;
const LOOPBACK_LISTEN_PATTERN = /^(127\.0\.0\.1|\[::1\]):([1-9][0-9]{3,4})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CLOUDFLARE_ZONE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const CLOUDFLARE_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class WafPolicyTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WafPolicyTemplateError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDomain(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WafPolicyTemplateError('waf_domain_invalid', 'WAF policy requires a valid domain name');
  }
  let primary;
  try {
    primary = normalizeDomainSet(value, []).primary;
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new WafPolicyTemplateError('waf_domain_invalid', error.message);
    }
    throw error;
  }
  if (isIP(primary)) {
    throw new WafPolicyTemplateError('waf_domain_invalid', 'WAF policy requires a DNS domain name, not an IP address');
  }
  return primary;
}

function normalizeMode(value = 'observe') {
  if (typeof value !== 'string' || !WAF_MODES.includes(value)) {
    throw new WafPolicyTemplateError('waf_mode_invalid', 'WAF mode must be disabled, observe or enforce');
  }
  return value;
}

function normalizeRoute(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 128 || !SAFE_ROUTE_PATTERN.test(value)) {
    throw new WafPolicyTemplateError(
      'waf_route_invalid',
      'WAF excluded route must be a bounded safe URI path starting with /',
    );
  }
  if (value.includes('//')) {
    throw new WafPolicyTemplateError('waf_route_invalid', 'WAF excluded route must not contain empty path segments');
  }
  const trimmedTrailing = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = trimmedTrailing.slice(1).split('/');
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new WafPolicyTemplateError('waf_route_invalid', 'WAF excluded route must not contain traversal or root-only segments');
  }
  return value;
}

export function normalizeWafExcludedRoutes(customRoutes = [], { includeDefaults = true } = {}) {
  if (!Array.isArray(customRoutes)) {
    throw new WafPolicyTemplateError('waf_routes_invalid', 'WAF excluded routes must be an array');
  }
  if (typeof includeDefaults !== 'boolean') {
    throw new WafPolicyTemplateError('waf_routes_invalid', 'includeDefaults must be a boolean');
  }
  if (customRoutes.length > MAX_EXCLUDED_ROUTES) {
    throw new WafPolicyTemplateError(
      'waf_routes_limit_exceeded',
      `At most ${MAX_EXCLUDED_ROUTES} excluded WAF routes are supported`,
    );
  }
  const merged = new Set(includeDefaults ? DEFAULT_SAFE_ROUTE_EXCLUSIONS : []);
  for (const route of customRoutes) {
    merged.add(normalizeRoute(route));
  }
  if (merged.size > MAX_EXCLUDED_ROUTES) {
    throw new WafPolicyTemplateError(
      'waf_routes_limit_exceeded',
      `At most ${MAX_EXCLUDED_ROUTES} excluded WAF routes are supported`,
    );
  }
  return Object.freeze([...merged].sort());
}

function normalizeListenAddr(value = CROWDSEC_APPSEC_DEFAULT_LISTEN) {
  if (typeof value !== 'string') {
    throw new WafPolicyTemplateError('waf_listen_addr_invalid', 'CrowdSec AppSec listenAddr must be a loopback host:port');
  }
  const match = LOOPBACK_LISTEN_PATTERN.exec(value);
  if (!match) {
    throw new WafPolicyTemplateError('waf_listen_addr_invalid', 'CrowdSec AppSec listenAddr must bind 127.0.0.1 or [::1] on port 1024-65535');
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new WafPolicyTemplateError('waf_listen_addr_invalid', 'CrowdSec AppSec port must be between 1024 and 65535');
  }
  return value;
}

function normalizeAppsecConfig(value = CROWDSEC_APPSEC_DEFAULT_CONFIG) {
  if (typeof value !== 'string' || !SAFE_APPSEC_CONFIG_PATTERN.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('/')) {
    throw new WafPolicyTemplateError('waf_appsec_config_invalid', 'CrowdSec AppSec config name contains invalid characters');
  }
  return value;
}

function normalizeCrowdSecRollbackSnapshot(snapshot, mode) {
  if (snapshot === undefined || snapshot === null) {
    if (mode === 'enforce') {
      throw new WafPolicyTemplateError(
        'waf_rollback_precondition_missing',
        'CrowdSec AppSec enforce mode requires rollbackSnapshot.previousPolicySha256 from an observe or prior policy',
      );
    }
    return null;
  }
  if (!isPlainObject(snapshot) || typeof snapshot.previousPolicySha256 !== 'string'
    || !SHA256_PATTERN.test(snapshot.previousPolicySha256)) {
    throw new WafPolicyTemplateError(
      'waf_rollback_precondition_missing',
      'CrowdSec AppSec rollbackSnapshot requires a lowercase SHA-256 previousPolicySha256 digest',
    );
  }
  return Object.freeze({
    previousPolicySha256: snapshot.previousPolicySha256,
  });
}

function normalizeCloudflareRollbackSnapshot(snapshot, mode) {
  if (snapshot === undefined || snapshot === null) {
    if (mode === 'enforce') {
      throw new WafPolicyTemplateError(
        'waf_rollback_precondition_missing',
        'Cloudflare Managed WAF enforce mode requires rollbackSnapshot with previousRulesetVersion and previousRulesetSha256',
      );
    }
    return null;
  }
  if (!isPlainObject(snapshot)
    || typeof snapshot.previousRulesetVersion !== 'string'
    || !CLOUDFLARE_VERSION_PATTERN.test(snapshot.previousRulesetVersion)
    || typeof snapshot.previousRulesetSha256 !== 'string'
    || !SHA256_PATTERN.test(snapshot.previousRulesetSha256)) {
    throw new WafPolicyTemplateError(
      'waf_rollback_precondition_missing',
      'Cloudflare rollbackSnapshot requires valid previousRulesetVersion and lowercase SHA-256 previousRulesetSha256',
    );
  }
  return Object.freeze({
    previousRulesetVersion: snapshot.previousRulesetVersion,
    previousRulesetSha256: snapshot.previousRulesetSha256,
  });
}

function normalizeCloudflareZoneId(zoneId) {
  if (zoneId === undefined || zoneId === null) return null;
  if (typeof zoneId !== 'string' || !CLOUDFLARE_ZONE_ID_PATTERN.test(zoneId)) {
    throw new WafPolicyTemplateError('waf_zone_id_invalid', 'Cloudflare zoneId must be a 32-character hexadecimal identifier');
  }
  return zoneId.toLowerCase();
}

export function nginxWafConfigPath(domain) {
  return `${NGINX_WAF_DIRECTORY}/${normalizeDomain(domain)}.conf`;
}

function renderNginxRouteExclusion(route) {
  if (route.endsWith('/')) {
    const escaped = route.replace(/[.]/g, '\\.');
    return `if ($uri ~ "^${escaped}") {\n  set $crowdsec_disable_appsec "1";\n  set $yunpanel_waf_skip "1";\n}`;
  }
  return `if ($uri = "${route}") {\n  set $crowdsec_disable_appsec "1";\n  set $yunpanel_waf_skip "1";\n}`;
}

function renderCrowdSecNginxSnippet({ domain, mode, listenAddr, excludedRoutes }) {
  const lines = [
    '# Managed by YunPanel: CrowdSec AppSec WAF policy',
    `# domain: ${domain}`,
    '# provider: crowdsec_appsec',
    `# mode: ${mode}`,
  ];
  if (mode === 'disabled') {
    lines.push(
      'set $crowdsec_disable_appsec "1";',
      'set $yunpanel_waf_provider "crowdsec_appsec";',
      'set $yunpanel_waf_mode "disabled";',
      'set $yunpanel_appsec_enabled "0";',
      'set $yunpanel_appsec_action "off";',
      'set $yunpanel_appsec_failure_action "passthrough";',
      'set $yunpanel_waf_skip "1";',
    );
    return `${lines.join('\n')}\n`;
  }

  const inbandAction = mode === 'observe' ? 'log' : 'block';
  lines.push(
    '# appsec_failure_action passthrough;',
    'set $crowdsec_disable_appsec "0";',
    'set $yunpanel_waf_provider "crowdsec_appsec";',
    `set $yunpanel_waf_mode "${mode}";`,
    'set $yunpanel_appsec_enabled "1";',
    `set $yunpanel_appsec_action "${inbandAction}";`,
    'set $yunpanel_appsec_failure_action "passthrough";',
    `set $yunpanel_appsec_endpoint "http://${listenAddr}";`,
    'set $yunpanel_waf_skip "0";',
  );
  if (excludedRoutes.length > 0) {
    lines.push('');
    for (const route of excludedRoutes) {
      lines.push(renderNginxRouteExclusion(route));
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderCrowdSecObserveAppsecConfigYaml() {
  return [
    '# Managed by YunPanel: CrowdSec AppSec observe (non-blocking) config',
    `name: "${CROWDSEC_APPSEC_OBSERVE_CONFIG_NAME}"`,
    'default_remediation: "allow"',
    'inband_rules:',
    ...CROWDSEC_APPSEC_OBSERVE_INBAND_RULES.map((rule) => `  - "${rule}"`),
    'outofband_rules:',
    ...CROWDSEC_APPSEC_OBSERVE_OUTOFBAND_RULES.map((rule) => `  - "${rule}"`),
    '',
  ].join('\n');
}

function renderCrowdSecAcquisitionYaml({ domain, mode, listenAddr, appsecConfig }) {
  if (mode === 'disabled') {
    return [
      '# Managed by YunPanel: CrowdSec AppSec acquisition (disabled)',
      `# domain: ${domain}`,
      '# mode: disabled',
      '',
    ].join('\n');
  }
  const simulation = mode === 'observe';
  const inbandAction = simulation ? 'log' : 'block';
  return [
    '# Managed by YunPanel: CrowdSec AppSec acquisition',
    'source: appsec',
    `listen_addr: "${listenAddr}"`,
    'path: /',
    `appsec_config: "${appsecConfig}"`,
    'labels:',
    '  type: appsec',
    '  managed_by: yunpanel',
    `  domain: "${domain}"`,
    `  mode: ${mode}`,
    `  simulation: ${simulation ? 'true' : 'false'}`,
    `  inband_action: ${inbandAction}`,
    '  appsec_failure_action: passthrough',
    '',
  ].join('\n');
}

function makeArtifact(filePath, content) {
  return Object.freeze({
    path: filePath,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
  });
}

export function previewCrowdSecAppSecPolicy({
  domain,
  mode = 'observe',
  excludedRoutes = [],
  includeDefaultExclusions = true,
  listenAddr = CROWDSEC_APPSEC_DEFAULT_LISTEN,
  appsecConfig = CROWDSEC_APPSEC_DEFAULT_CONFIG,
  rollbackSnapshot = null,
} = {}) {
  const primaryDomain = normalizeDomain(domain);
  const normalizedMode = normalizeMode(mode);
  const normalizedRoutes = normalizeWafExcludedRoutes(excludedRoutes, {
    includeDefaults: includeDefaultExclusions,
  });
  const normalizedListen = normalizeListenAddr(listenAddr);
  const normalizedAppsecConfig = normalizeAppsecConfig(appsecConfig);
  const effectiveAppsecConfig = normalizedMode === 'observe'
    ? CROWDSEC_APPSEC_OBSERVE_CONFIG_NAME
    : normalizedAppsecConfig;
  const normalizedSnapshot = normalizeCrowdSecRollbackSnapshot(rollbackSnapshot, normalizedMode);

  const nginxPath = nginxWafConfigPath(primaryDomain);
  const nginxContent = renderCrowdSecNginxSnippet({
    domain: primaryDomain,
    mode: normalizedMode,
    listenAddr: normalizedListen,
    excludedRoutes: normalizedRoutes,
  });
  const acquisContent = renderCrowdSecAcquisitionYaml({
    domain: primaryDomain,
    mode: normalizedMode,
    listenAddr: normalizedListen,
    appsecConfig: effectiveAppsecConfig,
  });
  const observeConfigContent = renderCrowdSecObserveAppsecConfigYaml();
  const disabledNginxContent = renderCrowdSecNginxSnippet({
    domain: primaryDomain,
    mode: 'disabled',
    listenAddr: normalizedListen,
    excludedRoutes: [],
  });
  const disabledAcquisContent = renderCrowdSecAcquisitionYaml({
    domain: primaryDomain,
    mode: 'disabled',
    listenAddr: normalizedListen,
    appsecConfig: normalizedAppsecConfig,
  });

  const nginxArtifact = makeArtifact(nginxPath, nginxContent);
  const acquisitionArtifact = makeArtifact(CROWDSEC_APPSEC_ACQUISITION_PATH, acquisContent);
  const observeConfigArtifact = makeArtifact(CROWDSEC_APPSEC_OBSERVE_CONFIG_PATH, observeConfigContent);
  const rollbackNginxArtifact = makeArtifact(nginxPath, disabledNginxContent);
  const rollbackAcquisitionArtifact = makeArtifact(CROWDSEC_APPSEC_ACQUISITION_PATH, disabledAcquisContent);

  const rollback = Object.freeze({
    targetMode: 'disabled',
    requiredBeforeEnforce: true,
    snapshot: normalizedSnapshot,
    nginxConfigTestRequired: true,
    reloadRequired: true,
    removeFiles: Object.freeze([CROWDSEC_APPSEC_OBSERVE_CONFIG_PATH]),
    artifacts: Object.freeze({
      nginxInclude: rollbackNginxArtifact,
      crowdsecAcquisition: rollbackAcquisitionArtifact,
    }),
  });

  const digestPayload = {
    version: 1,
    provider: 'crowdsec_appsec',
    domain: primaryDomain,
    mode: normalizedMode,
    listenAddr: normalizedListen,
    appsecConfig: normalizedAppsecConfig,
    effectiveAppsecConfig: normalizedMode === 'disabled' ? null : effectiveAppsecConfig,
    excludedRoutes: normalizedRoutes,
    snapshot: normalizedSnapshot,
    nginxSha256: nginxArtifact.sha256,
    acquisitionSha256: acquisitionArtifact.sha256,
    observeAppsecConfigSha256: normalizedMode === 'observe' ? observeConfigArtifact.sha256 : null,
  };

  return Object.freeze({
    version: 1,
    provider: 'crowdsec_appsec',
    domain: primaryDomain,
    mode: normalizedMode,
    blocking: normalizedMode === 'enforce',
    simulation: normalizedMode === 'observe',
    appsecFailureAction: 'passthrough',
    listenAddr: normalizedListen,
    appsecConfig: normalizedAppsecConfig,
    observeAppsecConfig: CROWDSEC_APPSEC_OBSERVE_CONFIG_NAME,
    effectiveAppsecConfig: normalizedMode === 'disabled' ? null : effectiveAppsecConfig,
    excludedRoutes: normalizedRoutes,
    artifacts: Object.freeze({
      nginxInclude: nginxArtifact,
      crowdsecAcquisition: acquisitionArtifact,
      ...(normalizedMode === 'observe' ? { crowdsecAppsecConfig: observeConfigArtifact } : {}),
    }),
    rollback,
    sha256: sha256(JSON.stringify(digestPayload)),
    sideEffects: false,
  });
}

function renderCloudflareSkipExpression(domain, excludedRoutes) {
  if (excludedRoutes.length === 0) return null;
  const clauses = excludedRoutes.map((route) => (
    route.endsWith('/')
      ? `starts_with(http.request.uri.path, "${route}")`
      : `http.request.uri.path eq "${route}"`
  ));
  return `(http.host eq "${domain}" and (${clauses.join(' or ')}))`;
}

export function previewCloudflareManagedWafPolicy({
  domain,
  zoneId = null,
  mode = 'observe',
  enforceAction = 'managed_challenge',
  excludedRoutes = [],
  includeDefaultExclusions = true,
  rollbackSnapshot = null,
} = {}) {
  const primaryDomain = normalizeDomain(domain);
  const normalizedZoneId = normalizeCloudflareZoneId(zoneId);
  const normalizedMode = normalizeMode(mode);
  if (typeof enforceAction !== 'string' || !CLOUDFLARE_ENFORCE_ACTIONS.includes(enforceAction)) {
    throw new WafPolicyTemplateError(
      'waf_action_invalid',
      'Cloudflare enforceAction must be managed_challenge or block',
    );
  }
  const normalizedRoutes = normalizeWafExcludedRoutes(excludedRoutes, {
    includeDefaults: includeDefaultExclusions,
  });
  const normalizedSnapshot = normalizeCloudflareRollbackSnapshot(rollbackSnapshot, normalizedMode);

  const action = normalizedMode === 'disabled'
    ? 'off'
    : normalizedMode === 'observe'
      ? 'log'
      : enforceAction;

  const rules = [];
  if (normalizedMode !== 'disabled') {
    const skipExpression = renderCloudflareSkipExpression(primaryDomain, normalizedRoutes);
    if (skipExpression) {
      rules.push(Object.freeze({
        id: 'yunpanel-safe-route-exclusions',
        phase: 'http_request_firewall_managed',
        action: 'skip',
        expression: skipExpression,
        actionParameters: Object.freeze({
          phases: Object.freeze(['http_request_firewall_managed']),
        }),
        logging: Object.freeze({ enabled: true }),
      }));
    }
    rules.push(Object.freeze({
      id: 'yunpanel-managed-waf-ruleset',
      phase: 'http_request_firewall_managed',
      action: 'execute',
      expression: `(http.host eq "${primaryDomain}")`,
      actionParameters: Object.freeze({
        overrides: Object.freeze({
          action,
        }),
      }),
      logging: Object.freeze({ enabled: true }),
    }));
  }

  const frozenRules = Object.freeze(rules);
  const rollback = Object.freeze({
    targetMode: 'disabled',
    targetAction: 'off',
    requiredBeforeEnforce: true,
    snapshot: normalizedSnapshot,
    restoreSteps: Object.freeze([
      'Switch managed ruleset override back to log or off for the domain',
      'Restore previousRulesetVersion and verify previousRulesetSha256 matches the pre-enforce snapshot',
      'Re-verify login, upload and API health checks',
    ]),
  });

  const digestPayload = {
    version: 1,
    provider: 'cloudflare_managed',
    domain: primaryDomain,
    zoneId: normalizedZoneId,
    mode: normalizedMode,
    action,
    excludedRoutes: normalizedRoutes,
    rules: frozenRules,
    snapshot: normalizedSnapshot,
  };

  return Object.freeze({
    version: 1,
    provider: 'cloudflare_managed',
    domain: primaryDomain,
    zoneId: normalizedZoneId,
    mode: normalizedMode,
    action,
    blocking: normalizedMode === 'enforce',
    simulation: normalizedMode === 'observe',
    excludedRoutes: normalizedRoutes,
    rules: frozenRules,
    rollback,
    sha256: sha256(JSON.stringify(digestPayload)),
    sideEffects: false,
  });
}

export function previewWafPolicy(options = {}) {
  if (!isPlainObject(options)) {
    throw new WafPolicyTemplateError('waf_input_invalid', 'WAF policy input must be an object');
  }
  const { provider, ...rest } = options;
  if (provider === 'crowdsec_appsec') return previewCrowdSecAppSecPolicy(rest);
  if (provider === 'cloudflare_managed') return previewCloudflareManagedWafPolicy(rest);
  throw new WafPolicyTemplateError(
    'waf_provider_invalid',
    'WAF provider must be crowdsec_appsec or cloudflare_managed',
  );
}

export const wafPolicyTemplatePolicy = Object.freeze({
  providers: WAF_PROVIDERS,
  modes: WAF_MODES,
  cloudflareEnforceActions: CLOUDFLARE_ENFORCE_ACTIONS,
  nginxWafDirectory: NGINX_WAF_DIRECTORY,
  crowdsecAppsecAcquisitionPath: CROWDSEC_APPSEC_ACQUISITION_PATH,
  crowdsecAppsecObserveConfigPath: CROWDSEC_APPSEC_OBSERVE_CONFIG_PATH,
  defaultListenAddr: CROWDSEC_APPSEC_DEFAULT_LISTEN,
  defaultAppsecConfig: CROWDSEC_APPSEC_DEFAULT_CONFIG,
  defaultObserveAppsecConfig: CROWDSEC_APPSEC_OBSERVE_CONFIG_NAME,
  defaultExcludedRoutes: DEFAULT_SAFE_ROUTE_EXCLUSIONS,
  maxExcludedRoutes: MAX_EXCLUDED_ROUTES,
});
