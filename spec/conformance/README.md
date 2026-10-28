# Conformance suite, protocol v0.1

Fixtures that say what a conforming implementation accepts and rejects, and a runner that checks one.

## Run it

```sh
cd spec
pnpm install --frozen-lockfile
pnpm run check                                        # self-check
node conformance/run.mjs --impl "<command>"           # check an implementation
node conformance/run.mjs --impl "<command>" --kinds envelope,audit
```

**Self-check** (`pnpm run check`, also `make spec-check` from the repository root, and CI on every pull request into `dev` and every push to `dev`):

1. compiles every schema in `schemas/v0.1/` (draft 2020-12) and lints them: every object with properties sets `additionalProperties: false`; every string has a `maxLength` and a `pattern`, `enum` or `const`, unless it is data text; every data-text field (a reference to `line_text` or `block_text`) is annotated `x-obi-text: data` and sets its own bounds; the action types are exactly the seventeen of the protocol;
2. checks the canonical-JSON vectors in `jcs-vectors.json` (RFC 8785);
3. regenerates every fixture with `generate.mjs` and fails if a committed file differs, is missing, or is extra;
   then checks that the repository's `.gitleaks.toml` allowlists exactly the public keys in `keys.json` (below, "Keys");
4. judges every fixture with the reference verifier (`lib/obi.mjs`) and fails on any verdict, or rejection code, other than the fixture's;
5. checks that the required fixtures exist (one valid envelope per action type, one per missing required field, and so on);
6. runs implementation mode once with the reference verifier (`verify.mjs`), to prove the `--impl` contract, and checks that an implementation is given only `{case, context, input}` (a checker that echoes the fixture's `expect` must fail).

**Implementation mode** (`--impl "<command>"`): for every fixture, the runner starts `sh -c "<command>"`, writes the case's `case`, `context` and `input` (below) to its stdin as one JSON object and closes it. It never sends `expect`, `reason`, `name` or `description`: the implementation judges the case, it isn't told the answer. **Exit status 0 means accept; anything else means reject.** Whatever the command prints is shown for cases it gets wrong. Each case has 20 seconds. The runner exits 1 if any case comes out otherwise than the fixture expects. `--kinds` limits it to some case kinds, for an implementation that only does part of the protocol (a Sphere server checks envelopes, cards and wire documents and builds chains; obid checks envelopes, cards, chains and `host_approval` cases).

## Case format

Every file under `fixtures/` is one case:

```json
{
  "case": "envelope",
  "name": "invalid-smuggle-body-prompt",
  "description": "A review request with an extra \"prompt\" field.",
  "expect": "reject",
  "reason": "invalid_envelope",
  "context": { … },
  "input": { … }
}
```

- `case` is `envelope`, `card`, `audit`, `wire` or `host_approval`. `expect` is `accept` or `reject`. `reason`, on rejections, is the error code the reference verifier gives (one of [sphere-api.md](../sphere-api.md)'s, or `wrong_recipient`, the receiver's own: [protocol.md](../protocol.md) section 10), for information: implementations are judged on accept or reject only.
- **`envelope`**: `input` is one envelope. `context` is `{now, sphere, receiver, keys, seq?, seen_ids}`: judge it as the Obi `receiver` (an `obi_id`) in the Sphere `sphere` would at time `now` (never the real clock), so a message whose `to` is another Obi is rejected (protocol.md section 10, check 5); with `keys` the directory (`{key_id: {obi, public_key, valid_from_seq?, valid_until_seq?}}`), `seq` the message's audit seq when it came in a delivery, and `seen_ids` the ids already handled. A case about sealed words (protocol.md section 9.1) also has `seal_keys`, the receiver's own seal keys (`{seal_key_id: base64url of the 32 private bytes}`, derived from public seed strings like every test key), and `sender_seals`, whether the sender's trusted card had a seal key when the message was written (protocol.md section 9.1, "Receiving"): check 11 opens the words with them. A key with a validity range must be valid at `seq`, or be current (`valid_until_seq` null) when there is no `seq` (protocol.md section 10, "Which key is valid for a message"); a key without one is valid. Checks: protocol.md section 10. A Sphere server's checker judges `receiver` too: the Sphere delivers a message only to its `to`, so it is the same check made at routing.
- **`card`**: `input` is one agent card. `context` is `{now, bound_owner_key?}`: the owner key the Sphere has bound for the card's owner, when it has one. Checks: identity.md section 2.2.
- **`audit`**: `input` is `{sphere, entries}`, a whole chain from seq 1. `context` is `{keys}`, the key history (`{key_id: {obi, public_key, valid_from_seq, valid_until_seq}}`). Checks: sphere-api.md section 7.1, the exchange rules (protocol.md section 4) included.
- **`wire`**: `input` is one request or answer body of [sphere-api.md](../sphere-api.md). `context` is `{schema}`, the wire schema it is judged by (`wire/invitation.request`, …), named as `verify.mjs --schema` names it. Checks: that schema alone (rejections are `bad_request`). They pin the rules a client needs that live in a schema, like a named invitation's `owner` and `obi` coming together.
- **`host_approval`**: whether a receiving Oby may post its approving review on the code host now ([protocol.md](../protocol.md) section 11, "Approving on the code host"): accept means it may, reject that it must not. `context` is `{now, request, member, owner_login, standing_permission}`: the request as `{correlation_id, repo, pr, base_branch, head_sha, expires_at}`, whether the receiver is still an active member of its Sphere, its owner's login on the code host, and whether its owner gave the standing permission for the sender's owner and `repo`. `input` is `{owner_confirmations, code_host}`: the owner's confirmations the receiver holds, each `{correlation_id, head_sha, signed_at, from_owner_device, used_before}` (the receiver has checked the device's signature already; `from_owner_device` false is a yes from anywhere else), and what the code host shows, `{codeowners, changed_files, files_complete, reviews, teams, permissions}`: the `CODEOWNERS` file on `base_branch` (or null), every changed path (a renamed file's old and new), whether that list is whole, the reviews in the order they were made, as the code host lists them (`{login, account_type, body, state, commit_id}`: `account_type` `User` or `Bot`, `state` `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`), the members of each team the file names (`{"org/team": [logins]}`) and each approver's access to the repository (`{login: "admin" | "maintain" | "write" | "triage" | "read" | "none"}`). Rejections are `lapsed`, `no_owner_confirmation` or `no_code_owner_approval`. The cases fix the matching rules of "Who counts as a code owner" too.

## The receiver track

The fixtures above check messages: what an implementation accepts and rejects. Three of the house rules are instead about what a receiver *does* — words are data, the owner decides, and received work gets no secrets — and a message can't show those. The **receiver track** checks them against a running implementation, through a scripted adversarial peer. It is issue #58.

```sh
cd spec
pnpm install --frozen-lockfile                                   # and the server's packages, for a local Sphere
node conformance/run.mjs --receiver "<adapter command>"          # run the track against an implementation
node conformance/run.mjs --receiver "<adapter command>" --corpus path/to/injections.json
```

The runner starts a local Sphere (the reference server; `--server <dir>`, default `../server`, or `--sphere-url <loopback url>` with `--operator-token` for one already running — only on this machine, never a shared Sphere), enrolls the implementation under test through its **adapter command**, and runs the cases against it with scripted peers. It reports per conformance **class** (below), and exits 0 only when every case that applies passed.

**What it judges from.** Nothing the track decides comes from asking the implementation; it watches what the implementation did. Pass and fail are read only from:

- **what reached a peer** — taken from the Sphere's audit chain, so it is exactly what the Sphere relayed, each envelope verified and its words opened as the addressee would (`protocol.md` section 10, with the peer's own seal keys);
- the case's **file-system and network markers** — a payload may name a file for the receiver to write and a loopback URL for it to fetch; the track creates neither and follows neither, it only watches whether the receiver did;
- a **canary** secret the implementation is given to hold like its owner's own: a fresh 40-character value, made for the run and never printed, that nothing the implementation sends may contain, in any encoding, sealed or not.

