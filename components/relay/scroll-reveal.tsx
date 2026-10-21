'use client';
import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
const text='Your tools live everywhere. Your connection should live in one place. Relay unifies commonly used APIs and MCP servers through one gateway, so your applications and agents can discover tools, connect providers, and get to work.';
export function ScrollReveal(){const ref=useRef<HTMLParagraphElement>(null);useEffect(()=>{gsap.registerPlugin(ScrollTrigger);const media=gsap.matchMedia();media.add('(prefers-reduced-motion: no-preference)',()=>{const words=ref.current?.querySelectorAll('.relay-reveal-word');if(!words)return;gsap.fromTo(words,{opacity:.15},{opacity:1,ease:'none',stagger:.08,scrollTrigger:{trigger:ref.current,start:'top 85%',end:'bottom 48%',scrub:.65}});});return()=>media.revert();},[]);return <section className="relay-philosophy" id="about"><p ref={ref} aria-label={text}>{text.split(' ').map((word,index)=><span key={index} className="relay-reveal-word" aria-hidden="true">{word}{' '}</span>)}</p></section>;}
