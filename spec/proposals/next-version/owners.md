# Who answers for an agent: organisations and projects as owners

Status: **Draft**, part of [the next protocol version](README.md). Issue: [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61).

In `obi/0.1` an owner is a person, and every agent acts for exactly one person (protocol.md section 1). That keeps every word accountable, and it stays. But many agents that should take part don't act for one person: a project's maintainer agent, a team's on-call agent, a company's hosted coding agent. Today they can join only by pretending to be someone.

The next version adds a second kind of owner, an **organisation** (an organisation, a project or a team; one kind covers all three), which answers through named people. Nothing about persons changes.

## 1. What doesn't change

- **A person's approval comes from that person's own device.** Every signature that stands for an organisation is a named person's, made with their own owner key.
- **Nothing joins without someone accountable.** An organisation has at least one person who answers for it, and its agents act only while it does.
- **Persons are owners as today**: one owner key, bound by the Obysphere the first time it sees them, signing their agents' cards.

## 2. The charter (D9)

An organisation owner has **no key of its own**. It is its **charter**: a signed list of the people who answer for it and of what each may do. An organisation key would have to sit on someone's device: either a key nobody in particular answers for, or one person's key under the organisation's name. A charter keeps every signature a person's.

| Field | Meaning |
|---|---|
| `protocol` | `NAME/0.2`. |
| `sphere` | The Obysphere it is for. |
| `org` | The organisation's owner id, in the same namespace as persons' (an organisation and a person never share an id). |
| `name` | What to call it, one line (100). Data. |
| `charter_seq` | 1 for the first charter, and greater with every change. |
| `answerers` | 1 to 20 people who answer for it, each `{owner, owner_key_id, approves}`: a person owner of this Obysphere, the key id of their bound owner key, and whether they may confirm what needs the owner's confirmation (section 5). At least one has `approves: true`, except after an approver leaves (below). |
| `thresholds` | `card`: how many answerers sign each of its agents' cards (1 or more). `charter`: how many of the current answerers sign the next charter (more than half of them, or more). `decide`: how many answerers make a remembered decision or a sharing rule for it (1 or more). None is more than the number of answerers. |
| `issued_at` | When it was signed. |
| `signatures` | One per signing answerer: `{owner_key_id, signature}`, Ed25519 by that person's owner key over the signing input `NAME/0.2 charter` + LF + the canonical JSON of the charter without `signatures`. |

**Who signs.**

1. **The first charter** is signed by every answerer it names: nobody is made to answer for an organisation without their own signature.
2. **A later charter** is signed by at least `thresholds.charter` answerers of the current charter, and by every answerer it adds.
3. **Leaving.** Any answerer may sign, alone, a charter that only removes them, with `charter_seq` one higher and any threshold over the remaining number of answerers lowered to it. Leaving is always allowed: when the one who leaves was the last approver, the organisation has none until a later charter names one, and nothing that needs its confirmation can be confirmed meanwhile. An organisation whose last answerer leaves has nobody accountable: its agents are revoked, as in `obi/0.1` (identity.md section 3).

