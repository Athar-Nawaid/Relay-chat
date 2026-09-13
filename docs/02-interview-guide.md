# Interview guide

Everything in this project: what was built, why, what went wrong, and how to talk about it.

**Ground rule: never claim anything here you cannot point at in the code.** Every answer below is backed by a file or a measured number. If an interviewer pushes past what you actually built, the correct answer is "I didn't build that, here's what I'd do" — that reads as honest engineering. Bluffing reads as a liar with a chat app.

---

## 1. The 30-second pitch

> It's a real-time chat app, but the point of it isn't the chat — it's what happens after the happy path. What if the recipient is offline? What if the network drops halfway through a send? What if there's more than one server? What if a server dies holding state?
>
> So it runs on multiple instances behind a Redis pub/sub adapter, it guarantees at-least-once delivery using client-generated idempotency keys, the offline queue is a watermark into an append-only log rather than a queue table, and presence is a TTL lease that can't leave ghosts when a server crashes. It's Postgres for the relational half and MongoDB for the message log, and I load-tested it to find out where it actually breaks.

If they only remember one sentence, make it: **"the offline queue isn't a queue — it's a cursor into the message log."** It's the most distinctive idea in the project.

---

## 2. Features, and the engineering behind each

### 2.1 Multi-instance fan-out

**What:** Several Node processes serve sockets simultaneously. A message sent to someone on instance A reaches someone on instance B.

**Why:** A single Node process is a single point of failure and a hard ceiling on connections. Without this, "scalable" is a word on a CV.

**The challenge:** `io.to(room).emit()` only knows about sockets connected to *this* process. Two instances are two isolated islands.

**The solution:** `@socket.io/redis-adapter`. Emitting publishes to a Redis channel; every instance subscribes and delivers to its own local sockets in that room. No instance needs to know where anyone else is connected.

**The detail that proves you ran it:** three Redis clients, not two. `sub` is a `duplicate()` of `pub` and is in subscriber mode, where it **cannot run ordinary commands**. So presence and rate limiting use a third `cmd` client. Trying to `SET` on the subscriber is the classic failure here.

**How it's demonstrated:** each instance generates an id at boot, exposes it at `/healthz` and in the socket `hello` event, and the UI renders it in the connection banner. Two browser windows showing two different ids while messaging is a visible fact, not a claim.

*Code: [`server/src/realtime/io.js`](../server/src/realtime/io.js), [`server/src/config/redis.js`](../server/src/config/redis.js)*

---

### 2.2 At-least-once delivery with an exactly-once effect

**What:** A message is never silently lost. Retries never create duplicates.

**Why:** The single most common failure in a naive chat app: user sends, connection blips, message vanishes, nobody notices.

**The challenge:** When an ack doesn't arrive, the client **cannot know** whether the server stored the message. Retrying risks a duplicate; not retrying risks losing it.

**The solution:** the client generates a `clientMsgId` (uuid v4) before sending and keeps the message in a localStorage **outbox** until acked. On reconnect, everything unacked is re-sent with the *same* key. A unique index on `(senderId, clientMsgId)` in MongoDB means a retry hits E11000, and the handler returns the message already stored.

**Say this precisely:** transport-level exactly-once is impossible. What you get is at-least-once delivery plus an **idempotent effect at the application layer**. Those are different things and knowing the difference is the point.

**The subtlety:** a duplicate is **not** rebroadcast to the room. A retry means the *sender* never saw its ack, not that the room missed the message. Re-emitting would show everyone else a second copy.

*Code: [`server/src/services/message.service.js`](../server/src/services/message.service.js), [`client/src/realtime/socket.js`](../client/src/realtime/socket.js)*

---

### 2.3 The offline queue that isn't a queue

**What:** Messages sent while you're offline arrive when you reconnect.

**Why:** Obvious product requirement, and the usual implementations are bad.

**The challenge:** The naive design is a `message_receipts` table — one row per recipient per message. That's **O(members) writes per message**. A 500-person group means 500 inserts to send one message. It's also the design an interviewer will attack first.

**The solution:** there is no queue. The append-only message log *is* the queue, and each membership row holds a **high-water mark** into it:

> A message with `seq = S` is delivered to user U if and only if `U.lastDeliveredSeq >= S`.

Everything with `seq > lastDeliveredSeq` is undelivered, by definition. That's **O(1) write per message regardless of group size**, and unread counts become arithmetic on two integers already in the row — `(next_seq - 1) - last_read_seq` — with zero message scanning.

**The critical rule:** the server's watermark is authoritative, never a value the client claims. It advances only on an explicit `sync:ack`. A client can't skip messages by lying, and a client that dies mid-drain simply gets the batch again.

