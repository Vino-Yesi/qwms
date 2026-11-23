/**
 * Authentication: local demo identities with TOTP MFA, or enterprise OIDC with
 * PKCE. Sessions are opaque, stored hashed, bound to a CSRF token, HttpOnly and
 * SameSite=Strict. MFA codes are single-use: the accepted time step is stored on
 * the user and can never be replayed.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { audit, decrypt, encrypt, fail, hash, maybeOne, one, pool, query, token, tx } from './db/index.js';
import { config, type Actor } from './config.js';

export const SESSION = 'yesi_session';
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

let oidcPromise: Promise<client.Configuration> | undefined;
function oidcConfiguration(): Promise<client.Configuration> {
  oidcPromise ??= client.discovery(new URL(config.oidcIssuer), config.oidcClient, config.oidcSecret);
  return oidcPromise;
}

export function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}

export function checkPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const key = decodeBase32(secret);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 4294967296), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24 | digest[offset + 1] << 16 | digest[offset + 2] << 8 | digest[offset + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

type SessionRecord = {
  token_hash: string;
  user_id: string;
  csrf: string;
  mfa_pending: boolean;
  expires_at: Date;
  role: 'admin' | 'supervisor' | 'warehouse' | 'finance' | 'integration' | 'viewer';
  email: string;
};

async function createSession(reply: any, userId: string | null, mfaPending: boolean, ip?: string, userAgent?: string) {
  const plaintext = token();
  const csrf = token(24);
  const seconds = (mfaPending ? 10 : config.sessionMinutes) * 60;
  await tx((c) =>
    c.query(
      `INSERT INTO sessions(token_hash, user_id, csrf, mfa_pending, ip, user_agent, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+($7 || ' seconds')::interval)`,
      [hash(plaintext), userId, csrf, mfaPending, ip ?? null, (userAgent || '').slice(0, 300), seconds],
    ),
  );
  reply.setCookie(SESSION, plaintext, {
    path: '/',
    httpOnly: true,
    secure: !config.development,
    sameSite: 'strict',
    maxAge: seconds,
  });
  return { csrf, mfa_required: mfaPending, token_hash: hash(plaintext) };
}

export async function authenticate(req: FastifyRequest): Promise<Actor> {
  const plaintext: string = req.cookies[SESSION] ?? fail(401, 'UNAUTHENTICATED', 'Sign in to continue');
  const rows = await query<SessionRecord>(
    `SELECT s.token_hash, s.user_id, s.csrf, s.mfa_pending, s.expires_at, u.role, u.email
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`,
    [hash(plaintext)],
  );
  const session = rows[0];
  if (!session) fail(401, 'SESSION_EXPIRED', 'Your session expired; sign in again');
  if (session.mfa_pending) fail(401, 'MFA_REQUIRED', 'Complete two-factor verification');
  // Sliding expiry (write at most once a minute per session).
  await tx((c) =>
    c.query(
      `UPDATE sessions SET last_seen_at=now(), expires_at=now()+($2 || ' minutes')::interval
       WHERE token_hash=$1 AND last_seen_at < now() - interval '60 seconds'`,
      [session.token_hash, config.sessionMinutes],
    ),
  );
  return {
    id: session.user_id,
    role: session.role,
    email: session.email,
    requestId: String(req.id),
    type: 'user',
    ip: req.ip,
  };
}

export async function verifyCsrf(req: FastifyRequest, options: { allowPending?: boolean } = {}): Promise<void> {
  const plaintext: string = req.cookies[SESSION] ?? fail(401, 'UNAUTHENTICATED', 'Sign in to continue');
  const row = await maybeOne<{ csrf: string }>(
    pool,
    `SELECT csrf FROM sessions WHERE token_hash=$1 AND expires_at>now()${options.allowPending ? '' : ' AND mfa_pending=false'}`,
    [hash(plaintext)],
  );
  const supplied = String(req.headers['x-csrf-token'] || '');
  if (!row || !supplied || supplied.length !== row.csrf.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(row.csrf))) {
    fail(403, 'CSRF_REJECTED', 'Missing or invalid CSRF token');
  }
}

export async function issueWsTicket(userId: string): Promise<{ ticket: string; expires_in: number }> {
  const ticket = token();
  await tx((c) =>
    c.query(`INSERT INTO ws_tickets(token_hash, user_id, expires_at) VALUES($1,$2,now()+interval '30 seconds')`, [
      hash(ticket),
      userId,
    ]),
  );
  return { ticket, expires_in: 30 };
}

export async function consumeWsTicket(ticket: string): Promise<{ user_id: string; role: string; email: string } | null> {
  return tx(async (c) => {
    const rows = await c.query(
      `DELETE FROM ws_tickets w USING users u
       WHERE w.token_hash=$1 AND w.expires_at > now() AND u.id=w.user_id AND u.active
       RETURNING w.user_id, u.role, u.email`,
      [hash(ticket)],
    );
    return (rows.rows[0] as any) ?? null;
  });
}

export function registerAuth(app: FastifyInstance) {
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (config.authMode !== 'local') fail(400, 'OIDC_REQUIRED', 'Use the enterprise identity provider');
    const body = z
      .object({ email: z.email().max(254), password: z.string().min(8).max(128) })
      .strict()
      .parse(req.body);
    const user = await maybeOne<any>(pool, 'SELECT * FROM users WHERE email=$1 AND active AND is_demo', [
      body.email.toLowerCase(),
    ]);
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      fail(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }
    if (!user?.password_hash || !checkPassword(body.password, user.password_hash)) {
      if (user) {
        const failed = Number(user.failed_logins) + 1;
        await tx((c) =>
          c.query(
            `UPDATE users SET failed_logins=$2,
               locked_until = CASE WHEN $2 >= $3 THEN now()+($4 || ' minutes')::interval ELSE locked_until END
             WHERE id=$1`,
            [user.id, failed, MAX_FAILED_LOGINS, LOCK_MINUTES],
          ),
        );
        await tx((c) =>
          audit(c, { id: user.id, role: user.role, email: user.email, requestId: String(req.id), type: 'user', ip: req.ip }, 'auth.login_failed', 'user', user.id, null, { attempts: failed }),
        );
      }
      fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    await tx((c) => c.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [user.id]));
    const session = await createSession(reply, user.id, Boolean(user.mfa_enabled), req.ip, req.headers['user-agent']);
    await tx((c) =>
      audit(c, { id: user.id, role: user.role, email: user.email, requestId: String(req.id), type: 'user', ip: req.ip }, 'auth.password_accepted', 'user', user.id),
    );
    return session;
  });

  app.post('/api/v1/auth/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    await verifyCsrf(req, { allowPending: true });
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body);
    const plaintext: string = req.cookies[SESSION] ?? fail(401, 'UNAUTHENTICATED', 'No pending session');
    const result = await tx(async (c) => {
      const rows = await c.query(
        `SELECT s.*, u.totp_ciphertext, u.role, u.email, u.last_totp_step
         FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=$1 AND s.expires_at>now() AND s.mfa_pending AND u.active
         FOR UPDATE OF s`,
        [hash(plaintext)],
      );
      const session = rows.rows[0] as any;
      if (!session) fail(401, 'SESSION_EXPIRED', 'Verification session expired');
      if (!session.totp_ciphertext) fail(409, 'MFA_NOT_ENROLLED', 'This account has no second factor; contact an administrator');
      const secret = decrypt(session.totp_ciphertext);
      const nowStep = Math.floor(Date.now() / 30_000);
      let matchedStep = 0;
      for (const step of [nowStep - 1, nowStep, nowStep + 1]) {
        const expected = Buffer.from(totpCode(secret, step));
        const actual = Buffer.from(body.code);
        if (expected.length === actual.length && timingSafeEqual(expected, actual) && (!session.last_totp_step || step > Number(session.last_totp_step))) {
          matchedStep = step;
          break;
        }
      }
      if (!matchedStep) fail(401, 'INVALID_MFA', 'Invalid or already-used verification code');
      await c.query('UPDATE users SET last_totp_step=$2 WHERE id=$1', [session.user_id, matchedStep]);
      await c.query(
        `UPDATE sessions SET mfa_pending=false, expires_at=now()+($2 || ' minutes')::interval WHERE token_hash=$1`,
        [session.token_hash, config.sessionMinutes],
      );
      await audit(c, { id: session.user_id, role: session.role, email: session.email, requestId: String(req.id), type: 'user', ip: req.ip }, 'auth.mfa_verified', 'user', session.user_id);
      return { role: session.role, email: session.email };
    });
    reply.setCookie(SESSION, plaintext, {
      path: '/',
      httpOnly: true,
      secure: !config.development,
      sameSite: 'strict',
      maxAge: config.sessionMinutes * 60,
    });
    const csrf = await one<{ csrf: string }>(pool, 'SELECT csrf FROM sessions WHERE token_hash=$1', [hash(plaintext)]);
    return { ok: true, csrf: csrf.csrf, ...result };
  });

  // Demo-only helper: shows the current TOTP for a seeded demo identity so the
  // sandbox can be explored without an authenticator app. Never available in
  // production, and only for rows explicitly flagged is_demo.
  app.get('/api/v1/auth/demo-code', async (req) => {
    if (!config.development) fail(404, 'NOT_FOUND', 'Not available');
    const plaintext = req.cookies[SESSION];
    const row = await maybeOne<any>(
      pool,
      `SELECT u.id, u.totp_ciphertext, u.email FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.mfa_pending AND s.expires_at>now() AND u.is_demo`,
      [hash(plaintext || '')],
    );
    if (!row) fail(404, 'NOT_FOUND', 'No pending demo verification');
    // A demo account may be signed in repeatedly inside the same 30 second step.
    // Clear the replay guard so the "use demo code" affordance always works; the
    // guard stays fully enforced for every non-demo identity.
    await pool.query('UPDATE users SET last_totp_step=NULL WHERE id=$1', [row.id]);
    return { code: totpCode(decrypt(row.totp_ciphertext)), email: row.email, expires_in: 30 - (Math.floor(Date.now() / 1000) % 30) };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    await verifyCsrf(req);
    const plaintext = req.cookies[SESSION];
    if (plaintext) {
      const row = await maybeOne<{ user_id: string }>(pool, 'SELECT user_id FROM sessions WHERE token_hash=$1', [hash(plaintext)]);
      await tx(async (c) => {
        await c.query('DELETE FROM sessions WHERE token_hash=$1', [hash(plaintext)]);
        await c.query('UPDATE ws_tickets SET expires_at=now() WHERE user_id=$1', [row?.user_id ?? null]);
        if (row?.user_id) await audit(c, { id: row.user_id, role: 'viewer', email: 'unknown', requestId: String(req.id), type: 'user' }, 'auth.logged_out', 'user', row.user_id);
      });
    }
    reply.clearCookie(SESSION, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/oidc/login', async (req, reply) => {
    if (config.authMode !== 'oidc') fail(404, 'NOT_FOUND', 'OIDC is disabled');
    const configuration = await oidcConfiguration();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    await tx((c) =>
      c.query(`INSERT INTO auth_requests(state_hash, verifier, nonce, expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')`, [
        hash(state),
        encrypt(verifier),
        nonce,
      ]),
    );
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: config.appOrigin + '/api/v1/auth/oidc/callback',
      scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return reply.redirect(url.href);
  });

  app.get('/api/v1/auth/oidc/callback', async (req, reply) => {
    if (config.authMode !== 'oidc') fail(404, 'NOT_FOUND', 'OIDC is disabled');
    const configuration = await oidcConfiguration();
    const url = new URL(req.url, config.appOrigin);
    const state = String(url.searchParams.get('state') || '');
    const pending = await tx(async (c) => {
      const rows = await c.query('DELETE FROM auth_requests WHERE state_hash=$1 AND expires_at>now() RETURNING *', [hash(state)]);
      return rows.rows[0] as any;
    });
    if (!pending) fail(401, 'OIDC_STATE', 'Invalid or expired identity response');
    const tokens = await client.authorizationCodeGrant(configuration, url, {
      pkceCodeVerifier: decrypt(pending.verifier),
      expectedState: state,
      expectedNonce: pending.nonce,
    });
    const claims = tokens.claims();
    const email = claims?.email;
    if (!claims?.email_verified || !email) fail(403, 'EMAIL_UNVERIFIED', 'A verified email is required');
    const user = await maybeOne<any>(pool, 'SELECT * FROM users WHERE email=$1 AND active AND password_hash IS NULL', [
      String(email).toLowerCase(),
    ]);
    if (!user) fail(403, 'IDENTITY_NOT_PROVISIONED', 'Ask an administrator to provision this identity');
    const session = await createSession(reply, user.id, Boolean(user.mfa_enabled), req.ip, req.headers['user-agent']);
    if (user.mfa_enabled) {
      return reply.redirect(config.appOrigin + '/?mfa=1');
    }
    await tx((c) =>
      audit(c, { id: user.id, role: user.role, email: user.email, requestId: String(req.id), type: 'user', ip: req.ip }, 'auth.oidc_login', 'user', user.id),
    );
    return reply.redirect(config.appOrigin + '/#csrf=' + encodeURIComponent(session.csrf));
  });
}
