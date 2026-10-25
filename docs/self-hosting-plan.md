# Self-hosting the Obysphere: the plan

The owner's ask of 2026-10-25: anyone hosts their team's Obysphere with the easiest setup in the world, on the platform they already use: Cloudflare (the button Deskree uses, kept and polished), Railway, Coolify, Docker on any VPS, and Vercel if it can work. This is the plan. Nothing here is built yet; one spike was run on a Mac, and it is marked as such.

**In short:** keep the Worker and its Deploy to Cloudflare button as the main path. Add **one Docker image** of the same server (Bun, SQLite on one volume, a thin layer standing in for D1 and the Durable Objects), which serves Railway, Coolify, a plain VPS, Fly.io and Render. Skip Vercel for now.

## What the Sphere needs (from the code, `dev` at 3554f8c)

| Part | Where | What it takes from Cloudflare | Off Cloudflare |
|---|---|---|---|
| The HTTP API | `server/src/app.ts`, `routes/`, `protocol/` | A `fetch(request, env)` handler | Runs as it is on Bun or Node |
| The database | `server/src/db.ts` and 13 other files; `server/migrations/` (5) | 104 queries through D1's API: `prepare`, `bind`, `first`, `all`, `run`, and `batch` as one transaction | A D1-shaped adapter over SQLite keeps every call and migration as it is |
| The Doorbell | `server/src/doorbell.ts` | A Durable Object per Obi holding hibernating WebSockets that wake its long poll | In-process: one wake-up per Obi. If it can't be reached, polls already fall back to reading the database every 250 ms |
| The phone relay | `server/src/relay.ts` | A Durable Object per Mac: tagged WebSockets, ping/pong auto-response, alarms, its own storage | In-process registry, one WebSocket server, `setTimeout` for alarms, a SQLite table for storage |
| The job channel | `server/src/channel.ts` | A Durable Object per run_request exchange | Only compute sharing uses it, which Oby is cutting (obi-ai-bot/oby, docs/trim.md): left out of the container |
| Settings | `server/src/env.ts`, `wrangler.jsonc` | `SPHERE_OPERATOR_TOKEN` (secret), `GOOGLE_CLIENT_ID`, `CREATOR_WORKSPACES`, `SPHERE_CREATE_LIMIT` | Environment variables |
| An address | Invite links, Oby pins the host | `*.workers.dev`, or a custom domain on the account | HTTPS from the platform, or Caddy on a VPS |

No crons. About 3,100 lines of TypeScript in `server/src`.

## Two shapes, one codebase

1. **The Worker**, as today, from the Deploy to Cloudflare button: free for a small team, and the only button that makes D1, the Durable Objects and the secret together.
2. **One container**: the same app on Bun, with a platform layer of three small files:
   - `d1.ts`: D1's shape over `bun:sqlite`, so `db.ts` and the routes don't change, and the same migrations apply at start, recorded as D1 records them.
   - `objects.ts`: one in-process instance per Doorbell and per phone relay, `Bun.serve`'s WebSockets with tags, alarms on `setTimeout`, storage in a SQLite table.
   - `main.ts`: reads the settings from the environment, keeps everything in `/data`, refuses plain HTTP except from localhost, and sends no telemetry.

   Images go to `ghcr.io/obi-ai-bot/obi-sphere`, with a version tag and `latest`. The acceptance test is the conformance suite (`pnpm conformance`, `server/conformance`) passing against the Worker and the container alike.