*Code: [`server/src/services/sync.service.js`](../server/src/services/sync.service.js), [`server/src/realtime/handlers/sync.js`](../server/src/realtime/handlers/sync.js)*

---

### 2.4 Presence that can't leave ghosts

**What:** Online/offline indicators that survive a server crash.

**Why:** The previous version of this project stored online users as durable MongoDB rows. Crash the server and those users stayed "online" **forever**. A cleanup job would be the obvious patch — and it can itself fail.

**The challenge:** presence is inherently distributed state. Any instance may need to answer "is Alice online?" when Alice is connected to a different instance entirely.

**The solution — and this is a conceptual fix, not a code fix:** presence is a **lease, not a record**. A Redis set per user holds `instanceId:socketId` members with a 45-second TTL, refreshed by a heartbeat. A dead instance stops refreshing and its users age out automatically.

**The line to say:** *"Presence doesn't survive restarts — it's designed not to. There's no cleanup job because there's no durable state to clean."*

**The optimisation worth mentioning:** the heartbeat is **per-instance, not per-socket** — one Redis pipeline every 15 seconds regardless of how many sockets are attached. Cost scales with the number of servers, not the number of users.

**Two layers, and naming both shows depth:** engine.io's own ping/pong (25s/20s) is transport-level liveness for one connection; the Redis TTL is the cluster-wide view any instance can query.

*Code: [`server/src/services/presence.service.js`](../server/src/services/presence.service.js)*

---

### 2.5 Polyglot persistence

**What:** PostgreSQL and MongoDB, each doing a different job.

**Why:** Because they genuinely have different shapes — not because two databases look impressive. **If you can't justify this crisply, it actively hurts you: it reads as résumé-driven development.**

**Postgres holds** users, conversations, memberships, read/delivery watermarks, refresh tokens. Small, highly relational, needs transactional integrity: a non-member must not post, a DM must be unique per pair, refresh rotation must be atomic. Foreign keys and unique constraints enforce it, not application code.

**MongoDB holds** the message log. Append-only, unbounded, never updated, never joined, always read by the same key — conversation plus a sequence range. **That's a log, not a relation.** It gives a natural shard key in `conversationId` and a document shape that can absorb attachments and reactions without migrating the highest-volume collection.

**The seam is one integer.** Postgres allocates a per-conversation sequence number in the same statement that bumps `last_message_at`. That `seq` is the only thing the message store knows about the relational world — and it's what makes ordering, unread counts, and redelivery work without ever scanning messages.

*Code: [`server/prisma/schema.prisma`](../server/prisma/schema.prisma), [`server/src/models/message.model.js`](../server/src/models/message.model.js)*

---

### 2.6 Authentication

**What:** Register/login/refresh/logout, plus authenticated WebSocket handshakes.

**The design, and why each half differs in *kind* not just lifetime:**

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, 15 min | Opaque random bytes |
| Stored | In memory only (zustand) | SHA-256 hash in Postgres |
| Delivered | `Authorization` header | `httpOnly` cookie, `Path=/api/auth` |
| Revocable | No | Yes — that's the point |

**Why the access token is a JWT:** so every request *and every socket handshake* authorises with a signature check, not a database round trip.

**Why the refresh token is deliberately not a JWT:** a JWT can't be revoked. Being stateful is the feature. Storing only the hash means a database leak yields no usable sessions.

**Why in memory, not localStorage:** XSS can still read an in-memory token, but the blast radius is one tab for fifteen minutes, versus a token sitting in storage for any later script or extension to find. Durability comes from the refresh cookie, which JavaScript can't read at all.

**Rotation with reuse detection:** every refresh burns the presented token and issues a replacement in the same `familyId`. A token presented twice means someone is replaying a stolen copy — and since thief and victim are indistinguishable, the **whole family** is revoked. That caps a theft at one refresh cycle instead of seven days.

*Code: [`server/src/services/token.service.js`](../server/src/services/token.service.js)*

---

### 2.7 Socket handshake auth — expect to be drilled here

Three things to be able to say:

**1. The token goes in the `auth` payload, not the cookie.** The cookie *would* work — the app is same-origin. The explicit payload is transport-agnostic, so it keeps working cross-origin and for a future native client with no cookie jar. Showing you considered both is the answer.

**2. The client must pass `auth` as a *callback*, not an object.**
```js
auth: (cb) => cb({ token: useAuthStore.getState().accessToken })  // correct
auth: { token }                                                   // the bug
```
The callback is re-invoked on every reconnect attempt, so a refreshed token is picked up. The object form snapshots once at construction — the classic bug where everything works for fifteen minutes and then reconnect-loops forever with a token that can never become valid again.

