# Changelog

Every change to the standards in [`spec/`](spec/): messages, schemas, fixtures and what an implementation must do. The newest is first. Each entry says its kind, as [spec/README.md, "Versions"](spec/README.md#versions) defines them:

- **Addition**: everything valid before is still valid and means the same.
- **Breaking**: something valid before is no longer valid, or means something else. From now on a breaking change gets a new protocol constant.
- **Clarification**: no message, schema or fixture changes.

Changes to the server alone are in the git history and in [server/README.md](server/README.md).

## Unreleased

Changes merged into `dev` since the baseline below. Each pull request that changes `spec/` adds its entry here.

- *Addition.* The Council process, Draft ([spec/council/process.md](spec/council/process.md)): roles, integrity rules, the ten steps from motion to audit, how a member re-checks a verdict, and the review profile on today's `review_request` and `result`. Not part of `obi/0.1`: no message, schema or fixture changes.
- *Clarification.* The spec index is organised by instrument and lists all 15 action types; this changelog replaces the one at the top of `spec/README.md`; the versioning rule is written down ([spec/README.md, "Versions"](spec/README.md#versions)). The conformance README says fifteen action types, as the self-check already checks.

## `obi/0.1`: the baseline

The protocol `obi/0.1` as it stands at commit `41d5a272` (#29). Until that commit, `obi/0.1` was amended in place: the entries below are those amendments, oldest last. From the baseline on it is no longer amended in place: an addition comes behind a feature, and a breaking change gets a new constant.

### Sealed words (#29, `41d5a272`). *Addition.*

A card may publish an X25519 seal key (`seal_key_id`, `seal_public_key`; identity.md section 2), and every message to an Obi whose card has one is sealed for it: each text value of the body is encrypted for that key (X25519, HKDF-SHA256, ChaCha20-Poly1305), and the envelope gains `seal` (protocol.md section 9.1). The Sphere checks a sealed envelope against the sealed schemas ([schemas/v0.1/sealed/](spec/schemas/v0.1/sealed/), derived from the plain ones), refuses one in the clear between two Obis that both seal (`400 not_sealed`) or one sealed for another key, and keeps it in the chain as sent. A receiver opens the words after the signature (protocol.md section 10, check 11: `seal_invalid`, `not_sealed`). A Sphere that takes them says `seal: true` in `GET /v0.1/health`. Known answers: [seal-vectors.json](spec/conformance/seal-vectors.json).

Earlier implementations close the card's `params`, so they refuse a card with a seal key: an Obi publishes one only once its Sphere and every member can read it (identity.md section 2).

### An Obysphere's admins manage it (#27, `829e1d4`). *Addition.*

Wire only, no message changes (sphere-api.md section 3): `PATCH /v0.1/spheres/{sphere}` renames a Sphere (its id never changes); `PUT`, `GET` and `DELETE …/image` keep a square PNG picture; `PUT` and `DELETE …/admins/{owner}` share the admin role among owners who have joined; `GET …/invitations` lists the usable invitations for admins; `DELETE /v0.1/spheres/{sphere}` erases everything a Sphere kept, and its id stays taken. New wire schemas: `sphere-update.request`, `invitations.response`; `sphere`, `invitation.request` and `invitation.response` gain members.

### Approving on the code host (#24, `3554f8c`). *Addition.*

A `review_request` may carry `approve_on_host: true` (it needs `pr`), and a review's `result` may carry `host_review` (`approved`, `asked` or `unable`). protocol.md section 11 says when a receiver may post an approving review on the code host ("Approving on the code host"), the one exception to "what a received action never causes". Not listed in the earlier changelog.

### Phone relay (#19, `fb62208`). *Addition.*

Wire only, no message changes (sphere-api.md section 9). A member's Mac keeps one WebSocket on a relay it registers with the Sphere, and the phones it paired join it with relay tokens it made, whose hashes it registers and can delete; the Sphere passes the end-to-end sealed frames between them, reading and keeping none, within limits per socket. A Sphere server relays for the members of its Spheres only, and revoking a member deletes its relays. New wire schema: [relay](spec/schemas/v0.1/wire/relay.schema.json).

### Signing in with Google, and invitations for one Workspace (#14, `63ef6b6`). *Addition.*

Wire only, no message changes (sphere-api.md sections 3, 3.1 and 4). A Sphere server may sign people in with Google: `POST /v0.1/spheres` takes a sign-in in place of the operator's token for someone from a Workspace the operator allows, and an open invitation may carry `domain`, redeemed only with a sign-in from that Workspace; one owner per account. An account may be the admin owner of a limited number of Spheres (`429 rate_limited` past it), and some Sphere ids are reserved. New wire schemas: `signin.request`, `signin.response`. Not listed in the earlier changelog.

### Running a job on another Obi's Mac, and sharing an API account (#12, `c156106`)

One pull request, three amendments:

1. **Run requests.** *Addition.* A new request, `run_request` (protocol.md 5.10), and three new replies: `run_progress`, `run_return` (the job came back before it finished; ends the exchange) and `run_cancel`, the one reply a request's own sender sends (ends the exchange). `result` gains `for: run_request`, `decline` the reason `not_free`, and tokens the scope `send:run_request`. Twelve action types; a card accepts up to four request types. A run_request's exchange has an end-to-end encrypted job channel the Sphere relays (protocol.md section 13, sphere-api.md 6.3), and an Obi publishes a signed runner status in the directory, shown only to the owners it is offered to (protocol.md section 14, sphere-api.md 6.4).
2. **Shares of an API account.** *Addition.* A new request, `share_offer` (5.14), and two replies its own sender sends: `share_status` (5.15) and `share_revoke` (5.16, ends the exchange). `run_request` gains an optional `account: {grant}`, `decline` and `run_return` the reason `share_used`, and tokens the scope `send:share_offer`. Exchange rule 8 keeps the share replies to share_offer exchanges. Fifteen action types; a card accepts up to five request types (protocol.md section 15).
3. **What the chain keeps of a guest job.** *Breaking, made before any of the above was deployed.* A `run_request` no longer carries the job's words (`request`): they go on the job channel, so the audit chain keeps only what a guest job is. A run_request's `result` loses `summary` and, with `run_return`, gains `cost_cents` for a job on a share. `run_progress` loses `paused` and `resumed`, and a receiver doesn't send it; a `run_request`'s exchange takes no `status`; `run_return`'s `reason` is `host_unavailable`, `time_limit` or `share_used`, without `minutes`; a runner status's `free` is worked out only at moments a random 15 to 20 minutes apart, and `free_at` is gone; a `run_request`'s `result` and `run_return` lose `host`; a receiver takes one `run_request` per sender's owner every 15 minutes; and a `run_request`'s `decline` says `unavailable` whatever the host's reason (only `expired`, `out_of_scope` and `share_used` stay), with no `by_rule`, and `not_free` is gone.

### Open invitations (#9, `d997e8d`). *Addition.*

Wire only, no message changes. An invitation may leave `owner` and `obi` out and say `max_uses` (1 to 1,000); each redeem's card names its own `obi_id` and owner, ids are still never reused, and an owner's key is still bound on its first redeem (sphere-api.md section 4, identity.md section 3). Every invitation answer carries `max_uses`. A new read, `POST …/invitations/{invitation_id}/preview`, authenticated by the invitation's secret, answers the Sphere's name and how many members are active. The admin can withdraw an invitation at once (`DELETE …/invitations/{invitation_id}`), and a policy rule or a runner status's `for` names only owners who have joined (or `*`). The conformance suite gets a `wire` case kind.

### Questions and answers (#5, `d2857d5`). *Breaking.*

`question` is now `{text, about?, choices?}`: `about` takes typed references to repositories, pull requests, issues and jobs (protocol.md 5.9), and `goal`, `question`, `repo` and `pr` are gone. A new reply, `answer` `{by, text, refs?, choice?, by_rule?}`, answers a question and ends its exchange; `result` no longer has `for: question`. Eight action types. The receiver answers a question by itself only from what a sharing rule of its owner allows, and otherwise asks its owner (protocol.md section 11, "Questions"), and it limits each sender ("Rate limits"). A question's repository for policy comes from its `about` (sphere-api.md section 5).

What it broke: a `question`, or a `result` for a question, made to the earlier text is no longer valid, and neither is an audit chain recorded under it that holds one. No Sphere was known to hold such a chain: Obi's card then accepted only `review_request`, so no member could be sent a question. Under the rule in force now, this change would have needed a new protocol constant.

### What the first Sphere server chose where the text was silent (#4, `2a6f2b0`; #3, `36e84f5`). *Clarification.*

A send that loses to concurrent writes is `429 rate_limited`, nothing recorded (sphere-api.md 6.1, check 13). An owner token on an endpoint that needs an Obi token is `403 forbidden` (sphere-api.md section 1; sending stays `401`), and so is an Obi token revoking a member (creating invitations and replacing the policy need `admin`, which an Obi's token never holds: `403 insufficient_scope`); a token request body over 131,072 bytes is `400 invalid_request` (identity.md 4.3); single-use `jti`s are kept per Sphere (identity.md 4.1); `pnpm run local` starts the Worker through wrangler's programmatic API with the operator token as a secret binding (sphere-api.md section 8).

### The first version (#1, `58fa595`)

`obi/0.1` replaces the first draft. It pins the envelope, signing (Ed25519 over RFC 8785 canonical JSON), the A2A agent-card profile, delegation (OAuth token exchange, RFC 8693), the receiving Obi's decision rule, the Sphere's HTTP binding and audit chain, JSON Schemas for all of it, and a conformance suite.
