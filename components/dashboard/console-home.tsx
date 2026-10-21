'use client';

import Link from 'next/link';
import { Activity, ArrowRight, ArrowUpRight, Braces, Check, ChevronRight, Clock3, Globe2, KeyRound, Layers3, Plus, RefreshCw, Search, ShieldCheck, Terminal, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@/components/relay/workspace-context';
import type { Endpoint, Metrics } from '@/shared/types';
import { api, errorMessage } from '@/lib/api';
import type { McpRegistry } from './providers';
import { EmptyState, formatDate, formatNumber, Notice, Spinner } from './ui';

export function ConsoleHome() {
  const { user } = useWorkspace();
  const [greeting, setGreeting] = useState('Welcome back');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [registry, setRegistry] = useState<McpRegistry | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'enabled'>('all');
  const [search, setSearch] = useState('');
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const [activity, connections, servers] = await Promise.all([api<Metrics>('/metrics?hours=24', { signal: controller.signal }), api<Endpoint[]>('/endpoints', { signal: controller.signal }), api<McpRegistry>('/mcps', { signal: controller.signal })]);
      if (!controller.signal.aborted) { setMetrics(activity); setEndpoints(connections); setRegistry(servers); setError(''); }
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, []);

  useEffect(() => { const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date())); setGreeting(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'); void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 30000); return () => { clearInterval(timer); request.current?.abort(); }; }, [load]);

  const steps = [
    { title: 'Connect your first API', description: 'Add an endpoint or import OpenAPI.', done: endpoints.length > 0, href: '/dashboard/endpoints' },
    { title: 'Create a scoped key', description: 'Choose what your application can use.', done: (metrics?.activeKeys ?? 0) > 0, href: '/dashboard/keys' },
    { title: 'Make your first tool call', description: 'Try your connection in the inspector.', done: (metrics?.totalRequests ?? 0) > 0, href: '/dashboard/mcp-inspector' },
  ];
  const completed = steps.filter(step => step.done).length;
  const filtered = endpoints.filter(endpoint => (filter !== 'enabled' || endpoint.enabled) && `${endpoint.name} ${endpoint.description} ${endpoint.url}`.toLowerCase().includes(search.toLowerCase()));
  const cards = [
    { title: 'API endpoints', label: 'REST & GRAPHQL', count: metrics ? `${endpoints.length} configured` : 'Connect your services', icon: Globe2, symbol: Braces, theme: 'violet', href: '/dashboard/endpoints' },
    { title: 'MCP directory', label: 'YOUR AGENT TOOLKIT', count: registry ? `${registry.providers.length} integrations` : 'Discover MCP servers', icon: Layers3, symbol: Layers3, theme: 'rose', href: '/dashboard/mcps' },
    { title: 'Tool inspector', label: 'JSON-RPC PLAYGROUND', count: 'Inspect, test, and explore', icon: Terminal, symbol: Terminal, theme: 'blue', href: '/dashboard/mcp-inspector' },
  ];

  return <div className="console-home"><header className="console-home-heading"><div><span className="console-eyebrow">YOUR RELAY WORKSPACE</span><h1>{greeting}, {user.name.split(' ')[0]}<span>.</span></h1><p>A world of APIs and MCPs. One place to bring them together.</p></div><Link href="/dashboard/endpoints" className="dash-button primary"><Plus size={16}/>Add endpoint</Link></header>{error && <Notice>{error}</Notice>}
    <div className="console-home-layout"><div className="console-home-primary"><div className="console-section-title"><h2>Your connections</h2><Link href="/dashboard/mcps">Explore directory<ArrowUpRight size={14}/></Link></div><div className="console-connection-cards">{cards.map(card => <article key={card.title} className={`console-connection-card ${card.theme}`}><div className="console-card-art" aria-hidden="true"><span/><card.symbol size={104} strokeWidth={1}/><i/></div><div className="console-card-content"><span>{card.label}</span><h3>{card.title}</h3><p>{card.count}</p><Link href={card.href} aria-label={`Open ${card.title.toLowerCase()}`}>Open<ChevronRight size={16}/></Link></div></article>)}</div>
      <section className="console-usage-summary" aria-label="Gateway usage over the last 24 hours">{[{ icon: Activity, label: 'API requests', value: metrics ? formatNumber(metrics.totalRequests) : '—', detail: 'Last 24 hours', theme: 'cyan' }, { icon: Clock3, label: 'Average latency', value: metrics ? `${formatNumber(metrics.averageLatency)} ms` : '—', detail: 'Upstream tool calls', theme: 'purple' }, { icon: KeyRound, label: 'Active keys', value: metrics ? formatNumber(metrics.activeKeys) : '—', detail: 'Scoped credentials', theme: 'pink' }].map(item => <div key={item.label}><span className={`console-stat-icon ${item.theme}`}><item.icon size={18}/></span><div><span>{item.label}</span><strong>{item.value}</strong><small>{item.detail}</small></div></div>)}</section>
      <section className="console-connections-panel"><div className="console-section-title"><h2>Connected APIs<span>{endpoints.length}</span></h2><Link href="/dashboard/endpoints">Manage<ArrowUpRight size={14}/></Link></div><div className="console-connection-toolbar"><div className="console-home-tabs">{(['all', 'enabled'] as const).map(value => <button key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All endpoints' : 'Enabled'}</button>)}</div><label><Search size={15}/><input aria-label="Search connected APIs" placeholder="Search connections…" value={search} onChange={event => setSearch(event.target.value)}/></label></div>{!metrics && busy ? <div className="console-home-loading"><Spinner label="Loading connections"/></div> : filtered.length ? <div className="console-home-endpoints">{filtered.slice(0, 5).map(endpoint => <Link key={endpoint.id} href="/dashboard/endpoints"><span className={`console-endpoint-status${endpoint.enabled ? ' enabled' : ''}`}><Globe2 size={18}/></span><span><strong>{endpoint.name}</strong><small>{endpoint.description || new URL(endpoint.url).hostname}</small></span><span className="console-endpoint-method">{endpoint.method}</span><ChevronRight size={16}/></Link>)}</div> : <EmptyState icon={<Globe2 size={25}/>} title={search || filter === 'enabled' ? 'No matching connections' : 'Your next connection starts here'} description={search || filter === 'enabled' ? 'Try another search or show all endpoints.' : 'Add an API endpoint or bring in an OpenAPI specification.'}>{!search && filter === 'all' && <Link className="dash-button" href="/dashboard/endpoints"><Plus size={14}/>Connect an API</Link>}</EmptyState>}</section>
    </div><aside className="console-home-aside"><div className="console-section-title"><h2><ShieldCheck size={18}/>Gateway setup</h2><span>{completed}/3</span></div><section className="console-onboarding"><div className="console-progress-ring"><svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="30" fill="none" stroke="#edf1f5" strokeWidth="5"/><circle cx="36" cy="36" r="30" fill="none" stroke="#1bb8e7" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${completed / 3 * 188.5} 188.5`} transform="rotate(-90 36 36)"/></svg><Zap size={26}/></div><h2>{completed === 3 ? 'Your gateway is ready.' : 'A little setup. A lot of possibility.'}</h2><p>Give your next application a clear path to the tools it needs.</p><div className="console-onboarding-steps">{steps.map((step, index) => <Link key={step.title} href={step.href}><span className={step.done ? 'complete' : ''}>{step.done ? <Check size={13}/> : index + 1}</span><div><strong>{step.title}</strong><small>{step.description}</small></div><ChevronRight size={13}/></Link>)}</div><Link className="dash-button primary" href={steps.find(step => !step.done)?.href || '/dashboard/mcp-inspector'}>{completed === 3 ? 'Open inspector' : 'Continue setup'}<ArrowRight size={16}/></Link></section><Link className="console-guide-card" href="/docs#quickstart"><span><Braces size={19}/>Built for your next idea</span><h3>Your first API.<br/>Your first MCP tool.</h3><p>Follow the quickstart and make your first connection.</p><strong>Read the guide<ArrowUpRight size={14}/></strong></Link></aside></div>
    <section className="console-recent-activity"><div className="console-section-title"><h2>Recent activity<span className="console-live-label"><i/>Gateway telemetry</span></h2><button className="console-refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={14} className={busy ? 'dash-spin' : ''}/>Refresh</button></div><div className="dash-panel">{metrics?.recent.length ? <div className="dash-table-scroll"><table className="dash-table"><thead><tr><th>Tool / endpoint</th><th>Status</th><th>Latency</th><th>Time</th></tr></thead><tbody>{metrics.recent.slice(0, 5).map(log => <tr key={log.id}><td><code>{log.tool}</code></td><td><span className={`dash-status-badge ${log.status >= 400 ? 'red' : ''}`}>{log.status}</span></td><td>{Math.round(log.latency)} ms</td><td>{formatDate(log.timestamp)}</td></tr>)}</tbody></table></div> : <EmptyState icon={<Activity size={23}/>} title="Ready when you are" description="Your gateway requests will appear here once your applications start calling tools."/>}</div></section>
  </div>;
}