**3. Token expiry mid-connection.** A JWT verified once at handshake stays valid for the **entire life of the socket** — potentially hours past `exp`. A long-lived WebSocket silently converts a 15-minute token into an unbounded session. There's a 60-second sweep that emits `auth:expired` and disconnects, so the client refreshes and reconnects cleanly. **Almost nobody handles this**, so it's disproportionately good to mention unprompted.

*Code: [`server/src/realtime/authSocket.js`](../server/src/realtime/authSocket.js)*

---

### 2.8 The client reliability UI

Without this, all the server work is invisible to anyone browsing the repo.

- **Outbox in localStorage** — survives a reload. Every storage access is wrapped in try/catch, because it throws in private windows and when site data is blocked; a chat app must not white-screen over that.
- **An ack timeout is not treated as failure** — the server may well have stored it. That ambiguity is exactly why retries carry an idempotency key.
- **Dedup on merge** — confirmed messages in `byId`, optimistic ones in `pending`. A message arriving twice renders once; a broadcast overtaking our own ack *promotes* the pending bubble instead of duplicating it.
- **Delivery acks are debounced ~500ms and coalesced to the highest seq**, so a busy room isn't one round trip per message, and the reconnect drain is normally empty.
- **Gap repair** — seeing a seq beyond the contiguous watermark triggers a range fetch.
- **The banner tells the truth** — losing the connection isn't an error; queued messages are safe and will send.

*Code: [`client/src/store/chatStore.js`](../client/src/store/chatStore.js), [`client/src/realtime/socket.js`](../client/src/realtime/socket.js)*

---

## 3. Bugs found and fixed — the best interview material you have

Interviewers ask "tell me about a difficult bug". These are real, and each has a root cause worth explaining.

### 3.1 The upsert that wasn't atomic

**Found by:** a test firing five simultaneous requests to create the same DM. It failed on the first run.

**What happened:** `prisma.upsert` is a SELECT followed by an INSERT, **not** an atomic operation. Under concurrency both requests miss the SELECT, both attempt the INSERT, and the unique constraint rejects the loser with `P2002`. No duplicate row was ever created — the constraint did its job — but the losing request returned a 500 instead of the conversation.

**The fix:** treat `P2002` as the expected outcome of a lost race and read the winner's row.

**Why it matters:** this is the difference between *"idempotent when requests happen to be serial"* and *"idempotent under concurrency"*. The naive upsert looks correct and passes every serial test.

### 3.2 A foreign key that made users undeletable

**Found by:** test cleanup failing with `violates RESTRICT setting of foreign key constraint`.

**What happened:** Prisma defaults a required relation to `ON DELETE RESTRICT`. Because `conversations.created_by` pointed at `users`, **a user who had ever created a conversation could never be deleted at all.**

**Why cascade would be worse:** it would delete a group the moment its creator left, destroying everyone else's history.

**The fix:** `created_by` is nullable with `ON DELETE SET NULL`. Authorship is metadata; **membership** is what governs access.

### 3.3 The history query that returned the oldest messages forever

**Inherited from the original project.** `find().sort({timeStamp: 1}).limit(50)` sorts *ascending* then limits — so it returns the fifty **oldest** messages, permanently. The chat was stuck showing day one.

**The fix:** `sort({seq: -1}).limit(50)`, reversed for render. And cursor pagination on `seq`, never `skip`: skip re-scans from the start and drifts when rows are inserted mid-scroll, which in a live chat is constant.

### 3.4 Stored XSS

**Inherited.** The original rendered messages with `innerHTML` and no escaping, and persisted them — so one `<img src=x onerror=...>` fired for **every future visitor, forever**.

**The fix:** JSX escapes by default, so it's gone structurally. But "the framework handles it" is not a security control, so `react/no-danger` is an ESLint **error** — a *process* control that makes reintroducing it a build failure rather than a code-review question.

**Know the three doors back in:** `dangerouslySetInnerHTML`; user input in an `href` (a `javascript:` URL — allowlist schemes if you ever linkify); and markdown or link-preview rendering, which needs DOMPurify.

### 3.5 A Windows-only path bug

`new URL('../../client/dist/', import.meta.url).pathname` yields `/D:/...` with a leading slash on Windows, which `express.static` can't resolve. It would have worked on Linux and broken only local production testing. Fixed with `fileURLToPath`.

### 3.6 Two React lint findings

