import { useEffect, useLayoutEffect, useRef } from 'react';
import { selectThreadMessages, useChatStore } from '../store/chatStore.js';
import { useAuthStore } from '../store/authStore.js';
import { conversations as conversationsApi } from '../lib/api.js';
import { dayKey, formatDayLabel, formatTime, sameGroup } from '../lib/time.js';
import { retryFailed } from '../realtime/socket.js';

/** Delivery state on our own bubbles. Absent once the server has acked. */
function StatusMark({ status }) {
  if (!status) return null;
  if (status === 'failed') return <span className="tick failed" title="Not delivered">!</span>;
  if (status === 'queued') return <span className="tick" title="Waiting for connection">◷</span>;
  return <span className="tick" title="Sending">·</span>;
}

export default function MessageList({ conversationId, members }) {
  const thread = useChatStore((s) => s.threads[conversationId]);
  const meId = useAuthStore((s) => s.user?.id);
  const setThreadMeta = useChatStore((s) => s.setThreadMeta);
  const mergeMessages = useChatStore((s) => s.mergeMessages);

  const scroller = useRef(null);
  const bottomAnchored = useRef(true);

  const messages = selectThreadMessages(thread);
  const byId = Object.fromEntries((members ?? []).map((m) => [m.id, m]));
  const isGroup = (members?.length ?? 0) > 2;
  const anyFailed = messages.some((m) => m.status === 'failed');

  useEffect(() => {
    if (!conversationId || thread) return;

    setThreadMeta(conversationId, { loading: true });
    conversationsApi
      .history(conversationId)
      .then(({ messages: page, hasMore }) => {
        mergeMessages(conversationId, page);
        setThreadMeta(conversationId, { hasMore, loading: false });
      })
      .catch(() => setThreadMeta(conversationId, { loading: false }));
  }, [conversationId, thread, mergeMessages, setThreadMeta]);

  // Only follow new messages when already at the bottom, so reading history is
  // never yanked away by someone else typing.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && bottomAnchored.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function onScroll(event) {
    const el = event.currentTarget;
    bottomAnchored.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && thread?.hasMore && !thread.loading) loadOlder();
  }

  async function loadOlder() {
    const oldest = messages.find((m) => m.seq);
    if (!oldest) return;

    setThreadMeta(conversationId, { loading: true });
    const el = scroller.current;
    const heightBefore = el.scrollHeight;

    try {
      const { messages: page, hasMore } = await conversationsApi.history(conversationId, {
        beforeSeq: oldest.seq,
      });
      mergeMessages(conversationId, page);
      setThreadMeta(conversationId, { hasMore, loading: false });

      // Hold the reading position instead of jumping to the top.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - heightBefore;
      });
    } catch {
      setThreadMeta(conversationId, { loading: false });
    }
  }

  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      {thread?.loading && <div className="notice">Loading…</div>}
      {thread && !thread.hasMore && !thread.loading && (
        <div className="notice">Start of the conversation</div>
      )}

      {messages.map((message, i) => {
        const previous = messages[i - 1];
        const mine = message.senderId === meId;
        const sender = byId[message.senderId];

        const grouped = sameGroup(previous, message);
        const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);

        return (
          <div key={message.id ?? message.clientMsgId} style={{ display: 'contents' }}>
            {newDay && <div className="day-sep">{formatDayLabel(message.createdAt)}</div>}

            <div
              className={`msg-row ${mine ? 'outgoing' : 'incoming'} ${
                grouped && !newDay ? 'grouped' : ''
              }`}
            >
              {!mine &&
                (grouped && !newDay ? (
                  <div className="avatar spacer" aria-hidden="true" />
                ) : (
                  <div
                    className="avatar"
                    style={{ background: sender?.avatarColor ?? '#94a3b8' }}
                    aria-hidden="true"
                  >
                    {(sender?.displayName ?? '?').charAt(0).toUpperCase()}
                  </div>
                ))}

              <div
                className={`bubble ${mine ? 'out' : 'in'} ${message.status ? 'unsent' : ''} ${
                  message.status === 'failed' ? 'failed' : ''
                }`}
              >
                {/* Only name people in group conversations — in a DM it's noise. */}
                {!mine && isGroup && !grouped && (
                  <span className="who">{sender?.displayName ?? 'Unknown'}</span>
                )}

                {/* JSX escapes by default. This is where the original stored XSS lived. */}
                <p>{message.body === null ? <em>message deleted</em> : message.body}</p>

                <span className="foot">
                  {formatTime(message.createdAt)}
                  <StatusMark status={message.status} />
                </span>
              </div>
            </div>
          </div>
        );
      })}

      {anyFailed && (
        <div className="retry-line">
          Some messages could not be sent
          <button type="button" onClick={retryFailed}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
