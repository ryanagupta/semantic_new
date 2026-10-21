'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Activity, ArrowRight, ArrowUpRight, BookOpen, ChevronDown, ChevronRight, CreditCard, FolderOpen, Globe2, House, KeyRound, Layers3, Library, LoaderCircle, LogOut, Menu, Plus, ScanSearch, Search, Settings, ShieldCheck, Sparkles, SquareCheckBig, Terminal, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { authClient } from '@/lib/auth-client';
import { RelayBrand } from '@/components/relay/brand';
import { useWorkspace } from '@/components/relay/workspace-context';
import { WorkspaceEditor } from '@/components/relay/workspace-editor';
import { GatewayAccess } from './gateway-access';

const primaryNavigation = [
  { href: '/dashboard', label: 'Home', description: 'Your connections and gateway overview', icon: House },
  { href: '/dashboard/endpoints', label: 'API endpoints', description: 'Add, import, and test REST APIs', icon: Globe2 },
  { href: '/dashboard/scrapers', label: 'Scraper builder', description: 'Turn public website data into a reusable API', icon: ScanSearch },
  { href: '/dashboard/mcps', label: 'MCP directory', description: 'Discover servers and connect accounts', icon: Layers3 },
  { href: '/dashboard/mcp-inspector', label: 'Tool inspector', description: 'Inspect schemas and simulate tool calls', icon: Terminal },
  { href: '/dashboard/keys', label: 'API keys', description: 'Manage scoped access credentials', icon: KeyRound },
];
const manageNavigation = [
  { href: '/dashboard/gateway', label: 'Usage & activity', description: 'Requests, latency, and upstream errors', icon: Activity },
  { href: '/dashboard/billing', label: 'Billing', description: 'Plan, credits, and monthly usage', icon: CreditCard },
];
const personalNavigation = [
  { href: '/dashboard/projects', label: 'Projects', description: 'Your saved projects', icon: FolderOpen },
  { href: '/dashboard/library', label: 'Library', description: 'Notes and saved links', icon: Library },
  { href: '/dashboard/tasks', label: 'Tasks', description: 'Your workspace tasks', icon: SquareCheckBig },
];
const destinations = [...primaryNavigation, ...manageNavigation, ...personalNavigation, { href: '/dashboard/settings', label: 'Settings', description: 'Manage your account profile', icon: Settings }];

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname(), router = useRouter();
  const { user, query, setQuery, error, message, setError } = useWorkspace();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(personalNavigation.some(item => pathname.startsWith(item.href)));
  const [signingOut, setSigningOut] = useState(false);
  const search = useRef<HTMLInputElement>(null), header = useRef<HTMLElement>(null);
  const active = destinations.find(item => item.href === pathname || item.href !== '/dashboard' && pathname.startsWith(item.href + '/'));
  const gatewayPage = pathname === '/dashboard' || [...primaryNavigation.slice(1), ...manageNavigation].some(item => pathname.startsWith(item.href));
  const searchResults = destinations.filter(item => `${item.label} ${item.description}`.toLowerCase().includes(query.toLowerCase())).slice(0, 7);
  const initials = user.name.split(' ').filter(Boolean).map(name => name[0]).slice(0, 2).join('').toUpperCase();

  useEffect(() => { setMobileMenu(false); setAccountMenu(false); setWorkspaceMenu(false); setSearchOpen(false); setQuery(''); }, [pathname, setQuery]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); search.current?.focus(); } if (event.key === 'Escape') { setMobileMenu(false); setAccountMenu(false); setWorkspaceMenu(false); setSearchOpen(false); search.current?.blur(); } };
    const outside = (event: PointerEvent) => { if (!header.current?.contains(event.target as Node)) { setAccountMenu(false); setWorkspaceMenu(false); setSearchOpen(false); } };
    document.addEventListener('keydown', keys); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', keys); document.removeEventListener('pointerdown', outside); };
  }, []);

  async function signOut() {
    setSigningOut(true);
    try { await fetch('/api/session', { method: 'DELETE' }).catch(() => {}); const result = await authClient.signOut(); if (result.error) throw new Error(result.error.message); router.replace('/login'); router.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not sign out.'); setSigningOut(false); }
  }

  function navLink(item: typeof destinations[number]) {
    const selected = active?.href === item.href;
    return <Link key={item.href} href={item.href} className={selected ? 'is-active' : ''} aria-current={selected ? 'page' : undefined}><item.icon size={20} strokeWidth={1.7}/><span>{item.label}</span>{selected && <span className="console-nav-indicator"/>}</Link>;
  }

  return <div className="relay-console">
    <a className="console-skip" href="#console-main">Skip to dashboard</a>
    <header className="console-topbar" ref={header}>
      <div className="console-topbar-brand"><button className="console-icon-button console-mobile-toggle" aria-label={mobileMenu ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileMenu} aria-controls="console-sidebar" onClick={() => setMobileMenu(!mobileMenu)}>{mobileMenu ? <X size={21}/> : <Menu size={21}/>}</button><RelayBrand tone="dark"/></div>
      <div className="console-workspace-switch"><button aria-expanded={workspaceMenu} onClick={() => { setWorkspaceMenu(!workspaceMenu); setAccountMenu(false); setSearchOpen(false); }}><span className="console-workspace-dot"/>Console<ChevronDown size={15}/></button>{workspaceMenu && <div className="console-popover console-workspace-popover"><span>Your workspace</span><strong>{user.name}</strong><small>{user.email}</small><Link href="/dashboard/settings"><Settings size={15}/>Workspace settings<ArrowUpRight size={13}/></Link><Link href="/"><ArrowUpRight size={15}/>Relay homepage</Link></div>}</div>
      <Link className="console-header-directory" href="/dashboard/mcps">Explore tools<ChevronDown size={14}/></Link>
      <div className="console-command-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setSearchOpen(false); }}><Search size={18}/><input ref={search} aria-label="Search console" role="combobox" aria-expanded={searchOpen} aria-controls="console-search-results" aria-autocomplete="list" placeholder="Search console" value={query} onFocus={() => { setSearchOpen(true); setAccountMenu(false); setWorkspaceMenu(false); }} onChange={event => { setQuery(event.target.value); setSearchOpen(true); }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); document.querySelector<HTMLAnchorElement>('#console-search-results a')?.focus(); } }}/><kbd>⌘ K</kbd>{searchOpen && <div className="console-popover console-search-results" id="console-search-results" role="listbox" aria-label="Console pages">{searchResults.length ? searchResults.map(item => <Link role="option" aria-selected={active?.href === item.href} key={item.href} href={item.href} onClick={() => setSearchOpen(false)}><item.icon size={18}/><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight size={14}/></Link>) : <p>No matching pages.</p>}</div>}</div>
      <div className="console-header-status"><span><Sparkles size={17}/>APIs + MCPs</span><Link href="/docs#quickstart"><Zap size={17}/>Quickstart</Link></div>
      <div className="console-account-menu"><button className="console-avatar" aria-label="Account menu" aria-expanded={accountMenu} onClick={() => { setAccountMenu(!accountMenu); setWorkspaceMenu(false); setSearchOpen(false); }}>{initials || 'R'}</button>{accountMenu && <div className="console-popover console-account-popover"><strong>{user.name}</strong><small>{user.email}</small><Link href="/dashboard/settings"><Settings size={15}/>Account settings</Link><button disabled={signingOut} onClick={() => void signOut()}>{signingOut ? <LoaderCircle size={15} className="dash-spin"/> : <LogOut size={15}/>}Sign out</button></div>}</div>
    </header>
    <aside className={`console-sidebar${mobileMenu ? ' is-open' : ''}`} id="console-sidebar"><nav aria-label="Dashboard navigation">{primaryNavigation.map(navLink)}<span className="console-nav-label">Workspace</span>{manageNavigation.map(navLink)}<button className="console-personal-toggle" aria-expanded={personalOpen} onClick={() => setPersonalOpen(!personalOpen)}><FolderOpen size={19}/><span>Saved workspace</span><ChevronDown size={14} className={personalOpen ? 'is-rotated' : ''}/></button>{personalOpen && <div className="console-personal-links">{personalNavigation.map(navLink)}</div>}</nav><div className="console-sidebar-bottom"><div className="console-sidebar-prompt"><span><ShieldCheck size={17}/>Your next connection</span><p>Bring an API into your agent’s toolkit.</p><Link href="/dashboard/endpoints">Connect an API<ArrowRight size={14}/></Link></div><Link className="console-upgrade" href="/dashboard/billing"><span><ArrowUpRight size={15}/></span>Upgrade plan</Link><Link href="/dashboard/settings" aria-current={active?.href === '/dashboard/settings' ? 'page' : undefined}><Settings size={20}/>Settings</Link><Link href="/docs"><BookOpen size={20}/>Documentation<ArrowUpRight size={13}/></Link></div></aside>
    {mobileMenu && <button className="console-scrim" aria-label="Close sidebar" onClick={() => setMobileMenu(false)}/>}
    <div className="console-main"><main className="console-page-content" id="console-main">{error && <div className="console-global-error" role="alert">{error}<button className="console-icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}{gatewayPage ? <GatewayAccess>{children}</GatewayAccess> : children}</main><footer className="console-footer"><span>Relay <span>·</span> Your tools, connected.</span><Link href="/docs#security">Privacy & security<ArrowUpRight size={12}/></Link></footer></div>
    {message && <div className="console-toast" role="status"><span/>{message}</div>}<WorkspaceEditor/>
  </div>;
}
