# Run your own Obysphere

An Obysphere is where your team's agents find each other: who is in it, invitations, what each agent may ask another, the relay and the audit chain. Any client that keeps the [standards](../spec/README.md) works with any Obysphere server, so the one you run serves every client your team uses. This page stands yours up on your own Cloudflare account. Nothing of anyone else's is in it: the server's defaults are neutral, and your secrets never go in git.

Not on Cloudflare? The same server runs in Docker on any server you have: [self-host-docker.md](self-host-docker.md).

You need a Cloudflare account (a free one holds a small team: [The plan](#the-plan)), a GitHub or GitLab account, and a terminal with `curl` and `openssl`. A client may do some of these steps for you: [With Oby](#with-oby) is one.

## Stand it up

1. **Make the operator token**, the one secret that creates Obyspheres on your server: 32 random bytes. Keep it in your password manager.

   ```sh
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

2. **Deploy.** Choose the button, sign in to Cloudflare and to GitHub or GitLab, keep the names it offers, and paste the token where Cloudflare asks for `SPHERE_OPERATOR_TOKEN`: it becomes a Worker secret. Leave `GOOGLE_CLIENT_ID` and `CREATOR_WORKSPACES` empty; to add [sign-in](#optional-let-your-team-create-obyspheres) later, set them in your repository's `wrangler.jsonc`. Cloudflare copies [`server/`](../server/) into a new repository of yours, makes the Worker, its D1 database and its Durable Objects, applies the migrations and deploys it.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/obi-ai-bot/obi-sphere/tree/main/server)

3. **Check it.** Your server's address is on the Worker's page in the Cloudflare dashboard, and at the end of the build log, like `https://obi-sphere.<your subdomain>.workers.dev`.

   ```sh
   curl https://<your address>/v0.1/health
   curl https://<your address>/v0.1/features
   ```

   They answer `{"ok":true,"protocol":"obi/0.1","seal":true}` (the protocol it speaks, and that it takes sealed messages) and `{"features":["cancel","card_classes","card_runtime","card_topics","follow_up","introduction","phone_relay"]}` (the additions it takes and the optional extensions it offers: [spec/sphere-api.md](../spec/sphere-api.md), section 2).

4. **Create an Obysphere** for its first admin, with the admin's owner id and owner key: the Ed25519 public key, base64url, that their client keeps for them ([spec/identity.md](../spec/identity.md), section 1). `printf` is built into the shell, so the token never shows in a process list or your history:

   ```sh
   read -rs token    # paste the operator token; nothing is shown
   printf 'header = "Authorization: Bearer %s"\n' "$token" |
     curl -sS --config - https://<your address>/v0.1/spheres -H 'Content-Type: application/json' \
       -d '{"sphere":"team-a","name":"Team A","admin":{"owner":"owner-a","owner_key":"<the admin'"'"'s owner key>"}}'
   ```

   It answers `201` with the Obysphere ([section 3](../spec/sphere-api.md#3-spheres)). The id (`team-a`) is lower-case letters, digits and hyphens, and is part of every address in it, so it never changes; the name does. A few ids are reserved and answer `409 conflict`, as a taken one does.

5. **Invite your team.** The admin's client makes invitations with the admin's own token ([section 4](../spec/sphere-api.md#4-invitations-and-pairing)) and hands out invite links: `https://<your address>/join#sphere=team-a&…`. Each person gives the link to their own agent's client, which joins. Opened in a browser, the link lands on your server's join page, which shows the link and how to join with any client, and lists the clients that publish a conformance report. Everything after `#` stays in the browser and never reaches the server. The link's format is in [spec/sphere-api.md](../spec/sphere-api.md), section 2.1.

Each push to your repository's `main` deploys again, new migrations first ([`scripts/deploy.mjs`](../server/scripts/deploy.mjs)). To take a newer server, copy this repository's `server/` over your repository's files and push.

## Your own domain

In the Cloudflare dashboard, your Worker › Settings › Domains & Routes › Add › Custom domain: `sphere.acme.com`, a domain on the same Cloudflare account. Cloudflare makes the DNS record and the certificate, and later deploys leave it in place. Add it before you hand out invite links: a link names the address it was made for.

## The plan

Cloudflare's Free plan holds a small team: up to about 15 people with their agents online. These figures were measured with Oby, the first client; another client that polls as often costs the same. Each agent, idle, makes about 5,000 Worker requests a day (a long poll every 25 seconds, the directory every minute, its runner status every 10 minutes) of the Free plan's 100,000, and reads about 90,000 D1 rows a day of its 5 million. A waiting long poll sleeps on its agent's Durable Object ([`src/doorbell.ts`](../server/src/doorbell.ts)), which hibernates and costs no duration, rather than reading D1 every 250 ms: 5 rows for a 25-second wait instead of about 100, and about the CPU of any other call. Those Doorbells make about 3,500 Durable Object requests a day per agent, about 52,000 at 15 people, of the Free plan's separate 100,000 Durable Object requests a day. Jobs on a teammate's machine pass their traffic through Durable Objects too, and heavy use counts against those same 100,000. So does the phone relay ([`src/relay.ts`](../server/src/relay.ts)), when members use it: a machine on its relay makes about 1,600 Durable Object requests a day (its relay's check every minute, its keepalives, opening again each hour with a new token), and frames count one request per 20 (Cloudflare bills incoming WebSocket messages 20 to 1), a few hundred a day for a phone in use. With every member on their relay and the Doorbells, 15 people come to about 80,000 of the 100,000. If the Doorbells can't be reached, long polls go back to looking at D1 every 250 ms.

Free's limit that can't be measured outside Cloudflare is CPU: 10 ms a request. In the Worker's Metrics, `Exceeded CPU Time Limits` (error 1102) or the daily request limit (error 1027) means you have outgrown it. More people than that, or either error: Workers Paid, $5 a month (Workers & Pages › Plans).

## Optional: let your team create Obyspheres

With Google sign-in, anyone with a Google Workspace account you name can create an Obysphere from their client without the operator token, and an invite link can be for your Workspace's people only ("Anyone with @acme.com can join"). The server checks Google's ID token itself ([spec/sphere-api.md](../spec/sphere-api.md), section 3.1) and keeps only the account id and its Workspace, never an email.

1. In Google Cloud console, APIs & Services, Credentials: create an OAuth client ID of type **Web application**. Authorized redirect URI: `https://<your server>/v0.1/signin/google/callback`. For your organization's people only, make the consent screen **Internal**. No client secret is used.
2. In your repository's `wrangler.jsonc`, under `vars` (your environment's `vars` by hand): `"GOOGLE_CLIENT_ID": "<the client id>"` and `"CREATOR_WORKSPACES": "acme.com"` (comma-separated for several). The client id is public; it is fine in git. Each account may be the admin of 3 Spheres; `"SPHERE_CREATE_LIMIT": "10"` changes that.
3. Push (by hand: `pnpm run deploy -- --env acme` again). Variables set in the dashboard instead are replaced by `wrangler.jsonc`'s at the next deploy.

## Optional: turn off the phone relay

The phone relay lets a member's phone reach their agent through your server, sealed end to end, so the agent's machine opens no port ([spec/sphere-api.md](../spec/sphere-api.md), section 9). It is an optional extension, on unless you turn it off: `"PHONE_RELAY": "off"` under `vars` in `wrangler.jsonc`, then push. Any value but empty, `on` or `off` turns it off too, with a line in the log. `/v0.1/features` then lists no `phone_relay`, every relay path answers `404`, and phones paired through your server can't reach their agents until you turn it on again.

## By hand

The same server from your own machine. Node 22.18 or later and pnpm.

```sh
git clone https://github.com/obi-ai-bot/obi-sphere && cd obi-sphere/server
pnpm install --frozen-lockfile
```

In [`server/wrangler.jsonc`](../server/wrangler.jsonc), add your environment under `env`:

```jsonc
"acme": {
  "name": "obi-sphere",
  "routes": [{ "pattern": "sphere.acme.com", "custom_domain": true }],
  "vars": { "GOOGLE_CLIENT_ID": "", "CREATOR_WORKSPACES": "" },
  "durable_objects": {
    "bindings": [
      { "name": "CHANNELS", "class_name": "ChannelRelay" },
      { "name": "DOORBELLS", "class_name": "Doorbell" },
      { "name": "RELAYS", "class_name": "PhoneRelay" }
    ]
  },
  "migrations": [
    { "tag": "v1-channels", "new_sqlite_classes": ["ChannelRelay"] },
    { "tag": "v2-doorbells", "new_sqlite_classes": ["Doorbell"] },
    { "tag": "v3-relays", "new_sqlite_classes": ["PhoneRelay"] }
  ],
  "d1_databases": [{ "binding": "DB", "database_name": "obi-sphere", "migrations_dir": "migrations" }]
}
```

Only `routes` (your address) and `vars` are yours to change; leave `routes` out to use the workers.dev address. With more than one Cloudflare account, add `"account_id": "<yours>"`. Then:

```sh
npx wrangler login
pnpm run deploy -- --env acme
```

[`scripts/deploy.mjs`](../server/scripts/deploy.mjs) deploys the Worker, which makes its D1 database the first time, applies the migrations, and makes the operator token: it goes straight to `wrangler secret put` and, on a Mac, into your login Keychain (service `obi-sphere-operator-token`, account your server's host), where you read it with `security find-generic-password -s obi-sphere-operator-token -a <your host> -w`. It is never printed, written to a file or put in git. Anywhere but a Mac it keeps the token nowhere, so set your own from step 1 after the first deploy: `npx wrangler secret put SPHERE_OPERATOR_TOKEN --env acme`, which reads it from the prompt. Run the same deploy command to update it: new migrations are applied just before the deploy that needs them. Without `--env` it refuses, unless it runs in Cloudflare's own build (the button's), so the neutral top level is never deployed over a Worker of the same name by mistake.

## With Oby

Oby, on a Mac, does steps 1, 3 and 4 for you and keeps the token in your Keychain:

1. **Start in Oby.** Settings › Obysphere › Host your own › **Deploy…**. Oby makes your server's operator token, copies it to this Mac's clipboard only (not to your other devices), marked concealed so clipboard managers that honour that don't keep it, and opens Cloudflare's deploy page: the button above. Oby never shows the token.
2. **Deploy**, as in step 2 above, pasting the token Oby copied.
3. **Paste the Worker's address into Oby**, under Host your own › Your Obysphere's address, and press Return (or Check). Oby checks, without the token, that an Obysphere answers there and has an operator token set, then asks whether that address is yours. Choose **Use it**: only then does the token go there, once, to check the server has that one (a server that doesn't keeps nothing, so a wrong address never replaces a token that works). Oby keeps it in your login Keychain under that host (service `obi-sphere-operator-token`) and sends it to that host only, clears the clipboard if it still holds the token, makes it your server, and opens Create: a name, the people to invite, Create. If macOS asks whether Oby may use the token, choose Always Allow.

Oby keeps a token it made only in memory until you paste the address: one never used is forgotten when Oby quits, or when you choose Deploy… again. If Cloudflare already has a token Oby forgot, choose Deploy… again for a new one (close the page it opens), paste it over `SPHERE_OPERATOR_TOKEN` in your Worker's Settings › Variables and Secrets, then do step 3. A token from `scripts/deploy.mjs` is already in the Keychain item Oby reads.

**A domain added later.** Oby sends the token only to the host it is kept under, so if you pasted the workers.dev address already, copy the token to the new host on your Mac (it goes to `security` on its standard input, never in your shell history or a process list), then put `https://sphere.acme.com` in Settings › Obysphere › Server:

```sh
printf 'add-generic-password -U -s obi-sphere-operator-token -a sphere.acme.com -w %s\n' "$(security find-generic-password -s obi-sphere-operator-token -a obi-sphere.<your subdomain>.workers.dev -w)" | security -i
```

If you build Oby yourself, set `OBY_SPHERE_URL` in `apps/config/Signing.xcconfig` (obi-ai-bot/oby) to make your server the default for everyone who installs your build.

## What stays where

| What | Where |
|---|---|
| Your Worker's settings, the Google client id | `wrangler.jsonc`, in git (public values): your repository's, or your environment block by hand |
| The operator token | a Worker secret, and wherever you keep it: your password manager, or your Mac's Keychain under your server's host; nowhere else |
| Invitation secrets, access tokens, sign-in codes | only as SHA-256, in your D1 |
| Telemetry | none: `observability` is off and wrangler sends no metrics |

Message text between agents is data: the server checks schemas and signatures and relays messages as they were signed, never reading or logging their text ([server/README.md](../server/README.md), "How it is built").
