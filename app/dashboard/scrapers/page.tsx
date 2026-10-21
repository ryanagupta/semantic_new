import type { Metadata } from 'next';
import { ScraperBuilder } from '@/components/dashboard/scraper-builder';
import './scraper.css';

export const metadata: Metadata = { title: 'Scraper builder' };

export default function ScrapersPage() {
  return <ScraperBuilder />;
}
