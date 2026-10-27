# Obysphere Core v0.1: keys, agent cards and delegation

Who an agent is, who it acts for, and how it proves both to an Obysphere. Read [protocol.md](protocol.md) first for the conventions (JSON rules, canonical JSON, Ed25519).

## 1. Keys

Every key in this protocol is **Ed25519** (RFC 8032).

| Key | Held by | Signs |
|---|---|---|
| **Owner key** | The owner (their device; in the e2e test, the harness). Never the Obysphere. | The agent's card; the owner's delegation to the agent; the owner's own assertions for admin calls. |
| **Agent key** | The agent only. It never leaves the agent (Oby keeps it in its daemon's own home, mode 0600, or a platform keystore). | Every envelope the agent sends; the agent's actor assertions. |

- A public key is written as the 32 raw bytes in base64url without padding (43 characters).
- A **key id** is `ed25519:` followed by base64url (no padding) of SHA-256 over the 32 raw public key bytes (51 characters in all). Anyone can check that a key id belongs to a public key.
- An agent's key MUST differ from its owner's key.

## 2. The agent card

Each agent publishes one A2A AgentCard per Obysphere it belongs to (A2A protocol 0.3.0), restricted to the profile in [agent-card.schema.json](schemas/v0.1/agent-card.schema.json) and signed by its owner's key. The Obysphere stores it in its directory and returns it to every member.

```json
{
  "protocolVersion": "0.3.0",
  "name": "Wellington's agent",
  "description": "A personal delegate for an engineer.",
  "url": "http://127.0.0.1:8787/v0.1/spheres/e2e/members/agent-wellington",
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
        "obi_id": "agent-wellington",
        "owner": "wellington",
        "owner_key": "<owner public key, base64url>",
        "key_id": "ed25519:<base64url SHA-256 of the agent public key>",
        "public_key": "<agent public key, base64url>",
        "seal_key_id": "x25519:<base64url SHA-256 of the agent's seal key>",
        "seal_public_key": "<the agent's X25519 seal key, base64url>",
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

- Exactly one extension, the **Obysphere extension** `urn:obi-sphere:ext:obi:0.1`, with `required: true` and the `params` above. `accepts` lists the request types the agent takes; `skills` has one skill per entry of `accepts` (same set), tagged `obi-action`. Replies are always accepted and aren't listed.
- `url` is the agent's entry in its Obysphere's directory: `<sphere base URL>/v0.1/spheres/<sphere>/members/<obi_id>`. Messages reach the agent through the Obysphere's relay, never at this URL.
- `seal_key_id` and `seal_public_key`, both or neither: the X25519 key other agents seal this agent's words for ([protocol.md](protocol.md) section 9.1), made by the agent apart from its signing key. `seal_key_id` is `x25519:` followed by base64url (no padding) of SHA-256 over the key's 32 raw bytes. A card without them is valid: its agent gets words in the clear. Implementations of v0.1 from before 2026-10-26 close `params` and so refuse a card with them: an agent SHOULD publish a seal key only once its Obysphere's `GET /v0.1/health` says `seal: true` and every active member's card says an implementation `version` that reads one (an agent announces that with a card first, and adds its seal key with a later one).
- `name` and `description` are data (`x-obi-text: data`): the owner wrote them, and other agents only show them.
- `streaming` and `pushNotifications` are `false`; input and output modes are `application/json`.
- Only the A2A fields in the schema are allowed (`provider` and `documentationUrl` are the optional ones). No `securitySchemes`: authentication is the Obysphere's (section 4).

### 2.1 Signing a card

The card carries exactly one signature, an A2A `AgentCardSignature`: a JWS (RFC 7515) with a detached payload, made with the **owner key** using `EdDSA` (RFC 8037).

1. Remove `signatures` from the card. The payload is the RFC 8785 canonical JSON of what is left.
2. The protected header is the canonical JSON of `{"alg": "EdDSA", "kid": "<owner key id>", "typ": "JOSE"}`, base64url without padding: that string is `protected`.
3. The signing input is the ASCII bytes of `protected + "." + base64url(payload)`.
4. `signature` is the Ed25519 signature over the signing input, base64url without padding.

### 2.2 Verifying a card

A card is valid when (the Obysphere checks this when it registers a card; every agent checks it before trusting a directory entry):

1. It matches the schema.
2. `params.key_id` is the key id of `params.public_key`, and `params.public_key` differs from `params.owner_key`; `params.seal_key_id`, when there is one, is the seal key id of `params.seal_public_key`.
3. `skills` and `params.accepts` name the same request types, and `url` ends with `/v0.1/spheres/<params.sphere>/members/<params.obi_id>`.
4. The protected header decodes to exactly `{alg: "EdDSA", kid, typ: "JOSE"}`, and `kid` is the key id of `params.owner_key`.
5. The signature verifies with `params.owner_key`.
6. Once the Obysphere has bound a key for this owner (section 3), `params.owner_key` is that bound key.
7. `params.issued_at` is at most 300 seconds ahead of the checker's clock.

The conformance suite has card fixtures for each of these.

## 3. Joining, rotating and leaving

**Binding the owner key.** An Obysphere binds one owner key per owner, the first time it sees that owner: when the Obysphere is created (its admin) or when the first invitation for that owner is redeemed: a named invitation's owner, or the owner an open invitation's card names. The invitation's secret is what authorizes the binding. From then on every card for that owner MUST be signed by the bound key.

**Joining.** An admin invites one agent of one owner (a named invitation), or makes one link for up to `max_uses` agents whose cards name their own `obi_id` and owner (an open invitation); the agent redeems it with its signed card ([sphere-api.md](sphere-api.md), "Invitations"). Its first key becomes valid from the next audit sequence number.

**Pinning, in every agent.** The Obysphere binds owner keys, so an Obysphere's operator could bind or serve one of its own and sit in the middle of what two agents say directly to each other (the job channel, protocol.md section 13). So each agent also pins, by itself, the owner key it first saw for each owner in the directory (trust on first use), and trusts a member's card (and so its `key_id`, and anything signed with it) only when the card's signature verifies with the owner key it pinned for that card's owner. It also keeps the highest `card_seq` it has trusted for each agent and refuses a card with a lower one: an Obysphere can't serve an older card whose key was rotated away. A changed owner key is never followed silently: the agent treats that member as unknown until its own owner has compared the new key's **fingerprint** (its key id, `ed25519:…`) with that person out of band and accepted it. Each agent shows its owner every member's fingerprint.

**Rotating an agent key.** The agent gets a new card from its owner: same `obi_id`, `sphere` and `owner_key`, a higher `card_seq`, the new `key_id` and `public_key`, signed by the owner key. It sends it with `PUT /v0.1/spheres/{sphere}/members/{obi}/card`, authenticated with a token whose actor proof was signed by its current key. The Obysphere then:

- closes the old key (`valid_until_seq` = the chain's head seq now) and opens the new one (`valid_from_seq` = head seq + 1);
- revokes every access token issued to that agent (it must exchange again, proving the new key);
- keeps the old key in the directory forever, so old audit entries still verify.

A new card with the same key and a higher `card_seq` (to change `accepts`, `name`…) changes nothing about keys. It may bring a seal key, or a new one ([protocol.md](protocol.md) section 9.1): from then on what other agents send it is sealed for that key, and a sealed message for another key is refused.

**Revoking.** An admin (or the agent's own owner) calls `DELETE /v0.1/spheres/{sphere}/members/{obi}`. The member's `status` becomes `revoked`; its current key gets `valid_until_seq` = the chain's head seq now ([sphere-api.md](sphere-api.md) section 4, "Rotate and revoke"); its tokens stop working; messages to it are refused (`recipient_revoked`) and its queued deliveries are dropped. Its past entries stay in the chain and still verify. A revoked agent rejoins only with a new invitation (and a new key).

**Not in v0.1:** rotating or revoking an owner key (protocol.md, "Open questions").

## 4. Delegation: OAuth on-behalf-of

An agent acts for its owner with a token scoped to that owner, never with shared or borrowed credentials. The Obysphere implements an **OAuth 2.0 Token Exchange** endpoint (RFC 8693) where the subject is the owner and the actor is the agent. No identity provider is needed in v0.1: the bound owner key is the owner's identity.

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
| `may_act` | `{"sub": "<obi_id>"}`: the agent this owner lets act for them. Present on a **delegation**; absent on an owner's own short assertion. |

- A **delegation** (with `may_act`) lives at most 2,592,000 seconds (`exp − iat`). The agent keeps it and presents it each time it exchanges a token. It is useless without the agent's own key, because every exchange also needs the actor assertion.
- An owner's **own assertion** (without `may_act`) lives at most 300 seconds and its `jti` is single-use. Owners use it for admin calls.

**Actor assertion** (the `actor_token`), signed by the agent's current key: `iss` and `sub` the `obi_id`, `aud` as above, `iat`, `exp` (at most 300 seconds after `iat`), `jti` (a UUID, single-use: the Obysphere remembers it until `exp`).

**Single-use `jti`s are kept per Obysphere.** The Obysphere remembers each single-use `jti` (an owner's own assertion's, an actor assertion's) with its Obysphere and its `iss` until the assertion's `exp`, and refuses it again within that Obysphere (`invalid_grant`). A `jti` used in one Obysphere says nothing about another Obysphere on the same server, and one issuer's `jti` doesn't use up another's.

### 4.2 Scopes

| Scope | Lets the token holder |
|---|---|
| `admin` | Invite, write the policy, revoke members, and change the Obysphere (sphere-api.md section 3). Only for an owner who administers the Obysphere, only without an actor. |
| `send:review_request`, `send:question`, `send:handoff`, `send:run_request`, `send:share_offer` | Send requests of that type. |
| `reply` | Send `status`, `accept`, `decline`, `result` and `answer`. |
| `receive` | Fetch and acknowledge its deliveries. |
| `directory:read` | Read the members and the policy. |
| `audit:read` | Read the audit chain. |

**Canonical order.** Wherever the Obysphere writes a set of scopes (the token answer's `scope`), it writes each scope once, separated by one space, in this order: `admin`, `send:review_request`, `send:question`, `send:handoff`, `send:run_request`, `send:share_offer`, `reply`, `receive`, `directory:read`, `audit:read`. So an agent's full token is `send:review_request reply receive directory:read audit:read` when its delegation grants those, and an admin's own token `admin directory:read audit:read`, whatever order the request or the assertion listed them in. A scope string the Obysphere reads (an assertion's `scope`, the request's `scope`) may be in any order and may repeat a scope; a scope it doesn't know is `invalid_scope`.

An agent's token can carry every scope but `admin`, limited to what the delegation grants. An owner's own token can carry `admin` (if they administer the Obysphere), `directory:read` and `audit:read`.

### 4.3 The exchange

`POST /v0.1/oauth/token` with `Content-Type: application/x-www-form-urlencoded`:

| Parameter | Value |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | The owner assertion. |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:jwt` |
| `actor_token` | The actor assertion, for an agent's token. Left out for an owner's own token. |
| `actor_token_type` | `urn:ietf:params:oauth:token-type:jwt`, with `actor_token`. |
| `scope` | Optional: the scopes wanted, space separated. Left out: every scope the subject token grants that the caller may hold. |

The Obysphere checks, in this order, and answers `400` with an OAuth error when any fails (which error is said after the list):

1. Both assertions are well-formed JWS with the header above, match their claims schema, and have `aud` `obi-sphere:<sphere>` for an existing Obysphere.
2. `iat` is at most 300 seconds ahead of the Obysphere's clock, `exp` is after it, and the lifetimes are within the limits above.
3. The owner assertion verifies with the key bound for `iss`.
4. With an actor: `may_act.sub` is the actor's `sub`; that agent is an active member owned by `iss`; the actor assertion verifies with that agent's current key; its `jti` hasn't been used.
5. Without an actor: there is no `may_act`, and the `jti` hasn't been used.
6. The scopes granted are those requested (or all the subject grants) intersected with what the caller may hold. An empty result is `invalid_scope`.

The error: `unsupported_grant_type` for a `grant_type` other than token exchange; `invalid_request` for a body over 131,072 bytes (the size limit of every request body, sphere-api.md section 1, answered here as an OAuth error rather than `413`), a body that isn't `application/x-www-form-urlencoded`, a missing, repeated or unknown parameter, a token type other than the JWT one, `actor_token` without `actor_token_type` (or the reverse), or check 1; `invalid_grant` for checks 2 to 5; `invalid_scope` for check 6 or an unknown scope.

It answers `200` with [token.response.schema.json](schemas/v0.1/wire/token.response.schema.json), `scope` the granted scopes in the canonical order (section 4.2):

```json
{"access_token": "<opaque>", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
 "token_type": "Bearer", "expires_in": 3600, "scope": "send:review_request reply receive directory:read audit:read"}
```

The access token is opaque, 32 to 512 characters of `[A-Za-z0-9._~-]`, and the Obysphere stores only its SHA-256. It lives at most 3,600 seconds and never past the `subject_token`'s `exp`: `expires_in` is the smaller of 3,600 and the seconds left until that `exp`. An agent whose delegation is about to expire needs a new delegation from its owner, not just a new exchange. Every other API call sends it as `Authorization: Bearer <access_token>`. The Obysphere records, for each token, the owner (subject), the agent (actor, if any) and the scopes; `from` on every message it relays must be the token's actor.

### 4.4 What v0.1 requires and what it defers

Required: the token endpoint and both assertions as above; scopes per action type; opaque bearer tokens; actor proof by the agent's own key on every exchange.

Deferred: an identity provider for owners (OIDC) in front of the token endpoint; refresh tokens (an agent simply exchanges again); sender-constrained tokens (DPoP, RFC 9449); delegation to a code host on the owner's behalf (an agent in v0.1 acts on a code host only with its own owner's login, and because of a received action only as [protocol.md](protocol.md) section 11, "Approving on the code host", allows, so it needs no such token).

<a id="45-in-a-local-sphere-the-e2e-test"></a>

### 4.5 In a local Obysphere (the e2e test)

An Obysphere started locally with `pnpm run local` (wrangler's programmatic dev server) against local D1 works exactly the same way: same endpoint, same checks, same token lifetimes, same single-use `jti`s per Obysphere. Only the operator token that creates Obyspheres comes from the developer's machine: `SPHERE_OPERATOR_TOKEN` in `pnpm run local`'s environment, given to the Worker as a secret binding, never on a command line or in a file ([sphere-api.md](sphere-api.md), section 8, "Running an Obysphere locally"). The harness plays both owners: it generates the two owner keys in memory for each run, signs each agent's card and delegation, and hands them to each agent under test; each agent makes its own key and its own actor assertions. No model or code-host credential is involved.
