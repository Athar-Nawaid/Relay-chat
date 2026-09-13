# Design decisions

Every deliberate choice in the project, why it was made, and the one line to say about it.

These are the small things. [02-interview-guide.md](02-interview-guide.md) covers the big features; this file is the collection of decisions that each take ten seconds to explain and quietly signal that you have hit the problem before. They are what separates "I built a chat app" from "I made these choices and here is why."

**Use them naturally.** Dropped in when relevant, they read as experience. Recited in a list, they read as memorised.

---

## Architecture and deployment shape

### The API server serves the React build

The client is not hosted separately. In production Express serves `client/dist`; in development the Vite proxy forwards `/api` and `/socket.io` to the same server.

> "I serve the client from the API server so the app is same-origin in both dev and prod — that removes CORS entirely and keeps the refresh cookie first-party."

The payoff is concrete: **not one line of CORS configuration exists in this project**, `SameSite=Lax` just works, and the WebSocket has no separate origin to configure. Hosting the client separately would mean `SameSite=None; Secure`, cross-origin credentials and a CORS allowlist — three more things to get wrong, all in the area that is hardest to debug.

### Dev is same-origin too, on purpose

The Vite proxy is not just about convenience.

> "I proxied in dev so development and production behave identically — otherwise the environments diverge exactly where auth is hardest to debug."

### One repo, npm workspaces, not a monorepo tool

> "It's two packages sharing one install and one lint config. Turborepo would have been half a day of configuration to solve a problem I don't have."

*`package.json`, `client/vite.config.js`, `server/src/app.js`*

---

## Real-time and transport

### WebSocket-only transport

No HTTP long-polling fallback.

> "engine.io's polling handshake spans several requests that all have to reach the same instance, which behind a load balancer means sticky sessions. Dropping polling removes that requirement — the trade is no fallback for proxies that block WebSockets."

This is why the Render/Caddy config can do plain round-robin with no session affinity. A design decision in one layer paying off in another is a good thing to point at.

### Three Redis clients, not two

> "The subscriber connection can't run ordinary commands — it's in subscriber mode — so the adapter gets a dedicated pub/sub pair and presence and rate limiting use a third client. Trying to SET on the subscriber is the classic mistake."

### `instanceId` is rendered in the UI

> "Each instance generates an id at boot and the client shows it in the connection banner. Two windows showing different ids while messaging is a visible fact rather than something I'm asking you to believe."

Fifteen minutes of work; it is what makes the demo GIF legible.

### Creating a conversation pulls existing sockets into the room

> "Sockets join their conversation rooms at connect time, so someone added to a new group would sit outside the room and receive nothing until they reloaded. Creating a conversation calls `socketsJoin` on that user's room — and because it goes through the Redis adapter it reaches their sockets on *any* instance, not just the one handling the request."

A good example of the adapter doing more than fan-out. There is a test asserting it works with the two users on different instances.

### Graceful shutdown releases presence leases

> "On SIGTERM I close sockets first and drop this instance's presence entries, so a rolling deploy doesn't leave 45 seconds of ghosts behind."

*`server/src/realtime/io.js`, `server/src/config/redis.js`, `server/src/services/presence.service.js`*

---

## Delivery semantics

### A duplicate is not rebroadcast

> "A retry means the *sender* never saw its ack — not that the room missed the message. Re-emitting would show everyone else a second copy."

### A failed ack is load-bearing

> "The send handler never throws silently. A failure acks `{ok: false}`, and that's what keeps the message in the client's outbox for retry. Silence would be data loss."

### An ack timeout is not treated as failure

> "On a timeout the server may well have stored it. That ambiguity is exactly why retries carry an idempotency key — the client doesn't need to know which happened."

### `seq` is monotonic, not contiguous

> "Gaps are expected — from soft deletes, and from a racing retry burning a number. The client treats a gap as 'fetch this range', never 'data lost'. Guaranteeing contiguity would need a cross-store transaction Postgres and Mongo can't provide between them."

### The server's watermark is authoritative

> "The delivery cursor lives server-side and only moves on an explicit ack. A client can't skip messages by lying about what it has seen."

### `GREATEST` on every watermark update

> "It means a duplicate or out-of-order ack can't rewind the cursor. Without it a late ack carrying a stale seq would redeliver the entire backlog."

### Delivery acks are debounced and coalesced

> "Acks are debounced 500ms and collapsed to the highest seq, so a busy room isn't one round trip per message — and the reconnect drain is normally empty as a result."

*`server/src/realtime/handlers/message.js`, `server/src/services/sync.service.js`, `client/src/realtime/socket.js`*

---

## Data modelling

### No `message_receipts` table

> "One receipt row per recipient per message is O(members) writes per message. High-water marks on the membership row are O(1) regardless of group size, and they make the unread count arithmetic instead of a scan."

