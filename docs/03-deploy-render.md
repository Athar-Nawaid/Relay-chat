# Deploying to Render (free)

Two web services from one repo, sharing state through Redis, each serving the React UI at its own URL.

The databases stay on Neon, Atlas and Redis Cloud — permanently free, unlike Render's own Postgres.

---

## 0. Push this first, or nothing else matters

The server serves the React build only when `client/dist/index.html` exists — it used to be gated on `NODE_ENV`, which is why a deploy without that variable answered `/` with `{"error":{"code":"NOT_FOUND"}}`.

Make sure your latest `server/src/app.js` is pushed before deploying. Without it the link returns JSON instead of the app.

---

## 1. Create the first service

Render Dashboard → **New → Web Service** → connect the repo.

| Setting | Value |
|---|---|
| Name | `relay-app-1` |
| Region | **Singapore** — same region as the databases |
| Branch | `main` |
| Root Directory | *(leave blank — the repo root)* |
| Runtime | Node |
| Instance Type | Free |

**Build Command** — one line:

```
npm install && npx prisma generate --schema server/prisma/schema.prisma && npx prisma migrate deploy --schema server/prisma/schema.prisma && npm run build --workspace client
```

Four things happen here, and all four are required:
1. install dependencies
2. **generate the Prisma client** — it ships as a placeholder that throws until generated
3. apply migrations
4. **build the React client** — this is what creates `client/dist`, without which you get an API with no UI

**Start Command:**

```
npm run start
```

**Health Check Path:** `/healthz`

---

## 2. Environment variables

Add these under **Environment** before the first deploy.

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `INSTANCE_ID` | `app-1` |
| `LOG_LEVEL` | `info` |
| `BCRYPT_ROUNDS` | `10` — free CPU is slow; 12 can push login past a second |
| `DATABASE_URL` | Neon **direct** URL (*not* the `-pooler` one — it benchmarked 5× slower) |
| `DIRECT_URL` | the same direct URL |
| `MONGO_URL` | Atlas `mongodb+srv://…` — include `/relay` before the `?` |
| `REDIS_URL` | Redis Cloud `redis://default:…` |
| `JWT_SECRET` | 32+ characters |

**Do not set `PORT`.** Render assigns it and the app reads it automatically.

Two easy mistakes: a `MONGO_URL` with no database name silently uses `test` instead of `relay`; and a password containing `@ / ? # :` or `%` must be percent-encoded (`@` → `%40`).

---

## 3. Create the second service

**New → Web Service**, same repo, and everything identical to service 1 **except**:

| Setting | Value |
|---|---|
| Name | `relay-app-2` |
| `INSTANCE_ID` | `app-2` |
| Build Command | **drop the `migrate deploy` step** |

```
npm install && npx prisma generate --schema server/prisma/schema.prisma && npm run build --workspace client
```

Two concurrent `prisma migrate deploy` runs can deadlock on the advisory lock, and service 1 has already applied the schema. Every other environment variable is the same — both services point at the same databases, which is exactly what makes them one cluster rather than two apps.

---

## 4. Seed the demo accounts

Free services have no shell, so run it from your machine against the same database:

```bash
npm run seed
```

Creates `demo1` / `demo2` / `demo3`, password `demo1234`.

---

## 5. Verify

```bash
curl https://relay-app-1.onrender.com/healthz
```

Expect `{"ok":true,"instanceId":"app-1",...}` with all three dependencies up. If `ok` is false, the response names which store is unreachable — usually a wrong password or Atlas Network Access not allowing `0.0.0.0/0`.

Then open the root URL. **You should see the login screen, not JSON.**

Finally, the thing the project exists to demonstrate: open **`relay-app-1` in one browser and `relay-app-2` in another**, log in as `demo1` and `demo2`, and send a message. It crosses between two separate server processes via the Redis adapter, and each connection banner shows a different instance ID.

---

## 6. The free tier's one real cost

Services spin down after 15 minutes idle; the next request takes 30–60 seconds to wake them.

1. **Put a demo GIF at the top of the README, above the link.** Most people who evaluate this never click through — for them the GIF *is* the demo.
2. Add an honest line under the link: *"Free instance — first load takes ~50s to wake."*
3. Optionally keep **one** service warm with an UptimeRobot ping on `/healthz`. The free tier allows 750 instance-hours per month across the account, so keeping both warm would exceed it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/` returns `{"error":{"code":"NOT_FOUND"}}` | `client/dist` missing — the build command skipped `npm run build --workspace client` |
| `@prisma/client did not initialize yet` | `prisma generate` missing from the build command |
| Build fails on `migrate deploy` | `DIRECT_URL` missing, or pointing at the pooled endpoint |
| Starts then exits immediately | A missing env var — the zod check names it in the logs |
| `/healthz` says `ok:false` | The response names the store; usually credentials or Atlas network access |
| Both services show the same instance ID | `INSTANCE_ID` not set on one of them |
| Login very slow | `BCRYPT_ROUNDS` too high for free CPU |

> `render.yaml` in the repo root describes this same setup as a Blueprint. It only applies via **New → Blueprint** — creating services manually ignores it.
