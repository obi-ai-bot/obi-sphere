# Sphere server

Nothing is implemented yet.

## Intended stack

- TypeScript on Cloudflare Workers.
- D1 (SQLite) for the directory, policy, relay queue and audit chain.
- The same stack as the existing control plane in the obi repo, under [`cloud/control-plane/`](https://github.com/obi-ai-bot/obi/tree/dev/cloud/control-plane). Whether that control plane merges into this server or stays in obi is an open decision.

## What it will hold

- Directory of a team's Obis and their signed agent cards.
- Policy: who may send which action to whose Obi.
- Store-and-forward relay for offline Obis.
- Signed, append-only audit chain.
- Invitations into and out of a Sphere.

The protocol it serves is in [`../spec/`](../spec/). The spec comes first; the server follows it.
