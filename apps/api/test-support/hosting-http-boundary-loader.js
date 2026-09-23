import { registerHooks } from 'node:module';

/** Load the REAL auth-http + Owner/MFA/panel policies, mocking only unrelated
 * webhook/gateway/global-audit adapters. Account storage and its audit
 * remain real SQLite in the caller. This is NOT a native password/MFA login test.
 * Hooks are scoped to this one importing module and removed immediately afterward.
 */
export async function loadHostingHttpBoundary() {
  const url = new URL('../src/auth-http.js', import.meta.url).href;
  const unused = (name) => `export function ${name}() { throw new Error('Unrelated adapter was invoked by hosting account test'); }`;
  const sources = new Map([
    ['./audit-http.js', unused('handleAuditRead')],
    ['./audit-request-context.js', 'export function withAuditActor(id, operation) { return operation(); }'],
    ['./management-audit.js', 'export function attachManagementAudit() {}'],
    ['./tool-gateway-session-policy.js', unused('requireToolGatewaySession')],
    ['./github-webhook-http.js', 'export function isGithubWebhookPath() { return false; }'],
    ['../../../packages/protocol/src/tool-gateway.js', 'export function isManagementToolGatewayAccessPath() { return false; } export function managementToolGatewayForAccessPath() { return null; }'],
  ]);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === url && sources.has(specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(sources.get(specifier))}`, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try { return await import(url); }
  finally { hooks.deregister(); }
}
