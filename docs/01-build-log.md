# Build log

Running record of what was built, and where reality diverged from [00-cv-rebuild-plan.md](00-cv-rebuild-plan.md). Deviations are recorded with their reason — that reasoning is the interview material.

---

## Cleanup — done

Old tree backed up to `D:\Athar\_backup-chitchat-20260912` before anything was deleted.

**Deleted:** `Src/Athar_Nawaid_Resume_11.pdf` (privacy), `index.js`, `config.js`, `client.js`, `client.html` (the four `innerHTML` XSS sinks), `Schemas/`, old `package.json` + lockfile.

**Kept:** `styles.css` (port source for Block E4), `Src/` media (wallpaper + two sound effects), `.git`.

`.gitignore` rewritten from one line to cover `.env`, build output, coverage and `*.pdf`.

> **Still outstanding:** the resume PDF remains inside the local `.git` object store and in the public GitHub repo's history. Deleting the working-tree copy does not remove either. The remote-side fix is deferred by request.

---

## Block A — Foundation — done

| Item | Status |
|---|---|
| A1 npm workspaces, scripts, eslint + prettier, `.env.example`, zod-validated env, pino logger | done |
| A2 Prisma schema + seed script | schema done, migration **not yet run** (needs a live `DATABASE_URL`) |
| A3 Mongoose message model + indexes, three Redis clients | done |
| A4 Express app: helmet, json limit, error handler, `/healthz`, rate limit, SIGTERM shutdown | done |

**Verified:** `eslint .` exits clean; `prisma generate` validates the schema and emits the client; booting with no `.env` fails fast listing exactly the four missing variables; `@node-rs/bcrypt` produces `$2b$12$` hashes and verifies correctly.

### Deviations from the plan, with reasons

**1. `Int` not `BigInt` for `nextSeq` / `lastDeliveredSeq` / `lastReadSeq`.**
Prisma maps `BigInt` to JS `BigInt`, which throws on `JSON.stringify` — and every one of these values crosses a socket payload on every message. `int4` caps at ~2.1B messages *per conversation*, which is ample. Correctness unchanged, one whole class of runtime footgun removed.

**2. `@node-rs/bcrypt` instead of `bcrypt`.**
`bcrypt` pulls `@mapbox/node-pre-gyp` → `tar`, which carried the only *critical* advisory in the tree, and it needs a native compile at install. The Rust binding ships prebuilt binaries: critical advisory gone, and no node-gyp toolchain needed in the Fly build. API is `hash(input, cost)` / `verify(password, hash)` rather than bcrypt's `compare`.

**3. Workspaces currently lists only `server`.**
`client` is added in Block E1 alongside the Vite setup. Declaring a workspace whose directory has no `package.json` breaks `npm install`.

**4. npm 12 blocks install scripts by default.**
Prisma, esbuild and the bcrypt binding need theirs. Approvals are recorded as `allowScripts` in the root `package.json`, so CI reproduces them rather than depending on an interactive approval.

**5. `citext` requires the `postgresqlExtensions` preview flag.**
Enabled in the generator block. This is what makes usernames case-insensitive at the database level instead of via `.toLowerCase()` scattered through application code.

### Known, accepted

`npm audit` reports 3 high advisories, all one root cause: `deepmerge-ts` inside `@prisma/config` — the Prisma **CLI**, a devDependency. Not in the runtime request path; waiting on an upstream Prisma release.

---

## Block B — Auth — done

| Item | Status |
|---|---|
| B1 register / login / refresh / logout / me, bcrypt cost 12, 15-min access JWT, opaque refresh token stored as sha256, rotation + family reuse detection | done |
| B2 `requireAuth` + `loadUser` HTTP middleware, socket handshake middleware, mid-connection token-expiry sweep | done |

**Verified: 23 tests pass** — 9 unit (JWT round trip, forged-secret rejection, expiry, all four handshake outcomes, and that a `userId` injected into the handshake payload is ignored in favour of the signed token) and 14 integration against the live Neon database, covering registration, duplicate detection, login, protected routes, rotation, reuse detection and logout.

