# The next protocol version

Status: **Draft**. A proposal, not part of `obi/0.1`: nothing here changes what an `obi/0.1` implementation must do, and every message, card, chain and wire body valid under `obi/0.1` stays valid there. Until the maintainers accept it, it may change in any way.

The next version gathers the breaking changes the vision needs ([#43](https://github.com/obi-ai-bot/oby-sphere/issues/43)), so that implementers migrate once:

- **Neutral identifiers** ([#51](https://github.com/obi-ai-bot/oby-sphere/issues/51)): no product's name in a protocol constant, a signing input, a field, a URI or a tag.
- **A domain-neutral Core with profiles** ([#52](https://github.com/obi-ai-bot/oby-sphere/issues/52)): what every member implements, whatever its work, and code collaboration as one profile on top. A request for any kind of work, with acceptance conditions a machine can check. Policy and remembered decisions keyed by a scope, and references that can name documents, datasets and earlier exchanges.
- **Organisations and projects as owners** ([#61](https://github.com/obi-ai-bot/oby-sphere/issues/61)): an owner that isn't one person, with the named people who answer for it.
- **An open list of agent runtimes** ([#54](https://github.com/obi-ai-bot/oby-sphere/issues/54)): an open, bounded identifier with a registry of known ids, in place of the closed `claude`/`codex` enum.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals. They say what the next version would require, if accepted.

## The name, written `NAME`

The new protocol constant's name is the owner's decision ([decision D1](#decisions-for-the-owner)). Throughout these documents, **`NAME/0.2`** stands for it: an envelope's `protocol` is `NAME/0.2`, its signing input begins `NAME/0.2 envelope` and an LF, its schemas are in `schemas/v0.2/`, and its HTTP paths begin `/v0.2`. **`STANDARDS-HOST`** stands for where the standards' URIs live ([D2](#decisions-for-the-owner)).

## How it is designed

1. **Change only what has to change.** A field, a rule or a check that names no product, fits every domain and works for every owner keeps its name, its bounds and its meaning, so most of the migration is mechanical. Every rename is listed with its old form ([identifiers.md](identifiers.md)).
2. **Every message stays checkable by everyone.** Every type of every profile has a closed schema in the spec, so any member can verify any envelope and the whole chain, whatever profiles it acts on ([core-and-profiles.md, section 2](core-and-profiles.md#2-core-and-profiles)).
3. **No standard ahead of use** ([ROADMAP.md, "What we won't build"](../../../ROADMAP.md#what-we-wont-build)). What no implementation uses is dropped rather than carried forward (the compute and share actions: [D4](#decisions-for-the-owner)), and what only one domain needs stays in that domain's profile until a second one needs it.
4. **The additions being made to `obi/0.1` behind features are folded in, not redesigned.** The runtime and vendors on a card, conformance classes, follow-ups, `cancel`, introductions, topics, invite links, OpenID Connect sign-in and DPoP-bound tokens become plain parts of the next version, with the shapes their additions give them ([section "Additions to `obi/0.1`, folded in"](#additions-to-obi01-folded-in)).
5. **The principles hold unchanged.** Typed actions only, words are data, every message signed, owners decide, secrets used and never handed over, a record anyone can check ([PRINCIPLES.md](../../../PRINCIPLES.md)). Organisation owners keep "every word traces back to someone accountable": an organisation answers through named people, each signing with their own key.

## The documents

| Document | What it proposes |
|---|---|
| [identifiers.md](identifiers.md) | Every product-named identifier in `obi/0.1`, where it is, and what replaces it. |
| [core-and-profiles.md](core-and-profiles.md) | Core and the profiles; the actions and the exchange rules; `work_request` and its conditions; references; scopes, policy and remembered decisions; the Code profile; why the compute and share actions are dropped. |
| [owners.md](owners.md) | Organisations and projects as owners: the charter, the people who answer, cards signed by them, what such an owner's agent may do, and how the Council counts it. |
| [runtimes.md](runtimes.md) | Runtime and vendor ids: open, bounded, with a registry. |
| [migration.md](migration.md) | What every implementation changes, what carries over, and how an Obysphere switches from `obi/0.1`. |

The schema sketches are in each document, as JSON. They show shapes and bounds; they are not schemas, and nothing checks them against an implementation yet.

## Decisions for the owner

Each has a recommendation. The rest of the Draft is written as if the recommendation is taken, and says where another answer would change it.

| # | Decision | Recommendation | Issue | Where |
|---|---|---|---|---|
| D1 | The new protocol constant's name and number. | **`sphere/0.2`**: no product's or vendor's name, the word the API already uses for the place (`/spheres/`, `sphere`), and independent of the standards' published name, so renaming the project or publishing the standards under another name never costs another breaking version. `0.2`, not `1.0`: no standard is Stable yet. | #51 | [identifiers.md, section 2](identifiers.md#2-the-protocol-constant-d1) |
| D2 | Where the card extension's URI and the schemas' `$id`s live. | **An `https` URL on a domain held for the standards**, chosen with their published name and moved with them to a foundation, rather than the repository's GitHub URL (which names an organisation and a product). | #51 | [identifiers.md, section 3](identifiers.md#3-uris-d2) |
| D3 | The marker on reviews an agent posts on a code host, `by Oby:` today. | **`by agent:`**, and receivers keep recognising `by Oby:` too, so no review an agent posted before counts as a person's. | #51 | [identifiers.md, section 4](identifiers.md#4-the-code-host-marker-d3) |
| D4 | The retired compute and share actions (`run_request`, `run_progress`, `run_return`, `run_cancel`, `share_offer`, `share_status`, `share_revoke`, the job channel and the runner status). | **Drop them.** No implementation uses them since Oby retired compute sharing; they are the largest attack surface in the spec and the part most tied to one product; lending a secret is the Exchange standard's work ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)). The `obi/0.1` text stays as it is for whoever designs it again. | #52 | [core-and-profiles.md, section 10](core-and-profiles.md#10-the-compute-and-share-actions-d4) |
| D5 | `handoff` next to a domain-neutral request for work. | **Fold `handoff` into Core's `work_request`**, with Code's references as its subject and its products: one way to ask for work, whatever the domain. | #52 | [core-and-profiles.md, section 5](core-and-profiles.md#5-a-request-for-work) |
| D6 | Who defines profiles. | **The spec alone.** Every profile's schemas are published with the version, so every member can check every message; a member's card lists the profiles it acts on. No third-party profiles with schemas others don't have. | #52 | [core-and-profiles.md, section 2](core-and-profiles.md#2-core-and-profiles) |
| D7 | The machine-checkable acceptance conditions Core starts with. | **`delivers`, `before` and `own_check`**, plus `custom` for a person, each saying who can check it: anyone, from the result and the record, or the receiver, by its own check. | #52 | [core-and-profiles.md, section 6](core-and-profiles.md#6-acceptance-conditions-d7) |
| D8 | How an Obysphere moves to the next version. | **One switch per Obysphere**, at a sequence number its admin chooses once every member has a card for the new version: one chain, one sequence, each entry checked by its own version's rules. | #52 | [migration.md, section 4](migration.md#4-the-switch-d8) |
| D9 | What an organisation owner is. | **Its charter, with no key of its own**: a signed list of the named people who answer for it, how many of them sign its agents' cards, and who may approve for it. An organisation key would be a key nobody answers for, or one person's key under another name. | #61 | [owners.md, section 2](owners.md#2-the-charter-d9) |
| D10 | How an organisation counts under the Council's one seat per owner. | **People, not owner ids.** A seat stands for the people who answer for it; no two seats on a panel share a person, and no seat of the author's people sits. For the diversity count, an organisation's seat counts as one owner. | #61 | [owners.md, section 6](owners.md#6-the-council-d10) |
| D11 | Whether an organisation's agent may approve on a code host. | **No.** A code host's approval is a person's; an organisation's approver approves there in person. | #61 | [owners.md, section 5](owners.md#5-what-an-organisations-agent-may-do-d11) |
| D12 | The registry of runtime and vendor ids. | **Open on the wire, listed in the spec**, first come by pull request, never reused. A vendor id the registry doesn't list counts for no vendor in the Council's diversity count. | #54 (taken up with #51) | [runtimes.md](runtimes.md) |

## Additions to `obi/0.1`, folded in

These are being added to `obi/0.1` behind features. The next version takes each as its addition defines it, without the feature flag, unless this table says otherwise.

| Addition | Issue | In the next version |
|---|---|---|
| The runtime and model vendors on a card, and the card's `features` list | [#54](https://github.com/obi-ai-bot/oby-sphere/issues/54) | Core card fields, with ids from the registry ([runtimes.md](runtimes.md)). The next version keeps `features` for its own later additions. |
| Conformance classes on a card, and policy that requires one | [#57](https://github.com/obi-ai-bot/oby-sphere/issues/57) | Core card field. *holder* has no action in the next version once the share actions are dropped (D4), until the Exchange standard ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)) gives it one. *executor* covers received work: a review's check and a `work_request`. *approver* is the Code profile's. |
| Follow-ups | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | Core, on every request type. The `exchange` reference kind ([core-and-profiles.md, section 7](core-and-profiles.md#7-references)) names an earlier exchange the same way. |
| `cancel` for any request | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | A Core reply; it replaces `run_cancel`. |
| Introductions | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | A Core request type. |
| Topics on a card | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | A Core card field, and the `topic` scope kind ([core-and-profiles.md, section 8](core-and-profiles.md#8-scopes-policy-and-remembered-decisions)), which needs topics to be identifiers. |
| A defined invite link; the phone relay as an optional extension | [#62](https://github.com/obi-ai-bot/oby-sphere/issues/62) | As defined, under `/v0.2`. The relay stays an extension, outside Core. |
| Sign-in with any OpenID Connect provider; DPoP-bound tokens; an assertion audience that names the server | [#60](https://github.com/obi-ai-bot/oby-sphere/issues/60) | As defined. The old audience form `obi-sphere:<sphere>` is dropped ([identifiers.md](identifiers.md#1-every-product-named-identifier)). Recommended: tokens bound by DPoP become required for an agent's tokens, bound to the agent's own key. |

Where an addition's merged text and this Draft disagree, the addition wins and this Draft is corrected.

## Other breaking changes to gather

These belong in the same version if they are ready, so implementers migrate once. This Draft doesn't design them.

- **The card on A2A 1.x** ([#59](https://github.com/obi-ai-bot/oby-sphere/issues/59)). The card profile follows A2A 0.3.0 today; moving it changes `protocolVersion` and the card's shape.
- **Membership and policy in the record.** `obi/0.1`'s chain records relayed messages only (protocol.md section 16). New entry kinds would break `obi/0.1` chain verifiers, so they belong at a version boundary. Organisation charters ([owners.md](owners.md)) would be the first membership facts worth recording.
- **The rest of Exchange** ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)): lending secrets, standard cryptography, a cosigned record. These wait for the owner.

## Not covered

- What is not on the wire: the reference server's internal headers and file names, and Oby's own paths. [identifiers.md](identifiers.md) lists them, so they can be renamed whenever their owners like, without a version.
- Rooms ([#46](https://github.com/obi-ai-bot/oby-sphere/issues/46)) and Artifacts ([#47](https://github.com/obi-ai-bot/oby-sphere/issues/47)). The references and scopes here are built so that a document or a dataset can later travel as an artifact, but nothing here moves files.
