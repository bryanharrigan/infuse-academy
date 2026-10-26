import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
const ROOT=process.cwd();
const T={".html":"text/html",".js":"text/javascript",".json":"application/json",".bin":"application/octet-stream"};
const s=createServer((q,r)=>{const u=new URL(q.url,"http://x");
const p=join(ROOT,u.pathname.startsWith("/anatomy/")?"public"+u.pathname:u.pathname);
if(!existsSync(p)){r.writeHead(404).end();return;}
r.writeHead(200,{"Content-Type":T[extname(p)]??"application/octet-stream"});r.end(readFileSync(p));});
await new Promise(r=>s.listen(8133,r));
mkdirSync("test/surface/shots",{recursive:true});
const b=await chromium.launch({executablePath:process.env.CHROME_PATH,
  args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const pg=await b.newPage({viewport:{width:1100,height:860}});
pg.on("pageerror",e=>console.log("ERR",String(e).slice(0,300)));
await pg.goto("http://localhost:8133/test/surface/index.html",{waitUntil:"load"});
await pg.waitForFunction(()=>window.__done===true,null,{timeout:120000});
await pg.waitForTimeout(600);
await pg.screenshot({path:"test/surface/shots/surface.png"});
await b.close(); s.close(); console.log("rendered");
