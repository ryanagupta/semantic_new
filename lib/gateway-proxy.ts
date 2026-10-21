import 'server-only';
export async function forwardGateway(request:Request,path:string):Promise<Response>{
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader)while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>1048576){await reader.cancel();return Response.json({error:'Payload Too Large'},{status:413});}chunks.push(result.value);}
  const headers=new Headers();for(const name of ['content-type','cookie','origin','sec-fetch-site','webhook-id','webhook-signature','webhook-timestamp']){const value=request.headers.get(name);if(value)headers.set(name,value);}
  try {
    const upstream=await fetch(`${process.env.GATEWAY_INTERNAL_URL||'http://127.0.0.1:3001'}${path}`,{method:request.method,headers,body:chunks.length?Buffer.concat(chunks):undefined,cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(25000)});
    const responseHeaders=new Headers();for(const name of ['content-type','set-cookie','location','retry-after','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset']){const value=upstream.headers.get(name);if(value)responseHeaders.set(name,value);}
    responseHeaders.set('Cache-Control','no-store');return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
  }catch{return Response.json({error:'Gateway unavailable'},{status:503});}
}
