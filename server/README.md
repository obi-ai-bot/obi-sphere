# Sphere server

The Sphere of the Obi-to-Obi protocol v0.1: a team's directory, invitations and pairing, tokens (OAuth on-behalf-of), policy, store-and-forward relay and audit chain. It implements [`../spec/sphere-api.md`](../spec/sphere-api.md) and nothing else; where this code and the spec disagree, the spec wins.

TypeScript on Cloudflare Workers with one D1 database, the same toolchain as Obi's control plane (`cloud/control-plane/` in obi-ai-bot/obi): pnpm, wrangler, and vitest inside workerd (Miniflare) through `@cloudflare/vitest-plugin`.

## Run it

Node 22.18 or later and pnpm. The spec's packages are needed for the conformance suite and the scenario.

```sh
(cd ../spec && pnpm install --frozen-lockfile)
pnpm install --frozen-lockfile

SPHERE_OPERATOR_TOKEN=<at least 32 random characters> \
  pnpm run local -- --port 8787 --persist-to /path/to/state   # a Sphere on 127.0.0.1:8787
```

`pnpm run local` ([scripts/local.mjs](scripts/local.mjs)) applies the D1 migrations to the local database under `--persist-to`, then runs `wrangler dev` on `127.0.0.1:<port>` with the same `--persist-to` and the operator token as a Worker variable (`--var`), never in a file. It is ready when `GET /v0.1/health` answers `200`, and stops on SIGINT or SIGTERM. It writes only under `--persist-to`, `server/.wrangler/`, `node_modules/`, `$HOME` and `$TMPDIR`, and sends no metrics.

## Check it

| Command | What |
|---|---|
| `pnpm run check` | TypeScript. |
| `pnpm test` | The Worker's tests inside workerd with a real D1 ([test/](test/)): every endpoint and the errors the spec gives for it (`rate_limited` only as the answer to a write that kept losing to other writes: v0.1 leaves the limits open), each send check in its order, the exchange rules, retries, rotation and revocation, concurrent writers, and every answer validated against its wire schema. |
| `pnpm run conformance` | The spec's conformance suite in implementation mode (`node ../spec/conformance/run.mjs --impl "node conformance/check.ts"`), all case kinds: envelopes, cards and chains, judged by the server's own protocol code. |
| `pnpm run scenario` | The Sphere-side steps of obi's `e2e/SCENARIO.md` (1, 3, 5 and 7, with what 2, 6 and 8 need of the Sphere) against a Sphere started with `pnpm run local`, by a scripted client ([e2e/client.mjs](e2e/client.mjs)) that plays both owners and both Obis with keys it generates. It checks every relayed message with the spec's reference `verifyEnvelope` and the chain with `verifyChain`. |
| `pnpm run load -- --sends 200` | [e2e/load.mjs](e2e/load.mjs): that many valid sends fired at once at a Sphere started with `pnpm run local`; passes only when every one is answered `202` and the chain holds each once and verifies. |
| `pnpm run test:client` | The scripted client's own tests (what it signs passes the reference verifier) and the fixture check's tests. |
| `pnpm run check:fixtures` | [e2e/fixtures/](e2e/fixtures/) still equal obi's `e2e/fixtures/messages/brief.json` and the `body` of `result.example.json` ([e2e/fixtures.mjs](e2e/fixtures.mjs)). It needs an obi checkout (`OBI_DIR`, or `../obi` beside obi-sphere) and fails without one. The scenario makes the same comparison whenever it finds a checkout, and stops on a difference. |
| `pnpm run check:validators` | [src/protocol/validators.generated.js](src/protocol/validators.generated.js) is up to date with `../spec/schemas/v0.1` (`pnpm run gen:validators` rewrites it). |

CI runs all of them ([.github/workflows/server.yml](../.github/workflows/server.yml)); `check:fixtures` only when the repository secret `OBI_READ_TOKEN` (Contents: read on obi-ai-bot/obi) exists, and it warns when it doesn't.

## How it is built

- [src/protocol/](src/protocol/): the protocol's checks, the same code in the Worker and in the conformance checker (Node runs the `.ts` files as they are): strict JSON (no duplicate names, integers only) and RFC 8785 canonical JSON, Ed25519 through WebCrypto, envelope checks (protocol.md section 10), the exchange rules, agent cards (identity.md 2.2), compact JWS, and the audit chain's hashes and verification. The JSON Schemas are compiled ahead of time by ajv into one module (Workers allow no code generation at run time).
- [src/app.ts](src/app.ts) routes the API; [src/oauth.ts](src/oauth.ts) is the token exchange; [src/routes/](src/routes/) the rest, each check in the order the spec gives it.
- [migrations/](migrations/): D1's tables. Every change a send depends on (the chain's head, members and keys, the policy) is one transaction guarded by the Sphere's revision, so concurrent writers never interleave: the chain stays one chain, an exchange gets at most one `accept`, an invitation is redeemed once. A send reads everything its checks need in one transaction, checks the signature once, and when another write took its turn it waits a random time under a ceiling that doubles with each loss, then reads again ([src/db.ts](src/db.ts)). If it still hasn't landed when its budget runs out it answers `429 rate_limited` with `Retry-After`, having recorded nothing.
- Message text is data. The Sphere checks a message's schema and signature and relays it as the sender signed it; it never reads, logs or interprets a text field. Error answers never echo what a client sent beyond a cleaned, one-line excerpt.
- Secrets: invitation secrets and access tokens are kept only as SHA-256; the operator token is a Worker secret, compared in constant time and never logged. No telemetry: observability is off in `wrangler.jsonc` and wrangler sends no metrics.

## Deploying

A person's step, never CI's: `wrangler d1 create obi-sphere`, paste its id into `wrangler.jsonc`, `pnpm run migrate:remote`, `wrangler secret put SPHERE_OPERATOR_TOKEN`, then `pnpm run deploy`.
