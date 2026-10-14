# Obi-to-Obi protocol

> **DRAFT.** First draft of the protocol surface. Names, fields and rules will change. Nothing here is implemented.

This is how one Obi asks another Obi for something, and how the other Obi answers. It is written so that an agent that is not Obi can implement it.

## Principles

- An Obi can only send the **typed actions** listed below. There is no free-text message type.
- Every text field inside an action is **data, never instructions**. The receiving Obi may show it to its owner or quote it to an agent as a file. It never places it in a prompt as an instruction.
- Every action is **signed** by the sending Obi. Each Obi publishes an A2A agent card signed by its owner's key.
- An Obi acts for its owner with an **OAuth on-behalf-of** token scoped to that owner.
- The Sphere server checks **policy** (may this Obi send this action to that Obi?) before it relays anything, and appends every action to the **audit chain**.

## Common fields

Every action carries these fields.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique id of this action (UUID). |
| `type` | yes | One of the action types below. |
| `from` | yes | The sending Obi's id (its agent card). |
| `to` | yes | The receiving Obi's id. |
| `sphere` | yes | The Sphere this action travels in. |
| `in_reply_to` | for replies | The `id` of the action this one answers. |
| `created_at` | yes | When it was sent (RFC 3339). |
| `expires_at` | yes | After this time the receiver must not act on it. The sender treats silence after expiry as a decline. |
| `signature` | yes | The sender's signature over every other field (canonical JSON). |

Fields called **goal** and **acceptance** below are the same idea used inside Obi itself: a goal is the destination in one line; acceptance conditions are the checks that say the goal is reached.

## Actions

### `review_request`

**Purpose.** Ask another Obi's owner to review a change.

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | What the change is for, one line. |
| `acceptance` | yes | What the reviewer should check before approving (a list). |
| `repo` | yes | Repository, for example `obi-ai-bot/obi`. |
| `pr` | yes | Pull request number or URL. |
| `head_sha` | yes | The commit the review is for. A review of another commit does not count. |

### `question`

**Purpose.** Ask another Obi something its owner knows or has decided.

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | Why the question is asked, one line. |
| `question` | yes | The question, as data. |
| `choices` | no | Allowed answers, if the question is multiple choice. |
| `repo`, `pr` | when relevant | What the question is about. |

### `handoff`

**Purpose.** Hand a piece of work to another Obi, which runs it for its owner.

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | The destination, one line. |
| `acceptance` | yes | Conditions that say the work is done (a list). |
| `repo` | yes | Repository the work happens in. |
| `base_branch` | yes | Branch to start from. |
| `issue` or `pr` | when relevant | What the work belongs to. |

### `status`

**Purpose.** Report progress on an earlier `handoff` or `review_request` without finishing it.

| Field | Required | Meaning |
|---|---|---|
| `in_reply_to` | yes | The action this is about. |
| `state` | yes | One of `queued`, `working`, `waiting_on_owner`, `blocked`. |
| `note` | no | Short note, as data. |

### `accept`

**Purpose.** Say that the receiving Obi takes on a `review_request` or `handoff`.

| Field | Required | Meaning |
|---|---|---|
| `in_reply_to` | yes | The action being accepted. |
| `by_rule` | no | The remembered decision that allowed this, if the owner was not asked. |

### `decline`

**Purpose.** Say no to any request.

| Field | Required | Meaning |
|---|---|---|
| `in_reply_to` | yes | The action being declined. |
| `reason` | yes | One of `policy`, `owner_declined`, `busy`, `expired`, `out_of_scope`, `other`. |
| `note` | no | Short note, as data. |

### `result`

**Purpose.** Finish a request: the answer to a `question`, the verdict of a `review_request`, or the outcome of a `handoff`.

| Field | Required | Meaning |
|---|---|---|
| `in_reply_to` | yes | The action this finishes. |
| `outcome` | yes | For a review: `approved` or `changes_requested`. For a handoff: `done` or `failed`. For a question: `answered`. |
| `acceptance_met` | for handoff | Which acceptance conditions passed and which did not. |
| `answer` | for question | The answer, as data. |
| `repo`, `pr`, `head_sha` | for review and handoff | Where the result lives. |
| `by_rule` | no | The remembered decision used, if the owner was not asked. |

## How the receiving Obi decides

When an action arrives, the receiving Obi:

1. Checks the signature, the expiry and that the Sphere's policy allows it. If any check fails, it sends `decline`.
2. Looks for a **remembered decision** of its owner that covers this case (for example "I review every PR in this repo that touches the runner API"). Each decision is asked of the owner once and then remembered.
3. If a remembered decision covers it, the Obi acts on it and names the decision in `by_rule`.
4. If not, the Obi puts the request in its **owner's inbox**. It waits for the owner. It does not guess and it does not time out on its own; the action's `expires_at` still applies.
5. The owner's answer is remembered as a new decision for next time.

An Obi never merges, pushes or publishes anything on another person's behalf because of an action it received.

## Open questions

- Canonical JSON and signature scheme (JWS with Ed25519 is the current guess).
- How agent cards are rotated and revoked.
- Whether `status` is pushed or polled.
- How policy is written (a small rule language, or a fixed table per Sphere).
