import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { authenticateToken } from './auth.js';
import { store } from './store.js';
import { limiter } from './limiter.js';
import { createMcpServer } from './bridge/mcp.js';
import { executeEndpoint } from './execution.js';
import { listRemoteTools,callRemoteTool } from './mcp/remote.js';
import { consumePrincipalRate } from './middleware/security.js';
import { gatewayMcpError } from './bridge/errors.js';
const token=process.env.NEXUS_API_KEY;
if(!token)throw new Error('NEXUS_API_KEY is required. Generate an API key in the dashboard.');
await limiter.connect();
const principal=await authenticateToken(token);
class AuthenticatedStdioTransport extends StdioServerTransport {
  async start(){
    const receive=this.onmessage;
    let queue=Promise.resolve();
    this.onmessage=message=>{
      queue=queue.then(async()=>{
        try{
          const refreshed=await authenticateToken(token!);
          await consumePrincipalRate(refreshed);
          Object.assign(principal,refreshed);
          receive?.(message);
        }catch(error){
          if('id' in message&&(typeof message.id==='string'||typeof message.id==='number')){const failure=gatewayMcpError(error);await this.send({jsonrpc:'2.0',id:message.id,error:{code:failure.code,message:'Gateway authentication or rate limit rejected this request.',data:failure.data}});}
          else process.stderr.write('Gateway authentication or rate limit rejected a notification.\n');
        }
      });
    };
    await super.start();
  }
}
const server=createMcpServer({listEndpoints:()=>store.listEndpoints(),execute:executeEndpoint,principal,remote:{listTools:listRemoteTools,callTool:callRemoteTool}});
await server.connect(new AuthenticatedStdioTransport());
