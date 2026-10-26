# The clerk: a deterministic vote count

A small library that counts ballots by a stated rule and gives the same answer every time, in [Rust](rust/) and [TypeScript](ts/). It never reads the words behind a ballot and never uses judgement: the count is a function of its input. Anyone holding the input can count again and compare with a recorded verdict.

Both implementations are checked against the same known-answer vectors, [vectors/count.json](vectors/count.json), and must give exactly the answers there. An implementation in another language is correct when it does too.

Status: Draft. The input and output below may still change; the vectors' `version` changes with them.

## Rules

| `rule.kind` | Ballots | Outcome |
|---|---|---|
| `majority` | `approve`, `reject`, `abstain` | `approve` when approvals are more than rejections, `reject` when fewer, `tie` when equal. |
| `supermajority` (`num`, `den`) | `approve`, `reject`, `abstain` | `approve` when approvals × `den` ≥ `num` × (approvals + rejections), otherwise `reject`. 1 ≤ `num` ≤ `den`. |
| `unanimity` | `approve`, `reject`, `abstain` | `approve` when there is no rejection, otherwise `reject`. |
| `schulze` | a complete ranking of the options, or `abstain` | The Schulze winners: the Condorcet winner when there is one. |
| `borda` | a complete ranking of the options, or `abstain` | The options with the highest Borda score. |
| `median` | a non-negative integer, or `abstain` | The lower median of the values. |

Abstentions count towards the quorum and nowhere else. A seat with no ballot is absent. All arithmetic is in integers (`supermajority` multiplies exactly, beyond 2^53).

**Order of decisions.** For every rule:

1. Fewer ballots than `quorum`: `no_quorum`.
2. Yes/no rules with `veto` on: any finding that blocks (below) makes the outcome `reject`, whatever the votes.
3. Every ballot is `abstain`: `no_votes`.
4. Otherwise the rule's outcome. A ranked rule's outcome is `elected` with one winner, or `tie` with several, unless the seeded tie-break applies (below).

**Findings and the veto.** With `veto: true` (yes/no rules only), each finding `{id, blocking, evidence, challenge}` blocks exactly when `blocking` and `evidence` are both true and `challenge` isn't `refuted` (`none` and `stands` both leave it standing). Without `veto`, findings are checked for shape and otherwise ignored.

**Schulze.** `d[i][j]` is the number of ballots ranking option *i* above option *j*. The strength `p[i][j]` starts at `d[i][j]` when `d[i][j] > d[j][i]`, else 0, and becomes the strength of the strongest path from *i* to *j* (Floyd–Warshall over the widest path: for each *i*, then *j* ≠ *i*, then *k* ∉ {*i*, *j*}, `p[j][k] = max(p[j][k], min(p[j][i], p[i][k]))`). The winners are the options *i* with `p[i][j] ≥ p[j][i]` for every other *j*.

**Borda.** With *n* options, a ballot gives the option it ranks first *n* − 1 points, the next *n* − 2, and so on to 0 for the last.

**Median.** The values sorted ascending; with *k* values, the one at index ⌊(*k* − 1) / 2⌋.

**Ties.** A yes/no tie is `tie`, never broken. A ranked tie stays `tie` unless `tie_break` is `{"kind": "seeded", "seed": <64 lower-case hex characters>}`: then the tied option whose SHA-256 over the bytes of `tie-break` and a newline, the seed's 32 bytes and the option id's UTF-8 bytes is lowest (compared as bytes) wins, the outcome is `elected` and `tie_broken` is true. The tie-break is used only for a tie among winners, never when there is one winner, and never on `no_quorum` or `no_votes`.

## Input

A JSON object. Integers are JSON integers from 0 to 2^53 − 1; ids are non-empty strings.

