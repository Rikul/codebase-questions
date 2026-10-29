import { useState } from 'react';
import { post } from '../lib/api';

function format(v: string) {
  const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return raw.match(/.{1,4}/g)?.join('-') ?? '';
}

export function Login({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = code.replace(/-/g, '').length === 16;
  return (
    <div className="login-wrap">
      <form
        className="login card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post('/auth/redeem', { code });
            onDone();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand" style={{ marginBottom: 18 }}>
          <span className="brand-mark">{'</>'}</span> Codebase Questions
        </div>
        <h2 style={{ fontSize: 20 }}>Enter your access code</h2>
        <p className="muted" style={{ margin: '6px 0 18px' }}>
          The server prints a 16-character one-time code when it starts. Each code works once.
        </p>
        <input
          className="input code-input"
          autoFocus
          autoComplete="one-time-code"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(format(e.target.value))}
          aria-label="Access code"
        />
        {error && <div className="error-box" style={{ marginTop: 12 }}>{error}</div>}
        <button className="btn primary" style={{ width: '100%', marginTop: 14, height: 40, justifyContent: 'center' }} disabled={!ready || busy}>
          {busy ? <span className="spinner" /> : 'Sign in'}
        </button>
        <details style={{ marginTop: 18 }} className="small muted">
          <summary style={{ cursor: 'pointer' }}>Where do I find the code?</summary>
          <p>With Docker:</p>
          <pre className="card" style={{ padding: 8, overflow: 'auto' }}>docker compose logs app | grep "Access code"</pre>
          <p>Lost it or already used it? Mint a fresh one:</p>
          <pre className="card" style={{ padding: 8, overflow: 'auto' }}>docker compose exec app node server/dist/cli/new-code.js</pre>
        </details>
      </form>
    </div>
  );
}
