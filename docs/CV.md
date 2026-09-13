# Putting this project on your CV

Ready-to-paste copy, plus the reasoning — so you can adapt it rather than just copy it.

**The governing rule: every number here is one you can defend.** A CV bullet is a promise that you can talk about it for ten minutes. An inflated number doesn't get caught by the ATS — it gets caught in the interview, where it costs you the whole project's credibility, not just that line.

---

## 1. The default version — use this

Two lines. Fits a standard Projects section.

> **Relay — Real-time chat platform** · Node.js, Socket.IO, React, Redis, PostgreSQL, MongoDB · [github.com/…](#)
> Built a horizontally-scalable messaging backend running across multiple instances via a Redis pub/sub adapter, with at-least-once delivery guaranteed by client-generated idempotency keys and server acks, and an offline message queue implemented as per-member watermarks into an append-only log rather than a queue table. Designed polyglot persistence — PostgreSQL for users, conversations and read state under transactional integrity; MongoDB for the message log — with JWT socket-handshake auth and rotating refresh tokens with reuse detection. Load-tested across 3 instances with zero message loss under forced disconnects; 53 integration tests including a suite that boots two live server instances.

**Why it's built this way:** the first sentence names the hard problem (distributed delivery guarantees), the second names a deliberate design decision you can defend, the third is evidence. Most 2-YOE project bullets are a feature list — "built a chat app with login, groups and file sharing" — which says nothing an interviewer can probe.

---

## 2. Shorter variants

### One line (when space is tight)

> **Relay — Real-time chat** (Node.js, Socket.IO, React, Redis, PostgreSQL, MongoDB): horizontally-scalable messaging with at-least-once delivery via idempotency keys, watermark-based offline queues, and TTL-leased presence; 53 tests, load-tested across 3 instances with zero message loss.

### Three lines (for a portfolio or a projects-heavy CV)

> **Relay — Real-time chat platform**
> *Node.js · Socket.IO · React · Redis · PostgreSQL · MongoDB · Prisma · Vitest*
> • Scaled fan-out horizontally with a Redis pub/sub adapter so messages reach clients on any instance; verified with an integration suite that boots two live servers and asserts cross-instance delivery.
> • Guaranteed at-least-once delivery using client-generated idempotency keys, server acks and a persisted client outbox; a unique index turns a retry into a no-op, giving an exactly-once effect without a distributed transaction.
> • Implemented the offline queue as per-member high-water marks into an append-only log — O(1) writes per message regardless of group size, versus O(members) for a receipts table.
> • Load-tested to 150 concurrent WebSocket connections across 3 instances with zero errors; profiling identified the per-conversation sequence lock as the bottleneck and the fix as moving allocation to Redis.

---

## 3. Tailoring by role

**Backend / distributed systems** — lead with the reliability engineering. Keep: Redis adapter, at-least-once delivery, the watermark queue, polyglot persistence, the load-test finding. Cut: React, the UI.

**Full-stack** — the default version in §1 is already this. Add one clause on the client: *"React client with optimistic UI, a localStorage outbox and reconnect resync."*

**Frontend-leaning** — invert it:
> Built a React client for a real-time chat platform with optimistic message rendering, a persisted outbox that survives reloads and network loss, client-side de-duplication for messages that legitimately arrive twice, and gap detection with range backfill; backed by a Node/Socket.IO service running across multiple instances.

---

## 4. Numbers you can defend

| Claim | Status |
|---|---|
| 3 server instances, cross-instance delivery | ✅ Measured, and there's a test asserting it |
| 150 concurrent WebSocket connections, 0 errors | ✅ Measured |
| Zero message loss under forced disconnects | ✅ There is a test that kills a client mid-drain |
| 53 tests | ✅ Run `npm test` |
| ~18,000 fan-out deliveries in a 20-second run | ✅ Measured |
| O(1) writes per message vs O(members) | ✅ True by design, explainable |

### Do NOT claim

| Tempting | Why not |
|---|---|
| "1,500+ concurrent connections" | You measured **150**. Anyone who's run a socket load test will ask about the generator, and the number unravels. |
| "p95 latency under 60 ms" | Your measured p95 is **466 ms**, and ~250 ms of that is your laptop's round trip to Singapore. Quote 466 ms with the caveat, or re-measure once deployed — but do not invent 60 ms. |
| "Production-ready" / "deployed at scale" | It isn't deployed yet and has no users. |
| "Microservices" | It's one service. Saying otherwise invites questions you can't answer. |
| "Docker / Kubernetes / CI-CD" | Not built. Add them to the CV **only** after you've actually added them to the repo. |

**If you want better latency numbers**, run the load test against databases on the same machine instead of free-tier instances in Singapore and Mumbai. The current figures are network-bound, not application-bound — a local run would be a fairer measure of the code, and would legitimately let you claim far better numbers. That's worth an hour if you want the bullet to be stronger.

---

## 5. Skills this project legitimately supports

Add these to your skills section only if they're genuinely here — they all are:

**Languages & runtime:** JavaScript (ES2023), Node.js, SQL
**Backend:** Express, Socket.IO, WebSockets, REST API design, JWT auth, rate limiting
**Data:** PostgreSQL, MongoDB, Redis, Prisma, Mongoose, schema design, indexing, cursor pagination
**Frontend:** React 18, Vite, zustand, optimistic UI
**Practices:** integration testing (Vitest, Supertest), load testing, structured logging, graceful shutdown

**Concepts worth naming explicitly if the job description mentions them:** at-least-once vs exactly-once delivery, idempotency, horizontal scaling, pub/sub, optimistic concurrency, polyglot persistence.

---

## 6. Naming and the repo description

**Rename the repo to `relay-chat`.** "Chit-Chat Instant Messaging Application" says the same noun three times, reads like a coursework title, and carries zero information about what's technically interesting — which is the whole reason the project exists.

GitHub description (this shows in search results and on your profile grid, so it carries as much weight as the name):

> Horizontally-scalable realtime chat — Socket.IO + Redis pub/sub adapter, at-least-once delivery, Postgres + MongoDB polyglot persistence.

---

## 7. Where it goes, and how much space

At 2 years' experience, **work experience still comes first.** This is a Projects section entry, not the headline of your CV.

Give it **one entry, 2–4 lines**. If it's your only substantial personal project, it can be the only thing in the section — one strong project beats four shallow ones, and a list of four tutorial apps actively signals that none of them went deep.

Include the GitHub link. **Make sure the README is the first thing a visitor sees** — that's where the architecture diagrams, the reliability contract and the measured numbers live, and it's what turns a CV line into a conversation.

---

## 8. Before you send the CV anywhere

- [ ] Repo renamed to `relay-chat` with the description above
- [ ] **Resume PDF removed from the public repo's history** — it's still there
- [ ] README demo GIF recorded (two windows, different instance IDs, a message crossing)
- [ ] Deployed, or the demo link removed from the README — a dead link is worse than none
- [ ] Database passwords rotated
- [ ] Every number in your bullet cross-checked against §4

---

## 9. If a recruiter asks about it on a screening call

Non-technical recruiters want the *shape*, not the mechanism:

> It's a chat application, but the interesting part isn't the chatting — it's making sure messages are never lost. If your phone loses signal mid-message, or the server restarts, or you're offline for an hour, the message still arrives exactly once when you come back. And it runs across multiple servers at the same time, so it doesn't fall over when one does.

For a technical screen, use the 30-second pitch in [02-interview-guide.md](02-interview-guide.md) instead.
