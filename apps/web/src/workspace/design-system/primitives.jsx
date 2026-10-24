import { Link } from 'react-router';

export const DesignSystemConfig = Object.freeze({
  id: 'shadcn-zinc-indigo',
  name: 'YunPanel Shadcn UI (Zinc/Slate + Indigo + Spotlight)',
  version: '2.0.0',
  swappable: true,
  tokens: Object.freeze({
    dark: Object.freeze({
      canvas: '#09090b',
      surface: '#141418',
      surfaceRaised: '#18181b',
      border: '#27272a',
      brand: '#6366f1',
      statusActive: '#10b981',
    }),
    light: Object.freeze({
      canvas: '#fafafa',
      surface: '#ffffff',
      surfaceRaised: '#ffffff',
      border: '#e4e4e7',
      brand: '#4f46e5',
      statusActive: '#059669',
    }),
    radius: Object.freeze({
      card: '12px',
      control: '8px',
      small: '6px',
    }),
  }),
});

export const DEFAULT_DOCKER_STACK_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'nginx', label: 'Nginx Web / Reverse Proxy', image: 'nginx:latest', serviceName: 'web', targetPort: 80, publishedPort: 18080 }),
  Object.freeze({ id: 'redis', label: 'Redis 7 Cache (Alpine)', image: 'redis:7-alpine', serviceName: 'redis', targetPort: 6379, publishedPort: 16379 }),
  Object.freeze({ id: 'postgres', label: 'PostgreSQL 16 Database', image: 'postgres:16', serviceName: 'postgres', targetPort: 5432, publishedPort: 15432 }),
  Object.freeze({ id: 'n8n', label: 'n8n Workflow Automation', image: 'n8n:latest', serviceName: 'n8n', targetPort: 5678, publishedPort: 15678 }),
  Object.freeze({ id: 'node', label: 'Node.js 24 Runtime', image: 'node:24-alpine', serviceName: 'app', targetPort: 3000, publishedPort: 13000 }),
]);