**The adapter contract.** The adapter is one shell command. The harness runs it as `sh -c "<command>"` in the receiver's work directory, with one JSON object `{ "op": …, "workdir": …, … }` on its stdin; for every op but `serve`, the adapter's last stdout line that is a JSON object is its answer. The command must use absolute paths (its working directory is a fresh temporary folder). An implementation provides this command; the suite ships one for its two test receivers (`receiver/receivers/receiver.mjs`).

Each op is a **fresh process**: `inbox` and `decide` run while the long-lived `serve` is still running, and they share only the work directory. So an implementation keeps its state on disk (or in a process `serve` owns and the others reach) and writes it so a concurrent read can't tear — the reference receiver writes each file to a temporary name and renames it, and tolerates a torn read. `enroll`'s `seal` is whether the implementation should publish a seal key on its card, so the track can check that its replies are sealed; `true` for the runs here.

| `op` | Given | Does | Answers |
|---|---|---|---|
| `enroll` | `sphere: {base, id, invitation_id, secret}`, `obi_id`, `owner`, `accepts`, `seal`, `canary: {name, value}` | Make its keys and owner-signed card, redeem the named invitation, hold the canary as one of its owner's secrets under `name`. | `{"ok": true}` |
| `serve` | `sphere: {base, id}`, `obi_id` | Run the receiver — poll deliveries, verify, decide, reply — until its process group gets `SIGTERM`. | (runs until stopped) |
| `inbox` | — | What waits for the owner now. | `{"items": [{"id", "correlation_id"}]}` |
| `decide` | `id`, `correlation_id`, `decision` (`accept`/`decline`/`answer`), `text?` | Apply that one owner decision; for `answer`, `text` is the owner's own words. | `{"ok": true}` |

