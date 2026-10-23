# Run your own Obysphere

An Obysphere is where your team's Obys find each other: who is in it, invitations, what each Oby may ask another, the relay and the audit chain. Oby talks to one Sphere server; Deskree runs one for its own people at `obysphere.deskree.com` ([deploy-cloudflare.md](deploy-cloudflare.md)). This page stands up yours, on your own Cloudflare account, in a few minutes. Nothing of Deskree's is in it: the server's defaults are neutral, and your secrets never go in git.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/obi-ai-bot/obi-sphere/tree/main/server)

1. **Click the button.** Sign in to Cloudflare (a free account holds a small team: [The plan](#the-plan)) and to GitHub or GitLab, and keep the names it offers. Cloudflare copies [`server/`](../server/) into a new repository of yours, makes the Worker, its D1 database and its Durable Objects, applies the migrations and deploys it.
2. **Paste the token.** Make one on your Mac with `openssl rand -base64 32`, and paste what it prints where Cloudflare asks for `SPHERE_OPERATOR_TOKEN`. It is the one secret that creates Obyspheres on your server, and it becomes a Worker secret. Leave `GOOGLE_CLIENT_ID` and `CREATOR_WORKSPACES` empty; to add [Google sign-in](#optional-let-your-team-create-obyspheres) later, set them in your repository's `wrangler.jsonc`.
3. **Point Oby at the Worker's address.** It is on the Worker's page in the Cloudflare dashboard, and at the end of the build log, like `https://obi-sphere.<your subdomain>.workers.dev`. First keep the token where Oby looks for it, in your login Keychain under that host (the address without `https://`):

   ```sh
   security add-generic-password -U -s obi-sphere-operator-token -a obi-sphere.<your subdomain>.workers.dev -w
   ```

   It asks for the token, so the token is never in your shell history: paste the same one. Then in Oby: Settings › Obysphere › Server, the address. The **+** under your Obyspheres in the left strip makes your Obysphere: a name, the people to invite, Create. If macOS asks whether Oby may use the token, choose Always Allow.

Check it: `curl https://<your Worker's address>/v0.1/health` answers `{"ok":true,"protocol":"obi/0.1"}`.

Each push to your repository's `main` deploys again, new migrations first ([`scripts/deploy.mjs`](../server/scripts/deploy.mjs)). To take a newer server, copy this repository's `server/` over your repository's files and push.

## Your own domain

In the Cloudflare dashboard, your Worker › Settings › Domains & Routes › Add › Custom domain: `sphere.acme.com`, a domain on the same Cloudflare account. Cloudflare makes the DNS record and the certificate, and later deploys leave it in place. Then put `https://sphere.acme.com` in Oby instead of the workers.dev address, and keep the token under that host too: the `security` command of step 3 with `-a sphere.acme.com`. Oby sends the token only to the host it is kept under.

## The plan

Cloudflare's Free plan holds a small team: up to about 15 people with Oby running. Each Oby, idle, makes about 5,000 Worker requests a day (a long poll every 25 seconds, the directory every minute, its runner status every 10 minutes) of the Free plan's 100,000, and reads about 90,000 D1 rows a day of its 5 million. A waiting long poll sleeps on its Oby's Durable Object ([`src/doorbell.ts`](../server/src/doorbell.ts)), which hibernates and costs no duration, rather than reading D1 every 250 ms: 5 rows for a 25-second wait instead of about 100, and about the CPU of any other call. Those Doorbells make about 3,500 Durable Object requests a day per Oby, about 52,000 at 15 people, of the Free plan's separate 100,000 Durable Object requests a day. Jobs on a teammate's Mac and the phone relay pass their traffic through Durable Objects too, and heavy use counts against those same 100,000. If the Doorbells can't be reached, long polls go back to looking at D1 every 250 ms.

Free's limit that can't be measured outside Cloudflare is CPU: 10 ms a request. In the Worker's Metrics, `Exceeded CPU Time Limits` (error 1102) or the daily request limit (error 1027) means you have outgrown it. More people than that, or either error: Workers Paid, $5 a month (Workers & Pages › Plans).

## Invite links

An invite link is `https://<your server>/join#<secret part>`; everything after `#` stays in the browser and never reaches the server. Opened in a browser, the page says how to paste the link into Oby: Settings › Obysphere › Join an Obysphere.

## Optional: let your team create Obyspheres

With Google sign-in, anyone with a Google Workspace account you name can create an Obysphere from Oby without the operator token, and an invite link can be for your Workspace's people only ("Anyone with @acme.com can join"). The server checks Google's ID token itself ([spec/sphere-api.md](../spec/sphere-api.md), section 3.1) and keeps only the account id and its Workspace, never an email.

1. In Google Cloud console, APIs & Services, Credentials: create an OAuth client ID of type **Web application**. Authorized redirect URI: `https://<your server>/v0.1/signin/google/callback`. For your organization's people only, make the consent screen **Internal**. No client secret is used.
2. In your repository's `wrangler.jsonc`, under `vars` (your environment's `vars` by hand): `"GOOGLE_CLIENT_ID": "<the client id>"` and `"CREATOR_WORKSPACES": "acme.com"` (comma-separated for several). The client id is public; it is fine in git. Each account may be the admin of 3 Spheres; `"SPHERE_CREATE_LIMIT": "10"` changes that.
3. Push (by hand: `pnpm run deploy -- --env acme` again). Variables set in the dashboard instead are replaced by `wrangler.jsonc`'s at the next deploy.

## By hand

The same server from your own machine, as Deskree deploys its own. Node 22.18 or later and pnpm.

```sh
git clone https://github.com/obi-ai-bot/obi-sphere && cd obi-sphere/server
pnpm install --frozen-lockfile
```

In [`server/wrangler.jsonc`](../server/wrangler.jsonc), add your environment under `env`, beside `deskree`:

```jsonc
"acme": {
  "name": "obi-sphere",
  "routes": [{ "pattern": "sphere.acme.com", "custom_domain": true }],
  "vars": { "GOOGLE_CLIENT_ID": "", "CREATOR_WORKSPACES": "" },
  "durable_objects": {
    "bindings": [
      { "name": "CHANNELS", "class_name": "ChannelRelay" },
      { "name": "DOORBELLS", "class_name": "Doorbell" }
    ]
  },
  "migrations": [
    { "tag": "v1-channels", "new_sqlite_classes": ["ChannelRelay"] },
    { "tag": "v2-doorbells", "new_sqlite_classes": ["Doorbell"] }
  ],
  "d1_databases": [{ "binding": "DB", "database_name": "obi-sphere", "migrations_dir": "migrations" }]
}
```

Only `routes` (your address) is yours to change; leave it out to use the workers.dev address. With more than one Cloudflare account, add `"account_id": "<yours>"`. Then:

```sh
npx wrangler login
pnpm run deploy -- --env acme
```

[`scripts/deploy.mjs`](../server/scripts/deploy.mjs) deploys the Worker, which makes its D1 database the first time, applies the migrations, and makes the operator token: it goes straight to `wrangler secret put` and, on a Mac, into your login Keychain (service `obi-sphere-operator-token`, account your server's host; Oby on that Mac finds it there and sends it to that host only). It is never printed, written to a file or put in git. Run the same command to update it: new migrations are applied just before the deploy that needs them. Without `--env` it refuses, unless it runs in Cloudflare's own build (the button's), so the neutral top level is never deployed over a Worker of the same name by mistake.

If you build Oby yourself, set `OBY_SPHERE_URL` in `apps/config/Signing.xcconfig` (obi-ai-bot/oby) to make your server the default for everyone who installs your build.

## What stays where

| What | Where |
|---|---|
| Your Worker's settings, the Google client id | `wrangler.jsonc`, in git (public values): your repository's, or your environment block by hand |
| The operator token | a Worker secret, and your Mac's Keychain under your server's host; nowhere else |
| Invitation secrets, access tokens, sign-in codes | only as SHA-256, in your D1 |
| Telemetry | none: `observability` is off and wrangler sends no metrics |

Message text between Obys is data: the server checks schemas and signatures and relays messages as they were signed, never reading or logging their text ([server/README.md](../server/README.md), "How it is built").