Two of those integration tests initially failed and **the implementation was right both times** — the assertions were wrong, and the failures were informative:

- A token killed by *family revocation* reports `REFRESH_REUSED`, not a distinct "revoked" code. It cannot report anything else: a revoked token carries only `revokedAt`, with no record of whether it died by replay or by family sweep. Failing closed on either is correct, and re-revoking an already-dead family is idempotent.
- Revoking a compromised family does **not** kill the user's other sessions. That is the intended design — a stolen session on one device should not log you out everywhere — and there is now a test asserting exactly that: the compromised chain drops to zero live tokens while an unrelated device keeps its one.

### The design points worth being able to defend

**Access vs refresh are different in kind, not just lifetime.** The access token is a stateless JWT so that every request *and every socket handshake* authorises with a signature check rather than a database round trip. The refresh token is deliberately the opposite: opaque random bytes, stored only as a sha256, so a database leak yields no usable sessions — and being stateful is the point, because it can be revoked, which a JWT cannot.

**Reuse detection.** Every refresh burns the presented token and issues a replacement in the same `familyId`. A token presented twice therefore means someone is replaying a stolen copy — and since we cannot distinguish the thief from the victim, the whole family is revoked and both are forced to log in again. That contains a theft to one refresh cycle instead of the full 7-day lifetime. Revoke-and-reissue runs inside a transaction, or a crash between the two steps would strand the user with a dead token and no replacement.

**Token expiry mid-connection** (`startTokenExpirySweep`). A JWT verified once at handshake otherwise stays valid for the entire life of the socket — a long-lived WebSocket silently converts a 15-minute token into an unbounded session. A 60s sweep emits `auth:expired` and disconnects, so the client refreshes and reconnects cleanly.

**The client must pass `auth` as a callback, not an object.** socket.io re-invokes the callback on every reconnect attempt, so a refreshed token is picked up automatically. An object literal snapshots the token once — the classic bug where everything works for fifteen minutes and then reconnect-loops forever. Noted in `authSocket.js` so Block E3 gets it right.

**Login is rate-limited harder than the rest of the API** (20 per 15 min). Beyond brute force, bcrypt at cost 12 is expensive for *us* too, so an unthrottled login endpoint is a cheap CPU-exhaustion vector.

Auth also failed a login for a non-existent user only after doing a throwaway hash, so response timing does not reveal whether a username exists.

---

## Group chat UI — done (was a planned cut)

The backend always supported groups — `createGroup()` with owner role, covered by tests. Only the UI was missing, and it was on the original cut list. Now built: the new-conversation dialog has DM and Group modes, with a title field and multi-select member chips.

### It exposed a real gap

Sockets join their conversation rooms **at connect time**. So a user who was already online when someone added them to a group sat outside the new room and received nothing until they reloaded — a silently broken feature, not a cosmetic one.

Fixed by calling `io.in(userRoom).socketsJoin(conversationRoom)` on creation. Because that goes through the Redis adapter it reaches the invitee's sockets on **any** instance, not just the one handling the HTTP request. A new `conversation:new` event tells their client to show the conversation without a reload.

Test 8 in the reliability suite asserts exactly this, with creator and invitee deliberately connected to **different instances**: the invitee is notified, and a message sent immediately afterwards arrives with no reconnect. **54 tests** now.

This is a nice demonstration that the adapter does more than fan-out — `socketsJoin` is a cluster-wide operation.

---

## Visual redesign — done

The first UI pass kept the original project's green-and-wallpaper look, which read as a WhatsApp pastiche — precisely the "clone project" impression the whole rebuild is meant to overturn. Replaced with a deliberate visual system.

