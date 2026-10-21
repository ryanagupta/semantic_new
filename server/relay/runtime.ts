import 'dotenv/config';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RelayStore } from './store.ts';
import { getRelaySocialProviders } from './auth-providers.ts';

export function createRelayRuntime(options:{databasePath?:string;secret?:string;baseURL?:string}={}){
  const path=resolve(/* turbopackIgnore: true */ options.databasePath||process.env.RELAY_DATABASE_PATH||'./data/relay.db');
  mkdirSync(dirname(path),{recursive:true});
  const production=process.env.NODE_ENV==='production';
  let secret=options.secret||process.env.BETTER_AUTH_SECRET;
  if(!secret&&production)throw new Error('BETTER_AUTH_SECRET is required in production (32+ random characters).');
  if(!secret){const secretPath=resolve(dirname(path),'.relay-auth-secret');if(!existsSync(secretPath))writeFileSync(secretPath,randomBytes(48).toString('base64url'),{mode:0o600,flag:'wx'});secret=readFileSync(secretPath,'utf8').trim();}
  if(secret.length<32)throw new Error('BETTER_AUTH_SECRET must have at least 32 characters.');
  const baseURL=options.baseURL||process.env.BETTER_AUTH_URL||process.env.APP_ORIGIN||'http://localhost:3000';
  if(production&&new URL(baseURL).protocol!=='https:')throw new Error('BETTER_AUTH_URL requires HTTPS in production.');
  const database=new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');
  const socialProviders=getRelaySocialProviders();
  const trustedOrigins=production?[new URL(baseURL).origin]:[...new Set([new URL(baseURL).origin,'http://localhost:3000','http://127.0.0.1:3000','http://localhost:3002','http://127.0.0.1:3002'])];
  if(socialProviders.apple)trustedOrigins.push('https://appleid.apple.com');
  const authOptions={
    appName:'Relay',secret,baseURL,database,
    trustedOrigins,
    emailAndPassword:{enabled:true,minPasswordLength:12,maxPasswordLength:128,autoSignIn:true},
    socialProviders,
    session:{expiresIn:60*60*24*7,updateAge:60*60*24,cookieCache:{enabled:false}},
    advanced:{cookiePrefix:'relay',useSecureCookies:production},
    rateLimit:{enabled:true,storage:'database',window:60,max:100,customRules:{'/sign-in/email':{window:60,max:8},'/sign-up/email':{window:60,max:5}}},
    logger:{level:'error'},
  } satisfies BetterAuthOptions;
  const initializeAuth=()=>betterAuth(authOptions);
  let auth:ReturnType<typeof initializeAuth>|undefined;
  const ready=getMigrations(authOptions).then(async migrations=>{await migrations.runMigrations();auth=initializeAuth();});
  const store=new RelayStore(database);
  return {get auth(){if(!auth)throw new Error('Await Relay database initialization before authentication.');return auth;},store,database,ready};
}
type Runtime=ReturnType<typeof createRelayRuntime>;
const globalRuntime=globalThis as typeof globalThis&{__relayRuntime?:Runtime};
export function getRelayRuntime():Runtime{return globalRuntime.__relayRuntime??=createRelayRuntime();}