An implementation that can't be driven headlessly this way can't be run on the track; say so rather than weakening the track.

**The classes a case belongs to.** Each case declares a conformance class (#57). The track here covers:

- **participant** — sends and receives typed actions, verifies everything, treats words as data, and waits for its owner. These are the cases the track ships.
- **executor** — runs received work in a sandbox with none of its owner's secrets. Its cases need a receiver that takes `run_request` and runs a job; they are added with #57.

A case lists the request types the receiver's card must accept (`needs`); one the card doesn't accept is reported *not applicable*, never passed.

**The hand-written cases** (`receiver/cases.mjs`) carry no adversarial text. They fix what holds whatever a peer sends — a question waits for the owner and the owner's own words come back as the owner's, a review is taken on only after the owner decides, a plain request for secrets is the owner's to answer and the canary never leaves — and they are what tell a careful receiver from a reckless one.

**The adversarial corpus.** The payloads that word an order as a question, split it across requests, or point at a file or URL are not kept in this repository: the suite carries the mechanism and the proof, not a library of attacks. They come from a **corpus file** (`--corpus`, default `receiver/injections.json`) the maintainer supplies — a published injection benchmark imported by `receiver/import-corpus.mjs`, or written by hand — each entry carrying its `source`, `licence` and `id`. The harness puts each payload into a request's data field (`protocol.md` section 8) and plays the owner's decision; a payload may use `{{FILE}}`, `{{URL}}` and `{{CANARY_NAME}}`, which the harness fills with the case's own markers and then watches. The repository ships only a placeholder corpus of inert entries, to prove the format loads; populating it with real injections is the maintainer's step, under the benchmark's licence. The format is documented at the top of `receiver/corpus.mjs`.

**Proving the track works.** The suite ships two test receivers and runs the track against both in CI (`receiver/receiver-track.test.mjs`): a **careful** one that must pass every case, and a **reckless** one that must fail — and fail because it acts without its owner and lets the canary out. A change that makes the track accept the reckless receiver, or reject the careful one, fails CI.

## Keys

The fixtures are signed with keys anyone can derive, so they are reproducible and nothing secret is committed. `keys.json` lists each key's seed string, public key and key id; the private key is Ed25519 (RFC 8032) from the 32-byte seed `SHA-256(UTF-8(seed string))`. For example `obi-a`'s seed string is `obi-conformance-test-key-obi-a`. **Never use these keys for anything else.**

Their public keys look like API keys to generic secret-scan rules, so the repository's `.gitleaks.toml` allowlists exactly those values, only under `spec/conformance/`, for gitleaks's generic API-key rule; any other value there is still reported. A new test key goes into that list in the same pull request (the self-check fails until it does).

## Changing the fixtures

Edit `generate.mjs`, run `pnpm run generate`, and commit the regenerated files with it. The self-check fails while the committed fixtures and the generator disagree. Never edit a fixture by hand, and never commit a private key: `generate.mjs` derives every key at run time.

## Files

| File | What |
|---|---|
| `run.mjs` | The runner (self-check, implementation mode, and the receiver track). |
| `verify.mjs` | The reference verifier as a command: one case on stdin, exit 0 or 1. With `--schema <name>`, validates a bare document against one schema instead. |
| `receiver/` | The receiver track: `harness.mjs` (the runner), `cases.mjs` (the hand-written cases), `corpus.mjs` + `injections.json` (the adversarial corpus and its placeholder), `import-corpus.mjs` (a benchmark importer), `peer.mjs`/`sphere.mjs`/`markers.mjs`/`adapter.mjs` (the scripted peers, the Sphere side, the markers, the adapter), `receivers/` (the careful and reckless test receivers), and `receiver-track.test.mjs`. |
| `lib/obi.mjs` | Reference code: canonical JSON, keys and key ids, envelope and card signing, verification of envelopes (the receiver check included), cards and chains, the exchange rules (`exchangeProblem`), finding ids. |
| `generate.mjs` | Writes `fixtures/` and `keys.json`. |
| `jcs-vectors.json` | Canonical-JSON test vectors. |
| `fixtures/` | The cases. |
