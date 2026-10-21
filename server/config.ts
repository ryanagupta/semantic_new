import 'dotenv/config';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('127.0.0.1'), APP_ORIGIN: z.url().default('http://localhost:3000'),
  DATABASE_PATH: z.string().default('./data/nexus.db'),
  DASHBOARD_PASSWORD: z.string().optional(), SESSION_SECRET: z.string().min(32).optional().or(z.literal('')),
  ENCRYPTION_KEY: z.string().regex(/^[a-f\d]{64}$/i).optional().or(z.literal('')), REDIS_URL: z.url().optional().or(z.literal('')),
  UPSTREAM_ALLOWLIST: z.string().default(''),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(5000),
  MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(20971520).default(5242880),
  JWT_ISSUER: z.string().optional(), JWT_AUDIENCE: z.string().optional(), JWT_JWKS_URL: z.url().optional().or(z.literal('')),
  DODO_PAYMENTS_ENVIRONMENT:z.enum(['test_mode','live_mode']).default('test_mode'),
  DODO_PAYMENTS_API_KEY:z.string().optional(),DODO_PAYMENTS_WEBHOOK_KEY:z.string().optional(),
  DODO_PRO_PRODUCT_ID:z.string().optional(),DODO_CREDITS_PRODUCT_ID:z.string().optional(),DODO_BUSINESS_ID:z.string().optional(),
  ENTERPRISE_MONTHLY_CREDITS:z.coerce.number().int().min(1).max(1000000000).default(10000000),
  ENTERPRISE_REQUESTS_PER_MINUTE:z.coerce.number().int().min(1).max(1000000).default(10000),
  ENTERPRISE_TOOLS_PER_MINUTE:z.coerce.number().int().min(1).max(1000000).default(2000),
  TRUST_PROXY_HOPS:z.coerce.number().int().min(0).max(10).default(0),
  QUOTA_NOTIFICATION_WEBHOOK_URL:z.url().optional().or(z.literal('')),
}).parse(process.env);
const production = env.NODE_ENV === 'production';
if(new URL(env.APP_ORIGIN).pathname!=='/'||new URL(env.APP_ORIGIN).search||new URL(env.APP_ORIGIN).hash)throw new Error('APP_ORIGIN must be a bare origin without a path, query, or fragment.');
if([env.JWT_ISSUER,env.JWT_AUDIENCE,env.JWT_JWKS_URL].some(Boolean)&&![env.JWT_ISSUER,env.JWT_AUDIENCE,env.JWT_JWKS_URL].every(Boolean))throw new Error('JWT_ISSUER, JWT_AUDIENCE and JWT_JWKS_URL must be configured together.');
if (production && (!env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD.length < 24 || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !/^[a-f\d]{64}$/i.test(env.ENCRYPTION_KEY || ''))) {
  throw new Error('Production requires DASHBOARD_PASSWORD (24+ chars), SESSION_SECRET (32+ chars), and ENCRYPTION_KEY (64 hex chars).');
}
if (production && new URL(env.APP_ORIGIN).protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTPS in production.');
const databasePath = resolve(env.DATABASE_PATH);
mkdirSync(dirname(databasePath), {recursive:true});
function localSecret(name: string) {
  const path = resolve(dirname(databasePath), name);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), {mode:0o600, flag:'wx'});
  return readFileSync(path, 'utf8').trim();
}
export const config = {
  ...env, production, databasePath,
  dashboardPassword: env.DASHBOARD_PASSWORD || 'nexus-local-dev',
  sessionSecret: env.SESSION_SECRET || localSecret('.session-secret'),
  encryptionKey: env.ENCRYPTION_KEY || localSecret('.encryption-key'),
  upstreamAllowlist: env.UPSTREAM_ALLOWLIST.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean),
};
