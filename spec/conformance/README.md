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

1. compiles every schema in `schemas/v0.1/` (draft 2020-12) and lints them: every object with properties sets `additionalProperties: false`; every string has a `maxLength` and a `pattern`, `enum` or `const`, unless it is data text; every data-text field (a reference to `line_text` or `block_text`) is annotated `x-obi-text: data` and sets its own bounds; the action types are exactly the twelve of the protocol;
2. checks the canonical-JSON vectors in `jcs-vectors.json` (RFC 8785);
3. regenerates every fixture with `generate.mjs` and fails if a committed file differs, is missing, or is extra;
   then checks that the repository's `.gitleaks.toml` allowlists exactly the public keys in `keys.json` (below, "Keys");
4. judges every fixture with the reference verifier (`lib/obi.mjs`) and fails on any verdict, or rejection code, other than the fixture's;
5. checks that the required fixtures exist (one valid envelope per action type, one per missing required field, and so on);
6. runs implementation mode once with the reference verifier (`verify.mjs`), to prove the `--impl` contract, and checks that an implementation is given only `{case, context, input}` (a checker that echoes the fixture's `expect` must fail).

**Implementation mode** (`--impl "<command>"`): for every fixture, the runner starts `sh -c "<command>"`, writes the case's `case`, `context` and `input` (below) to its stdin as one JSON object and closes it. It never sends `expect`, `reason`, `name` or `description`: the implementation judges the case, it isn't told the answer. **Exit status 0 means accept; anything else means reject.** Whatever the command prints is shown for cases it gets wrong. Each case has 20 seconds. The runner exits 1 if any case comes out otherwise than the fixture expects. `--kinds` limits it to some case kinds, for an implementation that only does part of the protocol (a Sphere server checks envelopes, cards and wire documents and builds chains; obid checks envelopes, cards and chains).

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

- `case` is `envelope`, `card`, `audit` or `wire`. `expect` is `accept` or `reject`. `reason`, on rejections, is the error code the reference verifier gives (one of [sphere-api.md](../sphere-api.md)'s, or `wrong_recipient`, the receiver's own: [protocol.md](../protocol.md) section 10), for information: implementations are judged on accept or reject only.
- **`envelope`**: `input` is one envelope. `context` is `{now, sphere, receiver, keys, seq?, seen_ids}`: judge it as the Obi `receiver` (an `obi_id`) in the Sphere `sphere` would at time `now` (never the real clock), so a message whose `to` is another Obi is rejected (protocol.md section 10, check 5); with `keys` the directory (`{key_id: {obi, public_key, valid_from_seq?, valid_until_seq?}}`), `seq` the message's audit seq when it came in a delivery, and `seen_ids` the ids already handled. A key with a validity range must be valid at `seq`, or be current (`valid_until_seq` null) when there is no `seq` (protocol.md section 10, "Which key is valid for a message"); a key without one is valid. Checks: protocol.md section 10. A Sphere server's checker judges `receiver` too: the Sphere delivers a message only to its `to`, so it is the same check made at routing.
- **`card`**: `input` is one agent card. `context` is `{now, bound_owner_key?}`: the owner key the Sphere has bound for the card's owner, when it has one. Checks: identity.md section 2.2.
- **`audit`**: `input` is `{sphere, entries}`, a whole chain from seq 1. `context` is `{keys}`, the key history (`{key_id: {obi, public_key, valid_from_seq, valid_until_seq}}`). Checks: sphere-api.md section 7.1, the exchange rules (protocol.md section 4) included.
- **`wire`**: `input` is one request or answer body of [sphere-api.md](../sphere-api.md). `context` is `{schema}`, the wire schema it is judged by (`wire/invitation.request`, …), named as `verify.mjs --schema` names it. Checks: that schema alone (rejections are `bad_request`). They pin the rules a client needs that live in a schema, like a named invitation's `owner` and `obi` coming together.

## Keys

The fixtures are signed with keys anyone can derive, so they are reproducible and nothing secret is committed. `keys.json` lists each key's seed string, public key and key id; the private key is Ed25519 (RFC 8032) from the 32-byte seed `SHA-256(UTF-8(seed string))`. For example `obi-a`'s seed string is `obi-conformance-test-key-obi-a`. **Never use these keys for anything else.**

Their public keys look like API keys to generic secret-scan rules, so the repository's `.gitleaks.toml` allowlists exactly those values, only under `spec/conformance/`, for gitleaks's generic API-key rule; any other value there is still reported. A new test key goes into that list in the same pull request (the self-check fails until it does).

## Changing the fixtures

Edit `generate.mjs`, run `pnpm run generate`, and commit the regenerated files with it. The self-check fails while the committed fixtures and the generator disagree. Never edit a fixture by hand, and never commit a private key: `generate.mjs` derives every key at run time.

## Files

| File | What |
|---|---|
| `run.mjs` | The runner (self-check and implementation mode). |
| `verify.mjs` | The reference verifier as a command: one case on stdin, exit 0 or 1. With `--schema <name>`, validates a bare document against one schema instead. |
| `lib/obi.mjs` | Reference code: canonical JSON, keys and key ids, envelope and card signing, verification of envelopes (the receiver check included), cards and chains, the exchange rules (`exchangeProblem`), finding ids. |
| `generate.mjs` | Writes `fixtures/` and `keys.json`. |
| `jcs-vectors.json` | Canonical-JSON test vectors. |
| `fixtures/` | The cases. |
