import { forwardGateway } from '@/lib/gateway-proxy';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){return forwardGateway(request,'/api/billing/checkout');}
