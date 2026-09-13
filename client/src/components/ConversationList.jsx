import { useChatStore } from '../store/chatStore.js';
import { useAuthStore } from '../store/authStore.js';
import { markRead } from '../realtime/socket.js';
import { formatRelative } from '../lib/time.js';
import { isOnline, otherMembers, titleOf } from '../lib/conversation.js';

export { titleOf };

export default function ConversationList({ onNewChat, onOpen }) {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const presence = useChatStore((s) => s.presence);
  const typing = useChatStore((s) => s.typing);
  const setActive = useChatStore((s) => s.setActive);
  const meId = useAuthStore((s) => s.user?.id);

  function open(conversation) {
    setActive(conversation.id);
    if (conversation.lastSeq > 0) markRead(conversation.id, conversation.lastSeq);
    onOpen?.();
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h2>Chats</h2>
        <button type="button" onClick={onNewChat} title="New conversation" aria-label="New conversation">
          +
        </button>
      </div>

      <ul className="conversations">
        {conversations.length === 0 && (
          <li className="empty">
            No conversations yet.
            <br />
            Tap + to start one.
          </li>
        )}

        {conversations.map((conversation) => {
          const name = titleOf(conversation, meId);
          const others = otherMembers(conversation, meId);
          const online = isOnline(conversation, presence, meId);
          const someoneTyping = (typing[conversation.id] ?? []).some((id) => id !== meId);

          return (
            <li key={conversation.id}>
              <button
                type="button"
                className={conversation.id === activeId ? 'active' : ''}
                onClick={() => open(conversation)}
                aria-current={conversation.id === activeId ? 'true' : undefined}
              >
                <span
                  className="avatar sm"
                  style={{ background: others[0]?.avatarColor ?? '#94a3b8' }}
                  aria-hidden="true"
                >
                  {name.charAt(0).toUpperCase()}
                </span>

                <span className="conv-main">
                  <span className="conv-top">
                    <span className="conv-name">{name}</span>
                    <span className="conv-when">{formatRelative(conversation.lastMessageAt)}</span>
                  </span>

                  <span className="conv-sub">
                    {conversation.type === 'dm' && (
                      <span className={`dot ${online ? 'on' : 'off'}`} aria-hidden="true" />
                    )}
                    {someoneTyping ? (
                      <em>typing…</em>
                    ) : conversation.type === 'group' ? (
                      <>{conversation.members?.length ?? 0} members</>
                    ) : (
                      <>{online ? 'Online' : 'Offline'}</>
                    )}
                  </span>
                </span>

                {conversation.unread > 0 && (
                  <span className="badge" aria-label={`${conversation.unread} unread`}>
                    {conversation.unread > 99 ? '99+' : conversation.unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
