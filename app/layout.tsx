import type { Metadata } from 'next';
import './globals.css';
import './relay.css';

export const metadata: Metadata = {
  title: { default: 'Relay — APIs and MCPs. One connection.', template: '%s · Relay' },
  description: 'Relay unifies commonly used APIs and MCP servers through one gateway. Discover tools, connect providers, and manage access for your applications and agents.',
  icons: { icon: '/icon.svg?v=relay-brand' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth"><head><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@200..800&family=Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800&display=swap" rel="stylesheet"/></head><body>{children}</body></html>;
}
