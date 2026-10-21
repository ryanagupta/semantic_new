import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { limiter } from './limiter.js';
import { store } from './store.js';
import { billingStore } from './billing/store.js';
import { shutdownMcp } from './bridge/mcp.js';
import { deliverQuotaNotifications } from './middleware/quotas.js';
import { mountWebSocket } from './bridge/websocket.js';
import { authenticateToken } from './auth.js';
import { executeEndpoint } from './execution.js';
import { listRemoteTools,callRemoteTool } from './mcp/remote.js';
import { startScraperWorkers } from './scraper/worker.js';
import { scraperStore } from './scraper/store.js';

await limiter.connect();
const stopScraperWorkers=startScraperWorkers();
const server=createServer({maxHeaderSize:16384},createApp());
const websocket=mountWebSocket(server,{listEndpoints:()=>store.listEndpoints(),execute:executeEndpoint,authenticateToken,remote:{listTools:listRemoteTools,callTool:callRemoteTool}});
server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=1000;
server.listen(config.PORT,config.HOST,()=>process.stderr.write(`NexusMCP gateway ready at http://${config.HOST}:${config.PORT}\n`));
const cleanup=setInterval(()=>{store.pruneLogs();scraperStore.prune();void deliverQuotaNotifications();},60000);cleanup.unref();
let closing=false;
async function shutdown(){if(closing)return;closing=true;clearInterval(cleanup);server.close();for(const client of websocket.clients)client.terminate();websocket.close();await stopScraperWorkers();await shutdownMcp();await limiter.close();scraperStore.close();store.close();billingStore.close();server.closeAllConnections();}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
