# Obi-to-Obi protocol v0.1: messages, actions and the receiver's rule

This document defines what one Obi may send another, how a message is signed and checked, and how the receiving Obi decides what to do. It is written so that an agent that is not Obi can implement it without reading any Obi source.

Companion documents:

- [identity.md](identity.md): keys, the agent card, and delegation (OAuth on-behalf-of).
- [sphere-api.md](sphere-api.md): the Sphere's HTTP binding and the audit chain.
- [schemas/v0.1/](schemas/v0.1/): JSON Schemas (draft 2020-12) for everything below.
- [conformance/](conformance/): fixtures and a runner that checks an implementation against them.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

## 1. Parties

- **Owner.** A person. Each owner has an Ed25519 key (the *owner key*) and an id unique in the Sphere (`owner_id`, like `wellington`).
- **Obi.** A personal delegate acting for exactly one owner. It has its own Ed25519 key (the *Obi key*) and an id unique in the Sphere (`obi_id`, like `obi-wellington`). It publishes an agent card signed by its owner's key ([identity.md](identity.md)).
- **Sphere.** A team's server: directory, policy, store-and-forward relay and audit chain ([sphere-api.md](sphere-api.md)). It checks every message before it relays it, but it never signs, writes or changes one.

## 2. JSON rules

Every message, card and API body is a JSON object (RFC 8259) encoded as UTF-8.

- Every string is a sequence of Unicode scalar values: no lone surrogates.
- Every number is an integer between 0 and 2^53 − 1. There are no floating-point numbers anywhere in the protocol. (So canonical JSON never has to format a fraction.)
- An object MUST NOT have two members with the same name. A receiver MUST reject a document whose parser reports a duplicate name, or MUST use a parser that rejects them.
- Every object has a fixed set of members (`additionalProperties: false` in every schema). A member the schema doesn't list makes the whole message invalid. This is how free text is kept out: there is nowhere to put it.
- Timestamps are RFC 3339 in UTC with `Z` and whole seconds, exactly 20 characters: `2026-10-14T12:00:00Z`. They must be real dates (no February 30th).
- Ids are lower-case UUIDs: `8a6c1f4e-5d2b-4c7a-9e3f-1b2c3d4e5f60`.

## 3. The envelope

