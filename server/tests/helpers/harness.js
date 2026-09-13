import http from 'node:http';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';
import { createApp } from '../../src/app.js';
import { createIo } from '../../src/realtime/io.js';
import { pub } from '../../src/config/redis.js';

/**
 * Boots a real server instance on an ephemeral port.
 *
 * Each instance gets its OWN Redis pub/sub pair, so two instances started in one
 * test process are as independent as two machines would be — which is what makes
 * the cross-instance assertions meaningful rather than an accident of sharing
 * process memory.
 */
let instanceCounter = 0;

export async function bootInstance() {
  const app = createApp();
  const server = http.createServer(app);

  const pubClient = pub.duplicate();
  const subClient = pub.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);

  // A distinct id per instance. In production one process is one instance and
  // the module-level default applies; here two live in one process, so they must
  // be told apart explicitly.
  instanceCounter += 1;
  const id = `test-${process.pid}-${instanceCounter}`;

  const io = createIo(server, { pubClient, subClient, id });
  // Mirrors index.js: HTTP handlers reach the socket layer through this.
  app.set('io', io);

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  return {
    app,
    io,
    port,
    url: `http://localhost:${port}`,
    async close() {
      await io.shutdown().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    },
  };
}

export async function registerUser(app, username, password = 'correct-horse-battery') {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password, displayName: username })
    .expect(201);

  return { id: res.body.user.id, username, token: res.body.accessToken };
}

export async function createDm(app, user, otherId) {
  const res = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ type: 'dm', userId: otherId })
    .expect(200);

  return res.body.conversation.id;
}

/** Connects a socket client and resolves once the server's `hello` arrives. */
export function connectClient(url, token, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      transports: ['websocket'],
      // Callback form, not an object: re-invoked on every reconnect so a
      // refreshed token is picked up automatically.
      auth: (cb) => cb({ token }),
      reconnection: false,
      ...options,
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out waiting for hello'));
    }, 15_000);

    socket.on('hello', (payload) => {
      clearTimeout(timer);
      socket.hello = payload;
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolves with the next payload for `event`, or rejects on timeout. */
export function waitFor(socket, event, { timeout = 10_000, filter } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeout);

    function handler(payload) {
      if (filter && !filter(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

/** Asserts an event does NOT arrive within the window. */
export async function expectNoEvent(socket, event, ms = 2500) {
  const received = [];
  const handler = (payload) => received.push(payload);
  socket.on(event, handler);
  await new Promise((resolve) => setTimeout(resolve, ms));
  socket.off(event, handler);
  return received;
}

export function emitWithAck(socket, event, payload, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for "${event}"`)), timeout);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}
