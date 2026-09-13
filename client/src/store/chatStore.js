import { create } from 'zustand';
import { loadOutbox, saveOutbox } from './outbox.js';

/**
 * Per-conversation message state.
 *
 * `byId` holds server-confirmed messages; `pending` holds optimistic ones that
 * have no server id yet. Keeping them apart is what lets the same message arrive
 * twice — once as a live broadcast, once in a reconnect backlog — without ever
 * rendering twice.
 */
const emptyConversation = () => ({
  byId: {},
  pending: {},
  highestContiguousSeq: 0,
  hasMore: true,
  loading: false,
});

export const useChatStore = create((set, get) => ({
  conversations: [],
  activeId: null,
  threads: {},
  presence: {},
  typing: {},
  connection: 'connecting', // connecting | connected | disconnected
  instanceId: null,
  outbox: loadOutbox(),

  /* ----------------------------- connection ----------------------------- */

  setConnection: (connection) => set({ connection }),
  setInstanceId: (instanceId) => set({ instanceId }),

  /* --------------------------- conversations ---------------------------- */

  setConversations: (conversations) => set({ conversations }),
  setActive: (activeId) => set({ activeId }),

  upsertConversation: (conversation) =>
    set((s) => {
      const rest = s.conversations.filter((c) => c.id !== conversation.id);
      return { conversations: [conversation, ...rest] };
    }),

  bumpUnread: (conversationId, senderId, meId) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId && conversationId !== s.activeId && senderId !== meId
          ? { ...c, unread: (c.unread ?? 0) + 1 }
          : c,
      ),
    })),

  clearUnread: (conversationId) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, unread: 0 } : c,
      ),
    })),

  /* ------------------------------ presence ------------------------------ */

  setPresence: (userId, online) =>
    set((s) => ({ presence: { ...s.presence, [userId]: online } })),

  setTyping: (conversationId, userId, isTyping) =>
    set((s) => {
      const current = new Set(s.typing[conversationId] ?? []);
      if (isTyping) current.add(userId);
      else current.delete(userId);
      return { typing: { ...s.typing, [conversationId]: [...current] } };
    }),

  /* ------------------------------ messages ------------------------------ */

  /**
   * The merge rule — the heart of client-side de-duplication.
   *
   * A message may arrive more than once by design, so this must be idempotent:
   *   1. already confirmed by id      -> ignore
   *   2. matches one of our pending   -> promote it (covers the broadcast
   *                                      overtaking our own ack)
   *   3. otherwise                    -> insert
   */
  mergeMessages: (conversationId, incoming) =>
    set((s) => {
      const thread = s.threads[conversationId] ?? emptyConversation();
      const byId = { ...thread.byId };
      const pending = { ...thread.pending };

      for (const message of incoming) {
        if (byId[message.id]) continue;
        if (message.clientMsgId && pending[message.clientMsgId]) {
          delete pending[message.clientMsgId];
        }
        byId[message.id] = message;
      }

      return {
        threads: {
          ...s.threads,
          [conversationId]: {
            ...thread,
            byId,
            pending,
            highestContiguousSeq: recomputeContiguous(byId, thread.highestContiguousSeq),
          },
        },
      };
    }),

  setThreadMeta: (conversationId, meta) =>
    set((s) => ({
      threads: {
        ...s.threads,
        [conversationId]: { ...(s.threads[conversationId] ?? emptyConversation()), ...meta },
      },
    })),

  /* ------------------------------- outbox ------------------------------- */

  /** Adds an optimistic message and records it for retry. */
  enqueue: (entry) =>
    set((s) => {
      const thread = s.threads[entry.conversationId] ?? emptyConversation();
      const outbox = [...s.outbox, entry];
      saveOutbox(outbox);

      return {
        outbox,
        threads: {
          ...s.threads,
          [entry.conversationId]: {
            ...thread,
            pending: { ...thread.pending, [entry.clientMsgId]: { ...entry, status: 'sending' } },
          },
        },
      };
    }),

  markOutboxStatus: (clientMsgId, status) =>
    set((s) => {
      const entry = s.outbox.find((e) => e.clientMsgId === clientMsgId);
      if (!entry) return {};

      const thread = s.threads[entry.conversationId];
      if (!thread?.pending[clientMsgId]) return {};

      return {
        threads: {
          ...s.threads,
          [entry.conversationId]: {
            ...thread,
            pending: {
              ...thread.pending,
              [clientMsgId]: { ...thread.pending[clientMsgId], status },
            },
          },
        },
      };
    }),

  /** Confirmed by the server: drop from the outbox and fold into the thread. */
  resolveOutbox: (clientMsgId, message) =>
    set((s) => {
      const outbox = s.outbox.filter((e) => e.clientMsgId !== clientMsgId);
      saveOutbox(outbox);

      const thread = s.threads[message.conversationId] ?? emptyConversation();
      const pending = { ...thread.pending };
      delete pending[clientMsgId];

      const byId = { ...thread.byId, [message.id]: message };

      return {
        outbox,
        threads: {
          ...s.threads,
          [message.conversationId]: {
            ...thread,
            byId,
            pending,
            highestContiguousSeq: recomputeContiguous(byId, thread.highestContiguousSeq),
          },
        },
      };
    }),

  getOutbox: () => get().outbox,
}));

/**
 * Advances the contiguous-sequence watermark as far as the messages allow.
 *
 * Used for gap detection. `seq` is guaranteed monotonic but NOT contiguous — a
 * retry that raced another can burn a number, and soft deletes leave holes — so a
 * gap means "go and check this range", never "data was lost".
 */
function recomputeContiguous(byId, from) {
  const seqs = new Set(Object.values(byId).map((m) => m.seq));
  let next = from;
  while (seqs.has(next + 1)) next += 1;
  return next;
}

/** Confirmed messages in seq order, with still-sending ones pinned to the end. */
export function selectThreadMessages(thread) {
  if (!thread) return [];

  const confirmed = Object.values(thread.byId).sort((a, b) => a.seq - b.seq);
  const pending = Object.values(thread.pending).sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );

  return [...confirmed, ...pending];
}
