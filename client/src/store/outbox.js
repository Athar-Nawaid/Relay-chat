const KEY = 'relay.outbox.v1';

/**
 * Unsent messages, persisted across reloads.
 *
 * This is the client half of at-least-once delivery. A message stays here until
 * the server acks it, so closing the tab mid-send, losing the network, or the
 * server restarting all end the same way: on reconnect everything still in the
 * outbox is re-sent, carrying its original clientMsgId so the server can
 * recognise the retry and store it only once.
 *
 * Every accessor is wrapped: storage throws in private windows and when site
 * data is blocked, and a chat app must not white-screen because of that.
 */
export function loadOutbox() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveOutbox(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Nothing to do. The in-memory outbox still works for this session; only
    // survival across a reload is lost.
  }
}
