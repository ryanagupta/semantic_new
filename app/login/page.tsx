import { redirect } from 'next/navigation';
import { getRelaySession } from '@/lib/relay-session';
import { AuthForm } from '@/components/relay/auth-form';
import { getRelaySocialProviderIds } from '@/server/relay/auth-providers';
export const metadata={title:'Log in',robots:{index:false,follow:false}};
export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const query = await searchParams;
  const next = query.next && /^\/(dashboard(?:[/?#]|$)|contact(?:[/?#]|$))/.test(query.next) ? query.next : '/dashboard';
  if (await getRelaySession()) redirect(next);
  return <AuthForm mode="login" next={next} providers={getRelaySocialProviderIds()} initialError={query.error ? 'That sign-in attempt could not be completed. Try again or use email.' : ''}/>;
}
