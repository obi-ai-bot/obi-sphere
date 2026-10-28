# A live Council panel

[panel.mjs](panel.mjs) runs the Council's review profile ([spec/council/review.md](../../spec/council/review.md)) end to end on a local Obysphere, with real processes, real keys and real signatures, and then re-checks the verdict from nothing but the record and the chain. It is the Council epic's first done-when (#45): a panel drawn by lot from several owners assesses a real change blind, a finding is challenged, the clerk's count gives a verdict, and anyone gets the same draw and count from the record.

## What it does

1. **The Obysphere and the team.**
   - A local Obysphere starts (`server/scripts/local.mjs`, port 8794 by default).
   - Its admin, `ada`, joins her convener: the scripted client of [server/e2e/client.mjs](../../server/e2e/client.mjs), with a seal key, so the seats' words are sealed for it alone.
   - Five members join through the [connector](../../connector/), each for an owner of its own: `bea`, `cai`, `dov`, `eli` and `fay`.
2. **The motion and the pool.**
   - The subject is Oby's end-to-end fixture: a small repository whose `feature/average` branch has two known bugs.
   - `ada` is the author, so her agents are out of the pool. The pool is the five members, one per owner (the clerk's `pool`).
3. **Calls.**
   - The convener sends every pool member a `question` whose id is the pool's anchor id (draw.md section 3), sealed for that member.
   - `fay`'s owner stands aside, declining with her passphrase through the connector's CLI.
4. **The draw.**
   - The script waits for drand quicknet's round more than 300 seconds after the first call, checks its signature with quicknet's key, and draws three seats and a verifier (the clerk's `draw`, with `fay` declined).
5. **Blind reviews.**
   - Each seat gets one `review_request`, the same for every seat and all expiring at `deadlines.reviews`.
   - Each seat's owner approves it with their passphrase. Then `claude -p`, with the connector as its only MCP server and read-only tools on a checkout of the change, reviews it alone and replies. Each seat's result is sealed for the convener.
6. **The challenge.**
   - The verifier gets one `custom` condition per blocking finding (`Finding n: file:line` and its title).
   - Its owner approves, and `claude -p` checks each finding against the code and answers with `met` per condition.
7. **The count and the record.**
   - The clerk's `reviewTally` turns the chain's entries into a count input, and `count` gives the verdict.
   - The convener signs the record (`council record\n`, review.md section 7).
   - The run folder keeps it as `record.json`, next to `chain.json`: the chain's entries and the directory's keys.
8. **The re-check**, from `record.json` and `chain.json` alone:
   - `verifyChain` over the whole chain, and the record's signature;
   - the pool rebuilt from the signed cards, and every call found in the chain with its anchor id;
   - the beacon round re-derived and its signature checked with quicknet's key;
   - the members that stood aside, read from the chain;
   - the draw run again, the seats' requests and the panel's silence checked;
   - the tally and the count made again.

   The verdict must be the same.

## Running it

```
cd client && pnpm install --frozen-lockfile
cd ../connector && pnpm install --frozen-lockfile && pnpm run build
cd ../server && pnpm install --frozen-lockfile
cd ../spec && pnpm install --frozen-lockfile
cd ../clerk/ts && pnpm install --frozen-lockfile
cd ../.. && node eval/live/panel.mjs --oby <an obi-ai-bot/oby checkout> [--port 8794] [--model sonnet] [--keep]
node eval/live/panel.mjs --recheck <the run folder it kept>
```

- **What it needs.** Node 22.18 or later, `git`, network access to a drand relay (`api.drand.sh` or another), and `claude` signed in. The script never signs in, and runs `claude` with only `HOME`, `PATH` and `USER` from its environment.
- **Time and cost.** About ten minutes, mostly waiting for the round. The four `claude` runs cost about $0.50 to $0.70 with Sonnet; the script prints `total_cost_usd`.
- **Its state** goes under `$TMPDIR/obysphere-s4/`.

## What it doesn't show yet

- **Two vendors.** Every seat runs Anthropic's models through `claude -p`, and the connector's cards don't declare their vendors yet. So the panel asks for 0 vendors, and its vendor count can't be checked here. A panel with seats on a second vendor (`cursor-agent` with a non-Anthropic model) waits for that subscription. A second Claude model would not be a second vendor.
- **Oby as a seat or the convener.** The convener here is the scripted client, not Oby's `obid`. Oby's convener ([obi-ai-bot/oby#1546](https://github.com/obi-ai-bot/oby/pull/1546)) sends the seats' requests, but not the calls or the draw.
- **A refuted finding.** The verifier tries to refute each finding, but in the runs so far every blocker it checked stood. The tally's vectors cover refutation (clerk/vectors/review.json).
