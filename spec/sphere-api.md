# Obi-to-Obi protocol v0.1: the Sphere's HTTP binding

The exact HTTP API a Sphere server exposes. Obi's Obi-to-Obi client (in `obid`) and the end-to-end test's scripted client call it; the Sphere server in [`../server/`](../server/) implements it. Anything not written here is not part of the contract: when an implementation needs it, change this document first.

Read [protocol.md](protocol.md) (messages) and [identity.md](identity.md) (keys, cards, tokens) first.

## 1. Conventions

- **Base URL.** Whatever the Sphere is served at, like `https://sphere.example.com` or `http://127.0.0.1:8787` locally. Every path below starts with `/v0.1`.
- **JSON.** Request and response bodies are JSON (protocol.md, "JSON rules"), `Content-Type: application/json`, keys in `snake_case`. A request body is at most 131,072 bytes (`413 payload_too_large`), except at the token endpoint, which takes a form and answers OAuth errors: a body over 131,072 bytes there is `400 invalid_request` (identity.md 4.3). Unknown members are refused (`400`), as everywhere in the protocol.
- **Authentication.** One of:
  - **none**: `GET /v0.1/health`, the token endpoint, and previewing or redeeming an invitation (its secret is the credential);
  - **operator**: `Authorization: Bearer <operator token>`, only for creating Spheres. The operator token is the Worker secret `SPHERE_OPERATOR_TOKEN` (at least 32 characters). A Sphere server without one refuses every operator call (`403 forbidden`). It is compared in constant time and never logged;
  - **bearer**: `Authorization: Bearer <access token>` from the token endpoint (identity.md, "Delegation"). A token is for one Sphere; it carries a subject (the owner), maybe an actor (the Obi) and scopes. "Obi token" below means a token with an actor; "owner token" one without.
  - An **owner token on an endpoint that needs an Obi token** (section 2: changing a card, fetching and acknowledging deliveries) is `403 forbidden`. Sending is the one exception: section 6.1, check 1, answers it `401 unauthorized`, before the body is read.
  - The other way round, an **Obi token on an endpoint that needs an owner token** (section 2) is refused too: those are the owner's own steps, never an Obi's. Revoking a member, which needs no scope, answers it `403 forbidden`, even when the member is that Obi itself. Creating an invitation and replacing the policy check their scope first, and an Obi's token never holds `admin` (identity.md 4.2), so there it is `403 insufficient_scope`.
- **Errors.** Every non-2xx answer except the token endpoint's is [error.schema.json](schemas/v0.1/wire/error.schema.json): `{"error": {"code": "<code>", "message": "<one line>", "details": ["…"]}}`. `message` and `details` are for people and are data. The token endpoint answers OAuth errors (RFC 6749 section 5.2): `{"error": "invalid_grant", "error_description": "…"}`.
- **Times.** The Sphere's clock decides expiry and records `recorded_at`. It allows 300 seconds of skew for `created_at`, `iat` and `issued_at`.

