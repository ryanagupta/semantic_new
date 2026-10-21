import Link from 'next/link';
import { RelayBrand } from '@/components/relay/brand';
export function MarketingFooter(){return <footer className="relay-footer relay-container"><div><RelayBrand/><p>One gateway for APIs and MCPs.</p></div><nav aria-label="Footer navigation"><Link href="/docs">The guide</Link><Link href="/contact">Contact</Link><Link href="/login?next=/dashboard/gateway">Log in</Link></nav><span>© {new Date().getUTCFullYear()} Relay</span></footer>;}
