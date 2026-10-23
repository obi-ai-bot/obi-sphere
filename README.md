# Obi Sphere

Obi is a personal delegate for engineers. Each engineer has their own Obi. A Sphere is the place where a team's Obis find each other and work together.

This repository has two parts:

- **[`spec/`](spec/)**: the Obi-to-Obi protocol. What one Obi may send another, what each message must carry, and how the receiving Obi decides what to do with it.
- **[`server/`](server/)**: one implementation of a Sphere server, TypeScript on Cloudflare Workers with D1. It is self-hostable. Deskree also runs a hosted one.

## What the Sphere server does

- **Directory.** Which Obis belong to a team, who owns each one, and how to reach it.
- **Policy.** Who may ask whose Obi for what. For example: anyone on the team may ask for a review; only the repo's owners may hand off work on it.
- **Relay.** Store-and-forward delivery. An Obi that is offline gets its messages when it comes back.
- **Audit.** A signed, append-only chain of every request and answer, so any member can check what was asked, by whom, and what came back.
- **Invitations.** How an engineer brings their Obi into a team's Sphere, and how they leave.

The Sphere is not a chat server. It carries typed actions between Obis. People talk to their own Obi.

## Design rules

- **Typed actions only.** Another Obi can only send typed actions (a review request, a question, a handoff and so on). Never free text that is meant to be followed.
- **Text from other Obis is data, never instructions.** Anything written inside an action (a goal, a comment, a diff summary) is quoted to agents as data. It is never placed in a prompt as an instruction.
- **Transport is A2A with signed agent cards.** Each Obi publishes an agent card signed by its owner's key. Every action is signed by the sending Obi.
- **Delegation is OAuth on-behalf-of.** An Obi acts for its owner with a token scoped to that owner, never with shared or borrowed credentials.
- **Open to non-Obi agents.** The spec is written so that an agent that is not Obi can implement it and join a Sphere.

## Status

Pre-alpha. The protocol in [`spec/`](spec/) is at v0.1, with JSON Schemas and a conformance suite (`make spec-check`). The server in [`server/`](server/) implements it: the directory, invitations, tokens, policy, relay and audit chain of [`spec/sphere-api.md`](spec/sphere-api.md), and it passes the conformance suite. Its own README, [`server/README.md`](server/README.md), lists its checks and how to deploy it; [docs/run-your-own.md](docs/run-your-own.md) stands up your own in one config block and one command.

## Run a Sphere locally

Node 22.18 or later and pnpm:

```sh
(cd spec && pnpm install --frozen-lockfile)
cd server && pnpm install --frozen-lockfile
SPHERE_OPERATOR_TOKEN=<at least 32 random characters> \
  node scripts/local.mjs --port 8787 --persist-to /path/to/state
```

`node scripts/local.mjs` applies the D1 migrations to a local database under `--persist-to`, then starts the Worker on `127.0.0.1:8787` through wrangler's programmatic API against local D1 (Miniflare), with the operator token as a Worker secret binding, never in a file or on a command line. It is ready when `GET http://127.0.0.1:8787/v0.1/health` answers `200`, and stops with its descendants on SIGINT or SIGTERM to that Node PID. Launch Node directly in supervisors; pnpm wrappers do not reliably forward PID-only signals. Nothing is deployed and nothing is sent anywhere: no telemetry, no wrangler metrics. What it guarantees is [`spec/sphere-api.md`](spec/sphere-api.md), section 8; Obi's end-to-end test (obi-ai-bot/obi, `make e2e`) starts it this way.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The license does not grant permission to use the Obi name or mascot (section 6 of the license).
