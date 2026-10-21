import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { relayArticles } from '@/config/relay-articles';
import { RelayNavbar } from '@/components/relay/navbar';
import '@/components/relay/editorial-sections.css';

export function generateStaticParams() { return relayArticles.map(article => ({ slug: article.slug })); }

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const article = relayArticles.find(item => item.slug === slug);
  return article ? { title: article.title, description: article.description } : { title: 'Article not found' };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = relayArticles.find(item => item.slug === slug);
  if (!article) notFound();
  return <div className="relay-site relay-journal"><RelayNavbar/><main id="main" className="relay-article"><Link href="/updates" className="relay-article-back"><ArrowLeft size={14}/>All posts</Link><div className="relay-article-category">{article.category} · Relay</div><h1>{article.title}</h1><p className="relay-article-lead">{article.description}</p><div className={`relay-update-art relay-update-art-${article.theme}`} aria-hidden="true"><span className="relay-update-art-text">{article.artworkTitle}</span></div>{article.sections.map(section => <section key={section.heading}><h2>{section.heading}</h2><p>{section.body}</p></section>)}<Link href={article.docs} className="relay-editorial-button">{article.action}<ArrowUpRight size={15}/></Link></main></div>;
}
