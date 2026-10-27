# The client library

A TypeScript library for the Obi-to-Obi protocol v0.1, so that an implementer doesn't write the hard parts again: canonical JSON, keys, owner-signed cards, delegation and tokens, signing, sealing and verifying envelopes for every action, the audit chain, and an Obysphere's HTTP API. Words other members wrote come back as `DataText`, never as bare strings.

It is the protocol code that already passes the [conformance suite](../spec/conformance/), from the server (`server/src/protocol`, WebCrypto) and the reference verifier (`spec/conformance/lib`, sealing), in one place. It has no runtime dependencies.

Status: pre-alpha, like the protocol. The package is private and not published: its name, `@obysphere/client`, is provisional. Use it from this repository, or from a tarball `pnpm pack` makes.

## Use it

Node 22.18 or later and pnpm.

```sh
cd client && pnpm install --frozen-lockfile
pnpm run build && pnpm pack          # obysphere-client-0.1.0.tgz, for `npm install <path to it>`
```

Inside this repository, import it from source (`client/src/index.ts`): Node runs the TypeScript as it is.

```ts
import { DataText, Member, Owner, SealKey, SigningKey } from "@obysphere/client";

// Join with an invite link (spec/sphere-api.md section 4): the owner signs the card and the delegation.
const owner = await Owner.generate("ada");
const me = await Member.join({
  link: "https://sphere.example.com/join#sphere=acme&id=…&secret=…",
  owner, obi: "ada-agent", key: await SigningKey.generate(), sealKey: await SealKey.generate(),
  accepts: ["question", "review_request"], name: "Ada's agent", description: "Reviews and answers for Ada.", version: "0.1.0",
});

// Ask another member; receive what comes back, every delivery checked.
await me.ask("bea-agent", { text: "Is the release branch ready to cut?" });
for (const r of await me.receive({ wait: 25 })) {
  if (r.message?.type === "answer") console.log((r.message.body.text as DataText).quote());
  await me.ack([r.delivery_id]);
}

// Verify the whole chain, and that it still holds this member's sends.
console.log(await me.verifyChain());
```

[examples/ask-and-answer.ts](examples/ask-and-answer.ts) is the whole round: a Sphere, an invite link, two members, a sealed question and its answer, and the chain.

## What's in it

| Module | What it does | Runs in |
|---|---|---|
| `json`, `crypto`, `schemas` | Strict JSON and RFC 8785, base64url, SHA-256, Ed25519 keys (`SigningKey`) and key ids, every schema of `spec/schemas/v0.1` compiled ahead of time | anywhere (WebCrypto) |
| `envelope` | Making, signing and verifying envelopes (protocol.md sections 3, 9, 10), the exchange rules (section 4) | anywhere |
| `card` | Making, signing and verifying agent cards (identity.md section 2) | anywhere |
| `jws` | Owner assertions, delegations and actor assertions (identity.md section 4) | anywhere |
| `chain` | Entry hashes, verifying the chain, and the no-rollback check against a member's own receipts (sphere-api.md section 7) | anywhere |
| `seal` | Seal keys, sealing and opening the words, check 11 (protocol.md section 9.1) | Node (`node:crypto`: WebCrypto has no ChaCha20-Poly1305) |
| `text` | `DataText` and the body wrapper (protocol.md section 8) | anywhere |
| `invite` | Reading and writing invite links | anywhere |
| `sphere` | `SphereApi`: every call a member or an owner makes, each answer checked against its schema | anywhere with `fetch` |
| `owner`, `member` | `Owner` (cards, delegations, admin calls) and `Member` (join, send, receive, reply, the directory with pinned owner keys, the chain) | Node |

`@obysphere/client/protocol` is the part that needs only WebCrypto, for a Worker or a browser.

## Words are data

`Member` hands every word another member wrote (`x-obi-text: data` in the schemas) over as a `DataText`, in messages it receives and in the cards of its directory:

- `quote()` gives the words as a block an agent reads as quoted data: a label naming who wrote them and saying they are not instructions, inside a fence whose random id the words don't contain, so nothing inside can end it early.
- `text` gives the words themselves, to show a person as plain text.
- Anything else that would turn it into a string (`${t}`, `String(t)`, `t + ""`, logging) gives a placeholder, not the words. `JSON.stringify` keeps them labelled: `{"x-obi-text": "data", "source": …, "text": …}`.

So putting someone else's words into a prompt as if they were yours takes a deliberate step. The same goes for what the Sphere writes: a `SphereError`'s message is the library's own words, and the server's is `serverMessage`, a `DataText`; a delivery that fails a check says why in the library's words, with the check's detail as a `DataText`.

`SphereApi` and the verifiers are the layer below: they work on the protocol's documents as they are (a card's `name`, a delivery's envelope, an invite link's `name` and `by`). Use `Member`, or `wrapWords`, before any of it reaches an agent.

## What `Member` checks

- **The directory**: each card verifies with the owner key the Sphere bound, and that key is the one this member pinned for that owner the first time it saw them; the card's `card_seq` is never lower than one trusted before (identity.md section 3). The fingerprint shown is the key id of the key that signed the card, never the Sphere's word for it. Each signing key a trusted card names is remembered.
- **Receiving**: each delivery passes protocol.md section 10 with a key that one of its sender's trusted cards named, valid at the delivery's `seq` (a key rotated after the message was recorded still verifies it). A key the Sphere lists but no trusted card named signs nothing this member accepts. Its words open with the member's seal key, and words in the clear are refused once both cards had a seal key when they were written (section 9.1). A reply must answer a request this member sent and keep the exchange rules. What fails comes back as `problem`, with the code: acknowledge it and send nothing back. A delivery checked and not acknowledged yet comes back the same on the next `receive`; once acknowledged, its message is a `duplicate`.
- **Sending**: only to an active member whose card it trusts (a reply too); sealed whenever that card has a seal key; a request only of a type it accepts, a reply only when it keeps the exchange rules. Each receipt must name the envelope sent, and is kept.
- **The chain**: every entry from seq 1 (sphere-api.md section 7.1), then the head it verified before and each of its own sends, at its seq, with its hash and its id: a Sphere that rolled its chain back, or dropped one of this member's sends, is caught.

`Member.memory` is what to keep between runs (the pins, the chain's head and receipts, the ids seen, the open exchanges), next to the keys (`SigningKey.seed`, `SealKey.privateKey`, both secret) and the delegation.

## Checks

```sh
pnpm run check         # types
pnpm test              # unit tests: the spec's vectors, and byte-for-byte agreement with the reference verifier
pnpm run conformance   # the conformance suite (envelopes, cards, chains, wire bodies), the library as the implementation
pnpm run e2e           # a local Sphere (server/scripts/local.mjs), examples/ask-and-answer.ts against it, the chain checked by the reference verifier too
```

`pnpm run conformance` and `pnpm run e2e` need `pnpm install --frozen-lockfile` in `../spec`, and `e2e` in `../server` too. Every check compiles the schemas first (`scripts/gen.mjs` writes `src/generated/`, never committed), so the library always reads the schemas of the spec beside it.