### `Int`, not `BigInt`, for sequence columns

> "Prisma maps BigInt to JS BigInt, which throws on JSON.stringify — and seq crosses a socket payload on every single message. int4 caps at about 2.1 billion messages per conversation, which is ample. It removes a whole class of runtime footgun."

A very good answer to have ready, because it looks like a trivial choice and isn't.

### `dm_key` is derived and unique

> "Sorting the two user ids means A-to-B and B-to-A produce the same key, and the unique constraint makes DM creation idempotent at the database level rather than through a read-then-write race in application code."

### `created_by` is nullable with `ON DELETE SET NULL`

> "Prisma defaults a required relation to RESTRICT, which meant a user who'd ever created a conversation could never be deleted. Cascade would be worse — it'd destroy a group the moment its creator left. Authorship is metadata; membership is what governs access."

### `citext` for usernames

> "Case-insensitivity is enforced by the database rather than by `.toLowerCase()` scattered through application code. There's a test that registering `DEMO1` collides with `demo1`."

### Cursor pagination on `seq`, never `skip`

> "`skip` re-scans from the start of the collection and drifts when rows are inserted mid-scroll — which in a live chat is constant. Cursor pagination is stable."

### Sender display names are not denormalised into messages

> "The client caches the member list instead. If history reads became the bottleneck I'd store a sender snapshot on the document and accept stale names after a rename — that's the trade real chat products make."

*`server/prisma/schema.prisma`, `server/src/models/message.model.js`, `server/src/services/message.service.js`*

---

## Concurrency

### `UPDATE … RETURNING` for sequence allocation

> "`SELECT MAX(seq)+1` races — two concurrent sends read the same max and write the same number. The UPDATE takes a row lock, which serialises them. That's the ordering guarantee I want, and it's also the bottleneck I measured."

### `P2002` is the expected outcome of a lost race

> "An upsert is a SELECT then an INSERT, not an atomic operation. Under concurrency both requests miss and both insert; the unique constraint lets one win. So I treat the rejection as the constraint working and read the winner's row. That's the difference between idempotent-when-serial and idempotent-under-concurrency."

Found by a test firing five simultaneous requests. It failed the first time it ran.

### The membership cache stores positive results only

> "A non-member must never be let in by a stale cache entry. A removed member keeping access for up to 30 seconds is an acceptable trade in the other direction."

### Rate limiting lives in Redis, not memory

> "A per-process limiter is bypassed by reconnecting until you land on a different instance."

*`server/src/services/message.service.js`, `server/src/services/conversation.service.js`, `server/src/services/ratelimit.service.js`*

---

## Auth and security

### Access and refresh tokens differ in kind, not just lifetime

> "The access token is a stateless JWT so every request *and every socket handshake* is a signature check, not a database round trip. The refresh token is deliberately the opposite — opaque bytes, stored as a hash, because being revocable is the entire point and a JWT can't be."

### The access token lives in memory only

> "XSS can still read it, but the blast radius is one tab for fifteen minutes rather than a token sitting in storage for any later script or extension to find. Durability comes from the httpOnly refresh cookie, which JavaScript can't read at all."

### Only the hash of the refresh token is stored

> "A database leak yields no usable sessions."

### Family-wide revocation on reuse

> "Every refresh burns the presented token. Presenting one twice means someone is replaying a stolen copy — and since I can't tell the thief from the victim, I revoke the whole family. That caps a theft at one refresh cycle instead of seven days."

### The socket `auth` option must be a callback

> "socket.io re-invokes the callback on every reconnect attempt, so a refreshed token gets picked up. The object form snapshots once at construction — that's the bug where everything works for fifteen minutes and then reconnect-loops forever."

### Token expiry is swept mid-connection

> "A JWT verified at handshake stays valid for the whole life of the socket, so a long-lived WebSocket silently turns a 15-minute token into an unbounded session. A 60-second sweep emits `auth:expired` and disconnects so the client can refresh cleanly."

Worth volunteering unprompted — almost nobody handles it.

### Identity always comes from the token, never the payload

> "There's a test that injects a `senderId` into the send payload and asserts it's ignored."

### Login is rate-limited harder than the rest of the API

> "Beyond brute force, bcrypt at cost 12 is expensive for *us* too — an unthrottled login endpoint is a cheap CPU exhaustion vector."

### A login attempt for an unknown user still hashes

> "Otherwise the response time tells you whether the account exists."

### `react/no-danger` is an ESLint error

> "JSX escaping already removed the stored XSS the old version had. But 'the framework handles it' isn't a security control — this makes the one escape hatch that would reintroduce it a build failure rather than a code-review question."

A *process* control rather than a one-time fix, which is the better answer.

*`server/src/services/token.service.js`, `server/src/realtime/authSocket.js`, `eslint.config.js`*

---

## Infrastructure choices

### Mongoose for Mongo, Prisma for Postgres

