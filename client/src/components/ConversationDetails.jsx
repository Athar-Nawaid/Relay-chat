import { useEffect } from 'react';
import { useChatStore } from '../store/chatStore.js';
import { useAuthStore } from '../store/authStore.js';
import { titleOf } from '../lib/conversation.js';

/**
 * Who is in this conversation.
 *
 * Members already travel with every conversation payload, so this needs no
 * request of its own — it is a view over state the client already holds.
 */
export default function ConversationDetails({ conversation, onClose }) {
  const presence = useChatStore((s) => s.presence);
  const meId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const members = conversation.members ?? [];
  // Online first, then owners, then alphabetical — the order you actually scan.
  const sorted = [...members].sort((a, b) => {
    const onlineDiff = Number(Boolean(presence[b.id])) - Number(Boolean(presence[a.id]));
    if (onlineDiff !== 0) return onlineDiff;
    const roleDiff = Number(b.role === 'owner') - Number(a.role === 'owner');
    if (roleDiff !== 0) return roleDiff;
    return (a.displayName ?? '').localeCompare(b.displayName ?? '');
  });

  const onlineCount = members.filter((m) => presence[m.id]).length;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Conversation details"
      >
        <div>
          <h3>{titleOf(conversation, meId)}</h3>
          <p className="modal-sub">
            {conversation.type === 'group'
              ? `${members.length} member${members.length === 1 ? '' : 's'} · ${onlineCount} online`
              : 'Direct message'}
          </p>
        </div>

        <ul className="results">
          {sorted.map((member) => (
            <li key={member.id}>
              {/* Not a button: there is nothing to do with a member yet. */}
              <div className="member-row">
                <span className="avatar sm" style={{ background: member.avatarColor }}>
                  {(member.displayName ?? '?').charAt(0).toUpperCase()}
                </span>

                <span className="conv-main">
                  <span className="conv-top">
                    <span className="conv-name">
                      {member.displayName}
                      {member.id === meId && <span className="tag">you</span>}
                      {member.role === 'owner' && <span className="tag owner">owner</span>}
                    </span>
                  </span>
                  <span className="conv-sub">
                    <span
                      className={`dot ${presence[member.id] ? 'on' : 'off'}`}
                      aria-hidden="true"
                    />
                    @{member.username}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>

        <div className="modal-actions">
          <span className="hint">Adding or removing members is not built yet.</span>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