**Every answerer is a person owner of the Obysphere**, with a bound owner key and, where the Obysphere signs people in, a sign-in that bound them to an account (#60). A person may answer for an organisation without an agent of their own: the next version lets a person join as an owner only (an invitation redeemed with their owner key and, where needed, a sign-in, and no card).

```json
{
  "$id": "https://STANDARDS-HOST/schemas/0.2/charter.schema.json",
  "title": "Organisation charter",
  "type": "object",
  "additionalProperties": false,
  "required": ["protocol", "sphere", "org", "name", "charter_seq", "answerers", "thresholds", "issued_at", "signatures"],
  "properties": {
    "protocol": { "$ref": "common.schema.json#/$defs/protocol" },
    "sphere": { "$ref": "common.schema.json#/$defs/sphere_id" },
    "org": { "$ref": "common.schema.json#/$defs/owner_id" },
    "name": { "$ref": "common.schema.json#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 100 },
    "charter_seq": { "type": "integer", "minimum": 1, "maximum": 1000000000 },
    "answerers": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["owner", "owner_key_id", "approves"],
        "properties": {
          "owner": { "$ref": "common.schema.json#/$defs/owner_id" },
          "owner_key_id": { "$ref": "common.schema.json#/$defs/key_id" },
          "approves": { "type": "boolean" }
        }
      }
    },
    "thresholds": {
      "type": "object",
      "additionalProperties": false,
      "required": ["card", "charter", "decide"],
      "properties": {
        "card": { "type": "integer", "minimum": 1, "maximum": 20 },
        "charter": { "type": "integer", "minimum": 1, "maximum": 20 },
        "decide": { "type": "integer", "minimum": 1, "maximum": 20 }
      }
    },
    "issued_at": { "$ref": "common.schema.json#/$defs/timestamp" },
    "signatures": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["owner_key_id", "signature"],
        "properties": {
          "owner_key_id": { "$ref": "common.schema.json#/$defs/key_id" },
          "signature": { "$ref": "common.schema.json#/$defs/signature" }
        }
      }
    }
  }
}
```

The rules no schema can say: answerers' `owner`s are distinct and each `owner_key_id` is that person's bound key; at least one answerer approves; the thresholds are within bounds; the signatures are by distinct answerers and verify.

## 3. Joining and the directory

**Joining.** An organisation joins the way a person does, with its charter where a person has an owner key: an invitation is redeemed with the charter and its first agent's card, or, for an organisation with no agent yet, with the charter alone. The Obysphere checks the charter (section 2) and binds the organisation's id to it, as it binds a person's id to their owner key the first time it sees them. From then on, the organisation's charter changes only by a later charter signed as section 2 says, sent with `PUT /v0.2/spheres/{sphere}/orgs/{org}/charter`.

**The directory keeps every charter**, never deleting one, with the range of audit sequence numbers it was current for (`valid_from_seq`, `valid_until_seq`), as it keeps every agent key. So a chain's verifier, and anyone else, can tell who answered for an organisation when any entry was recorded. `GET /v0.2/spheres/{sphere}/orgs/{org}` answers the current charter and the earlier ones.

**Pinning.** Each agent pins what it first saw for an organisation, as it pins a person's owner key (identity.md section 3, on pinning): it trusts a later charter only when the charter it already trusts signs it as section 2 says, and it never follows an organisation that starts over with a new first charter. So an Obysphere can't swap an organisation's answerers.

## 4. Its agents' cards

**How the card shows who answers.** A person's agent's card names its owner and their owner key, as in `obi/0.1`. An organisation's agent's card names the organisation and the charter it was signed under, and carries one signature from each signing answerer: A2A cards take several signatures, and `obi/0.1` allows only one.

```json
{
  "params": {
    "protocol": "NAME/0.2",
    "sphere": "acme",
    "agent_id": "release-agent",
    "owner": "acme-release",
    "charter": { "seq": 3, "sha256": "<SHA-256 of the charter's canonical JSON, signatures included>" },
    "key_id": "ed25519:…",
    "public_key": "…",
    "profiles": ["code"],
    "accepts": ["question", "review_request", "work_request"],
    "card_seq": 1,
    "issued_at": "2026-11-02T12:00:00Z"
  },
  "signatures": [
    { "protected": "<header with kid: wellington's owner key id>", "signature": "…" },
    { "protected": "<header with kid: ernesto's owner key id>", "signature": "…" }
  ]
}
```

`params` has exactly one of `owner_key` (a person's agent, as in `obi/0.1`) and `charter` (an organisation's). Everything else in `params`, including what is being added to `obi/0.1` (`runtime`, `vendors`, `features`, classes, topics), is the same for both.

**Verifying such a card** adds to identity.md section 2.2: the charter it names is the organisation's charter at that `seq`, with that hash; it has at least `thresholds.card` signatures, each by a distinct answerer of that charter, each verifying with that person's owner key; and that charter is still current, or a later charter still names every signer and its `card` threshold is no more than the number of signatures. Otherwise the card is stale, and the Obysphere refuses the agent's sends (`card_stale`) until it has a card signed under the current charter.

**What a receiver shows.** An agent shows its owner a sender's owner as the organisation's `name`, with the names of the people who answer for it from the charter, each with their owner key's fingerprint. Words from an organisation's agent are shown as that: "from Acme release's agent", never as one of its people's.

**Delegation.** An organisation's agent gets its tokens as a person's does (identity.md section 4), with one change: its delegation (the owner assertion with `may_act`) is signed by `thresholds.card` answerers, as a JWS in the general JSON serialization (RFC 7515, section 7.2.1) with one signature each. The token endpoint takes it with a subject token type of its own, checks it against the current charter, and otherwise works as today.

## 5. What an organisation's agent may do (D11)

**The same actions as a person's agent, under the same rules.** It sends and receives typed actions; its receivers decide by their own owners' rules, which may name the organisation like any owner (policy's `from_owner` and `to_owner`, sharing rules, rate limits counted by the sender's owner); nothing received makes it merge, push or publish; received work gets none of its people's secrets.

**Its owner's answers come from its people.** Where protocol.md section 11 says "the owner", for an organisation's agent it means its answerers, each on their own device:

- **Its inbox** is the organisation's: every answerer sees it, and one answerer's answer settles a request. The agent keeps which answerer answered.
- **Remembered decisions and sharing rules** are made by `thresholds.decide` answerers, each confirming on their own device.
- **An `answer` with `by: "owner"`** is one of its answerers' own words. It says so, without naming which: the organisation answers, and its charter says who it is.
- **A confirmation** (what an owner confirms on their own device) comes from an answerer with `approves: true`.

**It never approves on a code host** (D11). A code host's approval is a person's: it counts toward a branch rule because someone with write access stands behind it. An organisation's agent that gets a `review_request` with `approve_on_host` answers `host_review: "unable"`, and the person who would approve, one of its approvers, does it on the code host themselves. So the Council's rule I7, a person's approval is a person's, holds for organisations too. The alternative, letting an approver's confirmation make the organisation's agent post with that approver's own login, would put a person's code-host login in an agent that acts for others.

## 6. The Council (D10)

The Council's rule I3 ([council/process.md](../../council/process.md#3-integrity-rules)) is one seat per owner: "one person must not fill a panel with their own agents". With organisation owners, counting owner ids would let one person sit twice, once through their own agent and once through an organisation they answer for. So the next version counts **people**.

- **The people a seat stands for.** A person's agent, or a person sitting in person, stands for that person. An organisation's agent stands for every answerer of its charter as of the moment the pool is fixed.
- **I3, one seat per person.** No two entries of a pool, and no two seats of a panel, stand for a common person. Where several eligible entries share a person, the profile names which one stays, as it does for one owner's several agents today.
- **I2, the author never sits.** No entry that stands for any of the author's people is eligible: an organisation's agent can't review a change by one of its answerers, and an answerer's own agent can't review a change the organisation wrote.
- **I4, diversity.** An organisation's seat counts as **one** owner. Counting each of its answerers would let an organisation buy diversity by naming more people; one seat is one judgement.

What a draw needs from the directory is each entry's set of people: one person, or the answerers of the charter current when the pool is fixed. The pool's record lists each entry's people with its owner and declared vendor, so anyone re-checking the draw sees why each entry was eligible.

**The alternatives.** Counting an organisation as one owner apart from its people lets one person fill two seats. Barring organisations from panels loses the agents most likely to be built for review, a project's maintainer agent among them.

## 7. Open in this Draft

- Whether an organisation can answer for another organisation (a team inside a company). Recommended: not in the next version; answerers are persons.
- Whether a receiver can treat every organisation alike, for example declining all requests from organisations, without listing them. A policy field for the owner's kind would do it.
- Whether membership facts, a charter among them, go into the record as entries of their own ([README.md, "Other breaking changes to gather"](README.md#other-breaking-changes-to-gather)).

## 8. Done when

#61 is done when a project's agent joins an Obysphere as the project's, a receiver sees which people answer for it, and the integrity rules of the Council say how such owners count. In this Draft: it joins with a charter (section 3), its card names the charter and carries its people's signatures (section 4), and the Council counts people (section 6).
