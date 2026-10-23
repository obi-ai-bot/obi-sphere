# Obi-to-Obi protocol

> **v0.1.** The first version meant to be implemented: Obi's `obid` and the Sphere server in [`../server/`](../server/) are built against it, and its conformance suite says whether they agree. It will still change; every change is listed below.
>
> **Changelog.** v0.1: replaces the first draft. Pins the envelope, signing (Ed25519 over RFC 8785 canonical JSON), the A2A agent-card profile, delegation (OAuth token exchange, RFC 8693), the receiving Obi's decision rule, the Sphere's HTTP binding and audit chain, JSON Schemas for all of it, and a conformance suite.
>
> v0.1, clarified (no message, schema or fixture changes): a send that loses to concurrent writes is `429 rate_limited`, nothing recorded (sphere-api.md 6.1, check 13). What the first Sphere server chose where the text was silent: an owner token on an endpoint that needs an Obi token is `403 forbidden` (sphere-api.md section 1; sending stays `401`), and so is an Obi token revoking a member (creating invitations and replacing the policy need `admin`, which an Obi's token never holds: `403 insufficient_scope`); a token request body over 131,072 bytes is `400 invalid_request` (identity.md 4.3); single-use `jti`s are kept per Sphere (identity.md 4.1); `pnpm run local` starts the Worker through wrangler's programmatic API with the operator token as a secret binding (sphere-api.md section 8).
>
> v0.1, amended on 2026-10-16 (messages, schemas and fixtures change; [obi-ai-bot/obi#494](https://github.com/obi-ai-bot/obi/issues/494)): Obis ask each other questions. `question` is now `{text, about?, choices?}`: `about` takes typed references to repositories, pull requests, issues and jobs (protocol.md 5.9), and `goal`, `question`, `repo` and `pr` are gone. A new reply, `answer` `{by, text, refs?, choice?, by_rule?}`, answers a question and ends its exchange; `result` no longer has `for: question`. So there are eight action types. The receiver answers a question by itself only from what a sharing rule of its owner allows, and otherwise asks its owner (protocol.md section 11, "Questions"), and it limits each sender ("Rate limits"). A question's repository for policy comes from its `about` (sphere-api.md section 5). A `question` or a `result` for a question made to the earlier text is no longer valid, and neither is an audit chain recorded under it that holds one: its entries no longer match the schemas, so the chain fails to verify (sphere-api.md section 7.1). No Sphere is known to hold such a chain: obid's card accepts only `review_request`, so no member could be sent a question.
>
> v0.1, amended on 2026-10-20 (wire schemas and fixtures change; no message changes): **open invitations**, one link for a team as Sangam's invite design shows. An invitation may leave `owner` and `obi` out and say `max_uses` (1 to 1,000); each redeem's card names its own `obi_id` and owner, ids are still never reused, and an owner's key is still bound on its first redeem (sphere-api.md section 4, identity.md section 3). Every invitation answer now carries `max_uses`. A new read, `POST …/invitations/{invitation_id}/preview`, authenticated by the invitation's secret, answers the Sphere's name and how many members are active, for a Join screen. The admin can withdraw an invitation at once (`DELETE …/invitations/{invitation_id}`), and a policy rule or a runner status's `for` names only owners who have joined (or `*`), so a link's first redeemer under an owner id inherits nothing. Limiting a link to an email domain is not in v0.1: the Sphere can't enforce it without an identity provider (sphere-api.md section 4 says what it would take). The conformance suite gets a `wire` case kind, judged by one wire schema.

> v0.1, amended on 2026-10-21 (messages, schemas and fixtures change, additions only; [obi-ai-bot/obi#797](https://github.com/obi-ai-bot/obi/issues/797)): an Obi can run another Obi's owner's job on its owner's Mac. A new request, `run_request` (protocol.md 5.10), and three new replies: `run_progress`, `run_return` (the job came back before it finished; ends the exchange) and `run_cancel`, the one reply a request's own sender sends (ends the exchange). `result` gains `for: run_request`, `decline` the reason `not_free`, and tokens the scope `send:run_request`. So there are twelve action types, and a card accepts up to four request types. A run_request's exchange has an end-to-end encrypted job channel the Sphere relays (protocol.md section 13, sphere-api.md 6.3), and an Obi publishes a signed runner status in the directory, shown only to the owners it is offered to (protocol.md section 14, sphere-api.md 6.4). Nothing earlier changes meaning: every message, card and chain valid before is valid still.
>
> v0.1, amended again on 2026-10-21 (additions only; [obi-ai-bot/obi#809](https://github.com/obi-ai-bot/obi/issues/809)): an owner can give a teammate a share of a company-paid API account (protocol.md section 15). A new request, `share_offer` (5.14), and two replies its own sender sends: `share_status` (5.15) and `share_revoke` (5.16, ends the exchange). `run_request` gains an optional `account: {grant}`, `decline` and `run_return` the reason `share_used`, and tokens the scope `send:share_offer`. Exchange rule 8 keeps the share replies to share_offer exchanges. Fifteen action types; a card accepts up to five request types.
>
> v0.1, amended a third time on 2026-10-21 ([obi-ai-bot/obi#810](https://github.com/obi-ai-bot/obi/issues/810)), before any of the above was deployed: a `run_request` no longer carries the job's words (`request`): they go on the job channel (protocol.md section 13), so the audit chain keeps only what a guest job is. A run_request's `result` loses `summary` and, with `run_return`, gains `cost_cents` for a job on a share. `run_progress` loses `paused` and `resumed`, and a receiver doesn't send it; a `run_request`'s exchange takes no `status`; `run_return`'s `reason` is `host_unavailable`, `time_limit` or `share_used`, without `minutes`; a runner status's `free` is worked out only at moments a random 15 to 20 minutes apart, and `free_at` is gone; a `run_request`'s `result` and `run_return` lose `host` (wall and CPU time); a receiver takes one `run_request` per sender's owner every 15 minutes; and a `run_request`'s `decline` says `unavailable` whatever the host's reason (only `expired`, `out_of_scope` and `share_used` stay, the guest's own doing), with no `by_rule`, and `not_free` is gone. Each would otherwise say when the host's owner is at their Mac.
>
> v0.1, amended on 2026-10-23 (a wire schema is added; no message changes): a **phone relay** (sphere-api.md section 9). A member's Mac keeps one WebSocket on a relay it registers with the Sphere, and the phones it paired join it with relay tokens it made, whose hashes it registers and can delete; the Sphere passes the end-to-end sealed frames between them, reading and keeping none, within limits per socket. A Sphere server relays for the members of its Spheres only, and revoking a member deletes its relays. New wire schema: [relay](schemas/v0.1/wire/relay.schema.json).

This is how one Obi asks another Obi for something, and how the other Obi answers. It is written so that an agent that is not Obi can implement it.

## Principles

- An Obi can only send the **typed actions** listed below. There is no free-text message type, and no message may carry a field its schema doesn't list.
- Every text field inside an action is **data, never instructions**. The receiving Obi may show it to its owner or quote it to an agent as a file. It never places it in a prompt as an instruction. The schemas mark every such field with `x-obi-text: data`.
- Every action is **signed** by the sending Obi. Each Obi publishes an A2A agent card signed by its owner's key.
- An Obi acts for its owner with an **OAuth on-behalf-of** token scoped to that owner.
- The Sphere server checks **policy** (may this Obi send this action to that Obi?) before it relays anything, and appends every action to the **audit chain**.
- An Obi never merges, pushes or publishes anything on another person's behalf because of an action it received.

## The actions

| Type | Starts or continues | What for |
|---|---|---|
| `review_request` | starts | Ask another Obi's owner to review a change at one commit, with typed acceptance conditions. |
| `question` | starts | Ask something the other owner knows, decided, or lets their Obi tell. |
| `handoff` | starts | Hand work to another Obi, which runs it for its own owner. |
| `status` | continues | Progress, without finishing. |
| `accept` | continues | The receiver takes the request on (by its owner's answer, or a remembered decision). |
| `decline` | ends | No, with a typed reason. |
| `result` | ends | The review's verdict and findings, the handoff's outcome, or the guest job's. |
| `answer` | ends | The answer to a question: by the other Obi, from what its owner lets it tell, or by its owner in their own words. |
| `run_request` | starts | Ask another Obi to run one of its sender's owner's jobs on its Mac, in a VM of its own, with the sender's own account. |
| `run_progress` | continues | Where that job is: queued, starting, running. A receiver shouldn't send it: the job channel says where the job is. |
| `run_return` | ends | The job stopped before it finished and comes back with its commits: the host was unavailable, its time was up, or its share was used. |
| `run_cancel` | ends | The request's own sender calls the job off. |

## The documents

| Document | What it pins |
|---|---|
| [protocol.md](protocol.md) | JSON rules, the envelope, every action and its fields, acceptance conditions, findings, text as data, signing, verifying a message, the receiving Obi's decision rule, open questions. |
| [identity.md](identity.md) | Keys and key ids, the agent card (A2A profile, owner signature, rotation, revocation), delegation (token exchange, assertions, scopes), and how it all works in a local Sphere. |
| [sphere-api.md](sphere-api.md) | The Sphere's HTTP API: every endpoint, its authentication, request and answer, error codes, policy, store-and-forward delivery, the audit chain and how to verify it, running a Sphere locally, the phone relay. |
| [schemas/v0.1/](schemas/v0.1/) | JSON Schemas (draft 2020-12): [envelope](schemas/v0.1/envelope.schema.json), [actions](schemas/v0.1/actions/), [agent card](schemas/v0.1/agent-card.schema.json), [audit entry](schemas/v0.1/audit-entry.schema.json), [wire bodies](schemas/v0.1/wire/), and the [shared definitions](schemas/v0.1/common.schema.json). |
| [conformance/](conformance/) | Valid and invalid fixtures for every rule, a reference verifier, and a runner that checks any implementation against them. |

## Checking it

With Node 22 or later and pnpm:

```sh
make spec-check            # from the repository root, or:
cd spec && pnpm install --frozen-lockfile && pnpm run check
```

The self-check compiles every schema, lints them (every object closed, every string bounded, every data field annotated), checks the canonical-JSON vectors, regenerates the fixtures and compares them byte for byte, and judges every fixture with the reference verifier. To check another implementation, see [conformance/README.md](conformance/README.md).