Every message is one envelope that carries exactly one typed action in `body`. Schema: [envelope.schema.json](schemas/v0.1/envelope.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `protocol` | yes | Always `obi/0.1` for this version. |
| `id` | yes | Unique id of this message (UUID). The sender MUST NOT reuse it. |
| `type` | yes | One of `review_request`, `question`, `handoff`, `status`, `accept`, `decline`, `result`. Nothing else. |
| `from` | yes | The sending Obi's `obi_id`. |
| `to` | yes | The receiving Obi's `obi_id`. Different from `from`. Only that Obi may act on the message: any other Obi it reaches rejects it (section 10, check 5). |
| `sphere` | yes | The Sphere it travels in. |
| `correlation_id` | yes | The exchange it belongs to. On a request, equal to its own `id`. On a reply, equal to the request's `id`. |
| `in_reply_to` | replies only | On `status`, `accept`, `decline` and `result`: the `id` of the request it answers (in v0.1, always equal to `correlation_id`). A request MUST NOT have it. |
| `created_at` | yes | When the sender made it. |
| `expires_at` | yes | After this time the receiver MUST NOT act on it. Later than `created_at`, at most 2,592,000 seconds after it. |
| `key_id` | yes | The sender's signing key, as its agent card publishes it (`ed25519:` + base64url of SHA-256 of the raw public key). |
| `body` | yes | The action's fields: one of the schemas in [schemas/v0.1/actions/](schemas/v0.1/actions/), chosen by `type`. |
| `signature` | yes | Ed25519 signature over everything else (section 9). |

A whole envelope, in its canonical form (section 9), is at most 65,536 bytes.

## 4. Exchanges

Requests start an exchange: `review_request`, `question`, `handoff`. Replies continue it: `status`, `accept`, `decline`, `result`.

```
review_request, handoff:  request ─► [status…] ─► accept ─► [status…] ─► result or decline
                             └─────► [status…] ─► decline
question:                 the same, and also
                          request ─► [status…] ─► result
```

**The exchange rules.** These are the only ones. A receiving Obi applies them to the replies it gets (section 11, step 3), the Sphere applies them at send ([sphere-api.md](sphere-api.md) section 6.1, check 12), a chain's verifier applies them to every reply in the chain ([sphere-api.md](sphere-api.md) section 7.1, check 7), and the reference verifier implements them once (`exchangeProblem` in [conformance/lib/obi.mjs](conformance/lib/obi.mjs)). A reply is allowed exactly when all of these hold:

1. Its `in_reply_to` names a request, and the reply is from that request's `to` and to its `from`: only the request's receiver replies, and only to the request's sender.
2. The exchange has not ended: no `decline` or `result` for that request came before it. A `decline` or a `result` ends the exchange; nothing may follow it.
3. An `accept` comes only when the exchange has no `accept` yet: at most one per exchange. A `status` may come before the `accept` or after it, any number of times.
4. A `result`'s `for` is the request's type.
5. A `result` for a `review_request` or a `handoff` comes only after that exchange's `accept`. Only a `question` may be answered by a `result` without an `accept` (an `accept` before it is allowed too).
6. A `decline` may come at any point before the end, before or after an `accept`.

Silence until `expires_at` means no. The sender treats it as a decline with reason `expired`.

The conformance suite's audit fixtures pin each rule (`invalid-chain-review-result-without-accept`, `invalid-chain-handoff-result-without-accept`, `valid-chain-question-answered-directly`, `valid-chain-question-accepted-then-answered`, `invalid-chain-result-for-another-kind`, `valid-chain-decline-after-accept`, `invalid-chain-accepted-twice`, `valid-chain-status-before-accept`, `invalid-chain-reply-after-result`, `invalid-chain-reply-by-sender`).

## 5. Actions

Every human-written field is data (section 8). Every field below is bounded by the schemas; the lengths given are maximums in characters.

### 5.1 `review_request`

Ask another Obi's owner to review a change. Schema: [review_request.schema.json](schemas/v0.1/actions/review_request.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | What the change is for, one line (200). Data. |
| `repo` | yes | `owner/name`. |
| `pr` | no | The pull request number, when there is one. A change can be a branch only. |
| `base_branch` | yes | The branch the change goes into. |
| `head_branch` | yes | The branch that holds the change. |
| `head_sha` | yes | The commit to review. A review of another commit does not count. |
| `acceptance` | yes | 1 to 10 typed acceptance conditions (section 6). |
| `summary` | no | A few lines on what changed (2,000). Data. |

### 5.2 `question`

Ask another Obi something its owner knows or has decided. Schema: [question.schema.json](schemas/v0.1/actions/question.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | Why the question is asked, one line (200). Data. |
| `question` | yes | The question (2,000). Data. |
| `choices` | no | 2 or 3 distinct allowed answers (100 each). Data. |
| `repo`, `pr` | no | What it is about. |

### 5.3 `handoff`

Hand a piece of work to another Obi, which runs it for its own owner. Schema: [handoff.schema.json](schemas/v0.1/actions/handoff.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | The destination, one line (200). Data. |
| `repo` | yes | Where the work happens. |
| `base_branch` | yes | Branch to start from. |
| `issue`, `pr` | no | What the work belongs to. |
| `acceptance` | yes | 1 to 10 typed acceptance conditions. |
| `summary` | no | Context (2,000). Data. |

### 5.4 `status`

Progress on a request, without finishing it. `state` is one of `queued`, `working`, `waiting_on_owner`, `blocked`; `note` is optional one-line data (200). Status is pushed by the receiver when it chooses; v0.1 has no polling for it.

### 5.5 `accept`

The receiver takes the request on. `by_rule` (optional) names the remembered decision that allowed it, when the owner was not asked. An empty body means the owner said yes.

### 5.6 `decline`

No. `reason` is one of `policy`, `owner_declined`, `busy`, `expired`, `out_of_scope`, `other`. `by_rule` (optional) names the remembered decision that declined it. `note` is optional one-line data (200).

### 5.7 `result`

Finishes a request. `for` says which kind, and each kind has its own closed set of fields ([result.schema.json](schemas/v0.1/actions/result.schema.json)):

- **`for: review_request`.** `outcome` is `approved`, `changes_requested` or `failed`; `repo`, `head_sha` (the commit actually reviewed), `findings` (0 to 50, section 7), `acceptance` (one entry per condition of the request, required unless `failed`), optional `by_rule` and `summary` (4,000, data).
- **`for: question`.** `outcome` is `answered`; `answer` (2,000, data), optional `choice` (index into the question's `choices`) and `by_rule`.
- **`for: handoff`.** `outcome` is `done` or `failed`; `repo`, `acceptance`, optional `head_branch`, `head_sha`, `pr`, `by_rule`, `summary` (4,000, data).

Each `acceptance` entry is `{index, kind, severity?, met}`: `index` is the condition's position in the request, `kind` (and `severity`, for `no_findings_at_or_above`) repeat it so the result can be checked on its own, and `met` is a boolean.

A result MUST be consistent with itself. A receiver MUST reject one that isn't:

- `no_blocker_findings` is met exactly when no finding has severity `blocker`.
- `no_findings_at_or_above` with severity *s* is met exactly when no finding has severity *s* or higher.
- `approved` and `done` need every listed condition met; `changes_requested` needs at least one not met.
- Finding ids and acceptance indexes are unique within the result; `end_line`, when given, is not before `line`.

## 6. Acceptance conditions

Acceptance conditions are typed, so they can be checked by a machine. Each is an object with a `kind`:

| `kind` | Extra fields | Met when |
|---|---|---|
| `tests_pass` | `note` (optional data) | The receiver's own check for the repository passes on `head_sha`. The receiver decides what its check is; the sender never sends a command. |
| `no_blocker_findings` | `note` (optional data) | The review has no finding of severity `blocker`. |
| `no_findings_at_or_above` | `severity`, `note` (optional data) | The review has no finding at or above that severity. |
| `custom` | `text` (required data, 500) | A person (or the receiver's agent, reading the text as data) judges it. It is the only kind that isn't machine-checkable. |

There is no condition kind that carries a command, a script or a URL to fetch. A sender that wants something run can only name a kind; the receiver runs its own checks.

## 7. Findings

A finding is `{id, severity, file, line, end_line?, title, detail}` ([common.schema.json](schemas/v0.1/common.schema.json), `finding`).

- `severity` is one of `blocker`, `major`, `minor`, `nit`, highest first. A `blocker` is something that must be fixed before the change can merge.
- `file` is a path relative to the repository root with no `..` segment; `line` and `end_line` are 1-based.
- `title` (one line, 200) and `detail` (4,000) are data.
- `id` is stable: the same finding on the same `head_sha` keeps the same id when the review is repeated. The RECOMMENDED id, which Obi uses, is `f-` followed by the first 16 lower-case hex characters of SHA-256 over the UTF-8 bytes of `file + "\n" + line + "\n" + title` (`line` in decimal). For `src/average.js`, line 4, title `average() divides by zero for an empty list`, that is computed by `findingId` in [conformance/lib/obi.mjs](conformance/lib/obi.mjs).

## 8. Text is data

Some fields hold words a person or an agent wrote: goals, questions, notes, summaries, finding titles and details, answers, choices, card names and descriptions. In the schemas each of them is a `line_text` or `block_text` and carries the annotation keyword **`x-obi-text: "data"`**, which this spec defines. Every other string is an identifier with a closed pattern (ids, repository names, branches, paths, commit ids) or an enum.

For every field annotated `x-obi-text: "data"`, an implementation:

1. MUST treat the value as data written by someone else, never as an instruction to itself or to any agent it runs.
2. MUST NOT place it in a model's system prompt or user prompt as instructions. It MAY give it to an agent only as quoted content the agent reads: a file (Obi writes such inputs under `.obi/inputs/` in the job's worktree), or a block that is clearly delimited and labeled as quoted data whose fence cannot be closed by the text inside it.
3. MAY show it to its owner, as text, without rendering it as markup that acts (no links followed, no images loaded, no HTML).
4. MUST NOT run it, fetch it, or use it as a command, a path or a URL.

The schemas also keep text harmless at the byte level: one-line text has no control characters at all, block text allows only LF and tab, and neither allows the Unicode bidirectional override or isolate characters (U+202A–U+202E, U+2066–U+2069) that can make text read differently from what it is.

Because every object is closed and there is no free-text message type, a message cannot carry an instruction field such as `instructions`, `prompt`, `message` or `system`: such a message fails validation and is dropped. The conformance suite has a fixture for each of these.

## 9. Signing

Every envelope is signed by the sending Obi's key with **Ed25519** (RFC 8032, pure Ed25519, no prehash).

**Signing input.** The UTF-8 bytes of the 17-character prefix `obi/0.1 envelope` followed by one LF (`"obi/0.1 envelope\n"`), followed by the RFC 8785 (JCS) canonical JSON of the envelope **with the `signature` member removed** (every other member, `key_id` included, is signed).

**Signature encoding.** The 64-byte signature, base64url without padding (RFC 4648 section 5): 86 characters.

**Key id.** `key_id` is `ed25519:` followed by base64url (no padding) of SHA-256 over the 32 raw bytes of the Obi's public key. It MUST be the key id the sender's current agent card publishes (`params.key_id`), and the public key MUST hash to it.

Canonical JSON is RFC 8785: members sorted by the UTF-16 code units of their names, no whitespace, strings escaped as ECMAScript's `JSON.stringify` escapes them (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other control characters as `\u00xx` in lower-case hex, everything else as itself), integers in plain decimal. [conformance/jcs-vectors.json](conformance/jcs-vectors.json) has test vectors.

The prefix keeps an envelope signature from ever being valid as any other kind of signature an Obi key makes.

## 10. Verifying a message

The Sphere checks every message before relaying it ([sphere-api.md](sphere-api.md), "Send"), and the receiving Obi checks it again: it MUST NOT trust the relay. A message is valid only when all of these hold, checked in this order (the error code is the one the Sphere answers with, and the one the conformance fixtures name; `wrong_recipient` is the receiver's alone, below):

| # | Check | Code |
|---|---|---|
| 1 | Its canonical form is at most 65,536 bytes. | `payload_too_large` |
| 2 | It matches [envelope.schema.json](schemas/v0.1/envelope.schema.json), including the body schema for its `type`. | `invalid_envelope` |
| 3 | The rules no schema can say: `expires_at` after `created_at` and at most 2,592,000 seconds after it; real dates; `from` ≠ `to`; a request's `correlation_id` equals its `id`; a reply's `in_reply_to` equals its `correlation_id`; a `result` is consistent with itself (section 5.7). | `invalid_envelope` |
| 4 | `sphere` is the receiver's Sphere. | `wrong_sphere` |
| 5 | `to` is the receiver's own `obi_id`. | `wrong_recipient` |
| 6 | `key_id` is a key the directory lists for `from`, valid for this message (below), and that public key hashes to `key_id`. | `unknown_key` |
| 7 | The signature verifies with that key over the signing input. | `bad_signature` |
| 8 | `expires_at` is after now. | `expired` |
| 9 | `created_at` is at most 300 seconds after now (clock skew). | `clock_skew` |
| 10 | The receiver hasn't seen this `id` before. | `duplicate` |

**The receiver (check 5).** A message is for the one Obi its `to` names. An Obi that receives a message addressed to another Obi MUST reject it, however well it is signed: otherwise a Sphere that misroutes a delivery, or relays a message it captured to a member it wasn't for, could make that member act on a request meant for someone else. The Sphere never answers `wrong_recipient` over HTTP: it queues a message only for its `to` ([sphere-api.md](sphere-api.md) section 6.1, check 11), so a send has no other receiver to be wrong about. The conformance fixtures `invalid-wrong-recipient` and `invalid-wrong-recipient-reply` pin it; every envelope fixture's `context` names its `receiver`.

**Which key is valid for a message (check 6).** The directory gives each key a range of audit seqs (`valid_from_seq`, `valid_until_seq`; [identity.md](identity.md) section 3). A receiver judges a delivered message **by the delivery's `seq`**, the seq of its audit entry: the key is valid when `valid_from_seq` ≤ seq and, unless `valid_until_seq` is null, seq ≤ `valid_until_seq`. So a message the Sphere recorded with the sender's old key just before a rotation still verifies when it arrives after it. A message with no seq yet (the Sphere checking a send) needs the sender's current key (`valid_until_seq` null). The conformance fixtures `valid-key-rotated-after-relay`, `invalid-key-not-valid-at-seq` and `invalid-key-not-current-at-send` pin this; their `context` carries the `seq`.

## 11. How the receiving Obi decides

This rule is normative for Obi and RECOMMENDED for every implementation. The words "remembered decision" mean a decision the owner made once and asked the Obi to keep.

When a delivery arrives, the receiving Obi:

1. **Verifies** it (section 10). If it isn't valid, the Obi acknowledges the delivery, records why locally, and sends nothing back: it does not answer a message it cannot authenticate. An expired request is the exception: the Obi MAY send `decline` with reason `expired`.
2. **Deduplicates.** A message whose `id` it has already handled is acknowledged and ignored.
3. **Replies** (`status`, `accept`, `decline`, `result`) are matched to the outgoing request named by `in_reply_to`, which MUST have been sent to the reply's `from`. A reply that matches nothing, or that breaks the exchange rules (section 4) given the replies already recorded for that request, is acknowledged and dropped. A matched reply updates the exchange; a `result` is shown to the owner and is data like any other text.
4. **Requests.** If the type isn't one its card `accepts`, it sends `decline` with reason `out_of_scope`.
5. It looks for a **remembered decision** that covers the request. The key is `(type, sender's owner, repo)`, where the sender's owner comes from the directory (the sender's verified agent card), never from the message's text, and `repo` is the body's `repo` (or `*` when the body has none). A decision for that exact repo wins over one for every repo (`*`).
   - A remembered **accept**: go to step 7, and name the decision's id in `accept.by_rule` and `result.by_rule`.
   - A remembered **decline**: send `decline` with reason `owner_declined` and the decision's id in `by_rule`.
6. Otherwise it puts the request in its **owner's inbox** and waits. It does not guess, and it does not time out on its own; only `expires_at` ends the wait (the item is then settled by itself and the Obi MAY send `decline` with reason `expired`). The owner answers one of:
   - **Accept**: this time only.
   - **Accept, and remember for this repo**: accept, and keep an accept decision for `(type, sender's owner, repo)`.
   - **Decline**: this time only (`decline`, reason `owner_declined`).
   - **Decline, and remember for this repo**: decline, and keep a decline decision for that key.
   The answer that keeps a decision is applied to later requests at step 5 without asking again.
7. **Accepting.** It sends `accept`. It MAY send `status` while working. It does the work for its own owner, in a fresh, isolated workspace (Obi: a new git worktree per job), giving the request's data fields to its agent only as quoted data (section 8). For a review it checks out exactly `head_sha`; for `tests_pass` it runs its own check for the repository.
8. **Publishing the answer.** Before anything leaves, every text field of the reply passes the receiver's secret scan. If the scan finds a possible secret, or cannot run, the text does not go out: the Obi sends a `result` with outcome `failed` (or `decline` with reason `other`) and no text fields. Otherwise it sends the `result`.

The Obi acknowledges a delivery (sphere-api.md, "Ack") only after it has durably recorded what step 3 to 6 decided, so a crash before that means the Sphere delivers it again, and step 2 makes the second delivery harmless.

**What a received action never causes.** An Obi never merges, pushes, approves on a code host, publishes, or changes settings or remembered decisions because of an action it received. The only thing that leaves because of a received request is the typed reply to that request, through the Sphere. A remembered decision is changed only by its own owner.

## 12. Mapping to A2A (informative)

The agent card is an A2A AgentCard ([identity.md](identity.md)). In v0.1 the only transport is the Sphere relay. When Obis talk over A2A directly (a later version), an envelope travels as an A2A `Message` with a single `DataPart` whose `data` is the signed envelope, unchanged; the envelope's own signature, not the transport, is what the receiver checks.

## 13. Open questions

**Resolved in v0.1** (they were open in the draft):

- Canonical JSON and signatures: Ed25519 over RFC 8785 JCS with a domain prefix (section 9), not JWS, for envelopes; the agent card keeps A2A's JWS form ([identity.md](identity.md)).
- How agent cards are rotated and revoked: a new card with a higher `card_seq`; revocation through the Sphere ([identity.md](identity.md)).
- Whether `status` is pushed or polled: pushed by the receiver, as a reply.
- How policy is written: a fixed table of allow rules per Sphere ([sphere-api.md](sphere-api.md), "Policy").

**Still open:**

- Rotating an owner key, and recovering when an owner loses it.
- Owner identity beyond a bound key (OIDC or another identity provider in front of the token endpoint).
- Direct Obi-to-Obi transport over A2A without the Sphere, and federation between Spheres.
- Auditing membership and policy changes in the chain (v0.1 records relayed messages only).
- Cross-checking a result's `acceptance` against the request's conditions on the Sphere (today each Obi checks its own exchanges).
- Encrypting bodies end to end so the Sphere relays without reading them.
- Rate limits and quotas: the error code exists (`rate_limited`); the numbers don't.
- A `cancel` action for the sender.
