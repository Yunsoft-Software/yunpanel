export default function ServerManager({ servers, access, renderServer }) {
  return (
    <section className="panel domain-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Managed infrastructure</p>
          <h2>Servers</h2>
        </div>
        <span className="panel-meta">{access}</span>
      </div>
      {servers.length ? (
        <div className="server-list">{servers.map(renderServer)}</div>
      ) : (
        <div className="domain-empty">
          <strong>No local server configured</strong>
          <span>Bootstrap the host with the packaged local-runtime create command before starting local execution.</span>
        </div>
      )}
    </section>
  );
}
