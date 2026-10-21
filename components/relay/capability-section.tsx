import './capability-section.css';

export function CapabilitySection() {
  return <section className="relay-capability-section" id="connections" aria-labelledby="relay-capability-title">
    <div className="relay-container relay-capability-frame">
      <div className="relay-capability-heading"><h2 id="relay-capability-title">Connect, build & scale<br/>with one gateway.</h2><p>Bring the APIs and MCP servers your applications need<br className="relay-capability-break"/> into one consistent access layer.</p></div>
      <div className="relay-capability-metrics">
        <article><h3><span className="relay-capability-sweep">REST</span> + MCP</h3><p>Connect existing APIs and MCP servers through Relay.</p></article>
        <article><h3><span className="relay-capability-sweep">1</span> gateway</h3><p>Discover tools, connect providers, and manage access in one place.</p></article>
        <article><h3><span className="relay-capability-sweep">3</span> transports</h3><p>Streamable HTTP, SSE, and stdio. Connect your apps and local agents.</p></article>
      </div>
    </div>
  </section>;
}