- **Indigo accent, layered surfaces.** Dark-first, with surfaces distinguished by elevation and one-pixel borders rather than heavy shadows. Closer to a modern developer tool than a consumer messenger, which suits a project whose point is its engineering.
- **Three theme states, not two.** No attribute means follow `prefers-color-scheme`; an explicit choice stamps `data-theme` on the root and wins in both directions. The header cycles system → light → dark. Applied on module load before React paints, so there is no flash of the wrong scheme.
- **The photographic wallpaper is gone** — replaced by a faint dot grid built in CSS. Removed 84 KB and the single most derivative element.
- **Inter**, with a full system fallback stack so a blocked font degrades rather than breaking layout. Verified that helmet's default CSP already permits it: `style-src` and `font-src` both allow `https:`, so no CSP loosening was needed.
- Accent rail on the selected conversation instead of a filled block; tabular numerals on timestamps and counts; monospace for the instance id, leaning into it as a technical detail rather than hiding it.

---

## UI pass — done

Dark mode via `prefers-color-scheme` with the wallpaper as a separate layer so its opacity can drop without washing out the bubbles. Message grouping (consecutive messages from one sender within five minutes share a group, dropping the repeated avatar) and date separators. Sender names shown only in groups — in a DM they are noise.

Mobile now switches between one pane and the other rather than a cramped split, which is how chat apps actually work at that width.

**The sound effects are finally wired up.** Both mp3s had been carried over from the original project and sat unused in `public/`; send and receive now play, with a mute toggle that persists. Every path fails silently — browsers reject audio before a user gesture, and that must never surface as an error.

Also: relative timestamps, an animated typing indicator, a retry affordance on failed messages, and `prefers-reduced-motion` honoured throughout.

---

## Infrastructure consolidation — done

All three databases moved into `ap-southeast-1` (Singapore), and one measured configuration change.

### The connection pooler was costing 325ms per query

Neon's pooled endpoint was the default choice, on the usual advice. Benchmarked against the direct endpoint, 12 runs each:

| Endpoint | `SELECT 1` median |
|---|---|
| Pooled (`-pooler`, `pgbouncer=true`) | **407 ms** |
| Direct | **83 ms** |
| Pooled, no `channel_binding` | 427 ms |
| Direct, no `channel_binding` | 81 ms |

So it is the pooler, not TLS negotiation. The app now uses the direct endpoint.

**The generalisable reason:** a pooler solves a problem this application does not have. PgBouncer exists for serverless runtimes that open a connection per invocation. Here there are long-lived Node processes, and Prisma already maintains its own pool — so the pooler was a second pool in series, adding a hop to every query. Sequence allocation sits on the send path for *every message*, so that hop was paid constantly.

### Effect

| Measurement | Before | After |
|---|---|---|
| 1 sender, ack p50 | 488 ms | **278 ms** |
| 5 senders, ack p50 | 958 ms | **267 ms** |
| 5 senders, ack p95 | 4829 ms | **460 ms** |
| Connect p50 (100 clients) | 3301 ms | **1319 ms** |
| Full test suite wall time | 105 s | **51 s** |

The p95 improvement is over 10×. Note also that 5 concurrent senders are now indistinguishable from 1 — **the row-lock contention has stopped being the limiting factor**. It was never really about the lock itself; it was about holding the lock across a 400 ms query. With the critical section at ~80 ms, serialisation no longer dominates.

The remaining ~260 ms is three sequential round trips from a laptop in India to Singapore at ~83 ms each. That is the measurement rig, not the server, and it disappears when the app runs in the same region.

### Mongo cluster rebuilt

Atlas M0 regions cannot be changed, so the Mumbai cluster was replaced with one in Singapore. Indexes do **not** carry over — rebuilt via `syncIndexes()` and re-verified that the unique `(senderId, clientMsgId)` index rejects a duplicate with E11000, since the whole at-least-once design rests on it.

Redis Cloud likewise recreated in Singapore. Nothing to migrate: presence keys are TTL leases and rate-limit counters expire in seconds.

---

## Block G (partial) — load test and README — done

`loadtest/socket-load.js` plus `loadtest/cleanup.js`. Run with `npm run loadtest`.

Latency is measured as **end-to-end fan-out**: sender emit → a *different* client receiving. All clients live in one process, so the two clocks are identical, which is what makes the figure real rather than an estimate across unsynchronised machines.

