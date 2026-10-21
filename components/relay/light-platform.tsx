'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, ArrowUpRight, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { GatewayPreview } from './workspace-preview';
import { FeatureExplorer } from './feature-explorer';
import './light-platform.css';

const workflows = [
  { title: 'Agent workflows', heading: 'Give your agents a world of tools.', description: 'Connect APIs and MCP servers to the agents you build.', image: '/images/relay-agent-workflows.png', alt: 'Pastel glass loops connecting three ceramic spheres', href: '/docs#transports' },
  { title: 'Developer tools', heading: 'Build the product. Connect the rest.', description: 'Bring your services together through one consistent gateway.', image: '/images/relay-developer-tools.png', alt: 'A silver laptop and iridescent glass sphere on a sunlit workbench', href: '/docs#quickstart' },
  { title: 'Team infrastructure', heading: 'A shared foundation for your stack.', description: 'Keep access, provider connections, and usage controls together.', image: '/images/relay-connected-infrastructure.png', alt: 'Pastel glass towers connected by polished metal pathways', href: '/docs#gateway-and-observability' },
];

export function LightPlatformSection() {
  const [active, setActive] = useState(1);
  const selected = useRef(1);
  const rail = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const scrollFrame = useRef(0);

  function move(index: number, instant = false) {
    const next = (index + workflows.length) % workflows.length;
    const container = rail.current, card = cards.current[next];
    if (!container || !card) return;
    selected.current = next;
    setActive(next);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ left: card.offsetLeft - (container.clientWidth - card.offsetWidth) / 2, behavior: instant || reduced ? 'instant' : 'smooth' });
  }

  useLayoutEffect(() => {
    const container = rail.current;
    if (!container) return;
    const resize = new ResizeObserver(() => move(selected.current, true));
    resize.observe(container);
    move(1, true);
    return () => { resize.disconnect(); cancelAnimationFrame(scrollFrame.current); };
  }, []);

  function onScroll() {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      const container = rail.current;
      if (!container) return;
      const center = container.scrollLeft + container.clientWidth / 2;
      let nearest = 0, distance = Infinity;
      cards.current.forEach((card, index) => {
        if (!card) return;
        const delta = Math.abs(card.offsetLeft + card.offsetWidth / 2 - center);
        if (delta < distance) { distance = delta; nearest = index; }
      });
      selected.current = nearest;
      setActive(nearest);
    });
  }

  return <section className="relay-light-platform" id="platform" aria-labelledby="light-platform-title">
    <div className="relay-light-wash" aria-hidden="true"/>
    <div className="relay-container relay-light-intro"><h2 id="light-platform-title">Built for everything<br/>you want to connect.</h2><p>Public APIs. Powerful MCPs. Your own services.<br/> Bring the tools behind your next idea into one beautifully simple connection.</p></div>
    <div className="relay-container relay-light-console"><GatewayPreview light/></div>
    <FeatureExplorer/>
    <div className="relay-container relay-workflow-heading"><div><h2>One gateway.<br/>Every kind of builder.</h2><p>From your first agent to your next platform.</p></div><div className="relay-carousel-controls"><button aria-label="Previous use case" onClick={() => move(active - 1)}><ArrowLeft size={19}/></button><button aria-label="Next use case" onClick={() => move(active + 1)}><ArrowRight size={19}/></button></div></div>
    <div className="relay-workflow-tabs" aria-label="Use case categories">{workflows.map((item, index) => <button key={item.title} aria-pressed={active === index} onClick={() => move(index)}>{item.title}</button>)}</div>
    <div className="relay-workflow-rail" ref={rail} onScroll={onScroll} role="region" aria-label="Relay use cases" tabIndex={0} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); move(active + (event.key === 'ArrowRight' ? 1 : -1)); } }}>
      {workflows.map((item, index) => <article key={item.title} ref={element => { cards.current[index] = element; }} className={active === index ? 'relay-workflow-card is-active' : 'relay-workflow-card'} role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${workflows.length}: ${item.title}`}>
        <Image src={item.image} alt={item.alt} fill sizes="(max-width: 700px) 90vw, 760px"/>
        <div className="relay-workflow-image-shade"/>
        <Link className="relay-workflow-open" href={item.href} aria-label={`Explore ${item.title.toLowerCase()}`}><ArrowUpRight size={22}/></Link>
        <div className="relay-workflow-caption"><span>{item.title}</span><h3>{item.heading}</h3><p>{item.description}</p></div>
      </article>)}
    </div>
    <div className="relay-carousel-progress" role="status" aria-live="polite" aria-label={`${workflows[active].title}, ${active + 1} of ${workflows.length}`}><span>{String(active + 1).padStart(2, '0')}</span><div>{workflows.map((item, index) => <button key={item.title} aria-label={`Show ${item.title.toLowerCase()}`} aria-current={active === index ? 'true' : undefined} onClick={() => move(index)}/>)}</div><span>{String(workflows.length).padStart(2, '0')}</span></div>
    <div className="relay-container relay-light-security"><div className="relay-security-art" aria-hidden="true"><span className="relay-security-halo"/><div className="relay-security-tile"><KeyRound size={43}/></div><div className="relay-security-tile"><ShieldCheck size={43}/></div><div className="relay-security-tile"><LockKeyhole size={43}/></div></div><div><h2>Your tools.<br/>Your boundaries.</h2><p>Keep credentials scoped, connect providers with your own accounts, and control how your agents use each tool.</p><Link href="/docs#security" className="relay-light-link">Explore security<ArrowUpRight size={16}/></Link></div></div>
  </section>;
}
