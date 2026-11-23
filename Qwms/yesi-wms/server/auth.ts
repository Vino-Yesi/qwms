import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import { createHmac, randomBytes, scryptSync, timingSafeEqual, randomInt } from 'node:crypto';
import { z } from 'zod';
import { pool, tx, one, hash, token, uid, encrypt, decrypt, fail, audit } from './db.js';
import { config, type Actor, type Role } from './config.js';
export const SESSION='yesi_session';
let oidc:Promise<client.Configuration>|undefined;
export function oidcConfig(){return oidc??=client.discovery(new URL(config.oidcIssuer),config.oidcClient,config.oidcSecret);}
export function passwordHash(password:string){const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,64).toString('hex');}
export function checkPassword(password:string,stored:string){const [salt,h]=stored.split(':');if(!salt||!h)return false;const b=scryptSync(password,salt,64);const expected=Buffer.from(h,'hex');return b.length===expected.length&&timingSafeEqual(b,expected);}
export function totp(secret:string,step=Math.floor(Date.now()/30000)){const key=decodeBase32(secret);const b=Buffer.alloc(8);b.writeUInt32BE(Math.floor(step/4294967296),0);b.writeUInt32BE(step>>>0,4);const digest=createHmac('sha1',key).update(b).digest();const o=digest[digest.length-1]&15;return String(((digest[o]&127)<<24|digest[o+1]<<16|digest[o+2]<<8|digest[o+3])%1000000).padStart(6,'0');}
export function decodeBase32(s:string){const alpha='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0;const out:number[]=[];for(const ch of s.replace(/=+$/,'').toUpperCase()){const v=alpha.indexOf(ch);if(v<0)throw new Error('Invalid base32 secret');value=(value<<5)|v;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function base32(b:Buffer){const alpha='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0,out='';for(const x of b){value=(value<<8)|x;bits+=8;while(bits>=5){out+=alpha[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alpha[(value<<(5-bits))&31];return out;}
async function session(reply:any,userId:string|null,pending:boolean,seconds=900){const t=token();const csrf=token();await pool.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at,mfa_pending) VALUES($1,$2,$3,now()+($4||' seconds')::interval,$5)",[hash(t!),userId,csrf,pending]);reply.setCookie(SESSION,t,{path:'/',httpOnly:true,secure:!config.development,sameSite:'strict',maxAge:seconds});return {csrf,mfa_required:pending,token_hash:hash(t!)};}
export async function authenticate(req:FastifyRequest):Promise<Actor>{
 const t=req.cookies[SESSION];if(!t)fail(401,'UNAUTHENTICATED','Sign in to continue');
 const r=await pool.query('SELECT u.id,u.email,u.role,s.csrf,s.mfa_pending FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active',[hash(t!)]);
 const u=r.rows[0];if(!u||u.mfa_pending)fail(401,'MFA_REQUIRED','Verification required');
 return {id:u.id,role:u.role,email:u.email,requestId:String(req.id)};
}
export async function verifyCsrf(req:FastifyRequest){const t=req.cookies[SESSION];if(!t)fail(401,'UNAUTHENTICATED','Sign in');const r=await pool.query('SELECT csrf FROM sessions WHERE token_hash=$1 AND expires_at>now()',[hash(t!)]);if(!r.rows[0]||req.headers['x-csrf-token']!==r.rows[0].csrf)fail(403,'CSRF_REJECTED','Invalid CSRF token');}
export function registerAuth(app:FastifyInstance){
 app.post('/api/v1/auth/login',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  if(config.authMode!=='local')fail(400,'OIDC_REQUIRED','Use the enterprise identity provider');
  const b=z.object({email:z.email().max(254),password:z.string().min(8).max(128)}).strict().parse(req.body);
  const r=await pool.query('SELECT * FROM users WHERE email=$1 AND active AND is_demo',[b.email.toLowerCase()]);const u=r.rows[0];
  if(!u||!u.password_hash||!checkPassword(b.password,u.password_hash))fail(401,'INVALID_CREDENTIALS','Email or password is incorrect');
  return session(reply,u.id,true);
 });
 app.post('/api/v1/auth/verify',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  await verifyCsrf(req);
  const {code}=z.object({code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body);
  const t=req.cookies[SESSION];if(!t)fail(401,'UNAUTHENTICATED','No pending session');
  return tx(async c=>{const r=await c.query('SELECT s.*,u.totp_ciphertext,u.role,u.last_totp_step FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now() AND mfa_pending FOR UPDATE OF s',[hash(t!)]);const s=r.rows[0];if(!s)fail(401,'UNAUTHENTICATED','Session expired');const secret=decrypt(s.totp_ciphertext);const now=Math.floor(Date.now()/30000);let match=false;let matchedStep=0;for(const step of [now-1,now,now+1]){const expected=Buffer.from(totp(secret,step));const actual=Buffer.from(code);if(timingSafeEqual(expected,actual)&&(!s.last_totp_step||step>Number(s.last_totp_step))){match=true;matchedStep=step;}}if(!match)fail(401,'INVALID_MFA','Invalid or previously used verification code');await c.query('UPDATE users SET last_totp_step=$2 WHERE id=$1',[s.user_id,matchedStep]);reply.setCookie(SESSION,t,{path:'/',httpOnly:true,secure:!config.development,sameSite:'strict',maxAge:1800});await c.query("UPDATE sessions SET mfa_pending=false,expires_at=now()+interval '30 minutes' WHERE token_hash=$1",[hash(t!)]);await audit(c,{id:s.user_id,role:s.role,requestId:String(req.id)},'auth.mfa_verified','session',hash(t!).slice(0,12));return {ok:true};});
 });
 // Convenience ONLY for explicitly marked local demo identities. Never available in production.
 app.get('/api/v1/auth/demo-code',async(req)=>{if(!config.development)fail(404,'NOT_FOUND','Not available');const t=req.cookies[SESSION];const r=await pool.query('SELECT u.totp_ciphertext,u.is_demo FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND mfa_pending AND expires_at>now() AND u.is_demo',[hash(t||'')]);if(!r.rows[0])fail(404,'NOT_FOUND','No demo verification pending');return {code:totp(decrypt(r.rows[0].totp_ciphertext)),expires_in:30-Math.floor(Date.now()/1000)%30};});
 app.post('/api/v1/auth/logout',async(req,reply)=>{await verifyCsrf(req);const t=req.cookies[SESSION];if(t)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash(t!)]);reply.clearCookie(SESSION,{path:'/'});return {ok:true};});
 app.get('/api/v1/auth/oidc/login',async(req,reply)=>{if(config.authMode!=='oidc')fail(404,'NOT_FOUND','OIDC is disabled');const cfg=await oidcConfig();const verifier=client.randomPKCECodeVerifier();const state=client.randomState();const nonce=client.randomNonce();await pool.query("INSERT INTO auth_requests VALUES($1,$2,$3,now()+interval '5 minutes')",[hash(state),encrypt(verifier),nonce]);const url=client.buildAuthorizationUrl(cfg,{redirect_uri:config.origin+'/api/v1/auth/oidc/callback',scope:'openid email profile',code_challenge:await client.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',state,nonce});return reply.redirect(url.href);});
 app.get('/api/v1/auth/oidc/callback',async(req,reply)=>{const cfg=await oidcConfig();const url=new URL(req.url,config.origin);const state=String(url.searchParams.get('state')||'');const r=await pool.query('DELETE FROM auth_requests WHERE state_hash=$1 AND expires_at>now() RETURNING *',[hash(state)]);if(!r.rows[0])fail(401,'OIDC_STATE','Invalid or expired identity response');const claims=await client.authorizationCodeGrant(cfg,url,{pkceCodeVerifier:decrypt(r.rows[0].verifier),expectedState:state,expectedNonce:r.rows[0].nonce});const c=claims.claims();if(!c?.email_verified||!c?.email)fail(403,'EMAIL_UNVERIFIED','Verified email required');const u=await pool.query('SELECT * FROM users WHERE email=$1 AND active AND password_hash IS NULL',[String(c!.email).toLowerCase()]);if(!u.rows[0])fail(403,'IDENTITY_NOT_PROVISIONED','Ask an administrator to provision this identity');const s=await session(reply,u.rows[0].id,false,28800);await pool.query("UPDATE sessions SET expires_at=now()+interval '8 hours' WHERE token_hash=$1",[s.token_hash]);return reply.redirect(config.origin+'/#csrf='+encodeURIComponent(s.csrf));});
}
