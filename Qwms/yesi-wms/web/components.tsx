import React, { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { statusLabel } from './api';
const paths:Record<string,string>={
 grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 orders:'M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4 M9 3v4h6V3z M8 12h8 M8 16h5',
 box:'M21 8l-9-5-9 5v10l9 5 9-5z M3 8l9 5 9-5 M12 13v10 M7.5 5.5l9 5',
 link:'M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2',
 alert:'M12 3L2 21h20z M12 9v5 M12 17h.01',
 shield:'M12 3l8 4v6c0 5-8 9-8 9s-8-4-8-9V7z M8 12l3 3 5-6',
 truck:'M1 4h14v13H1z M15 9h4l3 4v4h-7 M5.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5 M18.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
 wave:'M13 2L3 14h9l-1 8 10-12h-9z',
 receive:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
 chart:'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
 finance:'M3 7h18v14H3z M3 7l3-4h12l3 4 M8 12h8 M8 16h5',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
 search:'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M17 17l5 5',
 bell:'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M10 21h4',
 sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
 arrow:'M5 12h14 M13 6l6 6-6 6',
 check:'M5 12l4 4L19 6',
 close:'M6 6l12 12 M6 18L18 6',
 refresh:'M20 7a9 9 0 1 0 1 8 M20 3v5h-5',
 download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
 menu:'M3 6h18 M3 12h18 M3 18h18',
 logout:'M9 3H3v18h6 M9 12h12 M16 7l5 5-5 5',
 clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
 lock:'M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4',
};
export function Icon({name,size=16,...props}:{name:string;size?:number;[k:string]:any}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]||paths.box}/></svg>}
export function Badge({children,tone=''}:{children:React.ReactNode;tone?:string}){return <span className={'badge '+tone}>{children}</span>}
export function Status({value}:{value:string}){const tone:Record<string,string>={RECEIVED:'',EXCEPTION:'red',MAPPED:'blue',RESERVED:'purple',PICKING:'amber',PACKED:'amber',READY_TO_SHIP:'green',SHIPPED:'green',DELIVERED:'green',CANCELLED:'',OPEN:'amber',DEAD:'red',PENDING:'amber',PROCESSING:'blue',DONE:'green',BOOKED:'blue',DISPATCHED:'green',CREATED:'',EXPECTED:'blue',RELEASED:'blue',COMPLETE:'green'};return <Badge tone={tone[value]||''}><span className="dot"/>{statusLabel(value)}</Badge>}
export function ProviderLogo({provider}:{provider:string}){const style:Record<string,any>={ozon:{background:'#1745b6',color:'#fff',letter:'O'},yandex:{background:'#f5c443',color:'#20200b',letter:'Я'},wildberries:{background:'#752995',color:'#fff',letter:'W'}};const s=style[provider]||{background:'#26342b',letter:'?'};return <span className="channel-logo" style={{background:s.background,color:s.color}}>{s.letter}</span>}
export function Panel({title,action,children,className=''}:{title?:React.ReactNode;action?:React.ReactNode;children:React.ReactNode;className?:string}){return <section className={'panel '+className}>{title&&<div className="panel-head"><h3>{title}</h3>{action}</div>}{children}</section>}
export function Empty({text='No records yet'}:{text?:string}){return <div className="empty"><Icon name="box" size={26}/><p style={{marginTop:12}}>{text}</p></div>}
export function Modal({title,children,onClose}:{title:string;children:React.ReactNode;onClose:()=>void}){const ref=useRef<HTMLDivElement>(null);useEffect(()=>{const prev=document.activeElement as HTMLElement;const el=ref.current;el?.querySelector<HTMLElement>('input,button,select')?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();if(e.key==='Tab'&&el){const nodes=Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,a[href]'));const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);prev?.focus();};},[onClose]);return <div className="overlay modal-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}><div className="between"><h2>{title}</h2><button className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></div>{children}</div></div>}
export function VirtualTable({rows,columns,render,height=440,onRow}:{rows:any[];columns:string[];render:(r:any,i:number)=>React.ReactNode;height?:number;onRow?:(r:any)=>void}){const ref=useRef<HTMLDivElement>(null);const virtual=useVirtualizer({count:rows.length,getScrollElement:()=>ref.current,estimateSize:()=>51,overscan:8});if(!rows.length)return <Empty text="No records match your filters"/>;return <div className="table-wrap" ref={ref} style={{maxHeight:height}}><table className="data-table" style={{height:virtual.getTotalSize(),position:'relative'}}><thead><tr>{columns.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{virtual.getVirtualItems().map(v=><tr key={rows[v.index].id||rows[v.index].sku+'-'+rows[v.index].location||v.index} style={{position:'absolute',top:v.start,left:0,width:'100%',height:51,display:'table',tableLayout:'fixed'}} onClick={()=>onRow?.(rows[v.index])}>{render(rows[v.index],v.index)}</tr>)}</tbody></table></div>}
export function Throughput({orders}:{orders:any[]}){const now=new Date();const buckets=Array.from({length:12},(_,i)=>{const d=new Date(now.getTime()-(11-i)*3600000);return {hour:d.getHours(),ingested:orders.filter(o=>new Date(o.created_at).getHours()===d.getHours()).length,shipped:orders.filter(o=>o.status==='SHIPPED'&&new Date(o.updated_at).getHours()===d.getHours()).length};});const max=Math.max(4,...buckets.map(b=>Math.max(b.ingested,b.shipped)));const points=(key:'ingested'|'shipped')=>buckets.map((b,i)=>`${35+i*53},${165-b[key]/max*125}`).join(' ');return <svg viewBox="0 0 660 200" width="100%" height="100%" role="img" aria-label="Orders ingested and shipped by hour, last twelve hours"><defs><linearGradient id="chartfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b4ed73" stopOpacity=".15"/><stop offset="100%" stopColor="#b4ed73" stopOpacity="0"/></linearGradient></defs>{[40,82,124,165].map((y,i)=><g key={y}><line x1="35" x2="630" y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 5"/><text x="2" y={y+4} fill="var(--faint)" fontSize="9">{Math.round(max*(1-i/3))}</text></g>)}<polygon points={`35,165 ${points('ingested')} 618,165`} fill="url(#chartfill)"/><polyline points={points('ingested')} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round"/><polyline points={points('shipped')} fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinejoin="round" strokeDasharray="4 3"/>{buckets.map((b,i)=>i%2===0?<text key={i} x={35+i*53} y="190" textAnchor="middle" fill="var(--faint)" fontSize="9">{String(b.hour).padStart(2,'0')}:00</text>:null)}</svg>}
