'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import './dark-chapter.css';

export function DarkChapter({ intro, children }: { intro: ReactNode; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!root.current || !surface.current || !content.current) return;
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const timeline = gsap.timeline({ scrollTrigger: { id: 'relay-light-to-dark', trigger: root.current, start: 'top 95%', end: 'top 18%', scrub: .8, invalidateOnRefresh: true } });
      timeline.fromTo(surface.current, { scaleX: .94, borderTopLeftRadius: 96, borderTopRightRadius: 96 }, { scaleX: 1, borderTopLeftRadius: 0, borderTopRightRadius: 0, duration: 1, ease: 'power1.inOut' }, 0);
      timeline.fromTo(content.current, { y: 55 }, { y: 0, duration: 1, ease: 'power1.out' }, 0);
    }, root);
    let disposed = false;
    void document.fonts.ready.then(() => { if (!disposed) ScrollTrigger.refresh(); });
    return () => { disposed = true; media.revert(); };
  }, []);

  return <div className="relay-dark-chapter" ref={root} data-theme="dark"><div className="relay-dark-chapter-entry" ref={surface}><div ref={content}>{intro}</div></div><div className="relay-dark-chapter-body">{children}</div></div>;
}
