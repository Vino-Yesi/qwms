import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const envFile=resolve(process.cwd(),'.env');
if(existsSync(envFile)) for(const line of readFileSync(envFile,'utf8').split('\n')) { const m=line.match(/^([A-Z_]+)=(.*)$/); if(m && process.env[m[1]]===undefined) process.env[m[1]]=m[2]; }
const env=process.env;
export const config={
 port:Number(env.PORT||3000), development:env.NODE_ENV!=='production',
 databaseUrl:env.DATABASE_URL||'postgresql://yesi:yesi_local_only@127.0.0.1:5432/yesi',
 origin:env.APP_ORIGIN||'http://localhost:5173',
 key:Buffer.from(env.MASTER_KEY||'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=','base64'),
 authMode:env.AUTH_MODE||'local', live:env.CONNECTORS_LIVE==='true',
 oidcIssuer:env.OIDC_ISSUER_URL||'', oidcClient:env.OIDC_CLIENT_ID||'', oidcSecret:env.OIDC_CLIENT_SECRET||'',
 redisUrl:env.REDIS_URL||'', metricsToken:env.METRICS_TOKEN||'',
 erpEndpoint:env.ERP_ENDPOINT||'', erpSecret:env.ERP_SECRET||'',
 tmsEndpoint:env.TMS_ENDPOINT||'', tmsSecret:env.TMS_SECRET||'',
};
if(config.key.length!==32) throw new Error('MASTER_KEY must decode to exactly 32 bytes');
if(!config.development) {
 if(config.authMode!=='oidc'||!config.oidcIssuer||!config.oidcClient) throw new Error('Production requires configured OIDC');
 if(!config.origin.startsWith('https://')) throw new Error('Production requires HTTPS APP_ORIGIN');
 if(!config.redisUrl) throw new Error('Production requires Redis-backed shared rate limits');
 if(env.MASTER_KEY==='MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=') throw new Error('Replace the public demo encryption key');
 if(config.live) throw new Error('Live connector certification gate has not been enabled in this reference build');
}
export type Role='admin'|'supervisor'|'warehouse'|'finance'|'integration'|'viewer';
export type Actor={id:string;role:Role;email:string;requestId:string};
export const permissions:Record<string,Role[]>={
 read:['admin','supervisor','warehouse','finance','integration','viewer'],
 fulfill:['admin','supervisor','warehouse'], stock:['admin','supervisor'],
 mapping:['admin','supervisor'], supervisor:['admin','supervisor'], integrate:['admin','integration'],
 finance:['admin','finance'], audit:['admin'], replay:['admin','integration'],
};
