import { relayAuthProviders, type RelayAuthProvider } from '../../config/auth-providers.ts';
import type { BetterAuthOptions } from 'better-auth';

export function getRelaySocialProviders(environment: NodeJS.ProcessEnv = process.env) {
  const common: Partial<Record<Exclude<RelayAuthProvider, 'cognito' | 'tiktok'>, { clientId: string; clientSecret: string }>> = {};
  const special: Pick<NonNullable<BetterAuthOptions['socialProviders']>, 'cognito' | 'tiktok'> = {};
  for (const provider of relayAuthProviders) {
    const clientId = environment[`${provider.prefix}_CLIENT_ID`]?.trim();
    const clientSecret = environment[`${provider.prefix}_CLIENT_SECRET`]?.trim();
    if (provider.id === 'tiktok') {
      const clientKey = environment.TIKTOK_CLIENT_KEY?.trim() || clientId;
      if (clientKey && clientSecret) special.tiktok = { clientKey, clientSecret };
    } else if (provider.id === 'cognito') {
      const domain = environment.COGNITO_DOMAIN?.trim(), region = environment.COGNITO_REGION?.trim(), userPoolId = environment.COGNITO_USER_POOL_ID?.trim();
      if (clientId && clientSecret && domain && region && userPoolId) special.cognito = { clientId, clientSecret, domain, region, userPoolId };
    } else if (clientId && clientSecret) common[provider.id] = { clientId, clientSecret };
  }
  return { ...common, ...special };
}

export function getRelaySocialProviderIds(): RelayAuthProvider[] {
  return Object.keys(getRelaySocialProviders()) as RelayAuthProvider[];
}
