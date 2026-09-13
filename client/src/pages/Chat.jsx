import { useEffect, useState } from 'react';
import { conversations as conversationsApi, auth } from '../lib/api.js';
import { connectSocket, disconnectSocket } from '../realtime/socket.js';
import { useChatStore } from '../store/chatStore.js';
import { useAuthStore } from '../store/authStore.js';
import { isMuted, setMuted } from '../lib/sound.js';
import { applyTheme, getTheme, nextTheme, themeIcon, themeLabel } from '../lib/theme.js';
import ConversationList from '../components/ConversationList.jsx';
import { isOnline, titleOf } from '../lib/conversation.js';
import MessageList from '../components/MessageList.jsx';
import Composer from '../components/Composer.jsx';
import ConnectionBanner from '../components/ConnectionBanner.jsx';
import NewChatDialog from '../components/NewChatDialog.jsx';
import ConversationDetails from '../components/ConversationDetails.jsx';

export default function Chat() {
  const [showNewChat, setShowNewChat] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  // Narrow screens show one pane at a time; ignored at desktop widths.
  const [view, setView] = useState('list');
  const [muted, setMutedState] = useState(isMuted());
  const [theme, setTheme] = useState(getTheme());

  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const typing = useChatStore((s) => s.typing);
  const presence = useChatStore((s) => s.presence);
  const me = useAuthStore((s) => s.user);

  useEffect(() => {
    connectSocket();

    conversationsApi
      .list()
      .then(({ conversations: list }) => {
        useChatStore.getState().setConversations(list);
        if (list.length > 0) useChatStore.getState().setActive(list[0].id);
      })
      .catch(() => {});

    return () => disconnectSocket();
  }, []);

  const active = conversations.find((c) => c.id === activeId);
  const typingUsers = (typing[activeId] ?? []).filter((id) => id !== me?.id);
  const online = isOnline(active, presence, me?.id);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  function cycleTheme() {
    const next = nextTheme(theme);
    applyTheme(next);
    setTheme(next);
  }

  async function logout() {
    await auth.logout().catch(() => {});
    disconnectSocket();
    useAuthStore.getState().clear();
  }

  function subtitle() {
    if (typingUsers.length > 0) {
      return (
        <span className="typing-dots" aria-label="typing">
          <i />
          <i />
          <i />
        </span>
      );
    }
    if (!active) return null;
    if (active.type === 'group') return `${active.members?.length ?? 0} members`;
    return online ? 'Online' : 'Offline';
  }

  return (
    <div className="app" data-view={view}>
      <header className="app-head">
        <div className="brand">
          <strong>Relay</strong>
          <ConnectionBanner />
        </div>

        <div className="me">
          <span>{me?.displayName}</span>
          <button
            type="button"
            className="ghost"
            onClick={cycleTheme}
            title={themeLabel(theme)}
            aria-label={themeLabel(theme)}
          >
            {themeIcon(theme)}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={toggleMute}
            title={muted ? 'Unmute sounds' : 'Mute sounds'}
            aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          <button type="button" className="link" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <div className="body">
        <ConversationList
          onNewChat={() => setShowNewChat(true)}
          onOpen={() => setView('thread')}
        />

        <main className="thread">
          {active ? (
            <>
              <div className="thread-head">
                <button
                  type="button"
                  className="ghost back"
                  onClick={() => setView('list')}
                  aria-label="Back to conversations"
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="thread-identity"
                  onClick={() => setShowDetails(true)}
                  title="View members"
                >
                  <h2>{titleOf(active, me?.id)}</h2>
                  <div className="sub">
                    {active.type === 'dm' && (
                      <span className={`dot ${online ? 'on' : 'off'}`} aria-hidden="true" />
                    )}
                    {subtitle()}
                  </div>
                </button>
              </div>

              <MessageList conversationId={active.id} members={active.members} />
              <Composer conversationId={active.id} />
            </>
          ) : (
            <div className="blank">
              <p>No conversation selected.</p>
              <button type="button" onClick={() => setShowNewChat(true)}>
                Start a conversation
              </button>
            </div>
          )}
        </main>
      </div>

      {showNewChat && (
        <NewChatDialog
          onClose={() => setShowNewChat(false)}
          onCreated={() => setView('thread')}
        />
      )}

      {showDetails && active && (
        <ConversationDetails conversation={active} onClose={() => setShowDetails(false)} />
      )}
    </div>
  );
}
