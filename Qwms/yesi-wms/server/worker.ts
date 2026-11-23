import { pool, tx, uid, audit, exception, emit, one } from './db.js';
import { bookTransport, postERP } from './connectors.js';
import { config } from './config.js';
import { metrics } from './metrics.js';
const system={id:'00000000-0000-0000-0000-000000000001',role:'integration',requestId:'outbox-worker'};
export async function handle(event:any){const p=event.payload;
 if(event.topic==='shipment.book'){
  const s=await one(pool,'SELECT s.*,o.external_id FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.id=$1',[p.shipment_id]);if(s.status!=='CREATED')return;
  const r=await bookTransport({...s,external_id:s.external_id});
  await tx(async c=>{const current=await one(c,'SELECT * FROM shipments WHERE id=$1 FOR UPDATE',[s.id]);if(current.status!=='CREATED')return;await c.query("UPDATE shipments SET status='BOOKED',external_id=$2,tracking_number=$3,version=version+1,updated_at=now() WHERE id=$1",[s.id,r.external_id,r.tracking_number]);await audit(c,{...system,requestId:event.id},'shipment.booked','shipment',s.id,current,{...r,order_id:s.order_id});await emit(c,'shipment.updated',{shipment_id:s.id,status:'BOOKED',mode:r.mode});});
 } else if(event.topic==='erp.post'){
  const entries=(await pool.query('SELECT * FROM journal_entries WHERE order_id=$1 ORDER BY kind',[p.order_id])).rows;
  if(!entries.length||!entries.some((e:any)=>e.kind==='SALE'))throw new Error('Missing revenue journal');
  for(const e of entries){const r=await postERP({journal_id:e.id,order_id:e.order_id,kind:e.kind,currency:e.currency,amount_minor:Number(e.amount_minor),debit_account:e.debit_account,credit_account:e.credit_account},'journal:'+e.id);await tx(async c=>{await audit(c,{...system,requestId:event.id},'erp.acknowledged','journal',e.id,null,r);});}
 } else if(event.topic==='inventory.changed'){
  const skus=Array.isArray(p.sku)?p.sku:p.sku?[p.sku]:(await pool.query('SELECT sku FROM products')).rows.map((r:any)=>r.sku);
  for(const sku of skus){const r=await pool.query('SELECT coalesce(sum(on_hand-reserved),0)::int AS available FROM inventory WHERE sku=$1',[sku]);await tx(async c=>{await audit(c,{...system,requestId:event.id},'inventory.sync_requested','inventory',sku,null,{available:r.rows[0].available,mode:'sandbox',network_call:false});await emit(c,'marketplace.stock',{sku,available:r.rows[0].available});});}
 } else if(event.topic==='marketplace.stock'||event.topic==='marketplace.status'){
  await tx(async c=>{await audit(c,{...system,requestId:event.id},'marketplace.status_pending','order',p.order_id,null,{status:p.status,mode:'sandbox',network_call:false});});
 }
}
export async function processOnce(){
 const e=await tx(async c=>{const r=await c.query("UPDATE outbox SET status='PROCESSING',locked_at=now(),attempts=attempts+1 WHERE seq=(SELECT seq FROM outbox WHERE (status='PENDING' AND next_attempt_at<=now()) OR (status='PROCESSING' AND locked_at<now()-interval '2 minutes') ORDER BY seq FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *");return r.rows[0];});if(!e)return false;
 try{await handle(e);await pool.query("UPDATE outbox SET status='DONE',processed_at=now(),last_error=NULL WHERE seq=$1",[e.seq]);metrics.processed.inc({topic:e.topic});}
 catch(error){const message=error instanceof Error?error.message:String(error);await tx(async c=>{const dead=e.attempts>=8;await c.query("UPDATE outbox SET status=$2,next_attempt_at=now()+($3||' seconds')::interval,last_error=$4,locked_at=NULL WHERE seq=$1",[e.seq,dead?'DEAD':'PENDING',Math.min(3600,2**e.attempts),message]);await audit(c,{...system,requestId:e.id},dead?'outbox.dead':'outbox.retry','event',e.id,null,{attempts:e.attempts,error:message});if(dead){await exception(c,'CONNECTOR_FAILURE',e.id,message,{topic:e.topic,sequence:e.seq});await emit(c,'exception.created',{kind:'CONNECTOR_FAILURE',entity_id:e.id});}});metrics.failed.inc({topic:e.topic});console.error(JSON.stringify({level:'error',event_id:e.id,topic:e.topic,attempt:e.attempts,message}));}
 return true;
}
export async function runWorker(signal:AbortSignal){while(!signal.aborted){try{if(await processOnce())continue;}catch(e){console.error(JSON.stringify({level:'error',component:'worker',message:e instanceof Error?e.message:String(e)}));}await new Promise(r=>setTimeout(r,500));}}
if(process.argv[1]?.endsWith('worker.ts')){const ac=new AbortController();process.on('SIGTERM',()=>ac.abort());process.on('SIGINT',()=>ac.abort());runWorker(ac.signal).finally(()=>pool.end());}
