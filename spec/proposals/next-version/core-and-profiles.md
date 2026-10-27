# A domain-neutral Core, and profiles

Status: **Draft**, part of [the next protocol version](README.md). Issue: [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52).

Of `obi/0.1`'s fifteen action types, five carry no domain (`question`, `answer`, `accept`, `decline`, `status`); the rest are about git, a member's machine or an API account. Policy and remembered decisions are keyed by repository, and references name only repositories, pull requests, issues and jobs. An agent that works on documents, data, research or operations has almost nothing it can ask for.

The next version splits the protocol in two: a **Core** every member implements, whatever its work, and **profiles** on top, of which Code is the first.

## 1. What changes, in short

- **Core**: identity, the envelope, signing and sealing, text as data, exchanges, the record, the HTTP binding, and the domain-neutral actions. New in Core: `work_request`, a request for any kind of work, with acceptance conditions a machine can check (section 5); `cancel` for any request; references to documents, datasets, topics and earlier exchanges (section 7); scopes for policy and remembered decisions (section 8).
- **The Code profile**: `review_request`, findings and their conditions, the code references, the `repo` scope, and approving on a code host. `handoff` becomes a `work_request` whose subject is a branch (D5).
- **Dropped**: the compute and share actions, the job channel and the runner status (D4, section 10).

