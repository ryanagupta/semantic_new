import { forwardGateway } from '@/lib/gateway-proxy';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{provider:string}>}){
  const {provider}=await context.params;
  if(!['reactbits','sequential-thinking','mobbin','higgsfield'].includes(provider))return Response.json({error:'Unknown provider'},{status:404});
  return forwardGateway(request,`/api/oauth/${encodeURIComponent(provider)}/callback${new URL(request.url).search}`);
}