`useDemo` was a plain function whose `use` prefix made React's linter treat it as a hook, so calling it from an event handler looked illegal. And `NewChatDialog` called `setState` synchronously in an effect body, causing cascading renders.

---

## 4. The load test — and the hypothesis it killed

**This is your strongest story. Lead with it if they ask about performance.**

### The results

| | 1 instance, 100 clients | 3 instances, 150 clients |
|---|---|---|
| Connect p50 | 3301 ms | **2095 ms** |
| Ack RTT p50 / p95 | 958 / 4829 ms | **650 / 1987 ms** |
| Deliveries | 18 216 | 14 155 |
| Errors | 0 | 0 |

Three instances with *more* clients beat one instance with fewer. That's horizontal scaling, measured.

### Finding the real bottleneck

Absolute latency was poor, so I varied only the number of senders **in the same conversation**:

| Senders | Ack p50 |
|---|---|
| 1 | 488 ms |
| 5 | 958 ms |
| 10 | 4959 ms |

That's the signature of `UPDATE conversations SET next_seq = next_seq + 1` **serialising writes**, with each row lock held across a cross-region round trip. A single uncontended send costs 488 ms — essentially all network, three sequential hops to managed free-tier databases in other regions.

### The part that makes this a good story

I had a hypothesis: the send path did a pre-emptive "have I seen this `clientMsgId`?" read, which looked like an obvious per-message cost. I removed it — **and the numbers didn't move.** The read was never the bottleneck; the row lock was.

I left the read removed, because it's strictly fewer round trips for identical guarantees (the unique index was always what enforced idempotency), and all 53 tests still passed confirming that. But the honest version is: **my guess was wrong, and the measurement corrected me.**

Say exactly that. "I profiled, found the bottleneck wasn't where I thought, and fixed the right thing" is a far stronger signal than a clean number.

### How you'd fix the real bottleneck

1. **Co-locate the databases with the app** — removes most of the constant.
2. **Move sequence allocation to Redis `INCR`** with periodic Postgres checkpointing — removes the serialisation, at the cost of larger gaps after an eviction. Acceptable, because the contract only promises monotonic, not contiguous.

---

## 5. Questions to expect, with answers

### System design

**"Walk me through what happens when I send a message."**
Client generates a `clientMsgId`, renders optimistically, saves to the outbox. Emits with an ack callback and a 8s timeout. Server authorises from the signed token (never the payload), validates with zod, checks a Redis rate limit, allocates a sequence number from Postgres with `UPDATE … RETURNING` under a row lock, inserts into Mongo, broadcasts to the conversation room via the Redis adapter, and acks. The client swaps the optimistic bubble for the server version and drops it from the outbox.

**"What if the ack never arrives?"**
The message stays in the outbox and is re-sent on reconnect with the same key. The server either stores it (first time) or returns the existing one (E11000). The client can't distinguish, and doesn't need to.

**"How would you scale this to a million users?"**
Honestly: the current design doesn't. Concretely — shard Mongo on `conversationId`; move sequence allocation off the Postgres hot row; replace fan-out-on-write with fan-out-on-read for large channels; add a real load balancer; partition the message collection by time. Then admit you've measured to 150 concurrent connections and everything past that is reasoning, not evidence.

**"Why not Kafka / RabbitMQ?"**
A broker would be the right call for cross-service messaging or if I needed replay and consumer groups. Here the durable log already exists in Mongo and the delivery cursor in Postgres, so a broker would be a third system duplicating what those two already do. I'd add one when there are multiple consumers of the message stream — analytics, search indexing, push notifications.

### Databases

**"Isn't two databases over-engineering?"**
Use the §2.5 answer. Then pre-empt: *"the honest counter-argument is that Postgres could hold the messages too — `JSONB` and partitioning would work fine at this scale. I chose the split because the access patterns genuinely differ and because `conversationId` is a natural shard key, but I wouldn't pretend it's forced at this volume."* **That concession makes you more credible, not less.**

**"Isn't that a distributed transaction? What if the Mongo insert fails after Postgres allocated the seq?"**
No, and it doesn't pretend to be. Seq allocation is the only Postgres write on the send path. If the Mongo insert fails, the effect is a burned sequence number — a gap. Gaps are expected anyway, from soft deletes and retries, so the client treats a gap as *fetch this range*, never *data lost*. The invariant needed is that `seq` is **monotonic, not contiguous**, and a single `UPDATE … RETURNING` under a row lock guarantees that.

**"Why not `SELECT MAX(seq) + 1`?"**
Race condition. Two concurrent sends both read the same max and both write the same seq. The `UPDATE … RETURNING` takes a row lock, which serialises them — that's exactly the ordering guarantee I want, and also exactly the bottleneck I measured.