export function ThemeRoot({ theme = 'dark', density = 'comfortable', className = '', children }) {
  return (
    <div
      data-ws-design-system={DesignSystemConfig.id}
      data-ws-theme={theme}
      data-ws-density={density}
      className={`yp-theme-root ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function FileRootBadge({ path, isSubdomain = false, parentDomain = null }) {
  const normalizedPath = path || (parentDomain ? `/var/www/vhosts/${parentDomain}/httpdocs` : '/var/www/vhosts/default/httpdocs');
  return (
    <span
      className="yp-file-root-pill"
      title={isSubdomain && parentDomain ? `${parentDomain} ortak dizini içinde alt alan adı dosya kökü` : 'Site dosya kökü'}
    >
      <code>{normalizedPath}</code>
      {isSubdomain && <small className="yp-file-root-tag">ortak kök</small>}
    </span>
  );
}

export function SubdomainBranchRow({
  domain,
  parentDomain = '',
  isLast = false,
  fileRoot = null,
  to = null,
  actions = null,
  children = null,
}) {
  const primaryDomain = typeof domain === 'string' ? domain : (domain?.primaryDomain ?? '');
  const cleanParent = parentDomain || '';
  const prefix = cleanParent && primaryDomain.endsWith(`.${cleanParent}`)
    ? primaryDomain.slice(0, -(cleanParent.length + 1))
    : (primaryDomain.split('.')[0] || 'sub');
  const computedRoot = fileRoot || (cleanParent
    ? `/var/www/vhosts/${cleanParent}/subdomains/${prefix}`
    : `/subdomains/${prefix}`);
  const connector = isLast ? '└─' : '├─';

  return (
    <div className="yp-subdomain-branch" role="treeitem" aria-label={primaryDomain}>
      <div className="yp-subdomain-branch-main">
        <span className="yp-tree-connector" aria-hidden="true">{connector}</span>
        {to ? <Link to={to}><strong>{primaryDomain}</strong></Link> : <strong>{primaryDomain}</strong>}
        <FileRootBadge path={computedRoot} isSubdomain parentDomain={cleanParent || null} />
      </div>
      {(actions || children) && (
        <div className="ws-actions">
          {actions}
          {children}
        </div>
      )}
    </div>
  );
}

export function HierarchyTree({
  parentDomain = '',
  items = [],
  renderItemActions = null,
  getItemHref = null,
  className = '',
}) {
  return (
    <div
      className={`yp-subdomain-tree ${className}`.trim()}
      role="tree"
      aria-label={parentDomain ? `${parentDomain} alt alan adı ağacı` : 'Alt alan adı ağacı'}
    >
      {items.map((item, index) => {
        const key = item?.id ?? item?.primaryDomain ?? index;
        const href = typeof getItemHref === 'function' ? getItemHref(item) : null;
        const actions = typeof renderItemActions === 'function' ? renderItemActions(item) : null;
        return (
          <SubdomainBranchRow
            key={key}
            domain={item}
            parentDomain={parentDomain}
            isLast={index === items.length - 1}
            to={href}
            actions={actions}
          />
        );
      })}
    </div>
  );
}

export function PortMappingTable({ services = [], proxyTarget = null }) {
  const rows = (services ?? []).flatMap((service) => {
    const ports = Array.isArray(service?.publishedPorts) ? service.publishedPorts : [];
    if (ports.length === 0) {
      return [{
        key: `${service.name}:none`,
        serviceName: service.name,
        sourceKind: service.imageConfigured ? 'image' : service.buildConfigured ? 'build' : '—',
        innerPort: null,
        outerPort: null,
        hostIp: null,
        protocol: 'tcp',
      }];
    }
    return ports.map((port) => ({
      key: `${service.name}:${port.hostIp ?? '*'}:${port.publishedPort}:${port.targetPort}/${port.protocol ?? 'tcp'}`,
      serviceName: service.name,
      sourceKind: service.imageConfigured ? 'image' : service.buildConfigured ? 'build' : '—',
      innerPort: port.targetPort,
      outerPort: port.publishedPort,
      hostIp: port.hostIp ?? '127.0.0.1',
      protocol: port.protocol ?? 'tcp',
    }));
  });

  return (
    <div className="ws-table-scroll">
      <table className="ws-table" aria-label="Docker Inner ve Outer Port Eşlemeleri">
        <thead>
          <tr>
            <th>Servis</th>
            <th>Kaynak</th>
            <th>Inner Port (Container)</th>
            <th>Outer Port (Host)</th>
            <th>Published ports</th>
            <th>Domain / Proxy Bağlantısı</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rawLabel = row.innerPort != null
              ? `${row.hostIp === '127.0.0.1' ? '127.0.0.1' : (row.hostIp ?? '*')}:${row.outerPort} → ${row.innerPort}/${row.protocol}`
              : '—';
            const proxyText = proxyTarget
              || (row.innerPort != null ? `127.0.0.1:${row.outerPort} ↔ container:${row.innerPort}/${row.protocol}` : 'Port yayımlanmadı');
            return (
              <tr key={row.key}>
                <td><strong>{row.serviceName}</strong></td>
                <td>{row.sourceKind}</td>
                <td>{row.innerPort != null ? <span className="yp-port-mapping-badge">Inner: {row.innerPort}/{row.protocol}</span> : '—'}</td>
                <td>{row.outerPort != null ? <span className="yp-port-mapping-badge">Outer: {row.hostIp}:{row.outerPort}</span> : '—'}</td>
                <td>{row.innerPort != null ? <small>{rawLabel}</small> : '—'}</td>
                <td><code>{proxyText}</code></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DockerHubCatalogPicker({
  catalog = DEFAULT_DOCKER_STACK_TEMPLATES,
  selectedImage = 'nginx:latest',
  targetPort = 80,
  publishedPort = 18080,
  onSelectImage,
  onChangeTargetPort,
  onChangePublishedPort,
  onApplyTemplate,
  disabled = false,
}) {
  return (
    <div className="yp-docker-quickbar" role="region" aria-label="Docker Hub / Hazır Stack Şablonundan Oluştur">
      <label>
        Docker Hub / Hazır İmaj
        <select
          aria-label="Docker Hub imajı"
          value={selectedImage}
          disabled={disabled}
          onChange={(event) => onSelectImage?.(event.target.value)}
        >
          {catalog.map((item) => (
            <option key={item.image} value={item.image}>
              {item.label ? `${item.label} (${item.image})` : item.image}
            </option>
          ))}
        </select>
      </label>
      <label>
        Inner Port (Container targetPort)
        <input
          type="number"
          aria-label="Inner Port (Container targetPort)"
          min={1}
          max={65535}
          value={targetPort}
          disabled={disabled}
          onChange={(event) => onChangeTargetPort?.(Number(event.target.value))}
        />
      </label>
      <label>
        Outer Port (Host publishedPort)
        <input
          type="number"
          aria-label="Outer Port (Host publishedPort)"
          min={1024}
          max={65535}
          value={publishedPort}
          disabled={disabled}
          onChange={(event) => onChangePublishedPort?.(Number(event.target.value))}
        />
      </label>
      <div>
        <button
          type="button"
          className="ws-button ws-button-secondary"
          disabled={disabled}
          onClick={() => onApplyTemplate?.({ image: selectedImage, targetPort: Number(targetPort), publishedPort: Number(publishedPort) })}
        >
          Şablondan YAML Oluştur
        </button>
      </div>
    </div>
  );
}