### Results

| | 1 instance, 100 clients | 3 instances, 150 clients |
|---|---|---|
| Connections established | 100/100 | 150/150 |
| Connect p50 / p95 | 3301 / 5346 ms | **2095 / 3177 ms** |
| Ack RTT p50 / p95 | 958 / 4829 ms | **650 / 1987 ms** |
| Fan-out p50 / p95 | 958 / 4828 ms | **671 / 1986 ms** |
| Deliveries | 18 216 | 14 155 |
| Errors | 0 | 0 |

Three instances with 150 clients beat one instance with 100 — which is the claim the project exists to demonstrate.

### The bottleneck is the per-conversation row lock, and it was measured

Absolute latency is poor, and the cause is not the application. Holding everything else constant and varying only the number of senders **in the same conversation**:

| Senders | Ack p50 |
|---|---|
| 1 | 488 ms |
| 5 | 958 ms |
| 10 | 4959 ms |

That is the signature of `UPDATE conversations SET next_seq = next_seq + 1` serialising writes, with each lock held across a cross-region round trip to Neon. A single uncontended send costs 488 ms, essentially all of it network: three sequential hops to managed free-tier databases in other regions.

This confirms by measurement the limitation the plan predicted. It stays — strict per-conversation ordering is worth it at this scale — but it is documented in the README as the first thing that would change under load.

### A hypothesis the measurement killed

The send path had a pre-emptive "have I seen this `clientMsgId`?" read, added to avoid burning a sequence number on retries. It looked like an obvious per-message cost, so it was removed — **and the numbers did not move** (p50 4228 ms → 4959 ms, within noise at 10 senders). The read was never the bottleneck; the row lock was.

The read stayed removed, since it is strictly fewer round trips for identical guarantees — the unique index was always the thing enforcing idempotency. But the honest version of the story is that the fix came from the measurement, not the guess, and the guess was wrong. All 53 tests still pass, which is what confirms the index alone is sufficient.

### README

Written against these numbers, not aspirational ones, including the caveat that this measures the application and its network path rather than a production deployment. Architecture and delivery-sequence diagrams are mermaid, which GitHub renders natively — no image files to maintain.

**Two TODO markers remain in the README**, both needing a screen recording I cannot make: the demo GIF at the top and the live demo link.

---

## Block E — React client — done

| Item | Status |
|---|---|
| E1 Vite + React + react-router + zustand, dev proxy for `/api` and `/socket.io` | done |
| E2 Login/Register, auth store, fetch wrapper that refreshes on 401 and retries once | done |
| E3 Socket provider — callback-form `auth`, reconnect handling, connection banner | done |
| E4 Chat shell — conversation list with unread + presence, message list with scroll-up pagination, composer | done |
| E5 **Reliability UI** — localStorage outbox, optimistic bubbles with status, dedup map, gap detection, resend-on-reconnect | done |
| E6 New-chat user search → DM | done |

**Verified:** lint clean across server and client, production build succeeds (223 kB JS / 72 kB gzipped), and the dev server was smoke-tested end to end — Vite serves and transforms JSX, and a real login for `demo1` through the `/api` proxy on port 5173 returned a valid token.

### E5 — where the reliability work becomes visible

- **Outbox in localStorage.** A message stays queued until the server acks it, so closing the tab mid-send, losing the network, or a server restart all end the same way: on reconnect everything unacked is re-sent with its original `clientMsgId`, which the server recognises as a retry.
- **An ack timeout is not treated as failure.** The server may well have stored the message — that ambiguity is exactly why retries carry an idempotency key.
- **Dedup on merge.** Confirmed messages live in `byId`, optimistic ones in `pending`. A message arriving twice (live broadcast, then reconnect backlog) renders once; a broadcast that overtakes our own ack promotes the pending bubble rather than duplicating it.
- **Delivery acks are debounced and coalesced** to the highest seq, so a busy room is not one round trip per message, and the reconnect drain is normally empty.
- **Gap repair.** Seeing `seq` beyond the contiguous watermark triggers a range fetch. A short result means the gap is real — a soft delete, or a number burned by a racing retry — which is expected, since seq is monotonic, not contiguous.
- **The connection banner states the truth**: losing the connection is not an error, queued messages are safe, and it names the instance you are connected to.

