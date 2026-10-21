import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { relayArticles } from '@/config/relay-articles';
import './editorial-sections.css';

export function ArticleCards() {
  return <div className="relay-update-grid">{relayArticles.map(article => <article className="relay-update-card" key={article.slug}><Link href={`/updates/${article.slug}`}><div className={`relay-update-art relay-update-art-${article.theme}`}><span className="relay-update-art-text">{article.artworkTitle}</span><span className="relay-update-art-arrow" aria-hidden="true"><ArrowUpRight size={21}/></span></div><div className="relay-update-caption"><h3>{article.title}</h3><span>{article.category}<i/>Relay</span></div></Link></article>)}</div>;
}

export function LatestUpdates() {
  return <section className="relay-latest-updates" id="updates" aria-labelledby="relay-updates-title"><div className="relay-container relay-editorial-frame"><header className="relay-editorial-heading"><h2 id="relay-updates-title">Latest from Relay.</h2><Link href="/updates" className="relay-editorial-button">All posts<ArrowUpRight size={15}/></Link></header><ArticleCards/></div></section>;
}
