import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { orderSchema, type CanonicalOrder } from './domain.js';
import { fail } from './db.js';
export const marketplaceDocs={ozon:'https://docs.ozon.ru/api/seller/en/',yandex:'https://yandex.ru/dev/market/partner-api/doc/en/reference/orders/getBusinessOrders',wildberries:'https://dev.wildberries.ru/en/docs/openapi/orders-fbs'};
export const credentialsSchema=z.object({apiKey:z.string().min(8),clientId:z.string().optional(),businessId:z.string().optional(),warehouseId:z.string().optional()}).strict();
export type Credentials=z.infer<typeof credentialsSchema>;
export function signedHeaders(secret:string,body:string,key:string){return {'Content-Type':'application/json','Idempotency-Key':key,'X-YESI-Signature':'sha256='+createHmac('sha256',secret).update(body).digest('hex')};}
export async function postJSON(url:string,body:unknown,headers:Record<string,string>={}){
 const u=new URL(url);if(u.protocol!=='https:'&&!config.development)fail(503,'HTTPS_REQUIRED','HTTPS required');if(u.username||u.password)fail(503,'UNSAFE_ENDPOINT','Credentials in URL are forbidden');
 const response=await fetch(url,{method:'POST',body:JSON.stringify(body),headers,redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok){const e=new Error(`Upstream HTTP ${response.status}`);(e as any).retryAfter=response.headers.get('retry-after');throw e;}
 return response.json();
}
export function marketplaceRequest(provider:string,c:Credentials,since:Date,pageToken?:string){
 const headers:Record<string,string>={'Content-Type':'application/json',Accept:'application/json'};let url:string;let body:unknown;
 if(provider==='ozon'){url='https://api-seller.ozon.ru/v3/posting/fbs/list';headers['Client-Id']=c.clientId||'';headers['Api-Key']=c.apiKey;body={dir:'ASC',filter:{since:since.toISOString(),to:new Date().toISOString(),status:'awaiting_packaging'},limit:100,offset:pageToken?Number(pageToken):0,with:{analytics_data:false,financial_data:false}};}
 else if(provider==='yandex'){if(!c.businessId)fail(400,'BUSINESS_ID_REQUIRED','Yandex businessId required');url='https://api.partner.market.yandex.ru/v1/businesses/'+encodeURIComponent(c.businessId!)+ '/orders'+(pageToken?'?pageToken='+encodeURIComponent(pageToken):'');headers.Authorization='Bearer '+c.apiKey;body={fake:false,dates:{updateDateFrom:since.toISOString(),updateDateTo:new Date().toISOString()},limit:50};}
 else if(provider==='wildberries'){url='https://marketplace-api.wildberries.ru/api/v3/orders'+(pageToken?'?limit=100&next='+encodeURIComponent(pageToken):'?limit=100&next=0');headers.Authorization=c.apiKey;body=undefined;}
 else throw new Error('Unknown marketplace');
 return {url,headers,body,method:provider==='wildberries'?'GET':'POST'};
}
function money(v:unknown){const n=Number(v);if(!Number.isFinite(n)||n<0||Math.abs(n*100-Math.round(n*100))>1e-6)throw new Error('Invalid source money');return Math.round(n*100);}
// Native response contracts are deliberately strict. Unknown/changed fields fail into the DLQ,
// never become fabricated orders. Live polling is disabled until account-level certification.
export function normalizeNativeOrder(provider:string,raw:any,connectionId:string):CanonicalOrder {
 let b:any;
 if(provider==='ozon') {const lines=raw.products.map((l:any)=>({external_sku:l.offer_id,quantity:l.quantity,unit_price_minor:money(l.price)}));b={event_id:'ozon:'+raw.posting_number+':'+raw.in_process_at,external_id:raw.posting_number,customer_ref:'OZON-'+raw.posting_number,currency:'RUB',total_minor:lines.reduce((s:number,l:any)=>s+l.quantity*l.unit_price_minor,0),ship_by:raw.shipment_date,lines};}
 else if(provider==='yandex'){const lines=raw.items.map((l:any)=>({external_sku:l.offerId.trim(),quantity:l.count,unit_price_minor:money(l.prices.payment.value/l.count)}));b={event_id:'yandex:'+raw.id+':'+raw.updatedAt,external_id:String(raw.id),customer_ref:'YANDEX-'+raw.id,currency:'RUB',total_minor:lines.reduce((s:number,l:any)=>s+l.quantity*l.unit_price_minor,0),ship_by:raw.delivery.shipment.shipmentDate+'T23:59:59+03:00',lines};}
 else if(provider==='wildberries'){const lines=[{external_sku:raw.chrtId.toString(),quantity:1,unit_price_minor:raw.convertedPrice??raw.price}];b={event_id:'wb:'+raw.id+':'+raw.createdAt,external_id:String(raw.id),customer_ref:'WB-'+raw.id,currency:'RUB',total_minor:lines[0].unit_price_minor,ship_by:raw.ddate+'T23:59:59+03:00',lines};}
 else throw new Error('Unknown provider');
 return orderSchema.parse(b);
}
export async function bookTransport(shipment:{id:string;order_id:string;external_id:string;carrier:string}){
 if(!config.tmsEndpoint)return {mode:'sandbox',external_id:'SIM-TMS-'+shipment.id,tracking_number:'SIM-TRK-'+shipment.id.slice(0,12).toUpperCase(),status:'BOOKED'};
 const body={shipment_id:shipment.id,order_reference:shipment.external_id,carrier:shipment.carrier};const r:any=await postJSON(config.tmsEndpoint,body,signedHeaders(config.tmsSecret,JSON.stringify(body),'book:'+shipment.id));const parsed=z.object({external_id:z.string(),tracking_number:z.string(),status:z.literal('BOOKED')}).parse(r);return {...parsed,mode:'live'};
}
export async function postERP(entry:unknown,key:string){if(!config.erpEndpoint)return {mode:'sandbox',acknowledgement:'SIM-ERP-'+key};const body=JSON.stringify(entry);const r:any=await postJSON(config.erpEndpoint,JSON.parse(body),signedHeaders(config.erpSecret,body,key));return {mode:'live',acknowledgement:z.object({acknowledgement:z.string()}).parse(r).acknowledgement};}
