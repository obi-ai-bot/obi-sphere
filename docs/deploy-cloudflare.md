# Deskree's Sphere on Cloudflare

Deployed 2026-10-20. It runs the Sphere server from [`server/`](../server/), unchanged, on Cloudflare Workers with one D1 database. The owner chose Cloudflare for now and will revisit DigitalOcean later.

| | |
|---|---|
| URL | https://obysphere.deskree.com (`GET /v0.1/health` answers `{"ok":true,"protocol":"obi/0.1"}`) |
| Cloudflare account | `Deskree` (`9784e77e77b9aaff2387596b31f85320`), the account that holds `deskree.com`. It is pinned as `account_id` in [`server/wrangler.jsonc`](../server/wrangler.jsonc). |
| Worker | `obi-sphere`, version `2f24b987-c346-4d5e-8c8b-0959d7c98524`, on the custom domain only (its workers.dev address is off) |
| Code | `dev` at `d2857d5`, plus the account, D1 id and route in `server/wrangler.jsonc` |
| D1 | `obi-sphere`, id `ff9bde6f-e277-47c8-b6e6-309bf00f87c7`, region ENAM, migration `0001_init.sql` applied |
| Secrets | `SPHERE_OPERATOR_TOKEN` (a Worker secret). A copy is in the deployer's macOS Keychain under service `obi-sphere-operator-token`, account `deskree`. Nothing else holds it. |
| Telemetry | Off, as `wrangler.jsonc` sets it: Cloudflare keeps no Workers logs or traces |

The first test deploy ran in the owner's personal account at `obi-sphere.well0cp.workers.dev`, with D1 `b93094ac-9fe4-4dee-88fc-f67297899392`. It held only test Spheres and was replaced by this deploy, so it can be deleted.

## Checked against the deployed URL

- `pnpm run conformance`: 179 of 179 cases as expected. The suite judges the server's protocol code, so it ran on the deployed commit, not over the network.
- The Sphere-side scenario (obi `e2e/SCENARIO.md` steps 1, 2, 3, 5, 6 and 7) ran over HTTPS against the URL, with fixtures matching obi's. Every step passed. Step 8 only runs locally.

  ```sh
  cd server
  OBI_SPHERE_URL=https://obysphere.deskree.com \
  SPHERE_OPERATOR_TOKEN="$(security find-generic-password -s obi-sphere-operator-token -w)" \
    node e2e/scenario.mjs
  ```

  Each remote run creates its own Sphere, `e2e-<hex>`, because v0.1 has no way to delete a Sphere. These Spheres are separate from Deskree's and stay in the D1. The first run made `e2e-73e08db8`.

## The plan

A team needs Workers Paid ($5 a month) on the Deskree account. The Free plan isn't enough for two reasons:

- Its CPU limit is 10 ms a request, and the smoke run's p99 was 9.3 ms.
- Long polls (`wait=25`) query D1 every 250 ms. With a handful of Obis online, that would use up the Free plan's 5 million D1 rows read a day.

The owner turned on Workers Paid for the personal account that held the first deploy. Whether the Deskree account has it still needs checking: go to dash.cloudflare.com, then Deskree, Workers & Pages, Plans.

## Creating Deskree's Sphere

The owner does this once. In the Mac app, go to Settings, then Obysphere (obi PR #800). Or post directly with the operator token. `owner_key` is the admin owner's public key from their Oby:

```sh
curl -sS https://obysphere.deskree.com/v0.1/spheres \
  -H "Authorization: Bearer $(security find-generic-password -s obi-sphere-operator-token -w)" \
  -H 'Content-Type: application/json' \
  -d '{"sphere":"deskree","name":"Deskree","admin":{"owner":"<handle>","owner_key":"<base64url>"}}'
```

Then the admin's Oby invites each Obi (`POST /v0.1/spheres/deskree/invitations`, [spec/sphere-api.md](../spec/sphere-api.md) section 4). Each obid joins with the Sphere URL, the invitation id and its secret.

## Moving to deskree.obysphere.com later

1. Add the `obysphere.com` zone to the Deskree Cloudflare account.
2. Add `{ "pattern": "deskree.obysphere.com", "custom_domain": true }` to `routes` in `server/wrangler.jsonc`, then run `pnpm run deploy`. Cloudflare creates the DNS record and the certificate.
3. Check `GET https://deskree.obysphere.com/v0.1/health`, then rerun the scenario with `OBI_SPHERE_URL` set to the new address.
4. Members' agent cards hold the Sphere URL (`…/v0.1/spheres/<sphere>/members/<obi>`). The server doesn't check that host, but each card keeps the old address until its Obi signs a new one (`PUT …/members/{obi}/card`). Keep both domains on the Worker until every card has moved.

## Redeploying

A person deploys, never CI:

```sh
cd server
pnpm install --frozen-lockfile
pnpm run migrate:remote    # only when migrations/ changed
pnpm run deploy
```

To rotate the operator token, run `wrangler secret put SPHERE_OPERATOR_TOKEN` and update the Keychain item to match.
