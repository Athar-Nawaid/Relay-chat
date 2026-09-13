# Rebuilding Chit-Chat into a CV-worthy project

## Context

The repo currently holds ~530 lines: a single global public chat room in vanilla JS, no auth, no React, two 3-field Mongoose schemas, zero HTTP routes, one-line README, 2 commits. It is a tutorial-tier learning exercise. At 2 YOE, "I built a chat app" is the most common portfolio line there is — it only earns its place if the *hard* parts are built. So the differentiator here is **scale and reliability engineering**, not feature count.

Three things are actively damaging right now:
- **Stored XSS** — `innerHTML` with unescaped user content in [client.js:94,103,128,141](client.js#L94), persisted to Mongo and replayed to every future visitor.
- **Undeployable** despite the commit "Adding for deployment" — `localhost:3000` hardcoded in [client.html:50](client.html#L50) and [client.js:3](client.js#L3), Mongo URI hardcoded in [config.js:5](config.js#L5), no `start` script.
- **Resume PDF committed to a public repo** — `Src/Athar_Nawaid_Resume_11.pdf`, in git history.

Target outcome: a repo whose README opens with a GIF of two server instances exchanging a message, backed by six integration tests that prove at-least-once delivery.

## Scope reality (read this first)

**React rewrite + polyglot persistence + Redis scaling + auth + tests + CI + deploy does not fit in 40 hours done well.** Properly, it's 55–70h. It fits in ~38h **only** with these six cuts already made:

1. **No TypeScript** (saves 6–8h; use zod at the boundaries instead).
2. **No Docker** — managed free-tier Postgres/Mongo/Redis from hour zero, used for local dev too. (Docker isn't installed on this machine; WSL2 setup is a 1–3h detour.)
3. **No design work** — port the existing 226-line [styles.css](styles.css) verbatim. No Tailwind, no component library.
4. **Group-chat UI cut** — the schema supports groups; a seed script creates them. One code path.
5. **Read-receipt UI cut** — the watermark that powers it stays (unread counts need it).
6. **Six integration tests, not a suite** — no Playwright, no React Testing Library.

Violate these and you end hour 40 with a half-finished app, which is worse than today.

---

## Hour 0 — before any code (1.5h)

### 0.0 Project docs folder (5 min)

Create `docs/` at the repo root as the durable home for this plan and everything that follows. Naming convention: `NN-kebab-topic.md`, numbered so the sequence reads in order.

```
docs/
  00-cv-rebuild-plan.md          <- this plan, verbatim
  README.md                      <- one-line index of what each doc is
```

Going forward, every plan, design note, and decision record from this project gets written here under the same convention — `01-…`, `02-…` and so on. Two reasons this is worth the five minutes: it survives the chat session, and a `docs/` folder with real architecture decisions in it is itself a hiring signal when someone browses the repo.

Note `docs/` also holds the architecture diagram and demo GIFs referenced in Block G.

### 0.1 Git/PDF remediation (45 min)

**Recommendation: delete the GitHub repo and start fresh. Do not rewrite history.** Justification: 0 forks / 0 stars / 0 watchers, so there's no history worth keeping and no fork network to leak the blob; the PDF is in the HEAD commit, which is exactly what BFG refuses to rewrite; a `filter-repo` force-push leaves old objects reachable via commit/blob URLs until GitHub GCs, so you'd have to contact Support anyway. Deleting 404s those URLs immediately — and lets you fix the name for free.

```bash
# Backup OUTSIDE the repo first
cp -r "/d/Athar/Chit-Chat-Instant-Messaging-Application" "/d/Athar/_backup-chitchat-20260912"

# Confirm which remote/owner you're actually dealing with, and fix auth.
# `gh` is currently authenticated as khanshaki-r with scopes gist,read:org,repo — no delete_repo.
git remote -v
gh auth status
gh auth login                                    # switch to the account that owns the repo
gh auth refresh -h github.com -s delete_repo

# Re-confirm no forks before deleting
gh api repos/<OWNER>/Chit-Chat-Instant-Messaging-Application --jq '{forks:.forks_count,stars:.stargazers_count}'

gh repo delete <OWNER>/Chit-Chat-Instant-Messaging-Application --yes

# Clean local history and the file
cd "/d/Athar/Chit-Chat-Instant-Messaging-Application"
rm -rf .git && rm -f "Src/Athar_Nawaid_Resume_11.pdf"
# .gitignore BEFORE first commit: node_modules, .env, .env.*, dist, coverage, *.pdf
git init -b main && git add -A && git commit -m "chore: initial commit"
gh repo create <OWNER>/relay-chat --public --source=. --remote=origin --push \
  --description "Horizontally-scalable realtime chat: Socket.IO + Redis adapter, at-least-once delivery, Postgres + MongoDB"
```

Caveats worth knowing: GHArchive records event *metadata* (repo name, file paths) but **not blob contents** — the PDF's contents aren't there. Check `archive.softwareheritage.org` once for the old repo name (unlikely for 0 stars; they have a takedown process). Search `site:github.com Athar_Nawaid_Resume` and use Google's Remove Outdated Content tool if anything surfaces. **What you can't un-publish is whatever the PDF exposed** — open it and inventory the personal details so you know your exposure; the email is rotatable, a phone number isn't.

Prevention: `*.pdf` in `.gitignore` plus a `gitleaks` pre-commit hook (mention it in the README — it's a process signal).

### 0.2 Provision managed DBs (45 min)
Neon Postgres free + Atlas M0 + Redis Cloud Essentials free. Put URLs in `.env`. **Do this now** — it's what buys the no-Docker constraint. Don't code against localhost DBs you'll have to migrate later.

---

## Block A — Foundation (5.5h)

| Task | Hrs |
|---|---|
| A1: npm workspaces scaffold, root scripts, eslint+prettier defaults, `.env.example`, zod-validated `config/env.js`, pino logger | 1.5 |
| A2: Prisma init, schema, first migration, seed script (3 demo users + 1 group + 2 DMs) | 2.0 |
| A3: Mongoose `message.model.js` + indexes; `config/{postgres,mongo,redis}.js` (3 ioredis clients) | 1.0 |
| A4: Express app — helmet, json limit, error handler, `/healthz` reporting PG/Mongo/Redis + `instanceId`, `express-rate-limit`, SIGTERM graceful shutdown | 1.0 |

**Structure** — npm workspaces monorepo (not Turborepo/Nx; overkill, half a day of config):

```
/  package.json (workspaces: server, client)  .github/workflows/ci.yml  docs/  loadtest/
server/prisma/schema.prisma
server/src/  index.js  app.js
             config/{env,postgres,mongo,redis}.js
             models/message.model.js
             http/{routes,controllers,middleware}/
             realtime/  io.js  authSocket.js  events.js  handlers/{message,sync,presence,typing}.js
             services/{message,sync,presence,conversation,token}.service.js
             lib/{logger,errors,instanceId}.js
client/  vite.config.js (proxy /api and /socket.io with ws:true)
client/src/  realtime/  store/{authStore,chatStore,outbox}.js  pages/  components/  styles/app.css
```

**Key decision:** in production Express serves `client/dist` statically, and in dev the Vite proxy makes dev same-origin too. Net effect — **you never write a CORS config**, and the `cors` package (currently imported at [index.js:4](index.js#L4) but not even in package.json, only resolving as a socket.io transitive dep) gets deleted.

### Postgres schema

```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TYPE conversation_type AS ENUM ('dm','group');
CREATE TYPE member_role       AS ENUM ('owner','member');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username citext NOT NULL UNIQUE, display_name text NOT NULL,
  password_hash text NOT NULL, avatar_color text NOT NULL DEFAULT '#6366f1',
  last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type conversation_type NOT NULL, title text,
  dm_key text UNIQUE,                          -- 'uuidA:uuidB' sorted; NULL for groups
  next_seq bigint NOT NULL DEFAULT 1,          -- per-conversation sequence allocator
  last_message_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_conv_last_msg ON conversations (last_message_at DESC NULLS LAST);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role member_role NOT NULL DEFAULT 'member',
  last_delivered_seq bigint NOT NULL DEFAULT 0,  -- offline-queue cursor
  last_read_seq      bigint NOT NULL DEFAULT 0,  -- unread counts
  muted boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id));
CREATE INDEX idx_member_by_user ON conversation_members (user_id);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,             -- sha256(opaque token)
  family_id uuid NOT NULL,                     -- rotation family, reuse detection
  user_agent text, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_rt_user ON refresh_tokens (user_id);
CREATE INDEX idx_rt_family ON refresh_tokens (family_id);
```

**Deliberate omission: no `message_receipts` table.** The obvious design — one receipt row per recipient per message — is O(members) writes per message and is the thing an interviewer will attack. Instead delivery/read state are **high-water marks on the membership row**: message `seq = S` is delivered to user U iff `U.last_delivered_seq >= S`. O(1) write per message regardless of group size, and unread count becomes one join with zero message scanning:

```sql
SELECT c.id, c.type, c.title, c.last_message_at,
       (c.next_seq - 1 - m.last_read_seq) AS unread
FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
WHERE m.user_id = $1 ORDER BY c.last_message_at DESC NULLS LAST;
```

### MongoDB document

```js
// collection: messages
{ _id, conversationId: String, seq: Number, senderId: String,
  clientMsgId: String,   // uuid v4 from browser — the idempotency key
  body: String,          // trimmed, 1..4000
  contentType: String,   // 'text' | 'system'
  createdAt: Date, editedAt: Date|null, deletedAt: Date|null }
```

| Index | Purpose |
|---|---|
| `{conversationId:1, seq:-1}` | The index. History pagination *and* backlog drain (`seq > cursor`). |
| `{senderId:1, clientMsgId:1}` **unique** | Idempotent sends — a retry hits E11000 instead of duplicating. |
| `{createdAt:1}` TTL 90d | Optional retention policy. Cheap README line. |

Do **not** denormalize sender display name; the client caches the member list. Note in the README that you'd denormalize a sender snapshot if history reads became the bottleneck, accepting stale names on rename — that's the tradeoff real chat products make.

### ORM choice
Prisma for Postgres (migrations + generated client + studio; hand-rolling `pg` + a migration runner costs 3–4h you'd rather spend on Block D). **Mongoose for Mongo** — already a dependency, zero learning cost. ioredis for Redis. **Do not use Prisma for Mongo** — it needs a replica set and a second generated client; two purpose-fit tools reads as deliberate, two Prisma clients reads as indecision.

---

## Block B — Auth (4.5h)

| Task | Hrs |
|---|---|
| B1: register/login/refresh/logout; bcrypt cost 12; JWT access 15m; opaque refresh token sha256-hashed in PG, rotation + family reuse detection | 3.0 |
| B2: `requireAuth` HTTP middleware; **socket handshake middleware**; mid-connection token-expiry disconnect | 1.5 |

**Access token** — JWT HS256, 15 min, held **in memory in zustand, never localStorage**. Rationale to state: XSS can still read an in-memory token, but the blast radius is one tab for 15 minutes and it isn't persisted where other scripts or extensions find it later.

**Refresh token** — opaque `crypto.randomBytes(32)`, *not* a JWT, stored as `sha256(token)`. Cookie: `httpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=7d`. Rotated every refresh. **Reuse detection:** a presented token already marked `revoked_at` revokes the entire `family_id` and forces re-login. That's stolen-token containment — highest security value per hour spent.

`SameSite=Lax` works because the client is same-origin in dev (Vite proxy) and prod (Express static). That's why the proxy matters.

**Socket handshake auth — the part interviewers drill:**

```js
// client — the FUNCTION form of `auth` is load-bearing
export const socket = io({ path: '/socket.io', transports: ['websocket'],
  auth: (cb) => cb({ token: useAuthStore.getState().accessToken }) });
```
It's re-invoked on every reconnect, so a refreshed token is picked up. The object form (`auth: {token}`) snapshots once — that's the classic bug where everything works for 15 minutes then reconnect-loops forever.

```js
// server/src/realtime/authSocket.js
io.use((socket, next) => {
  try { const p = jwt.verify(socket.handshake.auth?.token, env.JWT_SECRET);
        socket.data.userId = p.sub; socket.data.exp = p.exp; next(); }
  catch { const e = new Error('unauthorized'); e.data = { code: 'AUTH_FAILED' }; next(e); }
});
```

Three things to be able to say:
1. **Why the auth payload not the cookie?** The cookie *would* work same-origin. The explicit payload is transport-agnostic (works cross-origin, works for a future native client) and is the documented pattern. Show you considered both.
2. **Token expiry mid-connection.** A JWT verified at handshake stays valid for the *life of the connection* — potentially hours past `exp`. Store `exp` in `socket.data`, run a 60s interval that emits `auth:expired` then disconnects. ~30 lines, and almost nobody handles it.
3. **Why not socket.io `connectionStateRecovery`?** It exists (4.6+) and is the right first question. It covers a short window (default 2 min), doesn't survive a server restart, doesn't cover an hour offline. The watermark sync is the durable version. Knowing the built-in and why it's insufficient is a stronger answer than not knowing it exists.

`app.set('trust proxy', 1)` behind Fly/Render, or `express-rate-limit` keys everyone to the same proxy IP.

---

## Block C — Conversation + history HTTP API (3.5h)

| Task | Hrs |
|---|---|
| C1: `POST /api/conversations` (idempotent DM via `dm_key` upsert), `GET /api/conversations` (single-query unread), `GET /api/conversations/:id/messages?beforeSeq=`, `GET /api/users?q=` | 2.5 |
| C2: `assertMember()` helper + 30s in-process Map cache | 0.5 |
| C3: `requests.http` smoke file | 0.5 |

**One schema serves DMs and groups** — `conversations.type` distinguishes them and **nothing else in the code branches on it**. Membership, messages, seq, watermarks, presence, fan-out are identical. The only DM-specific mechanic is uniqueness: `dm_key = [a,b].sort().join(':')` with a UNIQUE constraint, created via `prisma.conversation.upsert({ where: { dmKey }, update: {}, create: {...} })`. Clicking "message Alice" twice returns the same conversation, enforced by the database rather than a read-then-write race in app code. **That is a concrete one-sentence answer to "why did you need Postgres?"**

---

## Block D — Realtime core: THE DIFFERENTIATOR (8h) — never cut

| Task | Hrs |
|---|---|
| D1: socket.io + `@socket.io/redis-adapter`, room joins on connect, `hello` event carrying `instanceId` | 1.0 |
| D2: `message:send` — authorize → zod → seq alloc → idempotent Mongo insert → broadcast → ack; Redis token-bucket flood control | 2.5 |
| D3: Watermark sync — `sync:request` / `message:backlog` (paged) / `sync:ack` → `GREATEST` update; drain on connect | 2.0 |
| D4: Presence — Redis TTL leases, per-instance `EXPIRE` refresh, transition broadcast, `MGET` bulk read | 1.5 |
| D5: Typing indicator (`typing:start/stop`, client 3s auto-expire) | 0.5 |
| D6: `read:mark` → `last_read_seq` | 0.5 |

### Send path — at-least-once with an idempotent effect
1. Client generates `clientMsgId = crypto.randomUUID()`, renders optimistically as `sending`, appends to an **outbox** in zustand mirrored to localStorage.
2. `socket.timeout(5000).emit('message:send', {conversationId, body, clientMsgId}, cb)`.
3. Server: **authorize from `socket.data.userId`, never the payload** → zod validate → Redis token bucket (`INCR rate:{userId}` + `EXPIRE 10`, reject >20/10s) → **allocate seq atomically**:
   ```sql
   UPDATE conversations SET next_seq = next_seq + 1, last_message_at = now()
   WHERE id = $1 RETURNING next_seq - 1 AS seq;
   ```
   The row lock serializes concurrent sends in a conversation — exactly the ordering guarantee wanted. (Follow-up "how would you make this faster?" → "Redis `INCR` with a periodic Postgres checkpoint, accepting gaps after eviction. I chose correctness because the write rate doesn't justify it yet.")
4. Insert into Mongo. **On E11000 this is a retry** — `findOne` the existing doc and ack with it. No duplicate ever written.
5. `io.to('conv:'+id).emit('message:new', dto)` — the DTO **includes `clientMsgId`** so the sender's other tabs reconcile. Then `cb({ok:true, clientMsgId, messageId, seq, createdAt})`.
6. On ack timeout, socket error, or **reconnect**, the client re-emits the outbox. Same `clientMsgId` → server dedups. At-least-once delivery; the unique index turns it into an exactly-once *effect*.

### Receive path — client dedup is protocol, not patch
The same message legitimately arrives twice: live broadcast and reconnect backlog. **State it that way.** Client keeps `messages: Map<messageId,…>` + `pendingByClientId: Map<clientMsgId,…>`. Incoming: if `messages.has(id)` drop; else if `pendingByClientId.has(clientMsgId)` promote (covers broadcast beating the ack); else insert. Render acked messages by `seq` ascending, unacked pinned to the tail.

### The offline queue — there isn't one, and that's the good part
**No queue table, no Redis list.** The Mongo message log *is* the queue; Postgres stores each member's cursor into it. Everything with `seq > last_delivered_seq` is undelivered.

Drain on every connect: server reads `last_delivered_seq` per conversation (**the server's watermark is authoritative, not the client's localStorage** — it only advances on explicit ack, so it can never skip) → `Message.find({conversationId, seq:{$gt:cursor}}).sort({seq:1}).limit(200)` → `message:backlog` → client renders + dedups → `sync:ack {conversationId, upToSeq}` → `UPDATE … SET last_delivered_seq = GREATEST(last_delivered_seq, $1)` (GREATEST prevents regression from out-of-order/duplicate acks).

**Crash between send and ack → the whole batch re-delivers → client dedups. That is exactly at-least-once**, and you can explain why it's neither at-most-once (nothing dropped on failure) nor exactly-once at the transport level (impossible; you get an exactly-once *effect* at the application level via idempotency keys).

Live operation also sends `sync:ack` debounced ~500ms, so the reconnect drain is normally empty.

**Gap detection:** client tracks the highest contiguous seq; on `seq > last+1` it fetches the range. A short range means a real gap (soft delete, or a seq burned by a failed insert). README states the contract: **seq is monotonic, not contiguous.**

### Presence — a lease, not a record
The current ghost-user bug is conceptual: presence is stored durably in Mongo. **Delete `Schemas/activeusers.Schema.js` entirely.**
- Connect: `SADD presence:conns:{userId} "{instanceId}:{socketId}"`, `EXPIRE … 45`.
- **Per-instance heartbeat, not per-socket:** one `setInterval` every 15s pipelines `EXPIRE` for every user with a socket on *this* instance. Scales with instances, not users.
- Disconnect: `SREM`; if set empty, write `last_seen_at` and broadcast `presence:update`.
- Bulk read: one pipelined `EXISTS` per member.

One-sentence answer: **"Presence doesn't survive restarts — it's designed not to. Every key is a TTL lease refreshed by a heartbeat, so a crashed instance's users age out within 45 seconds. There's no cleanup job because there's no durable state to clean."** Name both layers: engine.io ping/pong (25s/20s) is per-connection liveness; the Redis TTL is the cluster-wide view any instance can query.

### Redis adapter
**Three ioredis clients**: `pub`, `sub` (a `.duplicate()` — in subscriber mode it *cannot* run normal commands), and a third `cmd` client for presence/rate-limit keys. **Trying to `SET` on the subscriber is the classic mistake; mentioning it unprompted signals you've actually run this.**

**Sticky sessions:** engine.io's long-polling handshake needs sticky routing. Either configure it at the LB, or set `transports: ['websocket']` to skip polling entirely. Take the second — but state the tradeoff: you lose the fallback for restrictive corporate proxies and the first-connect failure mode is harsher.

**Cheapest possible proof it works:** generate `instanceId` at boot (`process.env.FLY_MACHINE_ID ?? nanoid()`), expose it at `/healthz` and in a `hello` event, render it as a corner badge. A screenshot of two windows showing **two different instance IDs exchanging messages** is self-evidently a multi-instance demo. 15 minutes; it's what makes the README GIF legible.

**Graceful shutdown** (SIGTERM → `io.close()` → drain → close PG/Mongo/Redis) gives README GIF #2: deploy *while chatting*, clients reconnect to the other instance, watermark means nothing is lost.

---

## Block E — React client (8.5h)

| Task | Hrs |
|---|---|
| E1: Vite + React + react-router + zustand; **dev proxy for `/api` and `/socket.io`** | 1.0 |
| E2: Login/Register + auth store + fetch wrapper that refreshes on 401 and retries once | 1.5 |
| E3: Socket provider — `auth` **callback** form, reconnect handling, connection-state banner | 1.5 |
| E4: Chat shell — ConversationList (unread + presence dots), MessageList (scroll-up pagination), Composer; port existing CSS | 1.5 |
| E5: **Reliability UI** — localStorage outbox, optimistic bubbles with status, dedup map, gap detection → backfill, resend-on-reconnect | 2.5 |
| E6: New-chat — user search → create DM (no group UI) | 0.5 |

**E5 is the visible proof of Block D.** Cutting it makes Block D invisible to anyone browsing the repo.

---

## Block F — Tests + CI (3.5h)

**Vitest**, not Jest — the project is `"type":"module"` and Jest+ESM is a known multi-hour tax. Supertest for HTTP.

**The six tests that matter** (`server/tests/integration/reliability.test.js`) — real server on an ephemeral port, two real `socket.io-client` instances:
1. same `clientMsgId` twice → exactly one document persisted (idempotency)
2. receiver offline at send time → receives it in the backlog on connect (offline queue)
3. backlog not re-sent after `sync:ack` (watermark advances)
4. backlog IS re-sent when the client disconnects before acking (at-least-once, no loss)
5. handshake without a valid JWT rejected with `AUTH_FAILED`
6. non-member cannot send to a conversation

**These six tests literally are your CV bullet, executable.** "How do you *know* delivery is at-least-once?" → "Test 4 kills the client mid-drain and asserts redelivery." Worth more than 500 unit tests.

Plus ~1h: auth flow test (register → login → refresh → **replay the old refresh token → expect 401 and the family revoked**) and unit tests for the client merge/dedup reducer.

**Explicitly cut** (say so in the README — stated scope beats silent absence): RTL component tests, Playwright, coverage thresholds.

Local tests point at cloud dev DBs with a `_test` name and a `beforeEach` truncate. CI uses GitHub Actions `services:` containers (postgres:16, mongo:7, redis:7 with health checks) — same code, env-driven. `mongodb-memory-server` is a fallback; **`ioredis-mock` is not**, because cross-client pub/sub is precisely what you're testing.

CI steps: checkout → setup-node 22 → `npm ci` → `npm run lint` → `prisma migrate deploy` → `npm test` → `npm run build --workspace client`.

> Local npm is **8.3.0** with Node 24 — quite old. Run `npm i -g npm@latest` before relying on workspaces.

---

## Block G — Load test, deploy, docs (5h)

| Task | Hrs |
|---|---|
| G1: `loadtest/socket-load.js`, 1-instance and 3-instance runs, results table | 2.0 |
| G2: Deploy, secrets, serve client build, smoke test | 1.5 |
| G3: README + architecture diagram + mermaid sequence + **2 demo GIFs** | 1.5 |

### Deployment
**Fly.io (2 machines, `auto_stop_machines=false`, `min_machines_running=1`) + Neon + Atlas M0 + Redis Cloud free ≈ $3–6/mo.** Fly because two machines make the Redis-adapter demo *real, not theoretical* — the two machines are the portfolio.

Do **not** use Vercel/Netlify for the API (serverless can't hold a WebSocket) — and since Express serves the client build you don't need them. Not Cloudflare Workers either (socket.io needs a Durable Objects rewrite).

**The Upstash trap:** Upstash's HTTP/REST Redis API does **not** support pub/sub, which is exactly what the adapter needs. Their TCP endpoint does. Redis Cloud free avoids the question. Also: Render free **spins down after 15 min idle (30–60s cold start)**; Supabase free **pauses after 7 days inactive** — the demo would die silently in a month.

**Cold start is a recruiter-experience problem, not a technical one.** Mitigations in order: (1) **a 20-second demo GIF at the top of the README, above the link** — most evaluators never click; (2) an honest banner if on a sleeping tier; (3) UptimeRobot/Actions cron ping on `/healthz`; (4) seed demo accounts and put **"Log in as `demo1`/`demo2`"** on the login screen — the fastest path from click to "oh, it works" is two tabs as two users. Don't make them register.

Ops that cost an hour each if forgotten: `trust proxy`, `PORT` from env (the current hardcoded 3000 is the bug), Fly health check on `/healthz`, `prisma migrate deploy` in release (never `migrate dev`).

### Load test numbers, cheaply
`loadtest/socket-load.js`, plain Node: mint JWTs directly with the same secret (skip login — you're measuring the WS path, not bcrypt); spawn N clients on a shared conversation; **embed `Date.now()` in the payload and measure `receivedAt - sentAt` on the receiver** — one process, one machine, identical clocks, which is what makes the latency number legitimate. Record connect p50/p95, **end-to-end fan-out p50/p95/p99**, ack RTT, msg/s, and **sent vs received (must be ≥, never <)**. Run 1 instance then 3 → a before/after table.

**Claim these, not more:** 1,000–2,000 concurrent WS per process; p95 fan-out 20–80ms local; 500–2,000 msg/s; **zero loss under forced disconnects**. Do not claim 10,000 — above ~2k the *generator* is the bottleneck (single-threaded, ephemeral port exhaustion) and an interviewer who has done this will know. Put the caveat in the README: *"single machine, 3 server processes, co-located generator — this measures the application, not the network."* **The caveat makes the number more credible, not less.**

---

## Bug & XSS disposition

| Bug | Fixed in | Root cause to state |
|---|---|---|
| `find().sort({timeStamp:1}).limit(50)` returns the **oldest** 50 ([index.js:37](index.js#L37)) | C1 | Sorting ascending *before* limiting. Fix: `sort({seq:-1}).limit(50)`, reverse for render — cursor pagination on `seq`, not `skip`. |
| Own past messages render as incoming ([client.js:38](client.js#L38)) | E4 — moot | Old client had no identity concept. `MessageBubble` takes `isOwn = msg.senderId === me.id`. |
| `send-message` doesn't verify join, saves `user: undefined` ([index.js:46](index.js#L46)) | B2 + D2 | Trusting client-supplied identity. Identity now from a signed token; authorization is a membership check. |
| `newMessage.save()` unawaited, no catch ([index.js:52](index.js#L52)) | D2 | Silent data loss. Now awaited in try/catch that acks `{ok:false}`; the outbox retries. The ack protocol is what removes the severity. |
| Ghost online users after restart | D4 — moot by deletion | Presence was durable state; now a TTL lease. |

**Stored XSS** — mostly moot in React (`{message.body}` in JSX escapes by default), gone when those four `innerHTML` functions are deleted in E4, and the poisoned Mongo rows die with the recreated DB. **But it can come back through three doors:** `dangerouslySetInnerHTML`; user input in an `href` (a `javascript:` URL — allowlist `http/https/mailto` if you ever linkify); and markdown/link-preview rendering (then you need DOMPurify). Defense in depth anyway, because "the framework handles it" is not a security control — and say exactly that in the README: ESLint `react/no-danger: error` (2 min, and a *process* control reads better than a one-time fix), helmet CSP (10 min), zod length validation server-side.

---

## Cut list, in exact order, if behind at hour 30

1. E6 new-chat UI → seed-script conversations only (−0.5h)
2. D6 read marking → hardcode unread to 0 (−0.5h)
3. D5 typing indicator (−0.5h)
4. G1 3-instance run → report 1-instance honestly, keep the manual 2-instance GIF (−0.75h)
5. B1 refresh rotation/reuse detection → plain 7-day refresh, **and write it under README "Known limitations"** (−1.5h)
6. E5 gap detection/backfill → keep outbox + dedup, drop gap repair (−0.75h)

**Never cut:** Redis adapter, idempotent send + ack, watermark offline queue, TTL presence, socket handshake auth, the six integration tests, README + GIFs.

**Phase 2, only if more time — label it as such in the README:** TypeScript migration · message search · attachments via presigned URLs · Playwright · Docker Compose · OpenTelemetry · reactions/threads · Web Push · read-receipt UI · group admin · E2EE.

---

## Naming

**Rename to `relay-chat`.** "Chit-Chat Instant Messaging Application" says the same noun three times, reads like a course assignment (precisely the impression you're overturning), carries zero information about what's technically interesting, and is inconsistent with `package.json`'s `chatter-app`. Avoid anything ending in `-clone`.

GitHub description (this is what shows in search and on your profile grid, carrying at least as much weight as the name):
> *Horizontally-scalable realtime chat — Socket.IO + Redis pub/sub adapter, at-least-once delivery, Postgres + MongoDB polyglot persistence.*

`relay` nods at IRC — Internet Relay Chat — an unforced signal you know where the problem space came from. Set `package.json` `name` to match. The rename is free since you're creating a fresh repo anyway.

---

## The polyglot justification — say this out loud

> "The two stores have different access patterns and different consistency needs. Identity, membership and read state are small, highly relational, and need transactional integrity — a non-member must not be able to post, a DM must be unique per pair, refresh-token rotation must be atomic — so that's Postgres, with foreign keys and unique constraints doing the enforcing instead of application code. Messages are the opposite: append-only, unbounded, never updated, never joined, always read by the same key — conversation plus a sequence range. That's a log, not a relation. Mongo gives me a natural shard key in `conversationId` and a document shape that absorbs attachments and reactions without a migration on the highest-volume collection. The seam between them is a single integer: Postgres allocates a per-conversation sequence number in the same statement that bumps `last_message_at`, and that `seq` is the only thing the message store needs to know about the relational world. It's also what makes ordering, unread counts, and at-least-once redelivery work without ever scanning the messages."

**Pre-arm the follow-up — "isn't that a distributed transaction?"** In the README:
> "There's no cross-store transaction and I didn't fake one. Seq allocation is the only Postgres write on the send path; if the Mongo insert then fails, the effect is a burned sequence number — a gap. Gaps are expected anyway, from soft deletes and idempotent retries, so the client treats a gap as 'fetch this range', not 'data lost'. The invariant I need is that `seq` is **monotonic**, not contiguous, and a single `UPDATE … RETURNING` under a row lock guarantees that."

---

## README structure

1. Title, one-line pitch, badges, **live demo link + demo credentials**
2. **The GIF, immediately** — two windows, two visible *different* instance IDs, a message crossing between them
3. **"What makes this different from a tutorial chat app"** — multi-instance via Redis adapter; at-least-once with idempotent sends; offline queue via per-member watermarks; TTL-leased presence that can't leave ghosts
4. Architecture diagram (Excalidraw → PNG, 30 min)
5. Why two databases — the paragraph above, plus the distributed-transaction answer
6. Delivery sequence diagram — mermaid, which GitHub renders natively (free, no image file)
7. Data model — the DDL and Mongo doc inline
8. **Reliability guarantees as a contract** — at-least-once; per-conversation ordering by monotonic-but-not-contiguous seq; idempotent sends keyed on `clientMsgId`; presence eventually consistent within 45s
9. Load test results + `npm run loadtest` to reproduce
10. **Known limitations / what I'd do next** — *do not skip, it's a hiring signal*: no E2EE; fan-out-on-write; no media; seq allocation is a per-conversation hot row; no search; presence is per-user not per-device
11. Local setup — five commands + env table
12. Testing — what's covered and what's deliberately not

---

## The CV bullet

> **Real-time chat platform (Node.js, Socket.IO, React, Redis, PostgreSQL, MongoDB)** — Built a horizontally-scalable messaging backend with a Redis pub/sub adapter across 3 instances, at-least-once delivery via client-generated idempotency keys with server acks, and watermark-based offline queues; load-tested to 1,500 concurrent WebSocket connections at p95 <60 ms end-to-end delivery with zero message loss under forced disconnects.
> Designed polyglot persistence — PostgreSQL (Prisma) for users, conversations and read-state under transactional integrity; MongoDB for the append-only message log — with JWT handshake auth and rotating refresh tokens, a React client with optimistic UI and reconnect resync, integration-tested with Vitest and deployed on Fly.io via GitHub Actions CI.

Every claim is backed by a file in the repo or a number in the README. That's the point.

---

## Verification

End-to-end, in order:

1. `npm run lint && npm test` — six reliability tests green, auth-flow test green.
2. `npx prisma migrate deploy && npm run seed` — three demo users, one group, two DMs.
3. **Two-instance local check:** `PORT=3000 npm run dev:server` and `PORT=3001 npm run dev:server` against the same Redis. Open two browsers, one against each. Confirm the corner badge shows **different instance IDs** and messages cross. This is the core claim — verify it before anything else.
4. **Offline queue:** kill browser B's tab, send 3 messages from A, reopen B → all 3 arrive via backlog, exactly once. Then disconnect B *mid-drain* (devtools offline) → on reconnect the batch redelivers and the client dedups (no duplicate bubbles).
5. **Presence ghost check:** hard-kill an instance (`kill -9`) with users connected → those users disappear from the online list within 45s with no cleanup job run.
6. **Idempotency:** in devtools, emit `message:send` twice with the same `clientMsgId` → `db.messages.countDocuments({clientMsgId})` returns 1.
7. **Auth:** connect a socket with a garbage token → `connect_error` with `AUTH_FAILED`. Replay a used refresh token → 401 and the whole family revoked.
8. `npm run loadtest` against 1 then 3 instances → fill the README table; confirm received ≥ sent.
9. **Graceful shutdown:** `fly deploy` while chatting in two windows → clients reconnect, no message lost. Record as GIF #2.
10. Deployed smoke: `/healthz` returns all three DBs up; log in as `demo1`/`demo2` in two browsers from the public URL.
