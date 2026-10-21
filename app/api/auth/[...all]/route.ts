import { getRelayRuntime } from '@/server/relay/runtime';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request){const instance=getRelayRuntime();await instance.ready;return instance.auth.handler(request);}
export {handle as GET,handle as POST};
