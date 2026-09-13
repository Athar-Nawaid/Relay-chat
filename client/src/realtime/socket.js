import { io } from 'socket.io-client';
import { useAuthStore } from '../store/authStore.js';
import { useChatStore } from '../store/chatStore.js';
import { auth, conversations as conversationsApi } from '../lib/api.js';
import { playReceive, playSend } from '../lib/sound.js';

let socket = null;

const ACK_TIMEOUT_MS = 8000;

export function getSocket() {
  return socket;
}

export function connectSocket() {
  if (socket) return socket;

  socket = io({
    path: '/socket.io',
    transports: ['websocket'],

    /**
     * The CALLBACK form is essential, not stylistic.
     *
     * socket.io re-invokes it on every reconnect attempt, so a token refreshed
     * after expiry is picked up automatically. The object form (`auth: {token}`)
     * captures the token once at construction — which is the classic bug where
     * everything works for fifteen minutes and then reconnect-loops forever with
     * a token that can never become valid again.
     */
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),

    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  const store = () => useChatStore.getState();

  socket.on('connect', () => {
    store().setConnection('connected');
    // Anything the server never acked goes back out. Same clientMsgId, so a
    // message the server did receive is recognised as a retry, not duplicated.
    flushOutbox();
  });

  socket.on('disconnect', () => store().setConnection('disconnected'));
  socket.io.on('reconnect_attempt', () => store().setConnection('connecting'));

  socket.on('hello', ({ instanceId }) => {
    // Rendered in the UI: two windows showing different ids is the multi-instance
    // demo, visible rather than asserted.
    store().setInstanceId(instanceId);
  });

  socket.on('connect_error', async (err) => {
    store().setConnection('disconnected');

    // The handshake was rejected for an expired token: refresh, and the auth
    // callback above will supply the new one on the next attempt.
    if (err?.data?.code === 'TOKEN_EXPIRED' || err?.data?.code === 'AUTH_REQUIRED') {
      const fresh = await auth.refresh();
      if (!fresh) useAuthStore.getState().clear();
    }
  });

  // The server is about to drop us because the token aged out mid-connection.
  socket.on('auth:expired', async () => {
    const fresh = await auth.refresh();
    if (!fresh) useAuthStore.getState().clear();
  });

  socket.on('message:new', (message) => {
    const { activeId } = store();
    const meId = useAuthStore.getState().user?.id;

    store().mergeMessages(message.conversationId, [message]);
    store().bumpUnread(message.conversationId, message.senderId, meId);

    // Only for other people's messages — our own already played on send.
    if (message.senderId !== meId) playReceive();

    void detectGap(message.conversationId);

    // Acknowledge delivery so the server's watermark tracks in real time and the
    // reconnect drain is normally empty.
    scheduleDeliveryAck(message.conversationId, message.seq);
    if (message.conversationId === activeId) markRead(activeId, message.seq);
  });

  socket.on('message:backlog', ({ conversationId, messages, hasMore }) => {
    if (!messages.length) return;

    store().mergeMessages(conversationId, messages);

    const highest = Math.max(...messages.map((m) => m.seq));

    // Only now does the server advance its watermark. Dying before this point
    // means the batch is simply delivered again — which is the contract.
    socket.emit('sync:ack', { conversationId, upToSeq: highest }, () => {
      if (hasMore) socket.emit('sync:request', { conversationId, fromSeq: highest });
    });
  });

  // Someone added us to a conversation. The server has already pulled this
  // socket into the room, so messages will arrive without a reload.
  socket.on('conversation:new', (conversation) => {
    store().upsertConversation({ ...conversation, unread: 0 });
  });

  socket.on('presence:update', ({ userId, online }) => store().setPresence(userId, online));

  socket.on('typing', ({ conversationId, userId, typing }) => {
    store().setTyping(conversationId, userId, typing);
    if (typing) {
      // Expire locally rather than trusting a stop event to arrive — a sender who
      // crashes mid-type must not leave someone "typing…" forever.
      setTimeout(() => store().setTyping(conversationId, userId, false), 4000);
    }
  });

  return socket;
}

export function disconnectSocket() {
  socket?.close();
  socket = null;
}

/* ------------------------------- sending -------------------------------- */

export function sendMessage({ conversationId, body }) {
  const clientMsgId = crypto.randomUUID();
  const store = useChatStore.getState();

  store.enqueue({
    clientMsgId,
    conversationId,
    body,
    senderId: useAuthStore.getState().user?.id,
    createdAt: new Date().toISOString(),
  });

  playSend();
  deliver({ clientMsgId, conversationId, body });
  return clientMsgId;
}

function deliver({ clientMsgId, conversationId, body }) {
  if (!socket?.connected) {
    // Stays in the outbox; the next 'connect' flushes it.
    useChatStore.getState().markOutboxStatus(clientMsgId, 'queued');
    return;
  }

  socket
    .timeout(ACK_TIMEOUT_MS)
    .emit('message:send', { conversationId, body, clientMsgId }, (timeoutErr, res) => {
      // A timeout is NOT a failure to deliver — the server may well have stored
      // it. That ambiguity is precisely why retries carry the same clientMsgId.
      if (timeoutErr || !res?.ok) {
        useChatStore.getState().markOutboxStatus(clientMsgId, 'failed');
        return;
      }
      useChatStore.getState().resolveOutbox(clientMsgId, res.message);
    });
}

export function flushOutbox() {
  for (const entry of useChatStore.getState().getOutbox()) deliver(entry);
}

export function retryFailed() {
  flushOutbox();
}

/* ------------------------------ watermarks ------------------------------ */

const ackTimers = new Map();

/** Debounced and coalesced to the highest seq, so a busy room is not one ack per message. */
function scheduleDeliveryAck(conversationId, seq) {
  const existing = ackTimers.get(conversationId);
  const upToSeq = Math.max(existing?.seq ?? 0, seq);

  clearTimeout(existing?.timer);

  const timer = setTimeout(() => {
    ackTimers.delete(conversationId);
    socket?.emit('sync:ack', { conversationId, upToSeq });
  }, 500);

  ackTimers.set(conversationId, { timer, seq: upToSeq });
}

export function markRead(conversationId, upToSeq) {
  socket?.emit('read:mark', { conversationId, upToSeq });
  useChatStore.getState().clearUnread(conversationId);
}

export function emitTyping(conversationId, isTyping) {
  socket?.emit(isTyping ? 'typing:start' : 'typing:stop', { conversationId });
}

/* ---------------------------- gap detection ----------------------------- */

/**
 * Repairs holes in the sequence.
 *
 * Seeing seq 8 when we have only up to 6 means 7 is missing — usually a message
 * that arrived out of order or was missed during a blip. Fetch the span and find
 * out. A short result means the gap is real (a soft delete, or a number burned by
 * a racing retry), which is expected: seq is monotonic, not contiguous.
 */
async function detectGap(conversationId) {
  const thread = useChatStore.getState().threads[conversationId];
  if (!thread) return;

  const seqs = Object.values(thread.byId).map((m) => m.seq);
  if (seqs.length === 0) return;

  const highest = Math.max(...seqs);
  const contiguous = thread.highestContiguousSeq;

  if (highest <= contiguous + 1) return;

  try {
    const { messages } = await conversationsApi.range(conversationId, contiguous, highest);
    if (messages?.length) useChatStore.getState().mergeMessages(conversationId, messages);
  } catch {
    // A failed repair is retried by the next message, and the reconnect drain is
    // the ultimate backstop.
  }
}
