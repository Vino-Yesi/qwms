import pg from 'pg';
import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { config } from './config.js';
export const pool=new pg.Pool({connectionString:config.databaseUrl,max:20,statement_timeout:10000});
export type Client=pg.PoolClient;
export const uid=()=>randomUUID();
export const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export const hashJson=(value:unknown):string=>hash(canonicalJson(value));
export function canonicalJson(value:any):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';}
export const token=()=>randomBytes(32).toString('base64url');
export class DomainError extends Error { constructor(public status:number,public code:string,message:string){super(message);} }
export const fail=(status:number,code:string,message:string):never=>{throw new DomainError(status,code,message);};
export async function tx<T>(fn:(c:Client)=>Promise<T>):Promise<T> { const c=await pool.connect(); try {await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();} }
export async function one<T=any>(c:{query:any},sql:string,params:any[]=[]):Promise<T>{const r=await c.query(sql,params);if(!r.rows[0])fail(404,'NOT_FOUND','Record not found');return r.rows[0] as T;}
export function encrypt(s:string){const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',config.key,iv);const data=Buffer.concat([c.update(s,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');}
export function decrypt(s:string){const b=Buffer.from(s,'base64');const d=createDecipheriv('aes-256-gcm',config.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
export async function audit(c:Client,a:{id:string;role:string;requestId:string},action:string,type:string,id:string,before:unknown=null,after:unknown=null){
 await c.query('SELECT pg_advisory_xact_lock(742001)');
 const prev=await c.query('SELECT entry_hash FROM audit_logs ORDER BY seq DESC LIMIT 1');
 const previous_hash=prev.rows[0]?.entry_hash||'genesis';
 const created_at=new Date().toISOString();
 const data={actor_id:a.id,action,entity_type:type,entity_id:id,before_data:before,after_data:after,request_id:a.requestId,previous_hash,created_at};
 const entry_hash=hashJson(data);
 await c.query('INSERT INTO audit_logs(id,actor_id,action,entity_type,entity_id,before_data,after_data,request_id,previous_hash,entry_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[uid(),a.id,action,type,id,before===null?null:JSON.stringify(before),after===null?null:JSON.stringify(after),a.requestId,previous_hash,entry_hash,created_at]);
}
export async function emit(c:Client,topic:string,payload:Record<string,unknown>){const id=uid();await c.query('INSERT INTO outbox(id,topic,payload) VALUES($1,$2,$3)',[id,topic,JSON.stringify({...payload,event_id:id})]);return id;}
export async function exception(c:Client,kind:string,entity:string,message:string,details:unknown={}){await c.query('INSERT INTO exceptions(id,kind,entity_id,message,details) VALUES($1,$2,$3,$4,$5)',[uid(),kind,entity,message,JSON.stringify(details)]);}
export async function stockMove(c:Client,a:{id:string},sku:string,location:string,oh:number,res:number,reason:string,key:string){
 const r=await c.query('UPDATE inventory SET on_hand=on_hand+$3,reserved=reserved+$4,version=version+1 WHERE sku=$1 AND location=$2 AND on_hand+$3>=0 AND reserved+$4>=0 AND reserved+$4<=on_hand+$3 RETURNING *',[sku,location,oh,res]);
 if(!r.rowCount)fail(409,'STOCK_CONSTRAINT','Insufficient stock or unknown inventory position');
 await c.query('INSERT INTO stock_ledger(sku,location,delta_on_hand,delta_reserved,reason,reference,actor_id,request_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[sku,location,oh,res,reason,key,a.id,reason+':'+key]);
 return r.rows[0];
}
export async function verifyAudit(){let prev='genesis';let count=0;let after=0;while(true){const r=await pool.query('SELECT * FROM audit_logs WHERE seq>$1 ORDER BY seq LIMIT 500',[after]);if(!r.rowCount)break;for(const row of r.rows){const data={actor_id:row.actor_id,action:row.action,entity_type:row.entity_type,entity_id:row.entity_id,before_data:row.before_data,after_data:row.after_data,request_id:row.request_id,previous_hash:row.previous_hash,created_at:new Date(row.created_at).toISOString()};if(row.previous_hash!==prev||hashJson(data)!==row.entry_hash)return {valid:false,sequence:row.seq,count};prev=row.entry_hash;count++;after=Number(row.seq);}if(r.rowCount<500)break;}return {valid:true,count};}