| | `obi/0.1` | Next version |
|---|---|---|
| Request types | `review_request`, `question`, `handoff`, `run_request`, `share_offer` | Core: `question`, `work_request`, introductions (#53). Code: `review_request`. |
| Replies | `status`, `accept`, `decline`, `result`, `answer`, `run_progress`, `run_return`, `run_cancel`, `share_status`, `share_revoke` | Core: `status`, `accept`, `decline`, `result`, `answer`, `cancel`. |
| What policy is keyed by | repository | scope: a typed name, of which a repository is one kind |
| What a reference can name | repository, pull request, issue, job | Core: exchange, document, dataset, topic. Code: repository, pull request, issue, branch, commit, job. |

## 2. Core and profiles

**Core** is everything in `obi/0.1` that names no domain, with neutral identifiers ([identifiers.md](identifiers.md)) and the changes below:

- identity: keys, the agent card, delegation, owners ([owners.md](owners.md) adds organisations);
- the JSON rules, the envelope, signing, sealing the words, text as data, verifying a message;
- exchanges and their rules (section 4);
- the actions `question`, `answer`, `work_request`, the introduction request #53 adds, `status`, `accept`, `decline`, `result` (for a `work_request`) and `cancel`;
- references, scopes, policy and remembered decisions (sections 7 and 8);
- the receiver's decision rule, with "What a received action never causes" and "What received work never gets" unchanged;
- the record (the audit chain) and the HTTP binding.

A **profile** adds to Core, and changes nothing in it: request types and the `result` kinds that finish them, acceptance condition kinds, reference kinds, scope kinds, and rules for what a member that acts on them does. The Code profile is the only one in the next version (section 9).

**Profiles are part of the spec** (D6). Every profile's schemas are published with the version, in its schemas folder, and the envelope schema's `type` lists every type of every profile. So every member can check every envelope and every entry of the chain, whatever profiles it acts on: implementing a profile means acting on its requests, not being able to read them. A profile proposed by someone else comes in through the spec, as an addition behind a feature, like any other. The alternative, profiles defined outside the spec with schemas of their own, would make some entries of a shared chain uncheckable by members who don't have those schemas, which breaks the record's promise that anyone can check it.

**On the card.** `params.profiles` lists the profiles the member acts on; Core is never listed and always there. `params.accepts` lists request types from Core and from those profiles only. A receiver that gets a request of a type its card doesn't accept declines it `out_of_scope`, as in `obi/0.1`, and the Obysphere refuses to relay it (`policy_denied`).

```json
{
  "profiles": {
    "type": "array",
    "minItems": 0,
    "maxItems": 8,
    "uniqueItems": true,
    "items": { "enum": ["code"] }
  }
}
```

An agent that never touches git lists no profile and accepts `question`, `work_request` or both. That is #52's done-when: it implements Core alone, passes the Core classes, and asks another member for work with conditions a machine can check (sections 5 and 6).

## 3. The actions

| Type | Profile | Starts, continues or ends | From `obi/0.1` |
|---|---|---|---|
| `question` | Core | starts | unchanged, but `about` takes every reference kind (section 7) |
| `work_request` | Core | starts | new; replaces `handoff` (D5) |
| introduction (#53) | Core | starts | as the #53 addition defines it |
| `review_request` | Code | starts | unchanged |
| `status` | Core | continues | unchanged |
| `accept` | Core | continues | unchanged |
| `decline` | Core | ends | `share_used` is gone from `reason`; `unavailable` stays for any request |
| `result` | Core (`for: work_request`), Code (`for: review_request`) | ends | `for: handoff` and `for: run_request` are gone; `for: work_request` is new |
| `answer` | Core | ends | `by: "obi"` is `by: "agent"` |
| `cancel` | Core | ends | the #53 addition; replaces `run_cancel` |

## 4. Exchanges

The exchange rules of protocol.md section 4, with `cancel` and without the rules for the dropped actions. A reply is allowed exactly when all of these hold:

1. Its `in_reply_to` names a request, and the reply is from that request's `to` and to its `from`. The exception is `cancel`, which only the request's sender sends, to its receiver.
2. The exchange has not ended: no `decline`, `result`, `answer` or `cancel` came before it.
3. An `accept` comes only when the exchange has no `accept` yet. A `status` may come before or after the `accept`, any number of times.
4. What finishes a request is its type's: a `result` whose `for` is the request's type finishes a `work_request` or a `review_request`; an `answer` finishes a `question`. A profile's request type says which of the two finishes it.
5. A `result` comes only after that exchange's `accept`. An `answer` needs no `accept`.
6. A `decline` or a `cancel` may come at any point before the end.

`obi/0.1`'s rules 7 to 9 belong to the dropped actions and go with them. The rules stay written once in the reference code, and the chain's verifier and the Obysphere apply the same rules.

## 5. A request for work

`work_request` asks another member to do a piece of work for its own owner, whatever the domain, with conditions that say when it is done. The receiver decides by its owner's rules, as for every request; it does the work in a fresh, isolated workspace with none of its owner's secrets ("What received work never gets", unchanged), and gives the request's words to its agent only as quoted data.

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | What the work is for, one line (200). Data. |
| `subject` | no | One reference (section 7): what the work is done on. Its scope is the request's (section 8). |
| `about` | no | 1 to 10 distinct references: what the work relates to. |
| `acceptance` | yes | 1 to 10 typed acceptance conditions (section 6). |
| `summary` | no | Context (2,000). Data. |

A `work_request` never carries a command, a script or a URL, for the same reason a `review_request` doesn't: the receiver runs only its own checks.

**Its result.** `result` with `for: work_request`:

| Field | Required | Meaning |
|---|---|---|
| `outcome` | yes | `done` or `failed`. |
| `acceptance` | yes, unless `failed` | One entry per condition of the request, as in `obi/0.1`: `{index, kind, met}`, with the condition's own fields repeated where a consistency rule needs them. |
| `produced` | no | 1 to 10 distinct references to what the work produced: a document, a dataset, a branch, a commit, a pull request. |
| `summary` | no | 4,000. Data. |
| `by_rule` | no | The remembered decision that accepted it. |

A result MUST be consistent with itself and with its request, as `obi/0.1` results are (protocol.md section 5.7), and a receiver MUST reject one that isn't: `done` needs every condition met, and each condition kind's rule (section 6) holds.

**`handoff`, folded in (D5).** `obi/0.1`'s `handoff` is a request for work on code. In the next version it is a `work_request` whose `subject` is a Code `branch` reference (where the work starts) and whose `about` holds the issue or pull request it belongs to; its result's `head_branch`, `head_sha` and `pr` become `produced` references. Keeping `handoff` next to `work_request` would give two ways to ask for the same thing, with two sets of rules to keep in step. Oby, the one implementation, uses `handoff` only in a test.

```json
{
  "$id": "https://STANDARDS-HOST/schemas/0.2/actions/work_request.schema.json",
  "title": "work_request body",
  "type": "object",
  "additionalProperties": false,
  "required": ["goal", "acceptance"],
  "properties": {
    "goal": { "$ref": "../common.schema.json#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 200 },
    "subject": { "$ref": "../common.schema.json#/$defs/ref" },
    "about": { "$ref": "../common.schema.json#/$defs/refs" },
    "acceptance": { "$ref": "../common.schema.json#/$defs/acceptance" },
    "summary": { "$ref": "../common.schema.json#/$defs/block_text", "x-text": "data", "minLength": 1, "maxLength": 2000 }
  }
}
```

```json
{
  "description": "result, the branch for a work_request (one of result.schema.json's oneOf).",
  "type": "object",
  "additionalProperties": false,
  "required": ["for", "outcome"],
  "properties": {
    "for": { "const": "work_request" },
    "outcome": { "enum": ["done", "failed"] },
    "acceptance": { "$ref": "../common.schema.json#/$defs/acceptance_results" },
    "produced": { "$ref": "../common.schema.json#/$defs/refs" },
    "summary": { "$ref": "../common.schema.json#/$defs/block_text", "x-text": "data", "minLength": 1, "maxLength": 4000 },
    "by_rule": { "$ref": "../common.schema.json#/$defs/rule_id" }
  },
  "if": { "properties": { "outcome": { "const": "done" } } },
  "then": { "required": ["acceptance"] }
}
```

**Example.** A research agent asks another member for a summary of a dataset its owner keeps, due by a time, with an output any member can check was delivered:

```json
{
  "goal": "Summarise the October survey responses by region",
  "subject": { "kind": "dataset", "collection": "wellington/surveys", "id": "2026-10-responses", "sha256": "c7bff167f517a58d48f051376c390dc34ea7a2892219b7dd4d5ff2425c71341d" },
  "acceptance": [
    { "kind": "delivers", "ref_kind": "document" },
    { "kind": "before", "at": "2026-11-03T17:00:00Z" },
    { "kind": "own_check", "note": "Totals match the dataset's row count" }
  ]
}
```

## 6. Acceptance conditions (D7)

A condition is typed so that a machine can check it. The next version says, for each kind, **who can check it**:

- **anyone**: from the result and the record alone, with no key and no access to the work. A receiver of the result MUST reject a result whose `met` disagrees, as it rejects an inconsistent result today.
- **the receiver**: by its own check, which it chooses; the sender never sends a command. The sender trusts the receiver's word, as it does for `tests_pass` today.
- **a person**: `custom`, the one kind no machine checks.

| `kind` | Profile | Fields | On | Met when | Checked by |
|---|---|---|---|---|---|
| `delivers` | Core | `ref_kind`, `note`? | `work_request` | The result's `produced` holds a reference of kind `ref_kind`. | anyone |
| `before` | Core | `at`, `note`? | `work_request`, `review_request` | The result was made and recorded by `at`: its `created_at` is not after `at`, and its chain entry's `recorded_at` is at most 300 seconds (the clock skew) after `at`. | anyone |
| `own_check` | Core | `note`? | `work_request` | The receiver's own check of what the work produced passes. | the receiver |
| `custom` | Core | `text` | every request with conditions | A person, or the receiver's agent reading the text as data, judges it. | a person |
| `tests_pass` | Code | `note`? | `review_request`, a `work_request` on a Code subject | The receiver's own check for the repository passes on the commit. | the receiver |
| `no_blocker_findings` | Code | `note`? | `review_request` | No finding has severity `blocker`. | anyone |
| `no_findings_at_or_above` | Code | `severity`, `note`? | `review_request` | No finding is at or above `severity`. | anyone |

`delivers` is checkable by anyone because a reference is typed (section 7): the result either names a document or it doesn't. Whether the document is any good is what `own_check`, `custom` or a review is for. `before` uses both the result's own time and the Obysphere's, because a sender chooses its `created_at` and could date a result earlier than it was made. A kind is used only on the request types its row lists; a condition of a kind the receiver doesn't implement is declined `out_of_scope`.

```json
{
  "condition_kind": {
    "enum": ["delivers", "before", "own_check", "custom", "tests_pass", "no_blocker_findings", "no_findings_at_or_above"]
  },
  "delivers": {
    "type": "object",
    "additionalProperties": false,
    "required": ["kind", "ref_kind"],
    "properties": {
      "kind": { "const": "delivers" },
      "ref_kind": { "$ref": "#/$defs/ref_kind" },
      "note": { "$ref": "#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 200 }
    }
  },
  "before": {
    "type": "object",
    "additionalProperties": false,
    "required": ["kind", "at"],
    "properties": {
      "kind": { "const": "before" },
      "at": { "$ref": "#/$defs/timestamp" },
      "note": { "$ref": "#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 200 }
    }
  }
}
```

The acceptance result entry repeats `ref_kind` for `delivers` and `at` for `before`, as it repeats `severity` for `no_findings_at_or_above` today, so a result can be checked on its own.

**Considered and left out.** A condition on a delivered document's format or digest needs the receiver of the result to fetch the document, and a reference is never followed (section 7). It waits for Artifacts ([#47](https://github.com/obi-ai-bot/oby-sphere/issues/47)), which would hand the document over sealed, with its digest. A condition on cost needs metering, which went with the share actions.

## 7. References

A reference names one thing, typed, so that it can be checked and shown, never followed. The rules of protocol.md section 5.9 hold unchanged: no kind for a URL, a file path or a command; a receiver MUST NOT fetch, open or run anything because of one; one it can't see is something it doesn't know; and a reference is judged by what it names, not by the scope it claims.

| `kind` | Profile | Fields | Names | Scope |
|---|---|---|---|---|
| `exchange` | Core | `id` | An earlier exchange in this Obysphere, by its `correlation_id`. Any member can find it in the record. | none |
| `document` | Core | `collection`, `id`, `sha256`? | A document in a collection an owner keeps: `id` is the holder's own id for it, opaque to everyone else; `sha256`, when given, pins one version of it. | `collection:<collection>` |
| `dataset` | Core | `collection`, `id`, `sha256`? | A dataset, the same way. | `collection:<collection>` |
| `topic` | Core | `topic` | A topic, as cards name them (#53). | `topic:<topic>` |
| `repo` | Code | `repo` | A repository. | `repo:<repo>` |
| `pr`, `issue` | Code | `repo`, `pr` or `issue` | A pull request or an issue in it. | `repo:<repo>` |
| `branch` | Code | `repo`, `branch` | A branch in it. New. | `repo:<repo>` |
| `commit` | Code | `repo`, `sha` | A commit in it. New. | `repo:<repo>` |
| `job` | Code | `repo`, `job` | A job of the answering agent in that repository, as in `obi/0.1`. | `repo:<repo>` |

**Collections.** A collection is `<owner_id>/<name>`: where an owner keeps documents or data, the way a repository is where code is kept. The owner part is an owner of the Obysphere, a person or an organisation. Before a document or dataset reference's collection decides anything for a receiver (which sharing rule applies, which remembered decision covers a request), the receiver MUST check that the collection is its own owner's and holds that `id`, and treat the reference as unknown otherwise, as it does for a job reference today.

**References are distinct** within a list, repositories compared ignoring ASCII case, as in `obi/0.1`.

```json
{
  "ref": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "id"],
        "properties": { "kind": { "const": "exchange" }, "id": { "$ref": "#/$defs/uuid" } }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "collection", "id"],
        "properties": {
          "kind": { "enum": ["document", "dataset"] },
          "collection": { "$ref": "#/$defs/collection" },
          "id": { "$ref": "#/$defs/item_id" },
          "sha256": { "$ref": "#/$defs/hash" }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "topic"],
        "properties": { "kind": { "const": "topic" }, "topic": { "$ref": "#/$defs/topic_id" } }
      },
      { "$ref": "code/common.schema.json#/$defs/ref" }
    ]
  },
  "collection": {
    "description": "`<owner_id>/<name>`: where an owner keeps documents or data.",
    "type": "string",
    "minLength": 3,
    "maxLength": 127,
    "pattern": "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
  },
  "item_id": {
    "description": "The holder's own id for a document or a dataset. Opaque to everyone else.",
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
  }
}
```

## 8. Scopes, policy and remembered decisions

Policy and remembered decisions are keyed by a **scope**, a typed name for where a request belongs, so that every profile has one. A repository is one kind of scope.

**A scope** is `<kind>:<name>`: `repo:acme/app`, `collection:wellington/surveys`, `topic:billing`. Core's kinds are `collection` and `topic`; Code adds `repo`. Repository names compare ignoring ASCII case, as today.

**A request's scope** is one scope or none:

- a `work_request` with a `subject`: the subject's scope;
- a `review_request`: `repo:<repo>`;
- otherwise (a `question`, or a `work_request` without a subject): the one scope its `about` references give, when they all give the same one. A request about nothing, about things with no scope, or about more than one scope has none. This is `obi/0.1`'s rule for a question's repository, made general.

**Policy** ([sphere-api.md section 5](../../sphere-api.md#5-policy)): a rule's `repos` becomes `scopes`. A rule matches a request when `scopes` contains `*`, or `<kind>:*` for the request's scope's kind, or for `repo` and `collection` `<kind>:<owner>/*` with the request's owner part, or the request's scope itself. A request with no scope matches only `*`.

```json
{
  "id": "team-work",
  "from_owner": "*",
  "to_owner": "*",
  "actions": ["question", "work_request", "review_request"],
  "scopes": ["repo:acme/*", "collection:acme-research/*", "topic:billing"]
}
```

```json
{
  "scopes": {
    "type": "array",
    "minItems": 1,
    "maxItems": 50,
    "uniqueItems": true,
    "items": {
      "type": "string",
      "minLength": 1,
      "maxLength": 160,
      "pattern": "^(\\*|(repo|collection|topic):\\*|repo:[A-Za-z0-9]([A-Za-z0-9-]{0,38})/(\\*|[A-Za-z0-9_][A-Za-z0-9._-]{0,99})|collection:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/(\\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)|topic:[a-z][a-z0-9-]{0,63})$"
    }
  }
}
```

**Remembered decisions** are keyed `(type, sender's owner, scope)`, with `*` for every scope and `<kind>:*` for every scope of a kind. The exact scope wins over its kind's wildcard, which wins over `*`. A question's decisions are applied scope by scope as they are repository by repository today (protocol.md section 11, step 5). Sharing rules cover scopes the same way.

**Topics as scopes** need topics to be identifiers. The `topic:` pattern above follows the id pattern #54 uses for runtime ids (`^[a-z][a-z0-9-]{0,63}$`); it takes whatever the #53 addition gives topics. If #53 makes topics words (data), the `topic` scope kind needs an identifier of its own next to them.

## 9. The Code profile

What `obi/0.1` has for code collaboration, unchanged except as said:

- **`review_request`** and its `result` (`for: review_request`), with findings, `approve_on_host` and `host_review`, exactly as in `obi/0.1`. A review of something other than a commit (a document, a design) waits until a real use needs it, such as the Council deciding about documents. Then findings, located by a reference instead of a file and line, would move to Core, with `no_blocker_findings` and `no_findings_at_or_above`.
- **Findings** (`file`, `line`, `end_line`, severity, `title`, `detail`) and their condition kinds.
- **The references** `repo`, `pr`, `issue`, `job`, and the new `branch` and `commit` (section 7), and the `repo` scope kind.
- **Approving on the code host**, as `obi/0.1` has it after the owner-confirmation rule (#38), with the neutral marker `by agent:` ([identifiers.md, section 4](identifiers.md#4-the-code-host-marker-d3)) and the rule for organisation owners ([owners.md, section 5](owners.md#5-what-an-organisations-agent-may-do-d11)).
- **`handoff`** becomes a `work_request` on a `branch` subject (section 5, D5).

A member that lists `code` in its card's `profiles` may accept `review_request`, and may take `work_request`s whose subject is a Code reference.

## 10. The compute and share actions (D4)

`run_request`, `run_progress`, `run_return` and `run_cancel` run one member's job on another's machine, in a VM, through an end-to-end encrypted job channel that also carries the job's model calls; a runner status says who offers their machine. `share_offer`, `share_status` and `share_revoke` lend the use of a company-paid API account, metered by the key holder. Oby retired compute sharing on 2026-10-27, and no other implementation has them.

**Recommended: drop them from the next version**, rather than carry them as an optional profile.

1. **No standard ahead of use.** Nobody uses them now. A profile no implementation runs is text, schemas and fixtures that nobody tests against real use, and that every server keeps paying for (the job channel, the runner directory, their limits).
2. **They are the largest attack surface in the spec.** Running another person's code on one's machine; relaying a model API with credentials added on the way; metering money in cents against a budget; blurring when an owner is at their machine. Each needed careful rules (protocol.md sections 13 to 15), and each is a place for a mistake. A version meant to be the minimal Core for every agent shouldn't carry them.
3. **They are the part most tied to one product.** A Mac, two VM sizes, two named CLIs and their model API paths, US cents, one provider's way of paying for tokens. Making them neutral would be a redesign, not a rename.
4. **Lending a secret is the Exchange standard's work** ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)), which is planned with a more general design. When a real use needs running work elsewhere or lending an account, it can start from `obi/0.1`'s text, which stays as it is (version rule 2), and come back as a profile through the spec.
5. **Dropping is cheap to undo; keeping is not.** A later version can add a profile. Once a profile is in a version, removing it is another breaking change.

**If kept instead**, as an optional profile, "Compute": the actions and the job channel as in `obi/0.1`, with neutral identifiers (the channel's prefixes become `NAME/0.2 channel…`, its `obi` member `agent`, the bundle's `obi-base` branch `base`), and `agent`, the coding agent that runs a job, becomes `runtime`, an open runtime id from the registry ([runtimes.md](runtimes.md)), not the closed `claude`/`codex` enum.

**What goes with them.** The scopes `send:run_request` and `send:share_offer`; `decline`'s `share_used`; `result`'s `for: run_request`; the endpoints `/channels/{correlation_id}` and `/members/{agent}/runner`; protocol.md sections 13 to 15; and the conformance class *holder*, which has no action until Exchange gives it one.

## 11. Done when

#52 is done when an agent that never touches git can implement Core alone, pass its conformance class, and ask another member for a piece of work with conditions a machine can check, and the Code profile is one profile among others. In this Draft: Core alone is sections 2 to 8 without section 9; the work is a `work_request`; the conditions are `delivers` and `before`, which anyone can check, and `own_check`, which the receiver's machine checks.
