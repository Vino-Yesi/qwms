import { useEffect, useRef, useState } from 'react';
import { ApiError, api, setCsrf } from './api';
import { Icon } from './components';

const DEMO_USERS = [
  { email: 'admin@yesi.local', role: 'Admin', detail: 'Everything, including replay' },
  { email: 'supervisor@yesi.local', role: 'Supervisor', detail: 'Fulfilment, counts, exceptions' },
  { email: 'warehouse@yesi.local', role: 'Warehouse', detail: 'Pick, pack, receive' },
  { email: 'finance@yesi.local', role: 'Finance', detail: 'Journals, ERP, reconciliation' },
  { email: 'integration@yesi.local', role: 'Integration', detail: 'Connectors, mappings, TMS' },
  { email: 'viewer@yesi.local', role: 'Viewer', detail: 'Read-only control tower' },
];

const PASSWORD = 'Yesi!Demo2026';

export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [step, setStep] = useState<'credentials' | 'code'>('credentials');
  const [email, setEmail] = useState('admin@yesi.local');
  const [password, setPassword] = useState(PASSWORD);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(30);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setSecondsLeft(30 - (Math.floor(Date.now() / 1000) % 30)), 1000);
    return () => clearInterval(timer);
  }, []);

  async function submitCredentials(event?: React.FormEvent) {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api<any>('/auth/login', { method: 'POST', body: { email: email.trim(), password } });
      setCsrf(result.csrf);
      if (result.mfa_required) {
        setStep('code');
        setTimeout(() => codeRef.current?.focus(), 30);
      } else {
        onAuthenticated();
      }
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event?: React.FormEvent) {
    event?.preventDefault();
    if (code.trim().length !== 6) {
      setError('Enter the six digit code from your authenticator.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api<any>('/auth/verify', { method: 'POST', body: { code: code.trim() } });
      setCsrf(result.csrf);
      onAuthenticated();
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Verification failed');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  async function useDemoCode() {
    setDemoBusy(true);
    setError(null);
    try {
      const result = await api<{ code: string; expires_in: number }>('/auth/demo-code');
      setCode(result.code);
      setSecondsLeft(result.expires_in);
      setTimeout(() => codeRef.current?.focus(), 20);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : 'Demo code unavailable');
    } finally {
      setDemoBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <section className="login-art">
        <div className="login-art-brand">
          <span className="brand-mark"><Icon name="layers" size={19} /></span>
          <div>
            <div className="brand-name">YESI<span className="accent">.</span>OS</div>
            <div className="brand-sub">FULFILLMENT PLATFORM</div>
          </div>
        </div>

        <div>
          <div className="eyebrow">Ozon · Yandex Market · Wildberries</div>
          <h1 className="login-headline">
            One fulfillment brain for every <em>marketplace</em>.
          </h1>
          <p className="login-copy">
            Orders, stock, waves, carriers and money move through a single auditable state machine — with
            signed ingestion, idempotent commands and an exception queue you can actually trust.
          </p>
          <div className="login-points">
            {[
              'Signature-verified order ingestion',
              'Ledger-backed inventory reservations',
              'Hash-chained audit trail',
              'Durable outbox with dead-letter replay',
              'Real-time control tower over WebSocket',
              'ERP postings with idempotency keys',
            ].map((point) => (
              <div className="login-point" key={point}>
                <Icon name="check" size={13} />
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="row tiny faint" style={{ gap: 18 }}>
          <span>Sandbox environment</span>
          <span>·</span>
          <span>PostgreSQL 18</span>
          <span>·</span>
          <span>Sequence-ordered events</span>
        </div>
      </section>

      <section className="login-form-side">
        <div className="login-card">
          {step === 'credentials' ? (
            <>
              <h1>Sign in</h1>
              <p>Operator console · two-factor authentication required.</p>
              <form className="form-stack" onSubmit={submitCredentials}>
                <label className="field">
                  <span className="field-label">Work email</span>
                  <input
                    className="input"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@yesi.local"
                    required
                  />
                </label>
                <label className="field">
                  <span className="field-label">Password</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </label>
                {error && <div className="danger-box" role="alert">{error}</div>}
                <button className="btn primary" type="submit" disabled={busy} style={{ height: 40 }}>
                  {busy ? 'Checking credentials…' : 'Continue'}
                  {!busy && <Icon name="arrow" size={15} />}
                </button>
              </form>

              <div className="section-title" style={{ marginTop: 22 }}>Demo identities</div>
              <div className="demo-users">
                {DEMO_USERS.map((user) => (
                  <button
                    type="button"
                    key={user.email}
                    className="demo-user"
                    onClick={() => {
                      setEmail(user.email);
                      setPassword(PASSWORD);
                      setError(null);
                    }}
                  >
                    <b>{user.role}</b>
                    {user.detail}
                  </button>
                ))}
              </div>
              <p className="tiny faint" style={{ marginTop: 12 }}>
                Password <span className="mono">{PASSWORD}</span> · the code is generated server-side for demo accounts.
              </p>
            </>
          ) : (
            <>
              <button type="button" className="btn ghost sm" style={{ paddingLeft: 0, marginBottom: 12 }} onClick={() => { setStep('credentials'); setCode(''); setError(null); }}>
                <Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} /> Back
              </button>
              <h1>Two-factor code</h1>
              <p>
                Enter the 6-digit code for <span className="mono">{email}</span>. It refreshes every 30 seconds.
              </p>
              <form className="form-stack" onSubmit={submitCode}>
                <div className="otp-row">
                  <input
                    ref={codeRef}
                    className="input otp-input grow"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    aria-label="Six digit authentication code"
                    placeholder="000000"
                  />
                  <button type="button" className="btn" onClick={useDemoCode} disabled={demoBusy} style={{ height: 48 }}>
                    {demoBusy ? 'Fetching…' : 'Use demo code'}
                  </button>
                </div>
                <div className="between tiny faint">
                  <span>Code rotates in {secondsLeft}s</span>
                  <span className="mono">TOTP · SHA-1 · 6 digits</span>
                </div>
                {error && <div className="danger-box" role="alert">{error}</div>}
                <button className="btn primary" type="submit" disabled={busy || code.length !== 6} style={{ height: 40 }}>
                  {busy ? 'Verifying…' : 'Verify and enter'}
                </button>
              </form>
              <div className="hint-box" style={{ marginTop: 16 }}>
                Sessions are HttpOnly, SameSite=Strict and expire after 30 minutes of inactivity. Every mutation also requires a CSRF token.
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
