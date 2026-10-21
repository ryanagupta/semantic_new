import { RelayNavbar } from '@/components/relay/navbar';
import { ContactForm } from '@/components/relay/contact-form';
export const metadata={title:'Talk to us'};
export default function Contact(){return <div className="relay-site"><RelayNavbar/><main className="relay-contact-page relay-container"><div><h1>Good things start<br/>with a conversation.</h1><p>Tell us which APIs and MCP servers you want to connect, what you’re building, and the scale you have in mind.</p></div><ContactForm/></main></div>;}
