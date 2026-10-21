# Obi-to-Obi protocol v0.1: keys, agent cards and delegation

Who an Obi is, who it acts for, and how it proves both to a Sphere. Read [protocol.md](protocol.md) first for the conventions (JSON rules, canonical JSON, Ed25519).

## 1. Keys

Every key in this protocol is **Ed25519** (RFC 8032).

| Key | Held by | Signs |
|---|---|---|
| **Owner key** | The owner (their device; in the e2e test, the harness). Never the Sphere. | The Obi's agent card; the owner's delegation to the Obi; the owner's own assertions for admin calls. |
| **Obi key** | The Obi only. It never leaves the Obi (obid keeps it in its own home, mode 0600, or a platform keystore). | Every envelope the Obi sends; the Obi's actor assertions. |

- A public key is written as the 32 raw bytes in base64url without padding (43 characters).
- A **key id** is `ed25519:` followed by base64url (no padding) of SHA-256 over the 32 raw public key bytes (51 characters in all). Anyone can check that a key id belongs to a public key.
- An Obi's key MUST differ from its owner's key.

## 2. The agent card

Each Obi publishes one A2A AgentCard per Sphere it belongs to (A2A protocol 0.3.0), restricted to the profile in [agent-card.schema.json](schemas/v0.1/agent-card.schema.json) and signed by its owner's key. The Sphere stores it in its directory and returns it to every member.

```json
{
  "protocolVersion": "0.3.0",
  "name": "Wellington's Obi",
  "description": "A personal delegate for an engineer.",
  "url": "http://127.0.0.1:8787/v0.1/spheres/e2e/members/obi-wellington",
  "preferredTransport": "HTTP+JSON",
  "version": "0.1.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extensions": [{
      "uri": "urn:obi-sphere:ext:obi:0.1",
      "required": true,
      "params": {
        "protocol": "obi/0.1",
        "sphere": "e2e",
        "obi_id": "obi-wellington",
        "owner": "wellington",
        "owner_key": "<owner public key, base64url>",
        "key_id": "ed25519:<base64url SHA-256 of the Obi public key>",
        "public_key": "<Obi public key, base64url>",
        "accepts": ["review_request", "question"],
        "card_seq": 1,
        "issued_at": "2026-10-14T12:00:00Z"
      }
    }]
  },
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [
    {"id": "review_request", "name": "Review a change", "description": "Reviews a change for its owner and answers with typed findings.", "tags": ["obi-action"]},
    {"id": "question", "name": "Answer a question", "description": "Answers what its owner knows or decided.", "tags": ["obi-action"]}
  ],
  "signatures": [{"protected": "<base64url JWS header>", "signature": "<base64url Ed25519 signature>"}]
}
```

What the profile requires beyond A2A:

- Exactly one extension, the **Obi extension** `urn:obi-sphere:ext:obi:0.1`, with `required: true` and the `params` above. `accepts` lists the request types the Obi takes; `skills` has one skill per entry of `accepts` (same set), tagged `obi-action`. Replies are always accepted and aren't listed.
- `url` is the Obi's entry in its Sphere's directory: `<sphere base URL>/v0.1/spheres/<sphere>/members/<obi_id>`. Messages reach the Obi through the Sphere's relay, never at this URL.
- `name` and `description` are data (`x-obi-text: data`): the owner wrote them, and other Obis only show them.
- `streaming` and `pushNotifications` are `false`; input and output modes are `application/json`.
- Only the A2A fields in the schema are allowed (`provider` and `documentationUrl` are the optional ones). No `securitySchemes`: authentication is the Sphere's (section 4).

### 2.1 Signing a card

The card carries exactly one signature, an A2A `AgentCardSignature`: a JWS (RFC 7515) with a detached payload, made with the **owner key** using `EdDSA` (RFC 8037).

1. Remove `signatures` from the card. The payload is the RFC 8785 canonical JSON of what is left.
2. The protected header is the canonical JSON of `{"alg": "EdDSA", "kid": "<owner key id>", "typ": "JOSE"}`, base64url without padding: that string is `protected`.
3. The signing input is the ASCII bytes of `protected + "." + base64url(payload)`.
4. `signature` is the Ed25519 signature over the signing input, base64url without padding.

### 2.2 Verifying a card

A card is valid when (the Sphere checks this when it registers a card; every Obi checks it before trusting a directory entry):

1. It matches the schema.
2. `params.key_id` is the key id of `params.public_key`, and `params.public_key` differs from `params.owner_key`.
3. `skills` and `params.accepts` name the same request types, and `url` ends with `/v0.1/spheres/<params.sphere>/members/<params.obi_id>`.
4. The protected header decodes to exactly `{alg: "EdDSA", kid, typ: "JOSE"}`, and `kid` is the key id of `params.owner_key`.
5. The signature verifies with `params.owner_key`.
6. Once the Sphere has bound a key for this owner (section 3), `params.owner_key` is that bound key.
7. `params.issued_at` is at most 300 seconds ahead of the checker's clock.

