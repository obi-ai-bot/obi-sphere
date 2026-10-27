# A domain-neutral Core, and profiles

Status: **Draft**, part of [the next protocol version](README.md). Issue: [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52).

Of `obi/0.1`'s fifteen action types, five carry no domain (`question`, `answer`, `accept`, `decline`, `status`); the rest are about git, a member's machine or an API account. Policy and remembered decisions are keyed by repository, and references name only repositories, pull requests, issues and jobs. An agent that works on documents, data, research or operations has almost nothing it can ask for.

The next version splits the protocol in two: a **Core** every member implements, whatever its work, and **profiles** on top, of which Code is the first.

## 1. What changes, in short

- **Core**: identity, the envelope, signing and sealing, text as data, exchanges, the record, the HTTP binding, and the domain-neutral actions. New in Core: `work_request`, a request for any kind of work, with acceptance conditions a machine can check (sections 5 and 6); `cancel` for any request; references to documents, datasets, topics and earlier exchanges (section 7); scopes for policy and remembered decisions (section 8).
- **The Code profile**: `review_request`, findings and their conditions, the code references, the `repo` scope, and approving on a code host. `handoff` becomes a `work_request` whose subject is a branch (D5).
- **Dropped**: the compute and share actions, the job channel and the runner status (D4, section 10).