> "Two purpose-fit tools. Prisma's Mongo connector needs a replica set and a second generated client — two Prisma clients reads as indecision, whereas this reads as deliberate."

### The direct Postgres endpoint, not the pooled one

Started on the pooled endpoint because that is the default advice, then measured it.

> "Neon's pooled endpoint benchmarked at 407ms median for `SELECT 1` against 83ms direct — about 325ms of overhead on every query, and sequence allocation is on the send path for every message. A pooler solves a problem this app doesn't have: PgBouncer is for serverless runtimes that open a connection per invocation, whereas I have long-lived Node processes and Prisma already pools internally. It was a second pool in series. Removing it took the 5-sender p95 from 4829ms to 460ms."

The generalisable point — *a pooler in front of something that already pools is overhead, not safety* — is the part worth saying.

Migrations need the direct endpoint regardless: they take advisory locks and run DDL, neither of which survives a transaction-mode pooler.

### `@node-rs/bcrypt` over `bcrypt`

> "`bcrypt` pulls in node-pre-gyp and tar, which carried the only critical advisory in the tree, and it needs a native compile at install. The Rust binding ships prebuilt — one fewer advisory and no build toolchain in the deploy."

### The standard Mongo connection string, not `mongodb+srv://`

> "SRV needs a DNS SRV lookup, and Node's resolver on my machine points at a local stub that refuses them. Listing the shard hosts explicitly skips the lookup and behaves identically everywhere — including CI."

A good "I debugged something unusual" answer: the record resolved fine via the OS and via 8.8.8.8, just not through Node's c-ares resolver.

### All three databases in one region as the app

> "A send makes three sequential round trips — Redis, Postgres, Mongo. I had them split across Singapore and Mumbai and measured 488ms for a single uncontended send, essentially all network. Consolidating in one region is a 20× improvement on the only part of that latency I control."

Worth saying because it demonstrates that you understood *why* the number was bad rather than just reporting it.

### `fileURLToPath`, not `.pathname`

> "`.pathname` yields `/D:/...` on Windows, which express.static can't resolve. It'd have worked on Linux and broken only local production testing."

### Only one service runs migrations

> "Two concurrent `prisma migrate deploy` runs can deadlock on the advisory lock, so the second instance's build skips it."

*`server/src/config/`, `render.yaml`, `.env.example`*

---

## Client

### Confirmed and pending messages are kept separately

> "Confirmed messages live in a map keyed by server id, optimistic ones keyed by clientMsgId. Keeping them apart is what lets the same message arrive twice — once live, once in a reconnect backlog — without ever rendering twice."

### A broadcast overtaking the ack promotes, not duplicates

> "If the room broadcast beats my own ack, the pending bubble is promoted rather than a second one inserted."

### Every localStorage access is wrapped

> "Storage throws in private windows and when site data is blocked. A chat app must not white-screen over that — the in-memory outbox still works, you just lose survival across a reload."

### The connection banner states the truth

> "Losing the connection isn't an error. Queued messages are safe and will send — so the banner says that instead of implying something broke."

### Demo accounts are seeded and offered on the login screen

> "The fastest path from a recruiter's click to 'oh, it actually works' is two tabs as two users. Never make an evaluator register first."

*`client/src/store/chatStore.js`, `client/src/store/outbox.js`, `client/src/pages/Login.jsx`*

---

## Testing and tooling

### Vitest, not Jest

> "The project is ESM throughout and Jest with ESM is a known multi-hour tax. Vitest is ESM-native."

### Real databases, no `ioredis-mock`

> "Cross-client pub/sub is precisely the thing under test. Mocking Redis would test the mock."

### Two live server instances in the test suite

> "The reliability tests boot two real servers on ephemeral ports, each with its own Redis pub/sub pair, and assert a message sent on one arrives on the other."

### The test timeout is 30 seconds, deliberately

> "These talk to managed databases in remote regions and a single test can make a dozen sequential round trips. The default 5s is a latency limit, not a correctness one — failing on it hides real results."

### What's *not* tested is stated

> "No component tests, no browser E2E, no coverage thresholds. A declared scope beats a silent absence."

*`server/vitest.config.js`, `server/tests/`*

---

## Two answers about being wrong

Worth more than any decision above, because they show method rather than knowledge.

### The load-test hypothesis

> "I thought a pre-emptive idempotency read was the per-message cost. I removed it and the numbers didn't move — the real bottleneck was the row lock serialising sends in the same conversation. I left the read removed because it's fewer round trips for identical guarantees, but the fix came from the measurement, not the guess. The guess was wrong."

### The concurrency bug

> "I wrote a test firing five simultaneous requests to create the same DM, expecting it to pass. It didn't. The upsert wasn't atomic, and the losing request surfaced a 500 instead of the conversation. The naive version looks correct and passes every serial test."
