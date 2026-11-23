import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
export const registry=new Registry();collectDefaultMetrics({register:registry});
export const metrics={
 requests:new Counter({name:'yesi_http_requests_total',help:'HTTP requests',labelNames:['method','route','status'],registers:[registry]}),
 duration:new Histogram({name:'yesi_http_duration_seconds',help:'HTTP duration',labelNames:['method','route'],buckets:[.01,.05,.1,.25,.5,1,2,5],registers:[registry]}),
 processed:new Counter({name:'yesi_outbox_processed_total',help:'Successfully processed events',labelNames:['topic'],registers:[registry]}),
 failed:new Counter({name:'yesi_outbox_failures_total',help:'Failed event attempts',labelNames:['topic'],registers:[registry]}),
 backlog:new Gauge({name:'yesi_outbox_backlog',help:'Unfinished durable events',labelNames:['status'],registers:[registry]}),
 connections:new Gauge({name:'yesi_websocket_connections',help:'Authenticated realtime clients',registers:[registry]}),
};
