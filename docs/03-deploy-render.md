# Deploying to Render (free)

Two web services from one repo, sharing state through Redis — so the multi-instance behaviour the project is built around is actually deployed, not just claimed.

The databases stay where they are: Neon, Atlas and Redis Cloud are permanently free, whereas Render's own free Postgres expires. Render runs only the Node app.

---

## Before you start

- [ ] Code pushed to GitHub (Render deploys from a repo — this is the one step that needs git)
- [ ] Your three connection strings to hand, from `.env`
- [ ] A Render account (free, GitHub sign-in, no card)
- [ ] **All three databases in the same region** — see below

### Put the databases in one region first

A single send makes three sequential round trips: Redis for the rate-limit check, Postgres to allocate a sequence number, Mongo to insert. Split across regions that is roughly **125 ms of pure network per message**; co-located it is closer to **5 ms**.

Render has no Mumbai region, so **Singapore (`ap-southeast-1`) is the point to consolidate on**:

| Service | Action |
|---|---|
| Neon Postgres | Already in Singapore — nothing to do |
| MongoDB Atlas | Recreate the M0 cluster in **AWS / Singapore** |
| Redis Cloud | Recreate the free database in **Singapore** |

**Atlas:** an M0 cluster's region cannot be changed, and the free tier allows one M0 per project — so delete the existing cluster and create a new one. Nothing is lost: `npm run seed` rebuilds the data. Afterwards, re-create the database user and set **Network Access → 0.0.0.0/0**, or the app will hang until it times out.

**Redis Cloud:** create a new free database in Singapore, delete the old one, update `REDIS_URL`. There is nothing to migrate — presence keys are ephemeral by design and rate-limit counters expire in seconds.

This is twenty minutes for roughly a 20× improvement on the latency you control, and it is what makes the load-test numbers in the README worth quoting.

---

## 1. Push the repo

Render needs a GitHub repo to watch. If you are creating a fresh one — which you should, since the resume PDF is still in the old history — this is the moment.

---

## 2. Create the Blueprint

1. Render Dashboard → **New → Blueprint**
2. Connect your GitHub account and pick the repo
3. Render finds [`render.yaml`](../render.yaml) and shows **two services**: `relay-app-1` and `relay-app-2`
4. It prompts for the five secrets marked `sync: false`. Paste them from your `.env`:

| Key | Value |
|---|---|
| `DATABASE_URL` | Neon **direct** URL — *not* the `-pooler` one. It benchmarked 5× faster; see the README |
| `DIRECT_URL` | The same direct URL. Migrations require a direct connection |
| `MONGO_URL` | Atlas — use the `mongodb+srv://` form here, with `/relay` before the `?` |
| `REDIS_URL` | Your Redis Cloud TCP URL |
| `JWT_SECRET` | The long hex string |

5. **Apply**

`app-2` inherits all five from `app-1`, so you enter them once.

First build takes 5–10 minutes. `app-1` applies the database migrations during its build; `app-2` deliberately does not, because two concurrent `migrate deploy` runs can deadlock on Prisma's advisory lock.

---

## 3. Seed the demo accounts

Free Render services have no shell, so run the seed from your own machine — it writes to the same Neon database:

```bash
npm run seed
```

If you already seeded during development, `demo1` / `demo2` / `demo3` are there and this is a no-op.

---

## 4. Verify

You get two URLs, something like:

- `https://relay-app-1.onrender.com`
- `https://relay-app-2.onrender.com`

```bash
curl https://relay-app-1.onrender.com/healthz
```

Expect `{"ok":true,"instanceId":"app-1",...}` with all three dependencies up. Check `app-2` too — same response, different `instanceId`.

Now the real test: open **`app-1` in one browser and `app-2` in another**, log in as `demo1` and `demo2` (password `demo1234`), and send a message. It crosses between two separate server processes via the Redis adapter, and each banner shows a different instance ID.

**That is your demo GIF.**

---

## 5. The free tier's one real cost

Free services **spin down after 15 minutes of inactivity**, and the next request takes 30–60 seconds to wake them.

This is a recruiter-experience problem, not a technical one — someone clicks your link, sees a spinner for a minute, and leaves. Three mitigations, in order of value:

1. **Put the demo GIF at the very top of the README, above the link.** Mandatory regardless of hosting. Most people who evaluate you will never click through, so the GIF *is* the demo for them.
2. **Say so honestly** under the link: *"Free instance — first load takes ~50s to wake."* Honesty reads better than an app that appears broken.
3. Optionally, an [UptimeRobot](https://uptimerobot.com) monitor pinging `/healthz` every 5 minutes keeps one service warm. Note the free tier allows **750 instance-hours per month across your account** — two always-warm services would exceed that, so keep at most one warm and let the other sleep.

---

## 6. Record the two GIFs

**GIF 1 — horizontal scaling.** Two browser windows side by side, banners showing *different* instance IDs, a message typed in one appearing in the other.

**GIF 2 — resilience.** In the Render dashboard, suspend `app-1` while chatting. That client shows "Reconnecting…", queued messages stay safe, and nothing is lost when it comes back. Resume it afterwards.

Record with ScreenToGif (Windows). Keep each under 20 seconds.

---

## 7. After deploying

- Put the live URL and the demo credentials at the top of the README, replacing the TODO markers
- Update the CV bullet only with numbers you can still defend — deploying does not change your measured figures, and Render's free CPU is slower than your laptop
- **Rotate the three database passwords**, then update them in Render's dashboard under each service's Environment tab

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Build fails on `prisma migrate deploy` | `DIRECT_URL` missing or pointing at the pooled endpoint. Migrations need the direct one. |
| Service starts then immediately exits | A missing env var. The zod check in `config/env.js` prints exactly which one — check the logs. |
| `/healthz` reports `ok: false` | One database is unreachable. The response names which; usually Atlas Network Access not allowing `0.0.0.0/0`. |
| WebSocket never connects, page loads | Check the browser console. Render supports WebSockets on free services, so this is normally an expired `JWT_SECRET` mismatch between the two services. |
| Both services show the same instance ID | `INSTANCE_ID` did not apply. Check each service's Environment tab. |
| Very slow login | `BCRYPT_ROUNDS` too high for free CPU. The blueprint sets 10; the README notes the trade-off. |
