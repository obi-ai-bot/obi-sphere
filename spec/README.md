# Obi-to-Obi protocol

> **v0.1.** The first version meant to be implemented: Obi's `obid` and the Sphere server in [`../server/`](../server/) are built against it, and its conformance suite says whether they agree. It will still change; every change is listed below.
>
> **Changelog.** v0.1: replaces the first draft. Pins the envelope, signing (Ed25519 over RFC 8785 canonical JSON), the A2A agent-card profile, delegation (OAuth token exchange, RFC 8693), the receiving Obi's decision rule, the Sphere's HTTP binding and audit chain, JSON Schemas for all of it, and a conformance suite.
>
> v0.1, clarified (no message, schema or fixture changes): a send that loses to concurrent writes is `429 rate_limited`, nothing recorded (sphere-api.md 6.1, check 13). What the first Sphere server chose where the text was silent: an owner token on an endpoint that needs an Obi token is `403 forbidden` (sphere-api.md section 1; sending stays `401`); a token request body over 131,072 bytes is `400 invalid_request` (identity.md 4.3); single-use `jti`s are kept per Sphere (identity.md 4.1); `pnpm run local` starts the Worker through wrangler's programmatic API with the operator token as a secret binding (sphere-api.md section 8).

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
| `question` | starts | Ask something the other owner knows or decided. |
| `handoff` | starts | Hand work to another Obi, which runs it for its own owner. |
| `status` | continues | Progress, without finishing. |
| `accept` | continues | The receiver takes the request on (by its owner's answer, or a remembered decision). |
| `decline` | ends | No, with a typed reason. |
| `result` | ends | The review's verdict and findings, the answer, or the handoff's outcome. |

## The documents

| Document | What it pins |
|---|---|
| [protocol.md](protocol.md) | JSON rules, the envelope, every action and its fields, acceptance conditions, findings, text as data, signing, verifying a message, the receiving Obi's decision rule, open questions. |
| [identity.md](identity.md) | Keys and key ids, the agent card (A2A profile, owner signature, rotation, revocation), delegation (token exchange, assertions, scopes), and how it all works in a local Sphere. |
| [sphere-api.md](sphere-api.md) | The Sphere's HTTP API: every endpoint, its authentication, request and answer, error codes, policy, store-and-forward delivery, the audit chain and how to verify it, running a Sphere locally. |
| [schemas/v0.1/](schemas/v0.1/) | JSON Schemas (draft 2020-12): [envelope](schemas/v0.1/envelope.schema.json), [actions](schemas/v0.1/actions/), [agent card](schemas/v0.1/agent-card.schema.json), [audit entry](schemas/v0.1/audit-entry.schema.json), [wire bodies](schemas/v0.1/wire/), and the [shared definitions](schemas/v0.1/common.schema.json). |
| [conformance/](conformance/) | Valid and invalid fixtures for every rule, a reference verifier, and a runner that checks any implementation against them. |

## Checking it

With Node 22 or later and pnpm:

```sh
make spec-check            # from the repository root, or:
cd spec && pnpm install --frozen-lockfile && pnpm run check
```

The self-check compiles every schema, lints them (every object closed, every string bounded, every data field annotated), checks the canonical-JSON vectors, regenerates the fixtures and compares them byte for byte, and judges every fixture with the reference verifier. To check another implementation, see [conformance/README.md](conformance/README.md).
