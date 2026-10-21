import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRelayRuntime } from '@/server/relay/runtime';
export async function getRelaySession(){const requestHeaders=await headers();const runtime=getRelayRuntime();await runtime.ready;return runtime.auth.api.getSession({headers:requestHeaders});}
export async function requireRelaySession(){const session=await getRelaySession();if(!session)redirect('/login');return session;}
