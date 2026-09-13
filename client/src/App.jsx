import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from './store/authStore.js';
import { auth } from './lib/api.js';
import Login from './pages/Login.jsx';
import Chat from './pages/Chat.jsx';

export default function App() {
  const status = useAuthStore((s) => s.status);

  /**
   * On boot, try to revive the session from the httpOnly refresh cookie.
   *
   * The access token is deliberately in memory only, so a reload always starts
   * with nothing. This is what stops that from meaning "log in again".
   */
  useEffect(() => {
    let cancelled = false;

    auth
      .refresh()
      .then((token) => {
        if (cancelled) return;
        if (!token) useAuthStore.getState().setAnonymous();
      })
      .catch(() => {
        if (!cancelled) useAuthStore.getState().setAnonymous();
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'loading') {
    return <div className="boot">Loading…</div>;
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={status === 'authenticated' ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/"
        element={status === 'authenticated' ? <Chat /> : <Navigate to="/login" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
