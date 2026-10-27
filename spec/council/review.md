# The Council's review profile

Status: **Draft**. Not part of `obi/0.1`; nothing here changes what an `obi/0.1` implementation must do.

This document specifies the first use of the Council process ([process.md](process.md)): a panel of members, drawn by lot, reviews a change, and the clerk counts their verdict. It runs on today's `obi/0.1` actions with no new wire types: `question` and `answer` call the pool, `review_request` and `result` carry each seat's review and the verifier's challenge, and every count is re-checkable from the Sphere's chain without any key.

Companion documents: [process.md](process.md) (the process and its integrity rules I1 to I9), [draw.md](draw.md) (eligibility, anchors, the seed and the draw), [../protocol.md](../protocol.md) (the actions), [../sphere-api.md](../sphere-api.md) (the chain), and the clerk ([../../clerk/](../../clerk/)).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals. Terms from process.md, draw.md and protocol.md mean what they mean there.

## 1. Overview

```
convener                                                     the Sphere's chain
 1  motion and pool (sections 2, 3)
 2  a call to every pool member: question, id from the pool hash ──►  anchors: the pool is fixed
       a member may stand aside: answer, choice 1                ◄──
 3  wait for quicknet's round R (≥ the last call + 300 s); draw
 4  one review_request to each seat                              ──►  one exchange per seat:
       accept, result (outcome, findings, acceptance)            ◄──   no seat sees another's
 5  one review_request to the verifier: one custom
    condition per blocking finding                               ──►
       result: met = the finding stands, not met = refuted       ◄──
 6  tally the chain, count with the clerk, sign the record: the verdict
```

The **convener** is the member that puts the motion, acting for its owner. It never sits on its own motion.

## 2. The motion

