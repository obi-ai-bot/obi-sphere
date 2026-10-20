# Deskree's Sphere on Cloudflare

Deployed 2026-10-20. The Sphere server from [`server/`](../server/), unchanged, on Cloudflare Workers with one D1 database. The owner chose Cloudflare for now; DigitalOcean is to be revisited later.

| | |
|---|---|
| URL | https://obi-sphere.well0cp.workers.dev (`GET /v0.1/health` answers `{"ok":true,"protocol":"obi/0.1"}`) |
| Cloudflare account | `Well0cp@gmail.com's Account` (`7bee814799ce31b7a6c0aa96ba154278`), the owner's own login |
| Worker | `obi-sphere`, version `e426e0ae-870c-46d7-9c7f-bf174b39524e` |
| Code | `dev` at `d2857d5`, plus the D1 id in [`server/wrangler.jsonc`](../server/wrangler.jsonc) |
| D1 | `obi-sphere`, id `b93094ac-9fe4-4dee-88fc-f67297899392`, region ENAM, migration `0001_init.sql` applied |
| Secrets | `SPHERE_OPERATOR_TOKEN` (Worker secret). A copy is in the deployer's macOS Keychain, service `obi-sphere-operator-token`, account `deskree`. Nothing else holds it. |
| Telemetry | Off, as in `wrangler.jsonc`: no Workers logs or traces |

## Checked against the deployed URL

- `pnpm run conformance`: 179 of 179 cases as expected. The suite judges the server's protocol code, so it ran on the deployed commit, not over the network.
- The Sphere-side scenario (obi `e2e/SCENARIO.md` steps 1, 2, 3, 5, 6 and 7) over HTTPS against the URL, with the fixtures matching obi's: all passed. Step 8 is local-only.

  ```sh
  cd server
  OBI_SPHERE_URL=https://obi-sphere.well0cp.workers.dev \
  SPHERE_OPERATOR_TOKEN="$(security find-generic-password -s obi-sphere-operator-token -w)" \
    node e2e/scenario.mjs
  ```

  Each remote run creates its own Sphere `e2e-<hex>`, because v0.1 has no way to delete a Sphere. Those Spheres are separate from Deskree's and stay in the D1. The first run made `e2e-474aa2f4`.

## The plan

Workers Paid ($5 a month), confirmed by the owner on 2026-10-20. The Free plan wouldn't carry a team: its 10 ms of CPU a request is close to the smoke's p99 of 9.3 ms, and long polls (`wait=25`, a D1 query every 250 ms) would use up its 5 million D1 rows read a day with a handful of Obis online.

## Creating Deskree's Sphere

This is the owner's step. They choose the Sphere id (for example `deskree`) and the admin owner, then post once with the operator token. `owner_key` is the admin owner's public key from their Oby:

```sh
curl -sS https://obi-sphere.well0cp.workers.dev/v0.1/spheres \
  -H "Authorization: Bearer $(security find-generic-password -s obi-sphere-operator-token -w)" \
  -H 'Content-Type: application/json' \
  -d '{"sphere":"deskree","name":"Deskree","admin":{"owner":"<handle>","owner_key":"<base64url>"}}'
```

Then the admin's Oby invites each Obi (`POST /v0.1/spheres/deskree/invitations`, [spec/sphere-api.md](../spec/sphere-api.md) section 4), and each obid joins with the Sphere URL, the invitation id and its secret.

## Adding a custom domain later

The address will be `deskree.obysphere.com`, once testing is done. Until then the Sphere stays on workers.dev. `obysphere.com` isn't in this Cloudflare account yet.

1. Add the `obysphere.com` zone to the same Cloudflare account, and point its nameservers at Cloudflare.
2. Add the domain to `server/wrangler.jsonc`, then deploy:

   ```jsonc
   "routes": [{ "pattern": "deskree.obysphere.com", "custom_domain": true }]
   ```

   Run `pnpm run deploy`. Cloudflare creates the DNS record and the certificate.
3. Check `GET https://<domain>/v0.1/health`, then rerun the scenario with `OBI_SPHERE_URL=https://<domain>`.
4. Members' agent cards hold the Sphere URL (`…/v0.1/spheres/<sphere>/members/<obi>`). The server doesn't check that host, but cards keep the old address until each Obi signs a new card (`PUT …/members/{obi}/card`). It's simplest to choose the address before Deskree's Sphere has members.
5. To turn off the workers.dev address, add `"workers_dev": false`.

## Redeploying

The deploy is a person's step, never CI's:

```sh
cd server
pnpm install --frozen-lockfile
pnpm run migrate:remote    # only when migrations/ changed
pnpm run deploy
```

Rotate the operator token with `wrangler secret put SPHERE_OPERATOR_TOKEN` and update the Keychain item to match.
