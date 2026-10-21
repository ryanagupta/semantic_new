import { createServer } from 'node:http';
// Keep the original preview address pointing at the real application.
createServer((request,response)=>{
  const source=new URL(request.url||'/','http://127.0.0.1');
  const target=new URL('http://localhost:3000');
  target.pathname=source.pathname==='/atelier.html'?'/':source.pathname;
  target.search=source.search;
  response.writeHead(307,{Location:target.href,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  response.end();
}).listen(3100,'127.0.0.1',()=>process.stdout.write('Relay preview: http://127.0.0.1:3100 → http://localhost:3000\n'));
