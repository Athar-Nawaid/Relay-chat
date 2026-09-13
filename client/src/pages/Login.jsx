import { useState } from 'react';
import { auth } from '../lib/api.js';
import { useAuthStore } from '../store/authStore.js';

export default function Login() {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const data = isRegister
        ? await auth.register(username, password, displayName || username)
        : await auth.login(username, password);

      useAuthStore.getState().setSession(data);
    } catch (err) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  // Not named useDemo: a `use` prefix makes React's linter treat a plain
  // function as a hook, and calling it from an event handler then looks illegal.
  function fillDemo(who) {
    setMode('login');
    setUsername(who);
    setPassword('demo1234');
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>Relay</h1>
        <p className="tagline">Real-time chat that does not lose your messages.</p>

        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          autoComplete="username"
          required
        />

        {isRegister && (
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name (optional)"
          />
        )}

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          required
        />

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Log in'}
        </button>

        <button
          type="button"
          className="link"
          onClick={() => setMode(isRegister ? 'login' : 'register')}
        >
          {isRegister ? 'I already have an account' : 'Create an account'}
        </button>

        {/* Nobody evaluating this should have to register first. */}
        <div className="demo">
          <span>Try it:</span>
          <button type="button" onClick={() => fillDemo('demo1')}>
            demo1
          </button>
          <button type="button" onClick={() => fillDemo('demo2')}>
            demo2
          </button>
          <small>Open two browsers to see messages cross in real time.</small>
        </div>
      </form>
    </div>
  );
}
