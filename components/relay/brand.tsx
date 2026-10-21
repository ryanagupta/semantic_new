import Link from 'next/link';
import Image from 'next/image';

type LogoProps = { compact?: boolean; tone?: 'light' | 'dark'; decorative?: boolean; className?: string };

export function RelayLogo({ compact = false, tone = 'light', decorative = false, className = '' }: LogoProps) {
  return <Image src={`/brand/relay-${compact ? 'mark' : 'wordmark'}-${tone}.svg`} alt={decorative ? '' : 'Relay'} width={compact ? 1128 : 1871} height={compact ? 1499 : 460} unoptimized className={`relay-logo ${compact ? 'relay-logo-mark' : 'relay-logo-wordmark'} ${className}`} />;
}

export function RelayBrand({ href = '/', compact = false, tone = 'light', className = '' }: { href?: string; className?: string } & Pick<LogoProps, 'compact' | 'tone'>) {
  return <Link href={href} className={`relay-brand ${className}`} aria-label="Relay home"><RelayLogo compact={compact} tone={tone} decorative /></Link>;
}