### Deviations

**The old CSS was not ported verbatim.** Its palette, bubble treatment and wallpaper are kept, but the layout was rebuilt: the original used viewport units throughout and assumed a single room, and neither survives a sidebar plus a message pane. Rewriting the layout was faster than fighting it.

**Member shape normalised.** `listForUser` returned flat user objects while `createOrGetDm` returned Prisma's nested `{user, role}`. Every endpoint now returns one flat shape, so the client never has to know which query produced a conversation.

### Two lint findings worth keeping

- `useDemo` was a plain function whose `use` prefix made React's linter treat it as a hook, so calling it from an event handler looked illegal. Renamed to `fillDemo`.
- `NewChatDialog` called `setState` synchronously in an effect body, which causes cascading renders. Clearing now happens inside the debounce timer with everything else.

`react/no-danger` is set to **error**. JSX escaping already removed the original stored XSS, but "the framework handles it" is not a security control — this makes the one escape hatch that would reintroduce it a build failure rather than a code-review question.

---

## Block D — Realtime core — done

The differentiator. **53 tests pass**, 13 of them the reliability contract itself.

| Item | Status |
|---|---|
| D1 socket.io + Redis adapter, room joins, `hello` carrying `instanceId` | done |
| D2 `message:send` — authorise, validate, allocate seq, idempotent insert, broadcast, ack, rate limit | done |
| D3 watermark sync — backlog drain on connect, `sync:ack`, `sync:request` | done |
| D4 presence as Redis TTL leases with per-instance heartbeat | done |
| D5 typing indicators | done |
| D6 `read:mark` | done |

### The reliability contract, executable

`tests/integration/reliability.test.js` boots **two real server instances** on ephemeral ports, each with its own Redis pub/sub pair, and drives them with real socket.io clients. It asserts:

1. **Idempotent sends** — the same `clientMsgId` twice stores exactly one document and returns the same `id` and `seq`; the duplicate is not rebroadcast to the room.
2. **Offline queue** — messages sent while the recipient has no socket at all arrive in the backlog on connect.
3. **The watermark advances** — an acknowledged backlog is never resent.
4. **At-least-once** — a client that receives a backlog and dies *without* acking gets the same messages again on reconnect, and exactly one copy is stored. This is the test that answers "how do you *know* it is at-least-once?"
5. **Handshake auth** — missing, forged and expired tokens are all rejected, with `TOKEN_EXPIRED` distinguished.
6. **Authorisation** — a non-member's send is refused, and a `senderId` injected into the payload is ignored in favour of the signed token.
7. **Horizontal scaling** — a message sent on instance A arrives at a client connected to instance B, with the two `instanceId`s asserted to differ; presence transitions propagate the same way.
8. **Ordering** — ten concurrent sends receive strictly increasing, non-duplicated sequence numbers.

### Two harness bugs worth recording

Both multi-instance tests failed first time, and neither was a product defect:

- **`instanceId` was a module-level constant**, so two instances inside one test process reported the same id. Correct in production, where one process *is* one instance — but it made the cross-instance assertion vacuous. `createIo` now takes an `id`, threaded onto `socket.data` so presence leases are tagged with the right owner.
- **The presence test raced a previous test's teardown.** Only the *first* connection announces "online", so a socket still closing from an earlier test suppressed the transition. Fixed by using a user who has never connected, which makes the assertion unambiguous rather than timing-dependent.

### Design points to be able to defend

**The duplicate is not rebroadcast.** A retry means the sender never saw its ack, not that the room missed the message. Re-emitting would show everyone else a second copy.

