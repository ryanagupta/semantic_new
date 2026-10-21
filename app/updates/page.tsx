import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { RelayNavbar } from '@/components/relay/navbar';
import { ArticleCards } from '@/components/relay/latest-updates';

export const metadata: Metadata = { title: 'Latest from Relay', description: 'Guides to connecting APIs, MCP tools, and provider accounts through Relay.' };

export default function UpdatesPage() {
  return <div className="relay-site relay-journal"><RelayNavbar/><main id="main" className="relay-container relay-editorial-frame"><header className="relay-editorial-heading"><div><span className="relay-editorial-eyebrow">The Relay journal</span><h1>Ideas for your<br/>next connection.</h1></div><Link href="/docs" className="relay-editorial-button">Explore docs<ArrowUpRight size={15}/></Link></header><p className="relay-journal-intro">Practical guides to connecting services, building agent workflows, and keeping access in your hands.</p><ArticleCards/></main></div>;
}