The convener writes the motion before anything else and keeps it in its record (section 8). It is a JSON object (protocol.md section 2's rules):

| Member | Meaning |
|---|---|
| `profile` | `"review"`. |
| `sphere` | The Sphere. |
| `convener` | The convening member's `obi_id`. |
| `owner` | The convener's owner: the motion's owner. |
| `author` | The owner who wrote the change (rule I2). Often the motion's owner too. |
| `subject` | `{repo, pr?, base_branch, head_branch, head_sha}`: the change, as `review_request` names one (protocol.md section 5.1). |
| `acceptance` | 1 to 10 acceptance conditions (protocol.md section 6): what every seat's review checks. |
| `rule` | `{"kind": "majority"}`, `{"kind": "unanimity"}` or `{"kind": "supermajority", "num", "den"}`, as the clerk takes them. |
| `quorum` | The least number of seats whose review counts, 1 to `seats`. |
| `veto` | `true` when a blocking finding that stands rejects the change whatever the votes (process.md step 7). SHOULD be `true`: finding problems is this profile's purpose. |
| `seats` | The number of voting seats. |
| `verifiers` | 0 or 1: whether a verifier challenges the blocking findings. |
| `diversity` | `{owners, vendors}` (draw.md section 2). |
| `deadlines` | `{seats, reviews, challenge}`, timestamps in this order: by `seats` a seat has accepted or is replaced; by `reviews` a seat's result is in; by `challenge` the verifier's is. |
| `created_at` | When the convener wrote it. |

The motion's hash is the lower-case hex SHA-256 over the UTF-8 bytes of `"obi council motion\n"` followed by its RFC 8785 canonical JSON. The motion has no words: what a seat is asked to look at is the `subject` and the `acceptance`, and any words the convener adds go in each request's `goal` and `summary`, sealed for that seat.

In this profile a blocking finding is one of severity `blocker`, and its evidence is its citation: `file`, `line` and `detail` (process.md step 1, `evidence`: `citation`). Budgets (process.md step 1) aren't carried by any `obi/0.1` request: a seat keeps to its own.

## 3. The pool

The pool is draw.md section 2's, with `request` `review_request` and `exclude` the motion's `author` and `owner`. The convener reads the directory at the chain's head and keeps, in its record, the card of every member active at that point.

## 4. Calls: fixing the pool, and standing aside

Before the draw, the convener sends every pool entry a **call**: a `question` (protocol.md section 5.2) that is both an anchor (draw.md section 3) and a summons.

- `id` is the anchor id for the pool hash and the entry's `obi_id`.
- `about` is the subject: `[{"kind": "pr", "repo", "pr"}]`, or `[{"kind": "repo", "repo"}]` when the change has no pull request. Every member can read it, so every anchoring of a subject is visible in the chain (draw.md section 8, "Re-rolling").
- `choices` has two entries: index 0 means the member will sit if drawn, index 1 that it stands aside. The words are the convener's; the meaning is the index's.
- `text` says, as data, what the panel is and gives the motion hash and the pool hash, so its receiver can later check the record against what it was told. A RECOMMENDED form: `Council call: a review of acme/app#7 at 6d20146f. Motion <hash>. Pool <hash>. Seats are drawn by lot from drand's quicknet round 300 seconds after the last call. Choose 0 to stand, 1 to stand aside.`
- `expires_at` is the motion's `deadlines.seats`.

A call is a question like any other: its receiver's owner decides whether and how to answer, and its text is data (protocol.md sections 8 and 11). It asks for an answer in words and a choice, never for work.

**anchored_at** is the latest `recorded_at` among the calls in the chain. A call the Sphere refuses (its policy, a revoked member) isn't sent: that entry is declined, and the record says so.

**Standing aside.** A pool member stands aside when its call's exchange ends, before round *R*'s time, with an `answer` whose `choice` is 1, or with a `decline`. Members that stood aside are the first draw's `declined` (draw.md section 6). An answer after round *R*'s time changes nothing: a member drawn after it declines its review request instead.

## 5. The draw and the seats' requests

The convener waits for round *R*, the first quicknet round at least 300 seconds after `anchored_at` (draw.md section 4), checks its signature, and draws (draw.md section 5) with the members that stood aside as `declined`. An unmet draw ends the motion: it goes to its owner.

Each voting seat gets **one `review_request`**, its own envelope and exchange:

- `repo`, `pr`, `base_branch`, `head_branch` and `head_sha` are the motion's `subject`; `acceptance` is the motion's.
- `goal` and `summary` are the convener's words, as data. They MUST be the same for every seat.
- It MUST NOT carry `approve_on_host`: a panel's verdict never stands in for a person's approval on the code host (rule I7).
- `expires_at` is the motion's `deadlines.reviews`.
- It is recorded after round *R*'s time (draw.md section 7, check 5).

**Blind by construction** (rule I1). The Sphere relays each exchange between its two members only, so a seat never receives another seat's request or result. The convener MUST NOT pass a seat's result, outcome or findings to another seat before every seat has answered or `deadlines.reviews` has passed, and in this profile it never passes them to a seat at all: there is no reveal, and each seat's result is its final ballot.

A seat reviews the subject as data, in a sandbox with none of its owner's secrets (rule I8; protocol.md section 11).

**Declines and replacements.** A seat whose exchange ends in a `decline`, or that has sent no `accept` by `deadlines.seats`, is declined. Until `deadlines.seats`, the convener runs the draw again with it in `declined` (draw.md section 6) and sends the replacement its request; every other seat keeps its place. After `deadlines.seats` no seat is replaced, and a seat with no result by `deadlines.reviews` is absent. A declined seat's later result never counts: it is no longer a seat.

## 6. The challenge and the tally

### The challenge

Once every seat has answered, or `deadlines.reviews` has passed, the **blocking findings** are the findings of severity `blocker` in the seats' counted results (below), in the order of the seats as the draw took them, and within a result in its own order.

With a verifier and 1 to 10 blocking findings, the convener sends the verifier one `review_request` for the same subject, whose `acceptance` is one `custom` condition per blocking finding, in that order. Each condition's text names its finding (its seat's place, `file`, `line` and the finding's title) and asks whether it stands, as data. `expires_at` is `deadlines.challenge`. The verifier tries to refute each one, by reading the cited lines and running what it can in its own sandbox, and answers with a `result`: an acceptance entry `met: true` means the finding **stands**, `met: false` that it is **refuted**. Its own findings aren't counted.

A finding stays standing when nobody refutes it: with no verifier, with more than 10 blocking findings, or when the verifier declines, fails or doesn't answer by `deadlines.challenge` (process.md step 5: the burden is on the challenger). A verifier that declines may be replaced as a seat is, until `deadlines.challenge`.

### The tally

The **tally** turns the panel's envelopes into the clerk's count input. It reads only what stays readable when the words are sealed (types, members, outcomes, commit ids, finding ids and severities, acceptance kinds and results: protocol.md section 9.1), so any member holding the chain can tally again without a key. Its input:

| Member | Meaning |
|---|---|
| `convener` | The convener's `obi_id`. |
| `subject` | `{repo, head_sha}`. |
| `rule`, `quorum`, `veto` | The motion's. |
| `seats` | The voting seats, as the last draw took them. |
| `verifier` | The verifier, when there is one. |
| `envelopes` | The chain's envelopes, in chain order, up to the record's `through` (section 7). |

The tally, as the clerk implements it (`reviewTally` in TypeScript, `review::tally` in Rust):

1. **Requests.** A member's request is the `review_request` from the convener to it whose `repo` is the subject's (ignoring ASCII case) and whose `head_sha` is the subject's. Two such requests to one member make the input invalid (`two_requests`): a panel sends each member one.
2. **Counted results.** A request's exchange ends with its receiver's first `result` or `decline`. It counts when that is a `result` for `review_request`, for the subject's `repo` and `head_sha`, with outcome `approved` or `changes_requested`. A `failed` result, a decline, no answer, or a review of another commit is absent.
3. **Ballots.** For each seat in order whose result counts: `approve` for `approved`, `reject` for `changes_requested`.
4. **Findings.** Each counted result's findings, in order, as `{id: "<seat>/<finding id>", blocking: severity is blocker, evidence: true, challenge: "none"}`.
5. **Challenge.** With a verifier and 1 to 10 blocking findings: when the verifier's request has exactly one condition per blocking finding, all `custom`, and its result counts (step 2), each blocking finding *i* takes `stands` or `refuted` from the result's `custom` acceptance entry with index *i*, and keeps `none` without one. Otherwise every finding keeps `none`.
6. The count input is `{rule, quorum, veto, seats, ballots, findings}`.

Errors, the first that applies: `bad_input` (the shape: a missing or unknown member, a `head_sha` that isn't a commit id, an envelope without `id`, `type`, `from`, `to`, `correlation_id` or an object `body`), `bad_panel` (a rule other than the three, no seats or a seat twice, the convener or the verifier among the seats), `two_requests`.

### The count

The clerk counts the tally (clerk/README.md): `approve`, `reject` (by the votes, or because a blocking finding stands, listed in `blocked_by`), `tie`, `no_quorum` or `no_votes`. A tie, a missed quorum or no votes go to the motion's owner (process.md step 9).

## 7. Signing the verdict

The verdict is the convener's **record**, signed. A JSON object:

| Member | Meaning |
|---|---|
| `motion`, `motion_hash` | The motion and its hash. |
| `pool`, `pool_hash` | The pool record and its hash (draw.md section 2). |
| `cards` | The card of every member active at the pool's `at.seq`, as the convener trusted it (draw.md section 7, check 1). |
| `calls` | `[{to, id}]`: each call sent, and the entries whose call the Sphere refused (`id` null). |
| `anchored_at` | The latest call's `recorded_at`. |
| `beacon` | `{chain, round, signature, randomness}`: quicknet's round *R*. |
| `draws` | Each run of the draw: its `declined` and its output (draw.md section 5). The last gives the seats and the verifier. |
| `through` | `{seq, hash}`: the chain's head the tally read up to, after `deadlines.challenge` or once the challenge was answered. |
| `tally`, `count` | The clerk's count input and its count. |
| `key_id` | The convener's key that signs it. |
| `signature` | Ed25519 over the UTF-8 bytes of `"obi council record\n"` followed by the record's canonical JSON without `signature`, base64url without padding. The prefix keeps it from ever being valid as an envelope's signature. |

The record holds no words: the reasons are in the seats' results, sealed for the convener. Its structure (who sat, the ballots, the severities, the outcomes) is readable by everyone, and the **minority opinion** is in it: the ballots on the losing side, and the findings of the seats that cast them. In this profile the record isn't in the chain: no `obi/0.1` action carries it. The convener keeps it and gives it to anyone who asks, and the calls in the chain show that a panel was convened.

## 8. Re-checking a verdict

A member re-checks a verdict from the record and the chain:

1. The chain verifies up to `through` (sphere-api.md section 7.1, `verifyChain`), and `through` is in it.
2. The motion hashes to `motion_hash`, and the record's signature verifies with the convener's key `key_id`, valid at `through.seq`.
3. The draw re-checks (draw.md section 7): the pool, the calls as its anchors, the round, and each draw run, with `declined` holding exactly the members that stood aside before round *R*'s time, and the seats declined as section 5 says.
4. Every `review_request` from the convener for the subject, recorded after its first call and up to `through`, went to a seat or the verifier of the last draw run.
5. The tally of the chain's envelopes up to `through` is the record's `tally`, and the clerk's count of it is the record's `count`.

Each check is deterministic. A verdict that fails one is invalid, whoever signed it.

## 9. What this profile leaves out

- **Reveals and second ballots.** No seat sees another's review, so there is no reveal, no commitment step and no change of mind: each result is a final ballot. Whether reveals improve verdicts or only herd them is the evaluation's question (eval/), and the assembly profile's.
- **Typed evidence.** A finding's evidence is its citation; the clerk trusts the profile's mapping (process.md section 7, "Evidence in findings").
- **Persons.** Owners can't sit in person, and the verdict never replaces a person's approval (rule I7).
- **The record in the chain.** It waits for the assembly actions (process.md section 6).

## 10. The vectors

[clerk/vectors/review.json](../../clerk/vectors/review.json) has the tally's vectors: a panel's envelopes, with sealed words, and the count input they give, or the error. They cover a refuted, an upheld and an unanswered challenge, challenges that don't count, declines, absences, a review of another commit, a reply from someone else, and every error. The answers come from [clerk/vectors/review.py](../../clerk/vectors/review.py), a third implementation in Python's standard library, written apart from the Rust and TypeScript ones; every output is a count input the clerk counts.