**The idempotency check reads before allocating.** A retry therefore usually does not burn a sequence number — but a *racing* retry still can, which is why the contract promises `seq` is monotonic, not contiguous. The client treats a gap as "fetch this range", never "data lost". Guaranteeing contiguity would need a cross-store transaction Postgres and Mongo cannot provide between them.

**Failed acks are load-bearing.** The handler never throws silently: a failure acks `{ok: false}`, which is what keeps the message in the client's outbox for retry. Silence would be data loss.

**WebSocket-only transport.** engine.io's polling handshake spans several HTTP requests that must hit the same instance, which behind a load balancer means sticky sessions. Dropping polling removes that requirement. The trade is no fallback for proxies that block WebSockets.

**Three Redis clients, not two.** `sub` is a `duplicate()` in subscriber mode and cannot run ordinary commands, so presence and rate limiting use a separate `cmd` client. Attempting to `SET` on the subscriber is the classic failure here.

**Rate limiting lives in Redis, not memory.** A per-process limiter is bypassed by reconnecting until you land on another instance.

**Graceful shutdown releases presence leases** rather than leaving them to expire, so a rolling deploy does not leave 45 seconds of ghosts.

---

## Block C — Conversation + history HTTP API — done

| Item | Status |
|---|---|
| C1 `GET/POST /api/conversations`, `GET /api/conversations/:id`, `GET /:id/messages`, `POST /:id/read`, `GET /api/users?q=` | done |
| C2 `assertMember()` with a 30s positive-only cache | done |
| C3 smoke file | replaced by 17 integration tests, which are strictly better |

**40 tests pass** (9 unit, 31 integration against live Neon + Atlas).

### A real bug the tests caught

The concurrency test — five simultaneous requests to create the same DM — **failed on the first run**, and the failure was correct.

`prisma.upsert` is a SELECT followed by an INSERT, not an atomic operation. Under concurrency both requests miss the SELECT, both attempt the INSERT, and the unique constraint rejects the loser with `P2002`. No duplicate row was ever created, so the *constraint* was doing its job — but the losing request surfaced a 500 instead of the conversation.

The fix is to treat `P2002` as the expected outcome of a lost race and read the winner's row. This is the difference between "idempotent when requests happen to be serial" and "idempotent under concurrency", and it is the honest version of the claim that the database enforces DM uniqueness. Worth being able to describe in an interview, because the naive upsert looks correct and passes every serial test.

### A modelling flaw the cleanup caught

Deleting a user failed with `violates RESTRICT setting of foreign key constraint conversations_created_by_fkey`. Prisma's default for a required relation is RESTRICT, which meant **a user who had ever created a conversation could never be deleted at all**.

Cascading would have been worse — deleting a group the moment its creator left, destroying everyone else's history with it. `created_by` is now nullable with `ON DELETE SET NULL` (migration `20260912193017_conversation_creator_set_null`): authorship is metadata, whereas membership is what actually governs access.

### Other decisions

**Cursor pagination on `seq`, never `skip`.** `skip` re-scans from the start of the collection and drifts when rows are inserted mid-scroll, which in a live chat is constant. A test walks three pages backwards and asserts all 120 messages appear exactly once, in order.

**The original history bug has a regression test.** `GET /:id/messages` returning the fifty *newest* in ascending order — rather than the fifty oldest forever — is now asserted directly.

**Membership cache stores positive results only.** A non-member must never be admitted by a stale entry; a removed member keeping access for up to 30s is an acceptable trade, and `invalidateMembership()` exists for explicit removals.

**DM creation returns 200, not 201.** The upsert means the caller cannot know whether anything was created, and a 201 would be a claim the server cannot back up.

---

## Infrastructure

| Store | Status |
|---|---|
| **Postgres** (Neon, ap-southeast-1) | connected, migrated, seeded, verified |
| **Redis** (Redis Cloud, ap-south-1) | connected; `PING` plus a real cross-client pub/sub round trip |
| **MongoDB** (Atlas 8.0.32, `firstcluster`) | connected, indexes built and verified |

### Postgres — verified, not assumed