**Why not run the Worker unchanged in a container?** The repository already runs it outside Cloudflare (`scripts/local.mjs`, wrangler's own dev server on workerd), and Oby's end-to-end suite does exactly that. But:

- **Spike (2026-10-25, this Mac):** a local Sphere on `scripts/local.mjs` used about **410 MB idle and 440 MB after 300 requests** (wrangler's Node process 240 MB, two workerd processes about 80 MB each). That's a 1 GB VPS at least, for tooling not built for production. The native Bun container isn't measured yet; similar Bun servers usually sit near 60 to 100 MB.
- **workerd itself:** its Durable Objects are single-instance and "not production-ready" (Cloudflare, 2026-10-09).
- **celld** (the Deno team's runtime for Workers apps): it needs an object-storage bucket even on one node.
- **Later:** Cloudflare is merging the two into a first-class self-hosted workerd, with no dates. When it ships, the container could become the Worker itself and the platform layer could go.

## Every target

| Target | Works? | How | One click? | A small team, per month | Updates |
|---|---|---|---|---|---|
| **Cloudflare** | Yes, today | The Worker, D1, the Durable Objects | Yes: the button makes all of it and asks for the token | $0 on Free (about 15 people with Oby running, docs/run-your-own.md); $5 Workers Paid past that | Cloudflare copies `server/` into the user's own repository and redeploys on each push. Taking a newer server is a copy by hand today |
| **Railway** | Yes, with the container | The image plus a volume | Yes: a template and its button | About $5 (Hobby, which includes $5 of use) | A template built from this repository tells its users when it changes, and they choose to update. Not for templates built from an image, so ours builds from the repository |
| **Coolify** | Yes, with the container | `compose.yaml` from the repository (Compose build pack) | Close: "Docker Compose from a public repository" with its URL. The service catalog is paused for outside contributions and needs 1,000 stars | A VPS Coolify accepts (at least 2 GB and 2 CPUs) | Redeploy from Git in Coolify |
| **Any VPS (Docker)** | Yes, with the container | `compose.yaml` (the Sphere and Caddy) and `.env` | Two downloaded files and `docker compose up -d` | The cheapest VPS: 512 MB should do for the container (to measure) | `docker compose pull && docker compose up -d` |
| **Fly.io** | Yes | The image, `fly.toml`, one volume | No button: `fly launch` from the repository | About $2.35 (256 MB plus a 1 GB volume) | `fly deploy` |
| **Render** | Paid plans only | `render.yaml` and a disk | Yes, a Deploy to Render button | About $7.25 (Starter plus 1 GB disk) | Render's own deploys, set not to follow every push here |
| **Vercel** | Not now | — | — | Pro, at least $20, plus Redis and a database | — |

### Vercel, plainly

Vercel's Functions have taken WebSockets since 2026-10-20. Still, a Sphere there is the wrong fit:

- **Connections end:** each connection stays on the instance that took it and closes at the function's maximum duration (300 s on Hobby, 800 s on Pro).
- **Fan-out needs Redis:** reaching sockets on other instances needs Upstash Redis's pub/sub, by Vercel's own advice.
- **D1 has to be replaced:** by Neon or Turso, which for Postgres means changing the SQL.
- **Memory is billed while a connection is open:** a Mac's relay, always open, keeps an instance alive all month, about four times Hobby's allowance.

If it's ever wanted, the smallest working shape is Vercel Pro, Upstash Redis and Turso.

Sources for all of this are at the end.

## The steps, counted

Every path starts in Oby, which already makes the operator token and copies it to the clipboard (Settings › Obysphere › Host your own). Oby gains a choice of where (Cloudflare, Railway, Coolify, your own server), opens that platform's page, and ends by joining the new Sphere. "Paste" is the token, or the server's address.

| Target | From nothing to "Oby joined" | Pastes |
|---|---|---|
| Cloudflare today | Deploy…, sign in to Cloudflare and GitHub, paste the token, Deploy, find the address in the dashboard, paste it into Oby, Use it | 2 |
| **Cloudflare, polished** | Deploy…, sign in, paste the token, Deploy, **Visit** (the button at the end of Cloudflare's deploy), **Open in Oby** on the Sphere's first page (it hands Oby its own address) | 1 |
| Railway | Deploy…, sign in, paste the token, Deploy, open the address Railway gives, Open in Oby | 1 |
| Coolify | New resource, Docker Compose, the repository's URL, paste the token, set a domain, Deploy, open it, Open in Oby | 1 |
| Your own server | Point a domain at it, run the two download lines, put the domain and the token in `.env`, `docker compose up -d`, open the address, Open in Oby | 1 |

Two things make this the easiest:

- **The Sphere's first page hands Oby its address.** An unclaimed Sphere's root page shows **Open in Oby**, which opens `oby://` with the server's own origin. Oby already holds the token it made, so nobody copies an address again. Clicked first by someone else, it gives away nothing: the token never leaves the person's Mac until Oby checks the server.
- **The token paste can go too, on containers (a decision below).** Started with no `SPHERE_OPERATOR_TOKEN`, the container writes a one-time claim link to its own log (as PocketBase does), never on a page, and Oby claims the server with it. That's no pastes at all, at the cost of reading one line of log. On Cloudflare and Railway the platform's secret field stays the simplest.

## The rules hold on every target

- **The same checks everywhere:** the same code means the same checks. The relay is for members only and its frames stay sealed; the container runs the same routes and the same Durable Object classes, through the platform layer.
- **The operator token:** a platform secret (Cloudflare, Railway, Render), a Coolify secret, or `.env` at 0600 on a VPS. Never in git, never in a log (the claim link is single-use and isn't the token).
- **HTTPS only:** Railway, Coolify and Render give it, and Caddy on a VPS gets a certificate the moment the domain points there. The container refuses plain HTTP from anywhere but localhost, so a misconfigured proxy fails closed.
- **No telemetry:** the container sends nothing, like the Worker.
- **Backups:** everything is in `/data`. One `sqlite3 /data/sphere.db ".backup …"` line goes in the guide, and Railway backs volumes up for you.

## Updates

- **The container:** versioned images, migrations applied at start (the same files, in order), and the guides' one line: pull, then up.
- **Oby tells you:** `GET /v0.1/health` adds the server's version, and Oby shows one line in Settings › Obysphere when your Sphere is behind.
- **Cloudflare:** the user's copy redeploys on push, but nothing brings our changes to it. The polish ships a small optional GitHub Action in `server/` that opens a pull request in the user's repository when a newer server is released.

## Order

1. **The platform layer and the image**, with the conformance suite passing against both shapes. Measure the container's memory against the spike's 410 MB.
2. **Your own server:** `compose.yaml`, the Caddyfile, `.env.example`, the guide. The quickest to try by hand.
3. **Railway:** the template, built from this repository, and its button in `docs/run-your-own.md`.
4. **Coolify:** the compose file with Coolify's magic variables, and the guide (the catalog when contributions reopen).
5. **Cloudflare polish:** the Sphere's first page with Open in Oby, the version in health, the update Action.
6. **Oby:** where to host in Host your own, the `oby://` hand-off, the "your Sphere is behind" line.
7. **Later:** Render's button, a Fly page, Vercel if asked again, and the self-hosted workerd once Cloudflare ships it.

## Decisions for the owner

1. **Bun or Node** for the container? Bun: one binary, built-in SQLite and WebSockets, the smallest image. Node 26 now has `node:sqlite` too. Recommended: Bun.
2. **Leave the job channel out** of the container (compute sharing is being cut in Oby), and later out of the Worker?
3. **Claim link or token paste** on containers? The paste works today on every target; the claim link removes it everywhere but Cloudflare's button.
4. **Skip Vercel** for now?
5. **Publish images** as `ghcr.io/obi-ai-bot/obi-sphere`?

## Sources

Read on 2026-10-25. Prices and limits change; recheck before publishing a guide.

- **Cloudflare:**
  - Deploy buttons: https://developers.cloudflare.com/workers/platform/deploy-buttons/
  - Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
  - Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
  - Custom domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
  - Self-hosted workerd and celld: https://blog.cloudflare.com/deno-joins-cloudflare/ (2026-10-09) · https://github.com/cloudflare/workerd · https://celld.dev/
- **Vercel:**
  - WebSockets: https://vercel.com/changelog/websocket-support-is-now-generally-available (2026-10-20) · https://vercel.com/docs/functions/websockets
  - Limits and pricing: https://vercel.com/docs/functions/limitations · https://vercel.com/docs/functions/usage-and-pricing
  - Realtime and storage: https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel · https://vercel.com/docs/storage
- **Railway:** https://docs.railway.com/templates/publish-and-share · https://docs.railway.com/templates/updates · https://docs.railway.com/reference/pricing/plans · https://docs.railway.com/networking/public-networking/specs-and-limits · https://docs.railway.com/volumes
- **Coolify:** https://coolify.io/docs/get-started/contribute/service · https://coolify.io/docs/knowledge-base/docker/compose · https://coolify.io/docs/get-started/installation
- **Caddy:** https://caddyserver.com/docs/automatic-https · https://caddyserver.com/docs/caddyfile/directives/reverse_proxy (set `stream_close_delay`, or a reload drops the relay's WebSockets)
- **Fly.io:** https://docs.fly.io/about/pricing · https://docs.fly.io/volumes/overview
- **Render:** https://render.com/docs/deploy-to-render · https://render.com/docs/free · https://render.com/docs/disks
- **Projects that make self-hosting easy, and what we take from each:**
  - PocketBase (one binary, SQLite, a one-time install link in its log): https://pocketbase.io/docs/going-to-production/
  - Uptime Kuma (one container, a `/data` volume, pull then up): https://github.com/louislam/uptime-kuma
  - n8n (SQLite by default, the volume holds its key): https://docs.n8n.io/hosting/installation/docker/
  - Vaultwarden (one container, `/data`): https://github.com/dani-garcia/vaultwarden
  - Immich (download the compose file and `.env`, version pinned): https://docs.immich.app/install/docker-compose
  - Coolify (pre-set the first admin, because whoever registers first wins): https://coolify.io/docs/get-started/installation
- **Running one codebase on several runtimes:** https://hono.dev/docs/helpers/websocket · https://orm.drizzle.team/docs/get-started-sqlite · https://nodejs.org/api/sqlite.html
