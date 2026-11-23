import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api';
import type { User } from '../types';

export function LoginPage({ onLogin }: { onLogin: (token: string, user: User) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { username, password } });
      await onLogin(r.token, r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <div className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" /></svg>
          </div>
          <div>
            <div className="brand-title">LECO</div>
            <div className="brand-sub">Customer Service Performance Standards</div>
          </div>
        </div>
        <label>
          Username
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div className="error-box">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