Migration `20260912190806_init` applied. Confirmed directly against Neon:

- All four tables exist (`users`, `conversations`, `conversation_members`, `refresh_tokens`).
- The `citext` extension is installed **and actually works** — looking up `DEMO1` returns the user registered as `demo1`, so case-insensitive usernames are enforced by the database rather than by scattered `.toLowerCase()` calls.
- The plan's unread-count query runs and returns the right shape: 2 DMs + 1 group for `demo1`.
- **The seed is idempotent.** Running it twice still yields exactly 2 DMs, which proves the `dm_key` unique constraint does what Block C's DM-creation upsert relies on.

**Pooled vs direct endpoints.** `DATABASE_URL` is Neon's pooled endpoint with `pgbouncer=true` (a transaction-mode pooler cannot support prepared statements); `DIRECT_URL` is the unpooled one, used by `prisma migrate`, because migrations take advisory locks and run DDL and neither survives a pooler. The schema declares `directUrl` so Prisma picks the right one per operation.

### MongoDB — two problems found, one still open

**Fixed: SRV lookup fails on this machine.** The `mongodb+srv://` form needs a DNS SRV query, and Node's resolver here points at `127.0.0.1` — a local stub that refuses them, so the driver got `ECONNREFUSED` even though the record resolves fine via the OS and via 8.8.8.8. Rather than patch DNS servers into application code, `.env` now uses Atlas's **standard connection string** with the three shard hosts listed explicitly. No SRV lookup, identical behaviour in CI and on Fly. The `replicaSet` and `authSource` values came from the cluster's TXT record, which is exactly what the `+srv` form fetches behind the scenes.

**Fixed: `bad auth`.** The first password supplied was the Atlas *account* login rather than a *database user* password — separate things in Atlas, and the usual trip-up. Resolved with the correct database-user credential.

**Indexes verified against the live cluster**, not just declared:

| Index | Unique |
|---|---|
| `{conversationId: 1, seq: -1}` | no |
| `{senderId: 1, clientMsgId: 1}` | **yes** |

The unique one was tested for real: inserting the same `clientMsgId` twice is rejected with E11000, and exactly one document remains. That is the constraint the whole at-least-once delivery design rests on — a retried send hits the index instead of writing a duplicate — so it is worth having proven rather than assumed.

### Server boot

`/healthz` returns `ok: true` with all three dependencies up and an `instanceId` (`local-…`), which is the hook the multi-instance demo hangs off.

### Credential hygiene

The connection strings were pasted into a chat transcript, so those secrets should be treated as disclosed. Once everything works, rotate the Neon password, the Atlas database-user password and the Redis password, and update `.env`. `.env` itself is gitignored — verified with `git check-ignore`.

---

## What remains

**Needs a push / an account — written but unverifiable here:**
- GitHub Actions workflow (service containers for Postgres, Mongo, Redis; lint → migrate → test → build).
- `fly.toml` + Dockerfile, and the deploy itself.

**Needs a screen recording — cannot be done from here:**
- **Demo GIF #1**: two browser windows, different instance ids visible in the connection banner, a message crossing between them.
- **Demo GIF #2**: kill one instance mid-conversation; the client reconnects to the other and loses nothing.

Both are marked with TODO in the README. They are the highest-value remaining item, because most people who evaluate this will read the README and never clone the repo.

### Also verified along the way

Production mode (`NODE_ENV=production`) serves the built client correctly: `/` and `/login` both return the SPA, `/healthz` reports all three stores up, and an unknown `/api` route still 404s rather than silently returning `index.html`.

That last one exposed a bug: the static path used `new URL(...).pathname`, which yields `/D:/...` on Windows and cannot be resolved by `express.static`. It would have worked on Linux and broken only local production testing. Now uses `fileURLToPath`.

### Still outstanding, unrelated to the build

- The resume PDF remains in the **public GitHub repo's history**. Local copies are gone; the remote is untouched by request.
- Rotate the Neon, Atlas and Redis passwords once finished — they were pasted into a chat transcript.