The conformance suite has card fixtures for each of these.

## 3. Joining, rotating and leaving

**Binding the owner key.** A Sphere binds one owner key per owner, the first time it sees that owner: when the Sphere is created (its admin) or when the owner's first invitation is redeemed. The invitation's one-time secret is what authorizes the binding. From then on every card for that owner MUST be signed by the bound key.

**Joining.** An admin invites one Obi of one owner; the Obi redeems the invitation with its signed card ([sphere-api.md](sphere-api.md), "Invitations"). Its first key becomes valid from the next audit sequence number.

**Rotating an Obi key.** The Obi gets a new card from its owner: same `obi_id`, `sphere` and `owner_key`, a higher `card_seq`, the new `key_id` and `public_key`, signed by the owner key. It sends it with `PUT /v0.1/spheres/{sphere}/members/{obi}/card`, authenticated with a token whose actor proof was signed by its current key. The Sphere then:

- closes the old key (`valid_until_seq` = the chain's head seq now) and opens the new one (`valid_from_seq` = head seq + 1);
- revokes every access token issued to that Obi (it must exchange again, proving the new key);
- keeps the old key in the directory forever, so old audit entries still verify.

A new card with the same key and a higher `card_seq` (to change `accepts`, `name`…) changes nothing about keys.

**Revoking.** An admin (or the Obi's own owner) calls `DELETE /v0.1/spheres/{sphere}/members/{obi}`. The member's `status` becomes `revoked`; its current key gets `valid_until_seq` = the chain's head seq now ([sphere-api.md](sphere-api.md) section 4, "Rotate and revoke"); its tokens stop working; messages to it are refused (`recipient_revoked`) and its queued deliveries are dropped. Its past entries stay in the chain and still verify. A revoked Obi rejoins only with a new invitation (and a new key).

**Not in v0.1:** rotating or revoking an owner key (protocol.md, "Open questions").

## 4. Delegation: OAuth on-behalf-of

An Obi acts for its owner with a token scoped to that owner, never with shared or borrowed credentials. The Sphere implements an **OAuth 2.0 Token Exchange** endpoint (RFC 8693) where the subject is the owner and the actor is the Obi. No identity provider is needed in v0.1: the bound owner key is the owner's identity.

### 4.1 The two assertions

Both are JWTs (RFC 7519) in JWS compact form, `alg` `EdDSA`, with the protected header `{"alg": "EdDSA", "kid": "<signing key id>", "typ": "JWT"}`. Schemas: [delegation.claims.schema.json](schemas/v0.1/wire/delegation.claims.schema.json), [actor.claims.schema.json](schemas/v0.1/wire/actor.claims.schema.json).

**Owner assertion** (the `subject_token`), signed by the owner key:

| Claim | Value |
|---|---|
| `iss`, `sub` | The owner's `owner_id`. |
| `aud` | `obi-sphere:<sphere id>`. |
| `iat`, `exp` | Seconds since 1970. |
| `jti` | A UUID. |
| `scope` | The scopes the owner grants, space separated. |
| `may_act` | `{"sub": "<obi_id>"}`: the Obi this owner lets act for them. Present on a **delegation**; absent on an owner's own short assertion. |

- A **delegation** (with `may_act`) lives at most 2,592,000 seconds (`exp − iat`). The Obi keeps it and presents it each time it exchanges a token. It is useless without the Obi's own key, because every exchange also needs the actor assertion.
- An owner's **own assertion** (without `may_act`) lives at most 300 seconds and its `jti` is single-use. Owners use it for admin calls.

**Actor assertion** (the `actor_token`), signed by the Obi's current key: `iss` and `sub` the `obi_id`, `aud` as above, `iat`, `exp` (at most 300 seconds after `iat`), `jti` (a UUID, single-use: the Sphere remembers it until `exp`).

**Single-use `jti`s are kept per Sphere.** The Sphere remembers each single-use `jti` (an owner's own assertion's, an actor assertion's) with its Sphere and its `iss` until the assertion's `exp`, and refuses it again within that Sphere (`invalid_grant`). A `jti` used in one Sphere says nothing about another Sphere on the same server, and one issuer's `jti` doesn't use up another's.

### 4.2 Scopes

| Scope | Lets the token holder |
|---|---|
| `admin` | Invite, write the policy, revoke members. Only for the Sphere's admin owner, only without an actor. |
| `send:review_request`, `send:question`, `send:handoff`, `send:run_request` | Send requests of that type. |
| `reply` | Send `status`, `accept`, `decline`, `result` and `answer`. |
| `receive` | Fetch and acknowledge its deliveries. |
| `directory:read` | Read the members and the policy. |
| `audit:read` | Read the audit chain. |

**Canonical order.** Wherever the Sphere writes a set of scopes (the token answer's `scope`), it writes each scope once, separated by one space, in this order: `admin`, `send:review_request`, `send:question`, `send:handoff`, `send:run_request`, `reply`, `receive`, `directory:read`, `audit:read`. So an Obi's full token is `send:review_request reply receive directory:read audit:read` when its delegation grants those, and an admin's own token `admin directory:read audit:read`, whatever order the request or the assertion listed them in. A scope string the Sphere reads (an assertion's `scope`, the request's `scope`) may be in any order and may repeat a scope; a scope it doesn't know is `invalid_scope`.

An Obi's token can carry every scope but `admin`, limited to what the delegation grants. An owner's own token can carry `admin` (if they are the admin), `directory:read` and `audit:read`.

### 4.3 The exchange

`POST /v0.1/oauth/token` with `Content-Type: application/x-www-form-urlencoded`:

| Parameter | Value |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | The owner assertion. |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:jwt` |
| `actor_token` | The actor assertion, for an Obi's token. Left out for an owner's own token. |
| `actor_token_type` | `urn:ietf:params:oauth:token-type:jwt`, with `actor_token`. |
| `scope` | Optional: the scopes wanted, space separated. Left out: every scope the subject token grants that the caller may hold. |

The Sphere checks, in this order, and answers `400` with an OAuth error when any fails (which error is said after the list):

1. Both assertions are well-formed JWS with the header above, match their claims schema, and have `aud` `obi-sphere:<sphere>` for an existing Sphere.
2. `iat` is at most 300 seconds ahead of the Sphere's clock, `exp` is after it, and the lifetimes are within the limits above.
3. The owner assertion verifies with the key bound for `iss`.
4. With an actor: `may_act.sub` is the actor's `sub`; that Obi is an active member owned by `iss`; the actor assertion verifies with that Obi's current key; its `jti` hasn't been used.
5. Without an actor: there is no `may_act`, and the `jti` hasn't been used.
6. The scopes granted are those requested (or all the subject grants) intersected with what the caller may hold. An empty result is `invalid_scope`.

The error: `unsupported_grant_type` for a `grant_type` other than token exchange; `invalid_request` for a body over 131,072 bytes (the size limit of every request body, sphere-api.md section 1, answered here as an OAuth error rather than `413`), a body that isn't `application/x-www-form-urlencoded`, a missing, repeated or unknown parameter, a token type other than the JWT one, `actor_token` without `actor_token_type` (or the reverse), or check 1; `invalid_grant` for checks 2 to 5; `invalid_scope` for check 6 or an unknown scope.

It answers `200` with [token.response.schema.json](schemas/v0.1/wire/token.response.schema.json), `scope` the granted scopes in the canonical order (section 4.2):

```json
{"access_token": "<opaque>", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
 "token_type": "Bearer", "expires_in": 3600, "scope": "send:review_request reply receive directory:read audit:read"}
```

The access token is opaque, 32 to 512 characters of `[A-Za-z0-9._~-]`, and the Sphere stores only its SHA-256. It lives at most 3,600 seconds and never past the `subject_token`'s `exp`: `expires_in` is the smaller of 3,600 and the seconds left until that `exp`. An Obi whose delegation is about to expire needs a new delegation from its owner, not just a new exchange. Every other API call sends it as `Authorization: Bearer <access_token>`. The Sphere records, for each token, the owner (subject), the Obi (actor, if any) and the scopes; `from` on every message it relays must be the token's actor.

### 4.4 What v0.1 requires and what it defers

Required: the token endpoint and both assertions as above; scopes per action type; opaque bearer tokens; actor proof by the Obi's own key on every exchange.

Deferred: an identity provider for owners (OIDC) in front of the token endpoint; refresh tokens (an Obi simply exchanges again); sender-constrained tokens (DPoP, RFC 9449); delegation to a code host on the owner's behalf (an Obi in v0.1 never acts on GitHub because of a received action, so it needs no such token).

### 4.5 In a local Sphere (the e2e test)

A Sphere started locally with `pnpm run local` (wrangler's programmatic dev server) against local D1 works exactly the same way: same endpoint, same checks, same token lifetimes, same single-use `jti`s per Sphere. Only the operator token that creates Spheres comes from the developer's machine: `SPHERE_OPERATOR_TOKEN` in `pnpm run local`'s environment, given to the Worker as a secret binding, never on a command line or in a file ([sphere-api.md](sphere-api.md), section 8, "Running a Sphere locally"). The harness plays both owners: it generates the two owner keys in memory for each run, signs each Obi's card and delegation, and hands them to each obid; each obid makes its own key and its own actor assertions. No model or code-host credential is involved.