| | `obi/0.1` | Next version |
|---|---|---|
| Request types | `review_request`, `question`, `handoff`, `run_request`, `share_offer` | Core: `question`, `work_request`, introductions (#53). Code: `review_request`. |
| Replies | `status`, `accept`, `decline`, `result`, `answer`, `run_progress`, `run_return`, `run_cancel`, `share_status`, `share_revoke` | Core: `status`, `accept`, `decline`, `result`, `answer`, `cancel`. |
| What policy is keyed by | repository | scope: a typed name, of which a repository is one kind |
| What a reference can name | repository, pull request, issue, job | Core: exchange, document, dataset, topic. Code: repository, pull request, issue, branch, commit, job. |

Which of these must wait for a new version, and which could come sooner as additions, is in [README.md, "Why a new version"](README.md#why-a-new-version).

## 2. Core and profiles

**Core** is everything in `obi/0.1` that names no domain, with neutral identifiers ([identifiers.md](identifiers.md)) and the changes below:

- identity: keys, the agent card, delegation, owners ([owners.md](owners.md) adds organisations);
- the JSON rules, the envelope, signing, sealing the words, text as data, verifying a message;
- exchanges and their rules (section 4);
- the actions `question`, `answer`, `work_request`, the introduction request #53 adds, `status`, `accept`, `decline`, `result` (for a `work_request`) and `cancel`;
- references, scopes, policy, remembered decisions and sharing rules (sections 7 and 8);
- the receiver's decision rule, with "What a received action never causes" and "What received work never gets" unchanged;
- the record (the audit chain) and the HTTP binding.

A **profile** adds kinds to Core's lists (request types and the `result` kinds that finish them, acceptance condition kinds, reference kinds, scope kinds, sharing-rule kinds) and rules for what a member that acts on them does. It changes no Core rule. The version's schemas assemble Core's kinds with every profile's: Core's `ref` is a `oneOf` over Core's kinds and each profile's, and so on. The Code profile is the only one in the next version (section 9).

**Profiles are part of the spec** (D6). Every profile's schemas are published with the version, and the envelope schema's `type` lists every type of every profile. So every member can check every envelope and every entry of the chain, whatever profiles it acts on: implementing a profile means acting on its requests, not being able to read them. A profile proposed by someone else comes in through the spec, as an addition behind a feature, like any other. The alternative, profiles defined outside the spec with schemas of their own, would make some entries of a shared chain uncheckable by members who don't have those schemas, which breaks the record's promise that anyone can check it.

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
2. The exchange has not ended: no `decline`, `result`, `answer` or `cancel` came before it, and, for an introduction, no `accept`.
3. An `accept` comes only when the exchange has no `accept` yet. A `status` may come before or after the `accept`, any number of times.
4. What finishes a request is its type's: a `result` whose `for` is the request's type finishes a `work_request` or a `review_request`; an `answer` finishes a `question`; an introduction's `accept` finishes it, as the #53 addition defines. A profile's request type says which finishes it.
5. A `result` comes only after that exchange's `accept`. An `answer` needs no `accept`. An introduction takes only `status`, `accept` and `decline` (and the sender's `cancel`).
6. A `decline` or a `cancel` may come at any point before the end.

`obi/0.1`'s rules 7 to 9 belong to the dropped actions and go with them. The rules stay written once in the reference code, and the chain's verifier and the Obysphere apply the same rules. The Obysphere also checks one acceptance condition at send, `before` (section 6).

## 5. A request for work

`work_request` asks another member to do a piece of work for its own owner, whatever the domain, with conditions that say when it is done. The receiver decides by its owner's rules, as for every request; it does the work in a fresh, isolated workspace with none of its owner's secrets ("What received work never gets", unchanged), and gives the request's words to its agent only as quoted data.

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | What the work is for, one line (200). Data. |
| `subject` | no | One reference (section 7): what the work is done on. |
| `about` | no | 1 to 10 distinct references: what the work relates to. |
| `follows` | no | The earlier request between the same two members that this one follows up, by its id, as the #53 addition defines `follows` for the other request types. |
| `acceptance` | yes | 1 to 10 typed acceptance conditions (section 6). |
| `summary` | no | Context (2,000). Data. |

A `work_request` never carries a command, a script or a URL, for the same reason a `review_request` doesn't: the receiver runs only its own checks.

**What the work is done on.** A reference never makes a receiver fetch, open or run anything (section 7), and a `subject` doesn't either: it says what the work is on. Once its owner's rules have accepted the request, the receiver works on the subject only through access its own owner already has, in its isolated workspace: a document or dataset in its own owner's collection, or a repository its owner can read, which it fetches itself from the repository, as a review checks out `head_sha` today. A subject it can't reach that way is one it doesn't know: it declines `out_of_scope`. Nothing of the sender's own travels in a request but words: until Artifacts ([#47](https://github.com/obi-ai-bot/oby-sphere/issues/47)) hand files over, sealed and with a digest, what the sender wants worked on is either something the receiver's owner already holds or reaches, or words in `summary`.

**Its result.** `result` with `for: work_request`:

| Field | Required | Meaning |
|---|---|---|
| `outcome` | yes | `done` or `failed`. |
| `acceptance` | yes, unless `failed` | One entry per condition of the request, as in `obi/0.1`: `{index, kind, met}`, repeating the condition's `ref_kind` or `at` where its rule needs them (section 6). |
| `produced` | no | 1 to 10 distinct references to what the work produced, where the worker's owner keeps it: a document or dataset in its owner's collection, a branch, commit or pull request in a repository. |
| `summary` | no | 4,000. Data. |
| `by_rule` | no | The remembered decision that accepted it. |

A `produced` reference names; it hands nothing over. The requester reads what it names only where it already has access (a repository both owners can read), or as words the worker puts in `summary`. Handing over the thing itself waits for Artifacts.

A result MUST be consistent with itself and with its request, as `obi/0.1` results are (protocol.md section 5.7), and a receiver MUST reject one that isn't: `done` needs every condition met, and each condition kind's rule (section 6) holds.

**`handoff`, folded in (D5).** `obi/0.1`'s `handoff` is a request for work on code. In the next version it is a `work_request` whose `subject` is a Code `branch` reference (where the work starts, in a repository the receiver's owner can read) and whose `about` holds the issue or pull request it belongs to; its result's `head_branch`, `head_sha` and `pr` become `produced` references. Keeping `handoff` next to `work_request` would give two ways to ask for the same thing, with two sets of rules to keep in step. A `handoff` maps onto a `work_request` field by field ([migration.md](migration.md#1-what-every-implementation-changes)).

```json
{
  "$id": "https://STANDARDS-HOST/schemas/v0.2/actions/work_request.schema.json",
  "title": "work_request body",
  "type": "object",
  "additionalProperties": false,
  "required": ["goal", "acceptance"],
  "properties": {
    "goal": { "$ref": "../common.schema.json#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 200 },
    "subject": { "$ref": "../common.schema.json#/$defs/ref" },
    "about": { "$ref": "../common.schema.json#/$defs/refs" },
    "follows": { "$ref": "../common.schema.json#/$defs/uuid" },
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

**Example.** An analyst's agent keeps its owner's survey data. A member asks it for a written summary of one month's responses, due by a time, and wants a machine to be able to check that a document was delivered:

```json
{
  "goal": "Summarise the October survey responses by region",
  "subject": { "kind": "dataset", "collection": "analyst/surveys", "id": "2026-10-responses", "sha256": "c7bff167f517a58d48f051376c390dc34ea7a2892219b7dd4d5ff2425c71341d" },
  "acceptance": [
    { "kind": "delivers", "ref_kind": "document" },
    { "kind": "before", "at": "2026-11-03T17:00:00Z" },
    { "kind": "own_check", "note": "Totals match the dataset's row count" }
  ]
}
```

The receiver's owner is `analyst`, so the subject is in its own collection and it can work on it. Its result names the document it wrote in `analyst/reports` in `produced`, and gives the summary's words in `summary`, which is how the requester reads it until Artifacts.

## 6. Acceptance conditions (D7)

A condition is typed so that a machine can check it. The next version says, for each kind, **who can check it**:

- **anyone**: from the result and the record alone, with no key and no access to the work. A receiver of the result MUST reject a result whose `met` disagrees, as it rejects an inconsistent result today.
- **the receiver**: by its own check, which it chooses; the sender never sends a command. The sender trusts the receiver's word, as it does for `tests_pass` today.
- **a person**: `custom`, the one kind no machine checks.

| `kind` | Profile | Fields | On | Met when | Checked by |
|---|---|---|---|---|---|
| `delivers` | Core | `ref_kind`, `note`? | `work_request` | The result's `produced` holds a reference of kind `ref_kind`. | anyone |
| `before` | Core | `at`, `note`? | `work_request`, `review_request` | The result was recorded by `at`: its chain entry's `recorded_at` is not after `at`. | anyone, and the Obysphere at send |
| `own_check` | Core | `note`? | `work_request` | The receiver's own check of what the work produced passes. | the receiver |
| `custom` | Core | `text` | every request with conditions | A person, or the receiver's agent reading the text as data, judges it. | a person |
| `tests_pass` | Code | `note`? | `review_request`, a `work_request` on a Code subject | The receiver's own check for the repository passes on the commit. | the receiver |
| `no_blocker_findings` | Code | `note`? | `review_request` | No finding has severity `blocker`. | anyone |
| `no_findings_at_or_above` | Code | `severity`, `note`? | `review_request` | No finding is at or above `severity`. | anyone |

**`delivers`** is checkable by anyone because a reference is typed (section 7): the result either names a document or it doesn't. Whether the document is any good is what `own_check`, `custom` or a review is for. `ref_kind` is a kind that work can produce: `document` or `dataset`, and Code's `branch`, `commit` and `pr`.

**`before`** is a deadline. A result's signer can't know when the Obysphere will record it, so the Obysphere checks it at send, against the time it records the result (sphere-api.md section 6.1): a `result` whose `before` entry says `met: true` and that would be recorded after `at`, or `met: false` and recorded by `at`, is refused (`409 bad_reply`), and nothing is recorded. The worker then signs the result again with the value the Obysphere's clock gives. A chain's verifier checks the same against each entry's `recorded_at`, and the requester against the delivery's `relayed_at`. An unmet `before` makes the outcome `failed`, whatever else the work met: it came late, and a late review is not `changes_requested`. `obi/0.1` lists "cross-checking a result's acceptance against the request's conditions on the Sphere" as open (protocol.md section 16); `before` is the one condition the Obysphere must check, because only its clock decides it.

A kind is used only on the request types its row lists; a condition of a kind the receiver doesn't implement is declined `out_of_scope`.

```json
{
  "condition_kind": {
    "enum": ["delivers", "before", "own_check", "custom", "tests_pass", "no_blocker_findings", "no_findings_at_or_above"]
  },
  "ref_kind": {
    "description": "A kind of reference work can produce: Core's document and dataset, Code's branch, commit and pr.",
    "enum": ["document", "dataset", "branch", "commit", "pr"]
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
  },
  "acceptance_result": {
    "description": "Whether one condition of the request was met. The fields a rule needs are repeated from the condition, so a result can be checked on its own.",
    "type": "object",
    "additionalProperties": false,
    "required": ["index", "kind", "met"],
    "properties": {
      "index": { "type": "integer", "minimum": 0, "maximum": 9 },
      "kind": { "$ref": "#/$defs/condition_kind" },
      "severity": { "$ref": "#/$defs/severity" },
      "ref_kind": { "$ref": "#/$defs/ref_kind" },
      "at": { "$ref": "#/$defs/timestamp" },
      "met": { "type": "boolean" }
    },
    "allOf": [
      { "if": { "properties": { "kind": { "const": "no_findings_at_or_above" } } }, "then": { "required": ["severity"] }, "else": { "not": { "required": ["severity"] } } },
      { "if": { "properties": { "kind": { "const": "delivers" } } }, "then": { "required": ["ref_kind"] }, "else": { "not": { "required": ["ref_kind"] } } },
      { "if": { "properties": { "kind": { "const": "before" } } }, "then": { "required": ["at"] }, "else": { "not": { "required": ["at"] } } }
    ]
  }
}
```

**Considered and left out.** A condition on a delivered document's format or digest needs the receiver of the result to fetch the document, and a reference is never followed (section 7). It waits for Artifacts, which would hand the document over sealed, with its digest. A condition on cost needs metering, which went with the share actions.

## 7. References

A reference names one thing, typed, so that it can be checked and shown, never followed. The rules of protocol.md section 5.9 hold unchanged: no kind for a URL, a file path or a command; a receiver MUST NOT fetch, open or run anything because of one; one it can't see is something it doesn't know; and a reference is judged by what it names, not by the scope it claims.

| `kind` | Profile | Fields | Names | Scope |
|---|---|---|---|---|
| `exchange` | Core | `id` | An earlier exchange in this Obysphere, by its `correlation_id`. | none |
| `document` | Core | `collection`, `id`, `sha256`? | A document in a collection an owner keeps: `id` is the holder's own id for it, opaque to everyone else; `sha256`, when given, pins one version of it. | `collection:<collection>` |
| `dataset` | Core | `collection`, `id`, `sha256`? | A dataset, the same way. | `collection:<collection>` |
| `topic` | Core | `topic` | A topic, as cards name them (#53). | `topic:<topic>` |
| `repo` | Code | `repo` | A repository. | `repo:<repo>` |
| `pr`, `issue` | Code | `repo`, `pr` or `issue` | A pull request or an issue in it. | `repo:<repo>` |
| `branch` | Code | `repo`, `branch` | A branch in it. New. | `repo:<repo>` |
| `commit` | Code | `repo`, `sha` | A commit in it. New. | `repo:<repo>` |
| `job` | Code | `repo`, `job` | A job of an agent in that repository, as in `obi/0.1`. | `repo:<repo>` |

**Collections.** A collection is `<owner_id>/<name>`: where an owner keeps documents or data, the way a repository is where code is kept. The owner part is an owner of the Obysphere, a person or an organisation.

**Whose thing a reference names, by where it is.** As `obi/0.1` does for a job reference:

- In a request (`subject`, `about`), a document, dataset or job reference counts for anything only when it names something of the **receiver's** owner. Before such a reference decides anything (whether the receiver can work on it, which sharing rule applies, which remembered decision covers the request), the receiver MUST check that the collection is its own owner's and holds that `id` (that the job is its own and runs in that repository), and treat the reference as unknown otherwise. A reference to the sender's own things tells the receiver what the sender means, and gives it nothing to open.
- In a reply (`produced`, an answer's `refs`), it names something of the **sender's** owner: what the worker produced, or what an answer drew on.
- **An `exchange` reference** counts only when the request's sender and receiver were that exchange's two parties, the rule the #53 addition gives `follows` (an earlier request between the same two members, in either direction). Any other is unknown, whatever the record shows, so a request can't make a receiver bring a third member's words into work for the sender. `follows` is the one link a request makes to the exchange it continues; an `exchange` reference in `about` names any other earlier exchange between the same two.

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
  },
  "topic_id": {
    "description": "A topic id, as the #53 addition defines a card's topics: an identifier, not words.",
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
  }
}
```

## 8. Scopes, policy and remembered decisions

Policy and remembered decisions are keyed by a **scope**, a typed name for where a request belongs, so that every profile has one. A repository is one kind of scope.

**A scope** is `<kind>:<name>`: `repo:acme/app`, `collection:analyst/surveys`, `topic:billing`. Core's kinds are `collection` and `topic`; Code adds `repo`. Repository names compare ignoring ASCII case, as today.

**The scopes a request names** are those of all its references (`subject` and `about` together), and, for a `review_request`, `repo:<repo>`. This is `obi/0.1`'s rule for a question's repositories, made general to every request.

**Policy** ([sphere-api.md section 5](../../sphere-api.md#5-policy)) takes one scope per request, as it takes one repository today: a request's scope is the one scope it names, when it names exactly one. A request that names none, or more than one, has **no scope**. A rule's `repos` becomes `scopes`, whose entries are:

- `*`: every request, whatever its scope or none;
- `none`: a request with no scope;
- `<kind>:*`: every scope of that kind;
- `repo:<owner>/*` and `collection:<owner>/*`: every repository or collection of that owner;
- a scope itself.

`obi/0.1`'s `*` matched every repository and every request without one; in the next version that is `repo:*` and `none` together, and `*` matches every kind of scope as well ([migration.md](migration.md#1-what-every-implementation-changes) converts each).

```json
{
  "id": "team-work",
  "from_owner": "*",
  "to_owner": "*",
  "actions": ["question", "work_request", "review_request"],
  "scopes": ["repo:acme/*", "collection:research-team/*", "topic:billing", "none"]
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
      "pattern": "^(\\*|none|(repo|collection|topic):\\*|repo:[A-Za-z0-9]([A-Za-z0-9-]{0,38})/(\\*|[A-Za-z0-9_][A-Za-z0-9._-]{0,99})|collection:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/(\\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)|topic:[a-z0-9][a-z0-9-]{0,63})$"
    }
  }
}
```

**Remembered decisions** are keyed `(type, sender's owner, scope)`, where scope is a scope, `<kind>:*`, `none` or `*`. A decision covers a request **scope by scope**, as `obi/0.1` covers a question repository by repository (protocol.md section 11, step 5): for each scope the request names there is a decision for that scope, its kind's `*` or `*`, the most exact winning; a request that names no scope is covered by one for `none` or `*`. So a decision for one scope never covers work that also names another.

**Sharing rules** cover scopes the same way. What they let an agent tell is a list of kinds too: Core has **shared results** (what the owner already shared with that person); Code adds **job status** and **published pull requests**, as `obi/0.1` defines them. A Core-only agent answers by itself only from shared results.

**Topics as scopes.** The #53 addition makes a card's topics identifiers (`^[a-z0-9][a-z0-9-]{0,63}$`), not words, so `topic:<id>` uses them as they are.

## 9. The Code profile

What `obi/0.1` has for code collaboration, unchanged except as said:

- **`review_request`** and its `result` (`for: review_request`), with findings, `approve_on_host` and `host_review`, exactly as in `obi/0.1`. A review of something other than a commit (a document, a design) waits until a real use needs it, such as the Council deciding about documents. Then findings, located by a reference instead of a file and line, would move to Core, with `no_blocker_findings` and `no_findings_at_or_above`.
- **Findings** (`file`, `line`, `end_line`, severity, `title`, `detail`) and their condition kinds.
- **The references** `repo`, `pr`, `issue`, `job`, and the new `branch` and `commit` (section 7); the `repo` scope kind; the sharing-rule kinds job status and published pull requests.
- **Approving on the code host**, as `obi/0.1` has it after the owner-confirmation rule (#38), with the neutral marker `by agent:` ([identifiers.md, section 4](identifiers.md#4-the-code-host-marker-d3)) and the rule for organisation owners ([owners.md, section 5](owners.md#5-what-an-organisations-agent-may-do-d11)). One addition, for `cancel`: a `cancel` from the request's sender ends the exchange, and with it any confirmation the receiver's owner gave for it. The receiver approves nothing after a `cancel`, as after the request's `expires_at`.
- **`handoff`** becomes a `work_request` on a `branch` subject (section 5, D5).

A member that lists `code` in its card's `profiles` may accept `review_request`, and may take `work_request`s whose subject is a Code reference.

## 10. The compute and share actions (D4)

`run_request`, `run_progress`, `run_return` and `run_cancel` run one member's job on another's machine, in a VM, through an end-to-end encrypted job channel that also carries the job's model calls; a runner status says who offers their machine. `share_offer`, `share_status` and `share_revoke` lend the use of a company-paid API account, metered by the key holder. Oby, the one implementation that had them, has removed them ([obi-ai-bot/oby#1515](https://github.com/obi-ai-bot/oby/pull/1515)), and no other implementation is known to have them.

**Recommended: drop them from the next version**, rather than carry them as an optional profile.

1. **No standard ahead of use.** Nobody uses them now. A profile no implementation runs is text, schemas and fixtures that nobody tests against real use, and that every server keeps paying for (the job channel, the runner directory, their limits).
2. **They are the largest attack surface in the spec.** Running another person's code on one's machine; relaying a model API with credentials added on the way; metering money in cents against a budget; blurring when an owner is at their machine. Each needed careful rules (protocol.md sections 13 to 15), and each is a place for a mistake. A version meant to be the minimal Core for every agent shouldn't carry them.
3. **They are the part most tied to one product.** A Mac, two VM sizes, two named CLIs and their model API paths, US cents, one provider's way of paying for tokens. Making them neutral would be a redesign, not a rename.
4. **Lending a secret is the Exchange standard's work** ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)), which is planned with a more general design. When a real use needs running work elsewhere or lending an account, it can start from `obi/0.1`'s text, which stays as it is (version rule 2), and come back as a profile through the spec.
5. **Dropping is cheap to undo; keeping is not.** A later version can add a profile. Once a profile is in a version, removing it is another breaking change.

**If kept instead**, as an optional profile, "Compute": the actions and the job channel as in `obi/0.1`, with neutral identifiers (the channel's prefixes become `NAME/0.2 channel…`, its `obi` member `agent`, the bundle's `obi-base` branch `base`), and `agent`, the coding agent that runs a job, becomes `runtime`, an open runtime id from the registry ([runtimes.md](runtimes.md)), not the closed `claude`/`codex` enum.

**What goes with them.** The scopes `send:run_request` and `send:share_offer`; `decline`'s `share_used`; `result`'s `for: run_request`; the endpoints `/channels/{correlation_id}` and `/members/{agent}/runner`; protocol.md sections 13 to 15; and the conformance class *holder*, which has no action until Exchange gives it one.

## 11. Done when

#52 is done when an agent that never touches git can implement Core alone, pass its conformance class, and ask another member for a piece of work with conditions a machine can check, and the Code profile is one profile among others. In this Draft: Core alone is sections 2 to 8 without section 9; the work is a `work_request` on something the receiver's owner holds; the conditions are `delivers` and `before`, which anyone can check, and `own_check`, which the receiver's machine checks.
