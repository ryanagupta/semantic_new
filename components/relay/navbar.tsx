'use client';
import Link from 'next/link';
import { ArrowUpRight, ChevronDown, Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { RelayBrand } from './brand';

type MenuLink = { title: string; description: string; href: string };
type NavMenu = { id: string; label: string; columns: { heading: string; links: MenuLink[] }[] };
const menus: NavMenu[] = [
  { id: 'platform', label: 'Platform', columns: [
    { heading: 'Explore Relay', links: [
      { title: 'Platform overview', description: 'One gateway for your APIs and MCP servers.', href: '/#gateway' },
      { title: 'API to MCP', description: 'Turn REST operations into tools for your agents.', href: '/docs#openapi' },
      { title: 'Developer console', description: 'Manage your connections in one place.', href: '/dashboard/gateway' },
    ] },
    { heading: 'Capabilities', links: [
      { title: 'Tool discovery', description: 'Inspect available tools and their input schemas.', href: '/docs#custom-tools' },
      { title: 'Authentication & access', description: 'Scoped keys and connected provider accounts.', href: '/docs#authentication' },
      { title: 'Usage & controls', description: 'Monitor requests, quotas, and rate limits.', href: '/docs#gateway-and-observability' },
    ] },
  ] },
  { id: 'directory', label: 'Directory', columns: [
    { heading: 'Find your connections', links: [
      { title: 'MCP registry', description: 'Explore configured servers and connect providers.', href: '/dashboard/mcps' },
      { title: 'REST APIs', description: 'Add endpoints or import an OpenAPI specification.', href: '/dashboard/endpoints' },
      { title: 'Explore the interface', description: 'See how APIs and MCPs come together in Relay.', href: '/#gateway' },
    ] },
    { heading: 'Ways to connect', links: [
      { title: 'Open MCP servers', description: 'Connect services that don’t require provider login.', href: '/docs#provider-connections' },
      { title: 'Authenticated providers', description: 'Use your own account to access gated tools.', href: '/docs#provider-connections' },
      { title: 'Your own services', description: 'Bring a custom API into your toolchain.', href: '/docs#openapi' },
    ] },
  ] },
  { id: 'developers', label: 'Developers', columns: [
    { heading: 'Start building', links: [
      { title: 'Quickstart', description: 'Set up Relay and connect your first service.', href: '/docs#quickstart' },
      { title: 'OpenAPI import', description: 'Map API operations to validated MCP tools.', href: '/docs#openapi' },
      { title: 'MCP inspector', description: 'Discover schemas and test JSON-RPC calls.', href: '/dashboard/mcp-inspector' },
    ] },
    { heading: 'Developer tools', links: [
      { title: 'API keys', description: 'Create credentials with the scopes you need.', href: '/dashboard/keys' },
      { title: 'MCP transports', description: 'Connect clients over HTTP, SSE, or stdio.', href: '/docs#transports' },
      { title: 'Custom tools', description: 'Define how agents interact with your APIs.', href: '/docs#custom-tools' },
    ] },
  ] },
  { id: 'resources', label: 'Resources', columns: [
    { heading: 'Guides & reference', links: [
      { title: 'Documentation', description: 'Everything you need to work with Relay.', href: '/docs#gateway' },
      { title: 'Latest from Relay', description: 'Guides for your next API or MCP connection.', href: '/updates' },
      { title: 'Security', description: 'Understand credential and execution controls.', href: '/docs#security' },
      { title: 'Deployment', description: 'Run the gateway in your own environment.', href: '/docs#deployment' },
    ] },
    { heading: 'Plan your setup', links: [
      { title: 'Billing & quotas', description: 'Understand plan limits and usage credits.', href: '/docs#billing-and-quotas' },
      { title: 'Why Relay', description: 'A consistent connection to the tools you use.', href: '/#about' },
      { title: 'Talk to sales', description: 'Discuss integrations, scale, and deployment.', href: '/contact' },
    ] },
  ] },
];

export function RelayNavbar({ overlay = false }: { overlay?: boolean } = {}) {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const mobileTrigger = useRef<HTMLButtonElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const { data: session } = authClient.useSession();
  useEffect(() => { const update = () => setScrolled(window.scrollY > 32); update(); window.addEventListener('scroll', update, { passive: true }); return () => window.removeEventListener('scroll', update); }, []);
  const consoleUrl = '/dashboard/gateway';
  const loginUrl = '/login?next=/dashboard/gateway';
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) { setOpen(null); setMobile(false); } };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!open && !mobile)) return;
      event.preventDefault();
      if (mobile) mobileTrigger.current?.focus();
      else if (open) triggers.current[open]?.focus();
      setOpen(null); setMobile(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); };
  }, [open, mobile]);
  function close() { setOpen(null); setMobile(false); }
  return <header className={overlay ? 'relay-nav relay-nav-overlay' : 'relay-nav'} ref={ref} data-scrolled={scrolled} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    <div className="relay-nav-inner"><RelayBrand/>
      <nav className={mobile ? 'relay-nav-links is-open' : 'relay-nav-links'} aria-label="Main navigation">
        {menus.map((menu, index) => <div className="relay-nav-group" key={menu.id}>
          {index === 2 && <Link className="relay-pricing-link" href="/#membership" onClick={close}>Pricing</Link>}
          <button ref={element => { triggers.current[menu.id] = element; }} id={'nav-trigger-' + menu.id} type="button" aria-expanded={open === menu.id} aria-controls={'nav-' + menu.id}
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            onPointerEnter={event => { if (event.pointerType === 'mouse' && open) setOpen(menu.id); }}
            onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(menu.id); requestAnimationFrame(() => document.getElementById('nav-' + menu.id)?.querySelector('a')?.focus()); } }}>
            {menu.label}<ChevronDown size={12} className={open === menu.id ? 'rotated' : ''}/>
          </button>
          {open === menu.id && <div className="relay-nav-dropdown relay-mega-menu" id={'nav-' + menu.id} role="region" aria-labelledby={'nav-trigger-' + menu.id}>
            <div className="relay-mega-columns">{menu.columns.map(column => <section className="relay-mega-column" key={column.heading} aria-label={column.heading}>
              <p className="relay-mega-heading">{column.heading}</p>
              {column.links.map(link => <Link className="relay-mega-link" href={link.href} key={link.title} onClick={close}><span><strong>{link.title}</strong><small>{link.description}</small></span><ArrowUpRight size={16} aria-hidden="true"/></Link>)}
            </section>)}</div>
          </div>}
        </div>)}
      </nav>
      <div className="relay-nav-actions"><Link href={session ? consoleUrl : loginUrl} className="relay-btn relay-btn-white relay-nav-cta">{session ? 'Console' : 'Sign in'}<ArrowUpRight size={15}/></Link><button ref={mobileTrigger} className="relay-menu-toggle" aria-label={mobile ? 'Close navigation' : 'Open navigation'} aria-expanded={mobile} onClick={() => { setMobile(!mobile); setOpen(null); }}>{mobile ? <X size={20}/> : <Menu size={20}/>}</button></div>
    </div>
  </header>;
}
