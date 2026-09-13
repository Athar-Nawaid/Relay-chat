import { useEffect, useState } from 'react';
import { conversations as conversationsApi, users as usersApi } from '../lib/api.js';
import { useChatStore } from '../store/chatStore.js';

export default function NewChatDialog({ onClose, onCreated }) {
  const [mode, setMode] = useState('dm');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isGroup = mode === 'group';

  useEffect(() => {
    const term = query.trim();

    // Everything including clearing happens inside the timer — calling setState
    // synchronously in an effect body triggers a cascading render.
    const timer = setTimeout(() => {
      if (!term) {
        setResults([]);
        return;
      }
      usersApi
        .search(term)
        .then(({ users }) => setResults(users))
        .catch(() => setResults([]));
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  // Escape closes, as every dialog should.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function finish(conversation) {
    useChatStore.getState().upsertConversation({ ...conversation, unread: 0 });
    useChatStore.getState().setActive(conversation.id);
    onCreated?.();
    onClose();
  }

  async function startDm(user) {
    setError(null);
    setBusy(true);
    try {
      // Idempotent server-side: picking someone you already talk to reopens the
      // existing conversation rather than creating a second one.
      const { conversation } = await conversationsApi.createDm(user.id);
      finish(conversation);
    } catch (err) {
      setError(err.message ?? 'Could not start conversation');
      setBusy(false);
    }
  }

  function toggleMember(user) {
    setSelected((current) =>
      current.some((u) => u.id === user.id)
        ? current.filter((u) => u.id !== user.id)
        : [...current, user],
    );
  }

  async function createGroup(event) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const { conversation } = await conversationsApi.createGroup(
        title.trim(),
        selected.map((u) => u.id),
      );
      finish(conversation);
    } catch (err) {
      setError(err.message ?? 'Could not create group');
      setBusy(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError(null);
    setQuery('');
    setResults([]);
  }

  const canCreate = title.trim().length > 0 && selected.length > 0 && !busy;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isGroup ? 'New group' : 'New conversation'}
      >
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!isGroup}
            className={!isGroup ? 'active' : ''}
            onClick={() => switchMode('dm')}
          >
            Direct message
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isGroup}
            className={isGroup ? 'active' : ''}
            onClick={() => switchMode('group')}
          >
            Group
          </button>
        </div>

        {isGroup && (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Group name"
            maxLength={60}
            aria-label="Group name"
          />
        )}

        {isGroup && selected.length > 0 && (
          <div className="chips">
            {selected.map((user) => (
              <button
                key={user.id}
                type="button"
                className="chip"
                onClick={() => toggleMember(user)}
                aria-label={`Remove ${user.displayName}`}
              >
                <span className="avatar xs" style={{ background: user.avatarColor }}>
                  {user.displayName.charAt(0).toUpperCase()}
                </span>
                {user.displayName}
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}

        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={isGroup ? 'Add people by username' : 'Search by username'}
          aria-label="Search users"
        />

        {error && <p className="error">{error}</p>}

        <ul className="results">
          {results.map((user) => {
            const picked = selected.some((u) => u.id === user.id);

            return (
              <li key={user.id}>
                <button
                  type="button"
                  className={picked ? 'picked' : ''}
                  disabled={busy}
                  onClick={() => (isGroup ? toggleMember(user) : startDm(user))}
                >
                  <span className="avatar sm" style={{ background: user.avatarColor }}>
                    {user.displayName.charAt(0).toUpperCase()}
                  </span>
                  <span className="conv-main">
                    <span className="conv-name">{user.displayName}</span>
                    <span className="conv-sub">@{user.username}</span>
                  </span>
                  {isGroup && <span aria-hidden="true">{picked ? '✓' : '+'}</span>}
                </button>
              </li>
            );
          })}

          {query.trim() && results.length === 0 && <li className="empty">No matches</li>}
          {!query.trim() && !isGroup && (
            <li className="empty">Start typing to find someone</li>
          )}
        </ul>

        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Cancel
          </button>

          {isGroup && (
            <button type="button" onClick={createGroup} disabled={!canCreate}>
              {busy
                ? 'Creating…'
                : `Create group${selected.length ? ` (${selected.length})` : ''}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
