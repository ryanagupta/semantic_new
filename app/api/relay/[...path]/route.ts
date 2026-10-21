import { z } from 'zod';
import { getRelayRuntime } from '@/server/relay/runtime';
import { RelayError } from '@/server/relay/store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function boundedJson(request:Request){const reader=request.body?.getReader();if(!reader)throw new RelayError(400,'A JSON body is required.');let bytes=0;const chunks:Uint8Array[]=[];while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>65536){await reader.cancel();throw new RelayError(413,'Request is too large.');}chunks.push(part.value);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RelayError(400,'Invalid JSON.');}}
async function handle(request:Request,context:{params:Promise<{path:string[]}>}){
  try{
    const instance=getRelayRuntime();await instance.ready;
    const session=await instance.auth.api.getSession({headers:request.headers});if(!session)return Response.json({error:'Sign in to continue.'},{status:401});
    if(request.method!=='GET'){const origin=request.headers.get('origin');const configured=new URL(process.env.BETTER_AUTH_URL||process.env.APP_ORIGIN||'http://localhost:3000').origin;const dev=process.env.NODE_ENV!=='production'&&origin&&/^http:\/\/(localhost|127\.0\.0\.1):(3000|3002)$/.test(origin);if(origin&&origin!==configured&&!dev)throw new RelayError(403,'Origin is not allowed.');if(request.headers.get('sec-fetch-site')==='cross-site')throw new RelayError(403,'Cross-site request rejected.');}
    const {path}=await context.params;const[kind,id]=path,user=session.user.id;
    if(path.length>2)throw new RelayError(404,'Route not found.');
    if(kind==='workspace'&&request.method==='GET')return Response.json(instance.store.workspace(user),{headers:{'Cache-Control':'no-store'}});
    if(kind==='contact'&&request.method==='POST'){return Response.json({id:instance.store.contact(user,await boundedJson(request)),saved:true},{status:201});}
    if(!['projects','items','tasks'].includes(kind))throw new RelayError(404,'Route not found.');
    if(request.method==='DELETE'&&id){instance.store.delete(user,kind as 'projects'|'items'|'tasks',id);return Response.json({deleted:true});}
    if((request.method==='POST'&&!id)||(request.method==='PUT'&&id)){const body=await boundedJson(request);const saved=kind==='projects'?instance.store.saveProject(user,body,id):kind==='items'?instance.store.saveItem(user,body,id):instance.store.saveTask(user,body,id);return Response.json({id:saved},{status:request.method==='POST'?201:200});}
    return Response.json({error:'Method not allowed.'},{status:405,headers:{Allow:'GET, POST, PUT, DELETE'}});
  }catch(error){const status=error instanceof z.ZodError?400:error instanceof RelayError?error.status:500;const message=error instanceof z.ZodError?error.issues.map(i=>i.message).join(' '):error instanceof RelayError?error.message:'Unable to save your changes. Please try again.';return Response.json({error:message},{status});}
}
export {handle as GET,handle as POST,handle as PUT,handle as DELETE};
