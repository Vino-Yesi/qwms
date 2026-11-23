export type Actor={id:string;email:string;role:string;csrf:string;expires_at:string};
export type Snapshot={sequence:number;orders:any[];inventory:any[];connections:any[];waves:any[];shipments:any[];exceptions:any[];mappings:any[];asns:any[];server_time:string};
let csrf='';
export function setCsrf(value:string){csrf=value;}
export async function api<T=any>(path:string,body?:unknown,method?:string):Promise<T>{
 const headers:Record<string,string>={};if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=crypto.randomUUID();headers['X-CSRF-Token']=csrf;}
 const response=await fetch('/api/v1'+path,{method:method||(body!==undefined?'POST':'GET'),credentials:'include',headers,body:body!==undefined?JSON.stringify(body):undefined});
 const data=await response.json();if(!response.ok){const e=new Error(typeof data.error?.message==='string'?data.error.message:JSON.stringify(data.error?.message||'Request failed'));(e as any).status=response.status;(e as any).code=data.error?.code;throw e;}return data;
}
export const money=(v:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(Number(v)/100);
export const num=(v:number)=>Number(v).toLocaleString('en-US');
export const time=(v:string)=>new Date(v).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
export const providerName=(p:string)=>({ozon:'Ozon',yandex:'Yandex Market',wildberries:'Wildberries'}[p]||p);
export const statusLabel=(s:string)=>s.replaceAll('_',' ').toLowerCase().replace(/^./,c=>c.toUpperCase());
