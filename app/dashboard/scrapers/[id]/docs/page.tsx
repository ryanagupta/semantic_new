import type { Metadata } from 'next';
import { ScraperDocs } from '@/components/dashboard/scraper-docs';
import '../../scraper.css';

export const metadata: Metadata = { title: 'Scraper API documentation' };

export default async function ScraperDocumentationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScraperDocs endpointId={id} />;
}
