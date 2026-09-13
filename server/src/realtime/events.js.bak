/** Wire protocol. Centralised so client and server cannot drift on a typo. */
export const EVENTS = {
  // server -> client
  HELLO: 'hello',
  MESSAGE_NEW: 'message:new',
  CONVERSATION_NEW: 'conversation:new',
  MESSAGE_BACKLOG: 'message:backlog',
  PRESENCE_UPDATE: 'presence:update',
  TYPING: 'typing',
  AUTH_EXPIRED: 'auth:expired',

  // client -> server
  MESSAGE_SEND: 'message:send',
  SYNC_REQUEST: 'sync:request',
  SYNC_ACK: 'sync:ack',
  READ_MARK: 'read:mark',
  TYPING_START: 'typing:start',
  TYPING_STOP: 'typing:stop',
};

export const room = {
  conversation: (id) => `conv:${id}`,
  user: (id) => `user:${id}`,
};
