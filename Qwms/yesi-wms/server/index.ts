import { buildApp } from './api.js';
import { config } from './config.js';
import { pool } from './db.js';
import { runWorker } from './worker.js';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
const {app,redis,listen}=await buildApp();
const publicDir=resolve(process.cwd(),'public');if(existsSync(publicDir))await app.register(fastifyStatic,{root:publicDir,wildcard:false});
app.setNotFoundHandler((req,reply)=>{if(req.url.startsWith('/api/'))return reply.status(404).send({error:{code:'NOT_FOUND',message:'Endpoint not found'}});if(existsSync(resolve(publicDir,'index.html')))return reply.sendFile('index.html');return reply.status(404).send({message:'Build the React client with npm run build, or use the Vite preview on port 5173.'});});
await app.listen({port:config.port,host:'0.0.0.0'});
void listen();
const ac=new AbortController();
// Single-process convenience for local preview only. Production runs API and worker separately.
if(config.development&&process.env.EMBEDDED_WORKER!=='false')void runWorker(ac.signal);
console.log(JSON.stringify({level:'info',message:'YESI core ready',port:config.port,mode:'sandbox',worker:config.development&&process.env.EMBEDDED_WORKER!=='false'}));
async function shutdown(){ac.abort();await app.close();await redis?.quit();await pool.end();process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
