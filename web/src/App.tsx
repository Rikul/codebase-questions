import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { api, authEvents, post } from './lib/api';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Repo } from './pages/Repo';

function useTheme() {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system'))] as const;
}

function InviteButton() {
  const [code, setCode] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn sm ghost"
        title="Create a one-time code to sign in on another device"
        onClick={async () => setCode((await post<{ code: string }>('/auth/rotate')).code)}
      >
        Add device
      </button>
      {code && (
        <div className="modal-back" onClick={() => setCode(null)}>
          <div className="card login" onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
            <h3>One-time access code</h3>
            <p className="muted small">Enter it on the other device. It works once and replaces any unused code.</p>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 24, letterSpacing: 2, margin: '14px 0' }}>{code}</div>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(code)}>Copy</button> <button className="btn primary" onClick={() => setCode(null)}>Done</button>
          </div>
        </div>
      )}
    </>
  );
}

function Shell({ onLogout, authDisabled }: { onLogout: () => void; authDisabled: boolean }) {
  const [theme, cycle] = useTheme();
  const loc = useLocation();
  const isRepo = loc.pathname.startsWith('/repo/');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-mark">{'</>'}</span> Codebase Questions</Link>
        <span className="grow" />
        <button className="btn sm ghost" onClick={cycle} title="Theme">{theme === 'dark' ? '☾ Dark' : theme === 'light' ? '☀ Light' : '◐ System'}</button>
        {!authDisabled && <InviteButton />}
        {!authDisabled && (
          <button
            className="btn sm ghost"
            onClick={async () => {
              await post('/auth/logout');
              onLogout();
            }}
          >
            Sign out
          </button>
        )}
      </header>
      <main style={{ flex: 1, minHeight: 0, overflow: isRepo ? 'hidden' : 'auto' }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/repo/:id" element={<Repo />} />
          <Route path="*" element={<div className="empty">Not found. <Link to="/">Go home</Link></div>} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<{ authenticated: boolean; authDisabled: boolean } | null>(null);
  const check = () => api<{ authenticated: boolean; authDisabled: boolean }>('/auth/status').then(setAuth, () => setAuth({ authenticated: false, authDisabled: false }));
  useEffect(() => {
    check();
    const h = () => setAuth((a) => (a ? { ...a, authenticated: false } : a));
    authEvents.addEventListener('unauthorized', h);
    return () => authEvents.removeEventListener('unauthorized', h);
  }, []);
  if (!auth) return <div className="empty"><span className="spinner" /></div>;
  if (!auth.authenticated) return <Login onDone={check} />;
  return (
    <BrowserRouter>
      <Shell onLogout={check} authDisabled={auth.authDisabled} />
    </BrowserRouter>
  );
}
