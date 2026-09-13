import { useChatStore } from '../store/chatStore.js';
import { retryFailed } from '../realtime/socket.js';

/**
 * Makes the reliability machinery visible.
 *
 * Losing the connection is not an error state here — queued messages are safe and
 * will be sent on reconnect — so the banner says exactly that rather than
 * implying something broke.
 */
export default function ConnectionBanner() {
  const connection = useChatStore((s) => s.connection);
  const instanceId = useChatStore((s) => s.instanceId);
  const queued = useChatStore((s) => s.outbox.length);

  if (connection === 'connected' && queued === 0) {
    return (
      <div className="banner ok">
        <span className="dot on" />
        Connected
        {instanceId && <code title="Which server instance you are connected to">{instanceId}</code>}
      </div>
    );
  }

  return (
    <div className={`banner ${connection === 'connected' ? 'ok' : 'warn'}`}>
      <span className={`dot ${connection === 'connected' ? 'on' : 'off'}`} />
      {connection === 'connected' ? 'Connected' : 'Reconnecting…'}
      {queued > 0 && (
        <>
          <span className="queued">
            {queued} message{queued === 1 ? '' : 's'} queued — they will send automatically
          </span>
          {connection === 'connected' && (
            <button type="button" onClick={retryFailed}>
              Retry now
            </button>
          )}
        </>
      )}
      {instanceId && <code>{instanceId}</code>}
    </div>
  );
}