**"Why no read receipts table?"**
One row per recipient per message is O(members) writes per message. High-water marks on the membership row are O(1) regardless of group size, and they make unread counts arithmetic instead of a scan.

### Security

**"Where do you store the JWT?"** — §2.6. In memory; the reasoning about blast radius is the answer.

**"How do you handle a stolen refresh token?"** — Family revocation, §2.6.

**"How is the WebSocket authenticated?"** — §2.7, all three points.

**"What's the biggest security risk left?"**
No end-to-end encryption — the server can read every message. And the membership cache means a removed member keeps access for up to 30 seconds. Both are deliberate trades, documented.

### Real-time

**"Why not `connectionStateRecovery`?"**
It exists in socket.io 4.6+ and it's the right first question. It covers a short window (default 2 minutes), doesn't survive a server restart, and doesn't cover a client offline for an hour. The watermark sync is the durable version. **Knowing the built-in and why it's insufficient is a stronger answer than not knowing it exists.**

**"Why WebSocket-only transport?"**
engine.io's polling handshake spans several HTTP requests that must all reach the same instance — which behind a load balancer means sticky sessions. Dropping polling removes that requirement entirely. The trade is no fallback for corporate proxies that block WebSockets, and a harsher first-connect failure.

**"How do you stop a client flooding the server?"**
A Redis fixed-window counter, 20 sends per 10 seconds. In Redis rather than memory specifically because a per-process limiter is bypassed by reconnecting until you land on another instance. A fixed window allows up to 2× the limit across a boundary; a sliding window would be stricter, but for chat flood control that's an acceptable trade for one `INCR`.

### Testing

**"How do you know delivery is at-least-once?"**
There's a test for it. It connects a client, lets it receive a backlog, kills it **without acking**, reconnects, and asserts the same messages arrive again — and that exactly one copy is stored. The test suite boots two real server instances with separate Redis clients and drives them with real socket clients.

**"Why not mock Redis?"**
`ioredis-mock` can't do cross-client pub/sub, which is precisely the thing under test. Mocking it would test the mock.

**"What's not tested?"**
React components, browser E2E, coverage thresholds. Deliberate and stated in the README — a declared scope beats a silent absence.

### Behavioural

**"Tell me about a bug you're proud of finding."** — §3.1, the upsert race.

**"Tell me about something you got wrong."** — §4, the load-test hypothesis. This is the best one; it shows you measure rather than assume.

**"What would you do differently?"**
TypeScript from the start — it was cut for time and that's a real cost in a codebase with this many shapes crossing a wire. Co-locate the databases before benchmarking. And build the load test *earlier*, because it changed my understanding of the system more than any other single thing.

---

## 6. Where to concede

Confidence is good; overclaiming is fatal. Concede these cleanly:

- **"Have you run this in production?"** No. It's a portfolio project, load-tested locally to 150 concurrent connections.
- **"Is this production-ready?"** No — no E2EE, no media, no search, no observability beyond structured logs, and sequence allocation is a known hot row. Those are listed in the README.
- **"Did you design this from scratch?"** It's a rebuild of an earlier tutorial-grade version of mine. Worth saying: the interesting work was identifying what was wrong with it — no auth, stored XSS, presence that left ghosts forever, a history query stuck on day one.
- **"Why so few tests on the frontend?"** Time. Stated in the README.
- **Anything about Kubernetes, service meshes, or gRPC** — not used, don't pretend otherwise.

---

## 7. Numbers to memorise

| Fact | Value |
|---|---|
| Tests | 53 (9 unit, 44 integration) |
| Reliability tests | 13, across two live instances |
| Load tested to | 150 concurrent connections, 3 instances, 0 errors |
| Uncontended send latency | 488 ms p50 (cross-region DBs) |
| Fan-out deliveries measured | ~18 000 in a 20-second run |
| Access token lifetime | 15 minutes |
| Refresh token lifetime | 7 days, rotating |
| Presence TTL / heartbeat | 45 s / 15 s |
| Rate limit | 20 sends / 10 s |
| Message size cap | 4000 chars |

---

## 8. The one-paragraph close

> The thing I'd want you to take from it is that I treated the failure modes as the actual product. Anyone can make a message appear in another window. What I found interesting was the ambiguity when an ack doesn't arrive, the fact that presence is a lease rather than a record, and that an offline queue doesn't need to be a queue at all. And when I load-tested it, my guess about the bottleneck turned out to be wrong — which is exactly why I load-tested it.
