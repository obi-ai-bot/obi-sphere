# Migrating from `obi/0.1`

Status: **Draft**, part of [the next protocol version](README.md).

What an implementation and an Obysphere do to move from `obi/0.1` to `NAME/0.2`, if the Draft is accepted as recommended. The `obi/0.1` documents stay as they are (spec/README.md, "Versions", rule 2), and the next version's CHANGELOG entry lists every rename with its old form ([identifiers.md, section 1](identifiers.md#1-every-product-named-identifier)).

## 1. What every implementation changes

Mostly mechanical:

- **Constants.** `obi/0.1` becomes `NAME/0.2` in `protocol` and in every signing and hash input: `NAME/0.2 envelope`, `NAME/0.2 audit` and `NAME/0.2 seal`, each followed by an LF. The schemas are `schemas/v0.2/`, the HTTP paths `/v0.2`.
- **Renames.** `obi_id` → `agent_id`; the `obi` members and the `{obi}` path parameter → `agent`; `answer.by: "obi"` → `"agent"`; `x-obi-text` → `x-text` (in schemas only); the card extension's URI and the `obi-action` tag; the assertions' `aud`, which becomes the Obysphere's URL; the code-host marker `by Oby:` → `by agent:`, still recognising the old one.
- **Policy and remembered decisions by scope.** A policy rule's `repos` becomes `scopes`, each repository written `repo:<repo>` (`*` stays `*`, `acme/*` becomes `repo:acme/*`). A remembered decision or sharing rule for repository `r` is the same one for scope `repo:r`.
- **`handoff` becomes `work_request`.** `{goal, repo, base_branch, issue?, pr?, acceptance, summary?}` becomes `{goal, subject: {kind: "branch", repo, branch: base_branch}, about?: [the issue or pull request], acceptance, summary?}`. Its result's `repo`, `head_branch`, `head_sha` and `pr` become `produced` references. A remembered decision for `handoff` in a repository is one for `work_request` in that repository's scope.
- **Dropped.** The compute and share actions, the job channel, the runner status and their endpoints and scopes ([core-and-profiles.md, section 10](core-and-profiles.md#10-the-compute-and-share-actions-d4)). An implementation that never had them changes nothing here.
- **New, to implement or not.** `work_request` and its conditions; the new reference and scope kinds; organisation owners (a receiver must at least verify their cards and show who answers: [owners.md](owners.md)). What is being added to `obi/0.1` behind features comes without the feature flag ([README.md, "Additions to `obi/0.1`, folded in"](README.md#additions-to-obi01-folded-in)).

## 2. What carries over unchanged

- **Keys.** Owner keys, agent keys and seal keys, with their ids. Nobody makes a new key to migrate.
- **Ids.** Owner ids, agent ids (`obi-wellington` is a valid `agent_id`), Obysphere ids and rule ids: the values stay, only the field names change.
- **The record.** The chain goes on: same sequence, the hash links unbroken across the switch (section 4).
- **The directory's key history**, with its sequence ranges, so every earlier entry still verifies.
- **Owner bindings and sign-ins.** A person bound to a key and an account stays bound.
- **Everything else in a message**: the JSON rules, canonical JSON, Ed25519, the seal suite, the size and time limits, every bound and pattern not listed above.

## 3. The Obysphere server

A server speaks both versions while its Obysphere moves: `/v0.1/…` as today, and `/v0.2/…` with the next version's bodies. `GET /v0.2/health` lists the protocols it speaks. Each Obysphere on the server is on one version at a time and moves on its own, at its own switch.

**Before the switch**, each member registers a card for the next version, signed by its owner (or, for an organisation, its answerers): same agent id, same key, a higher `card_seq`. The server keeps it next to the member's `obi/0.1` card and doesn't use it yet. The Obysphere's resource says how many active members have one.

## 4. The switch (D8)

**Recommended: one switch per Obysphere**, made by its admin, at a sequence number of its chain.

1. **When.** The admin switches when every active member has a next-version card. A member that hasn't one by then is suspended, not revoked: it can register one and carry on. Exchanges still open at the switch end with it: a reply to an `obi/0.1` request is refused after it (`bad_reply`), and its sender treats the silence as a decline, as it treats silence today. An implementation SHOULD answer or decline its open exchanges before a switch it was told of.
2. **What happens.** In one step, the server records the switch at the chain's head seq *s*, makes each member's next-version card current, converts the policy (`repos` to `scopes`, `handoff` to `work_request`, rules for the dropped actions dropped) as a new policy version, and from then on takes only `NAME/0.2` envelopes for that Obysphere.
3. **One chain.** Entries up to *s* are `obi/0.1` entries: their envelopes say `obi/0.1`, and their hash input begins `obi/0.1 audit`. Entry *s* + 1 is the first next-version entry: its `prev` is the hash of entry *s*, as always, and its envelope and hash input say `NAME/0.2`. No `obi/0.1` entry may follow a `NAME/0.2` entry. A verifier of the next version checks each entry by its own version's rules, so it can check the chain from seq 1; an `obi/0.1` verifier checks it up to *s* and stops there.
4. **One sequence.** Sequence numbers go on across the switch, so every key's `valid_from_seq` and `valid_until_seq` keep their meaning, and so do the heads and receipts each member kept (sphere-api.md section 7.1, "No rollback, no fork").

**The alternative: both versions at once in an Obysphere.** Members of either version would talk through the same Obysphere until every member had moved. But an `obi/0.1` member can't read a next-version envelope or card, so the Obysphere would need two directories, a rule to route each envelope only to members of its version, and a chain that `obi/0.1` verifiers stop checking at its first next-version entry anyway. It keeps two versions' rules alive in every server and client for as long as one member hasn't moved, which is the cost one switch avoids. With one client today, and few Obyspheres, a switch per Obysphere is simpler and safe.

## 5. Oby

Oby is the one implementation today. What it would change, in its own repository and order: the constants and renames in its protocol crate, which would speak both versions until each of its Obyspheres switched; its copy of the spec, which `sync-spec.sh` makes from `spec/schemas/v0.2` and the next version's fixtures; and its policy and decisions storage, keyed by scope. Its compute and share code is retired already.

## 6. The conformance suite

The next version gets fixtures of its own, generated as `obi/0.1`'s are, and the `obi/0.1` fixtures stay. Cases the migration needs, beyond each new rule's:

- a chain that switches from `obi/0.1` to `NAME/0.2` at a seq, valid; one with an `obi/0.1` entry after a `NAME/0.2` entry, invalid;
- an envelope with `obi/0.1`'s field names under `NAME/0.2`, invalid;
- every rename, both ways: the old name refused in the new version.