| Member | Required | Meaning |
|---|---|---|
| `rule` | yes | `{"kind": …}`, plus `num` and `den` for `supermajority`, and nothing else. |
| `quorum` | yes | The least number of ballots, abstentions included, for a count. 1 to the number of seats. |
| `seats` | yes | The ids of the seats that may cast a ballot, at least one, all different. |
| `ballots` | yes | Each `{"seat": id}` with exactly one of `vote` (`approve`, `reject` or `abstain`), `ranking` (every option exactly once, best first) or `value` (an integer). At most one per seat; any order. |
| `options` | ranked rules only | The options' ids, at least two, all different. Their order is the order of every array in the output. |
| `veto` | no | `true` turns the veto on (yes/no rules only). Default `false`. |
| `tie_break` | no | `{"kind": "none"}` (the default) or the seeded tie-break (ranked rules only). |
| `findings` | no | Each `{"id", "blocking", "evidence", "challenge"}`: an id unique among the findings, two booleans, and `none`, `stands` or `refuted`. |

## Output

A JSON object with exactly these members:

- Every rule: `outcome`, `seats` (how many), `present` (how many ballots).
- Yes/no rules: `tally` `{approve, reject, abstain}`; `blocked_by`, the ids of the findings that block, in the findings' order (empty without `veto`). `outcome` is `approve`, `reject`, `tie`, `no_quorum` or `no_votes`.
- Ranked rules: `tally` `{ranked, abstain}`; `winners`, in the options' order; `tie_broken`; `winner` only when `outcome` is `elected`; for `borda`, `scores` (per option); for `schulze`, `pairwise` (`d`) and `strengths` (`p`), *n* × *n* in the options' order with zeros on the diagonal. `outcome` is `elected`, `tie`, `no_quorum` or `no_votes`.
- `median`: `tally` `{values, abstain}`; `value` only when `outcome` is `value`. `outcome` is `value`, `no_quorum` or `no_votes`.

Two outputs are the same when they are the same JSON value: member order doesn't matter, array order does. `verify(input, verdict)` is true exactly when the count of `input` is the same as `verdict`; an input with an error has no valid verdict.

## Errors

An input that can't be counted gives one error code: the first that applies, checking in this order.

1. `bad_input`: the shape is wrong. Not an object; a member that isn't listed above, at the top level, in a ballot or in a finding; a required member missing; a wrong type (`rule` not an object with a string `kind`, `quorum` not an integer, `veto` not a boolean, `options` or `seats` not an array of ids, `tie_break` not an object, a ballot without exactly one of `vote`, `ranking` and `value`, a `vote` that isn't a string, a `ranking` that isn't an array of strings, a `value` that isn't an integer, a finding without all four members or with a wrong type).
2. `bad_rule`: an unknown `kind`; extra or missing members in `rule`; `supermajority` with `num` 0 or above `den`; `veto: true` on a rule that isn't yes/no; `options` on a rule that isn't ranked; a `tie_break` that isn't one of the two forms, or a seeded one on a rule that isn't ranked.
3. `bad_options`: a ranked rule without `options`, with fewer than two, or with one repeated.
4. `bad_seats`: no seats, or a seat repeated.
5. `bad_quorum`: `quorum` below 1 or above the number of seats.
6. `bad_finding`: a finding id repeated, or a `challenge` that isn't `none`, `stands` or `refuted`.
7. Then each ballot in order, the first failing check winning: `unknown_seat` (its seat isn't in `seats`), `duplicate_ballot` (its seat already has one), `wrong_ballot` (a choice the rule doesn't take: `vote` other than `abstain` on a ranked rule or `median`, a `vote` other than the three, a `ranking` on a rule that isn't ranked, a `value` on a rule other than `median`), `bad_ranking` (not every option exactly once).

## Running

```
make clerk-check
```

runs both: `cargo test` and `cargo clippy` in `rust/`, and `pnpm run check` and `pnpm test` in `ts/` (Node 22.18 or later). To count inputs from the command line, one JSON object per line:

```
cd clerk/rust && cargo run -q --example count < inputs.jsonl
```

## The vectors

[vectors/count.json](vectors/count.json) has `count` vectors (an input, and the exact output or the error code) and `verify` vectors (an input, a recorded verdict, and whether it matches). The expected answers were worked out by hand, not by either implementation; the Schulze and Borda cases include standard examples from the literature, where Borda and Schulze pick different winners from the same ballots.