| Code | HTTP | When |
|---|---|---|
| `bad_request` | 400 | The body doesn't match the endpoint's schema, or a query parameter is not a decimal integer in its range (section 6.2, section 7). |
| `invalid_envelope` | 400 | A message fails protocol.md section 10, checks 2 or 3, or isn't JSON. |
| `wrong_sphere` | 400 | The message names another Sphere than the path. |
| `unknown_key` | 400 | `key_id` isn't the sender's current key. |
| `bad_signature` | 400 | The signature doesn't verify. |
| `expired` | 400 | `expires_at` has passed. |
| `clock_skew` | 400 | `created_at` is more than 300 seconds ahead. |
| `card_invalid` | 400 | An agent card fails identity.md section 2.2, or doesn't match its invitation or member. |
| `unauthorized` | 401 | No token, an unknown, expired or revoked token, or a token for another Sphere; or a wrong operator token. |
| `insufficient_scope` | 403 | The token lacks the scope the call needs. |
| `forbidden` | 403 | The caller may not do this (a message `from` another Obi than the token's actor, an owner token where an Obi token is needed, an Obi token revoking a member, an Obi's token on another Obi's card, an owner key that differs from the bound one, no operator token configured). |
| `policy_denied` | 403 | No policy rule allows this request, or the receiver's card doesn't accept its type. |
| `recipient_revoked` | 403 | The receiver was revoked. |
| `invitation_invalid` | 403 | Unknown, expired, used up, or the wrong secret: always the same answer. |
| `not_found` | 404 | No such Sphere, member or invitation. |
| `unknown_recipient` | 404 | `to` isn't a member. |
| `duplicate` | 409 | A message with this `id` and a different signature was relayed before. |
| `bad_reply` | 409 | A reply that breaks the exchange rules (protocol.md section 4; section 6.1, check 12). |
| `conflict` | 409 | The resource exists already, a stale `expected_version` or `card_seq`, or a key id another member uses. |
| `payload_too_large` | 413 | The body is over 131,072 bytes, or the message's canonical form over 65,536. |
| `rate_limited` | 429 | Too many calls, or a message could not be recorded because of concurrent writes to the same Sphere (section 6.1, check 13); `Retry-After` says when to try again. Nothing was recorded. v0.1 doesn't fix the Sphere's limits; protocol.md section 11 ("Rate limits") recommends a receiver's. |
| `internal` | 500 | The Sphere failed. Nothing was recorded. |

## 2. Endpoints

| Method and path | Auth | Scope | Request | Answer |
|---|---|---|---|---|
| `GET /v0.1/health` | none | | | `200` [health.response](schemas/v0.1/wire/health.response.schema.json) |
| `POST /v0.1/spheres` | operator | | [create-sphere.request](schemas/v0.1/wire/create-sphere.request.schema.json) | `201` [sphere](schemas/v0.1/wire/sphere.schema.json) |
| `POST /v0.1/oauth/token` | none | | form (identity.md 4.3) | `200` [token.response](schemas/v0.1/wire/token.response.schema.json) |
| `GET /v0.1/spheres/{sphere}` | bearer | any | | `200` sphere |
| `POST /v0.1/spheres/{sphere}/invitations` | owner token | `admin` | [invitation.request](schemas/v0.1/wire/invitation.request.schema.json) | `201` [invitation.response](schemas/v0.1/wire/invitation.response.schema.json) |
| `POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/preview` | none (secret) | | [invitation-preview.request](schemas/v0.1/wire/invitation-preview.request.schema.json) | `200` [invitation-preview.response](schemas/v0.1/wire/invitation-preview.response.schema.json) |
| `POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/redeem` | none (secret) | | [redeem.request](schemas/v0.1/wire/redeem.request.schema.json) | `201` [member](schemas/v0.1/wire/member.schema.json) |
| `GET /v0.1/spheres/{sphere}/members` | bearer | `directory:read` | | `200` [members.response](schemas/v0.1/wire/members.response.schema.json) |
| `GET /v0.1/spheres/{sphere}/members/{obi}` | bearer | `directory:read` | | `200` member |
| `PUT /v0.1/spheres/{sphere}/members/{obi}/card` | Obi token of `{obi}` | any | [card-update.request](schemas/v0.1/wire/card-update.request.schema.json) | `200` member |
| `DELETE /v0.1/spheres/{sphere}/members/{obi}` | owner token | `admin`, or the Obi's own owner | | `200` member |
| `GET /v0.1/spheres/{sphere}/policy` | bearer | `directory:read` or `admin` | | `200` [policy](schemas/v0.1/wire/policy.schema.json) |
| `PUT /v0.1/spheres/{sphere}/policy` | owner token | `admin` | [policy-put.request](schemas/v0.1/wire/policy-put.request.schema.json) | `200` policy |
| `POST /v0.1/spheres/{sphere}/messages` | Obi token | `send:<type>` or `reply` | the signed envelope | `202` [send.response](schemas/v0.1/wire/send.response.schema.json) (`200`, the original answer, for a retry: section 6.1, check 8) |
| `GET /v0.1/spheres/{sphere}/deliveries?limit=&wait=` | Obi token | `receive` | | `200` [deliveries.response](schemas/v0.1/wire/deliveries.response.schema.json) |
| `POST /v0.1/spheres/{sphere}/deliveries/ack` | Obi token | `receive` | [ack.request](schemas/v0.1/wire/ack.request.schema.json) | `200` [ack.response](schemas/v0.1/wire/ack.response.schema.json) |
| `GET /v0.1/spheres/{sphere}/audit?from_seq=&limit=` | bearer | `audit:read` | | `200` [audit.response](schemas/v0.1/wire/audit.response.schema.json) |

A path for a Sphere that doesn't exist is `404 not_found`; a token for another Sphere on it is `401 unauthorized`.

## 3. Spheres

`POST /v0.1/spheres` creates a Sphere (a team):

```json
{"sphere": "e2e", "name": "E2E sphere", "admin": {"owner": "wellington", "owner_key": "<base64url>"}}
```

It binds `owner_key` to the admin owner, sets the policy to version 0 with no rules (every request refused) and `updated_at` equal to the Sphere's `created_at`, and starts an empty audit chain (head seq 0, head hash 64 zeros). Answers `201`:

```json
{"sphere": "e2e", "name": "E2E sphere", "protocol": "obi/0.1", "admin_owner": "wellington", "created_at": "2026-10-14T12:00:00Z"}
```

`409 conflict` when the id is taken.

## 4. Invitations and pairing

**Invite.** The admin asks for an invitation. A **named** invitation is for one Obi of one owner (the owner may be new) and is used once:

```json
POST /v0.1/spheres/e2e/invitations
{"owner": "ernesto", "obi": "obi-ernesto", "expires_in": 3600}
```

```json
201 {"invitation_id": "…", "sphere": "e2e", "owner": "ernesto", "obi": "obi-ernesto", "max_uses": 1,
     "secret": "<43 base64url characters>", "expires_at": "2026-10-14T13:00:00Z"}
```

An **open** invitation leaves `owner` and `obi` out: it is one link for a team, used by up to `max_uses` Obis (1 to 1,000; 1 when left out), each of whose cards names its own `obi_id` and `owner`:

```json
POST /v0.1/spheres/e2e/invitations
{"expires_in": 604800, "max_uses": 50}
```

```json
201 {"invitation_id": "…", "sphere": "e2e", "max_uses": 50,
     "secret": "<43 base64url characters>", "expires_at": "2026-10-21T12:00:00Z"}
```

`owner` and `obi` come together or not at all, and a named invitation takes no `max_uses` (`400 bad_request`). The secret is 32 random bytes, base64url, shown once; the Sphere keeps its SHA-256. `expires_at` is the Sphere's clock when it made the invitation plus `expires_in` seconds. A named invitation's `obi` id that is or was a member is `409 conflict`: ids are never reused.

**Preview.** Before joining, whoever holds the link can read what it leads to, so a Join screen can show it. The secret is the credential, sent in the body to keep it out of URLs and logs, as for redeeming; nothing is used up:

```json
POST /v0.1/spheres/e2e/invitations/{invitation_id}/preview
{"secret": "…"}
```

```json
200 {"sphere": "e2e", "name": "E2E sphere", "member_count": 2, "expires_at": "2026-10-21T12:00:00Z"}
```

`member_count` is the number of `active` members now. The invitation is checked as in redeem check 2, with the same `403 invitation_invalid` for every way it fails; a body that doesn't match the schema is `400 bad_request`.

**Redeem (pair the Obi).** The Obi presents the secret, its owner's key and its owner-signed card:

```json
POST /v0.1/spheres/e2e/invitations/{invitation_id}/redeem
{"secret": "…", "owner_key": "<base64url>", "card": { …agent card… }}
```

The Sphere checks, in order:

1. The body matches the schema (`400 bad_request`).
2. The invitation exists, is unexpired, has been used fewer than `max_uses` times, and the secret's SHA-256 matches, compared in constant time (`403 invitation_invalid` for every one of these).
3. The card is valid (identity.md 2.2, checks 1 to 5 and 7) (`400 card_invalid`).
4. The card's `sphere` is the Sphere's, its `owner_key` is the body's, and for a named invitation its `obi_id` and `owner` are the invitation's (`400 card_invalid`). For an open invitation, the card's `obi_id` and `owner` are the member's.
5. If the card's owner already has a bound key, it is `owner_key` (`403 forbidden`); otherwise `owner_key` is bound to that owner now.
6. No other member uses the card's `key_id` (`409 conflict`).
7. The card's `obi_id` is not and never was a member (`409 conflict`): ids are never reused, and an Obi that gets this answer picks another id and redeems again.

A redeem that fails uses nothing. Then, in one transaction: the invitation is used once more (used up when it reaches `max_uses`), the member is `active` with `joined_at` the Sphere's clock now, and its key's `valid_from_seq` is the chain's head seq + 1 and `valid_until_seq` null. Answers `201` with the member:

```json
{"obi": "obi-ernesto", "owner": "ernesto", "owner_key": "…", "owner_key_id": "ed25519:…", "status": "active",
 "joined_at": "2026-10-14T12:00:05Z", "card": { … },
 "keys": [{"key_id": "ed25519:…", "public_key": "…", "valid_from_seq": 1, "valid_until_seq": null}]}
```

**What an open invitation's secret proves.** Only that the redeemer holds the link. The owner id an open redeem binds is the one its card names, so:

- the first redeem that names an owner who has no bound key yet takes that owner id for good: a later owner with that id and another key is `403 forbidden`, and owner ids are never released, even when every Obi of that owner is revoked;
- an owner who is already bound (the admin, or anyone who joined) can't be impersonated: a card naming them must carry, and be signed by, their bound key;
- a policy rule that names an owner (section 5) gives its permissions to whoever binds that owner id first. An admin writes such rules for people who have joined, after checking their `owner_key_id` with them, or uses a named invitation;
- the admin sees every member in the directory and revokes what it doesn't recognise (identity.md section 3). `expires_in` and `max_uses` bound what a leaked link can do; v0.1 has no call to withdraw an invitation before it expires.

**Limiting an invitation to an email domain** (anyone at `@example.com`) is not in v0.1, and the Sphere can't enforce it without an identity provider: owner ids and card names are chosen by the redeemer, and nothing in a redeem proves an email address. To add it, a Sphere would trust an OpenID Connect issuer (configured by its operator), an invitation would carry the domain, and a redeem would carry an ID token from that issuer whose audience is the Sphere and whose `nonce` binds it to the invitation and the `owner_key`. The Sphere would check its signature against the issuer's keys, `iss`, `aud`, `exp` and `nonce`, require `email_verified` and the domain (for Google Workspace, the `hd` claim), and bind the owner id to that verified address, one owner id per address. An address an issuer relays or hides (Sign in with Apple's private relay) proves no domain. Until then, a client that shows such a limit must not say it is enforced.

**Directory.** `GET /members` lists every member, active and revoked, ordered by `joined_at` then `obi`. A member has `revoked_at` (when it was revoked) exactly when its `status` is `revoked`, and no `revoked_at` while it is `active`. Receivers use it to find a sender's owner and keys, and check each card themselves (identity.md 2.2) before trusting it.

**Rotate and revoke.** `PUT /members/{obi}/card` and `DELETE /members/{obi}`: identity.md section 3. A card update needs a higher `card_seq` (`409 conflict` otherwise), the same `sphere`, `obi_id`, `owner` and bound `owner_key` (`400 card_invalid`), and a `key_id` no other member uses (`409 conflict`). The key values, with *h* the chain's head seq at the moment the change is made (in the same transaction as the change):

- **Rotation** (a new `key_id`): the old key's `valid_until_seq` becomes *h*; the new key is added with `valid_from_seq` *h* + 1 and `valid_until_seq` null. A card with the same `key_id` changes no key.
- **Revocation**: the current key's `valid_until_seq` becomes *h*, `status` becomes `revoked` and `revoked_at` the Sphere's clock now. Keys closed earlier keep their values. When nothing was recorded since the key was opened, *h* is its `valid_from_seq` − 1: an empty range, so no entry verifies with it.
- Revoking an already revoked member changes nothing and answers it as it is (`200`).

## 5. Policy

The policy is a fixed table of **allow** rules ([policy.schema.json](schemas/v0.1/wire/policy.schema.json)). A request is allowed when at least one rule matches all of:

- `from_owner` is `*` or the sending Obi's owner;
- `to_owner` is `*` or the receiving Obi's owner;
- `actions` contains the request's type;
- `repos` contains `*`, or `<owner>/*` where `<owner>` is the owner part of the request's repository, or that repository itself; each comparison of a repository or its owner part ignores ASCII case. The request's repository is the body's `repo`, and for a question the one repository its `about` references name ([protocol.md](protocol.md) section 5.2). A request without one (a question about nothing, or about more than one repository) matches only `*`.

Replies are not governed by rules: a reply is allowed when it continues an open exchange (section 6.1, check 12).

`GET /policy` answers the current policy:

```json
{"version": 1, "updated_at": "2026-10-14T12:00:06Z",
 "rules": [{"id": "team-reviews", "from_owner": "*", "to_owner": "*", "actions": ["review_request", "question"], "repos": ["*"]}]}
```

`PUT /policy` replaces it whole: `{"expected_version": 0, "rules": [ … ]}`. The version must be the current one (`409 conflict` otherwise); rule ids must be unique (`400 bad_request`). The new policy has `version` + 1, `updated_at` the Sphere's clock when it was written, and the rules in the order given; it applies to every message sent after the answer.

## 6. Messages

### 6.1 Send

`POST /v0.1/spheres/{sphere}/messages` with the signed envelope as the body, exactly as the sender signed it. The Sphere checks, in this order, and stops at the first failure:

| # | Check | Failure |
|---|---|---|
| 1 | The bearer token is valid for this Sphere and has an actor. | `401 unauthorized` |
| 2 | The body is at most 131,072 bytes. | `413 payload_too_large` |
| 3 | The body is JSON with no duplicate member names. | `400 invalid_envelope` |
| 4 | protocol.md section 10, checks 1 to 3 (size, schema, the rules no schema says). | `413 payload_too_large`, `400 invalid_envelope` |
| 5 | `sphere` is the path's Sphere. | `400 wrong_sphere` |
| 6 | `from` is the token's actor. | `403 forbidden` |
| 7 | The token has `send:<type>` for a request, `reply` for a reply. | `403 insufficient_scope` |
| 8 | No message with this `id` is in the chain. If one is and the body is the same JSON value as the recorded envelope (the same canonical JSON, signature included), this is a **retry**: answer `200` with the original send's answer and record nothing, even when the message has expired or the sender's key has changed since it was recorded. Otherwise `409 duplicate`. | `409 duplicate` |
| 9 | `key_id` is the sender's current key (protocol.md section 10, "Which key is valid for a message"), and the signature verifies (protocol.md section 9). | `400 unknown_key`, `400 bad_signature` |
| 10 | Not expired; `created_at` at most 300 seconds ahead. | `400 expired`, `400 clock_skew` |
| 11 | `to` is a member (`404 unknown_recipient`) and active (`403 recipient_revoked`); for a request, its card's `accepts` contains the type (`403 policy_denied`). | as written |
| 12 | A request is allowed by the policy (section 5). A reply keeps the exchange rules (protocol.md section 4, rules 1 to 6) against the request its `in_reply_to` names in this Sphere's chain and the replies to it already recorded: the reply is from the request's `to` and to its `from`; the exchange has no `decline`, `result` or `answer` yet; an `accept` comes only when there is no `accept` yet; a `result`'s `for` is the request's type, and an `answer` replies to a `question`; a `result` comes only after its `accept`. | `403 policy_denied`, `409 bad_reply` |
| 13 | Record it: in one transaction, append the audit entry (section 7) and queue a delivery for `to`. | `500 internal` (nothing recorded); `429 rate_limited` with `Retry-After` when the record could not be made because of concurrent writes to the same Sphere (nothing recorded) |

Check 8 comes before the key and expiry checks so that a sender whose answer was lost can always learn that its message was recorded: retrying the same bytes answers `200` with the original `seq`, whatever happened since. Only the sender can learn it (check 6), and only for bytes the Sphere already checked when it recorded them.

It answers `202` with [send.response](schemas/v0.1/wire/send.response.schema.json):

```json
{"id": "<the envelope's id>", "seq": 7, "entry_hash": "<hex>", "recorded_at": "2026-10-14T12:00:09Z"}
```

The Sphere never changes the envelope: what it records and delivers is byte-for-byte the same JSON value the sender signed (the receiver re-checks the signature over its canonical form).

### 6.2 Deliveries

`GET /v0.1/spheres/{sphere}/deliveries?limit=50&wait=0` answers the deliveries queued for the token's actor that it hasn't acknowledged and that haven't expired, oldest (lowest `seq`) first:

```json
{"deliveries": [{"delivery_id": "…", "seq": 7, "relayed_at": "2026-10-14T12:00:09Z", "envelope": { …as sent… }}]}
```

- `seq` is the audit seq of the envelope's entry (section 7), and `relayed_at` is that entry's `recorded_at`, the same value. A receiver judges the sender's key by this `seq` (protocol.md section 10, "Which key is valid for a message").
- `limit` is 1 to 100 (50 when left out); `wait` is 0 to 25 seconds (0 when left out). Each is a decimal integer; anything else, or a value outside its range, is `400 bad_request`. With `wait` above 0 and nothing queued, the Sphere MAY hold the request until a delivery arrives or `wait` passes, and MAY answer an empty list sooner; clients just ask again.
- Delivery is **at least once**: a delivery comes back on every fetch until it is acknowledged. Receivers deduplicate by the envelope's `id` (protocol.md section 11, step 2).
- A delivery whose envelope expires before it is acknowledged is dropped from the queue. It stays in the audit chain.

`POST /v0.1/spheres/{sphere}/deliveries/ack` with `{"delivery_ids": ["…", "…"]}` (1 to 100 distinct ids) acknowledges deliveries, and answers how many of them were waiting for this Obi: `{"acked": 2}`. Ids that are unknown, already acknowledged, dropped (expired, or the receiver revoked) or another Obi's count 0 and are not an error. A receiver acknowledges only after it has recorded what it decided (protocol.md section 11).

## 7. Audit chain

Every message the Sphere relays is one entry in its append-only audit chain, in relay order. An entry ([audit-entry.schema.json](schemas/v0.1/audit-entry.schema.json)):

```json
{
  "sphere": "e2e",
  "seq": 7,
  "prev": "<hash of entry 6>",
  "recorded_at": "2026-10-14T12:00:09Z",
  "envelope": { …the signed envelope as sent, its signature unchanged… },
  "hash": "<this entry's hash>"
}
```

- `seq` starts at 1 and grows by exactly 1.
- `prev` is the previous entry's `hash`; for `seq` 1 it is 64 zeros (`"000…000"`).
- `recorded_at` is the Sphere's clock when it appended the entry, never earlier than the previous entry's.
- `hash` is the lower-case hex SHA-256 over the UTF-8 bytes of `"obi/0.1 audit\n"` followed by the RFC 8785 canonical JSON of the entry **without `hash`**.
- The Sphere signs nothing: each entry's authenticity is its sender's signature, kept verbatim, and the chain's integrity is the hash links.

`GET /v0.1/spheres/{sphere}/audit?from_seq=1&limit=500` answers entries with `seq` from `from_seq` (1 when left out; `limit` 1 to 1,000, 500 when left out), in order, and the head now:

```json
{"sphere": "e2e", "entries": [ … ], "head": {"seq": 7, "hash": "<hash of entry 7>"}}
```

An empty chain's head is `{"seq": 0, "hash": "000…000"}`.

- `from_seq` is 1 to 9,007,199,254,740,991 and `limit` 1 to 1,000, each a decimal integer; anything else is `400 bad_request`.
- `entries` holds the entries with `from_seq` ≤ `seq` ≤ `head.seq`, the first `limit` of them. When `from_seq` is beyond the head (`from_seq` > `head.seq`, an empty chain included) the answer is `200` with `entries` `[]` and the head: not an error, so a reader that has seen everything just asks again later.
- `head` is the chain's head when the Sphere answered, which may be past the page's last entry; the next page starts at the last entry's `seq` + 1.

### 7.1 Verifying the chain

Take the entries from seq 1 (fetch more pages until the last answer's `head.seq` is reached), and the key history of every member from `GET /members`: for each key, `{key_id: {obi, public_key, valid_from_seq, valid_until_seq}}`. The chain is valid when, for the *i*-th entry (counting from 1), with `prev_hash` starting at 64 zeros:

1. The entry matches the schema, its `seq` is *i*, its `sphere` is the chain's, and its `prev` is `prev_hash`.
2. Its `hash` is the hash of its other members, as above.
3. Its `recorded_at` is not before the previous entry's.
4. Its envelope passes protocol.md section 10 checks 2 and 3, names the chain's Sphere, was created at most 300 seconds after `recorded_at`, and expires after `recorded_at`.
5. Its `key_id` is a key of the envelope's `from`, valid at this seq (`valid_from_seq` ≤ seq, and seq ≤ `valid_until_seq` unless that is null), whose public key hashes to `key_id`; and the signature verifies with it.
6. No earlier entry has the same envelope `id`.
7. A reply keeps the exchange rules (protocol.md section 4, rules 1 to 6) against the earlier request its `in_reply_to` names and the earlier replies to it: it is from the request's `to` and to its `from`; no `decline`, `result` or `answer` for that request comes before it; an `accept` has no earlier `accept`; a `result`'s `for` is the request's type, and an `answer` replies to a `question`; a `result` has an earlier `accept`. (The same rules as section 6.1, check 12, so a chain the Sphere built always passes.)

Then `prev_hash` becomes this entry's `hash`. A verifier that has checked a chain up to some head can later check only the new entries, starting from that head's hash. The conformance suite has chains that pass and fail each of these: [conformance/fixtures/audit/](conformance/fixtures/audit/).

## 8. Running a Sphere locally

For development and the end-to-end test, the server in `server/` runs on the developer's machine against local D1 (Miniflare), through wrangler's own dev server. The server package provides one script for it, and the e2e harness relies on exactly this:

```sh
cd "$OBI_SPHERE_DIR/server"
pnpm install --frozen-lockfile
SPHERE_OPERATOR_TOKEN=<at least 32 random characters> \
  node scripts/local.mjs --port 8787 --persist-to /path/to/state
```

- `node scripts/local.mjs` applies the D1 migrations to the local database under `--persist-to`, then starts the Worker on `127.0.0.1:<port>` with the same `--persist-to` through **wrangler's programmatic API** (`unstable_startWorker`, the dev server `wrangler dev` itself runs on), not the `wrangler dev` command. The operator token is read from `SPHERE_OPERATOR_TOKEN` in its environment and given to the Worker as a **secret binding**, never on a command line and never written to a file. Without it, the Sphere refuses every operator call (`403 forbidden`, section 1).
- Nothing on the Sphere's port reaches its D1 except through the Sphere's checks: the Worker runs with no DevTools inspector (`wrangler dev` always opens one and has no flag to turn it off, which is why the API is used), and with wrangler's Local Explorer and local observability off (their endpoints under `/cdn-cgi/local/explorer` take no token and run any SQL against the D1).
- It is ready when `GET http://127.0.0.1:<port>/v0.1/health` answers `200`. It stops when its launcher PID receives SIGINT or SIGTERM; the Worker and its descendants stop too. Use this direct Node command in supervisors and the e2e harness: `pnpm run local` is an interactive convenience wrapper whose signal forwarding differs across platforms and pnpm versions, so signalling only pnpm's PID does not guarantee shutdown.
- It writes only under `--persist-to`, wrangler's own scratch folder `server/.wrangler/` and the `node_modules/` folders under `server/` (the installed packages and their caches, like `node_modules/.cache/`), plus `$HOME` and `$TMPDIR`, which the harness points at folders of its own. Nothing else in the checkout: a local Miniflare folder such as `.mf/` belongs under `--persist-to`. It sends no telemetry (`WRANGLER_SEND_METRICS=false`).
- Everything else is the same as a deployed Sphere: same endpoints, checks, token lifetimes and audit chain.
