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

1. compiles every schema in `schemas/v0.1/` (draft 2020-12) and lints them: every object with properties sets `additionalProperties: false`; every string has a `maxLength` and a `pattern`, `enum` or `const`, unless it is data text; every data-text field (a reference to `line_text` or `block_text`) is annotated `x-obi-text: data` and sets its own bounds; the action types are exactly the seven of the protocol;
2. checks the canonical-JSON vectors in `jcs-vectors.json` (RFC 8785);
3. regenerates every fixture with `generate.mjs` and fails if a committed file differs, is missing, or is extra;
4. judges every fixture with the reference verifier (`lib/obi.mjs`) and fails on any verdict, or rejection code, other than the fixture's;
5. checks that the required fixtures exist (one valid envelope per action type, one per missing required field, and so on);
6. runs implementation mode once with the reference verifier (`verify.mjs`), to prove the `--impl` contract.

**Implementation mode** (`--impl "<command>"`): for every fixture, the runner starts `sh -c "<command>"`, writes the fixture (the whole case, below) to its stdin and closes it. **Exit status 0 means accept; anything else means reject.** Whatever the command prints is shown for cases it gets wrong. Each case has 20 seconds. The runner exits 1 if any case comes out otherwise than the fixture expects. `--kinds` limits it to some case kinds, for an implementation that only does part of the protocol (a Sphere server checks envelopes and cards and builds chains; obid checks all three).

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

- `case` is `envelope`, `card` or `audit`. `expect` is `accept` or `reject`. `reason`, on rejections, is the error code of [sphere-api.md](../sphere-api.md) the reference verifier gives, for information: implementations are judged on accept or reject only.
- **`envelope`**: `input` is one envelope. `context` is `{now, sphere, keys, seq?, seen_ids}`: judge it as the receiver of `sphere` would at time `now` (never the real clock), with `keys` the directory (`{key_id: {obi, public_key, valid_from_seq?, valid_until_seq?}}`), `seq` the message's audit seq when it came in a delivery, and `seen_ids` the ids already handled. A key with a validity range must be valid at `seq`, or be current (`valid_until_seq` null) when there is no `seq` (protocol.md section 10, "Which key is valid for a message"); a key without one is valid. Checks: protocol.md section 10.
- **`card`**: `input` is one agent card. `context` is `{now, bound_owner_key?}`: the owner key the Sphere has bound for the card's owner, when it has one. Checks: identity.md section 2.2.
- **`audit`**: `input` is `{sphere, entries}`, a whole chain from seq 1. `context` is `{keys}`, the key history (`{key_id: {obi, public_key, valid_from_seq, valid_until_seq}}`). Checks: sphere-api.md section 7.1.

## Keys

The fixtures are signed with keys anyone can derive, so they are reproducible and nothing secret is committed. `keys.json` lists each key's seed string, public key and key id; the private key is Ed25519 (RFC 8032) from the 32-byte seed `SHA-256(UTF-8(seed string))`. For example `obi-a`'s seed string is `obi-conformance-test-key-obi-a`. **Never use these keys for anything else.**

## Changing the fixtures

Edit `generate.mjs`, run `pnpm run generate`, and commit the regenerated files with it. The self-check fails while the committed fixtures and the generator disagree. Never edit a fixture by hand, and never commit a private key: `generate.mjs` derives every key at run time.

## Files

| File | What |
|---|---|
| `run.mjs` | The runner (self-check and implementation mode). |
| `verify.mjs` | The reference verifier as a command: one case on stdin, exit 0 or 1. With `--schema <name>`, validates a bare document against one schema instead. |
| `lib/obi.mjs` | Reference code: canonical JSON, keys and key ids, envelope and card signing, verification of envelopes, cards and chains, finding ids. |
| `generate.mjs` | Writes `fixtures/` and `keys.json`. |
| `jcs-vectors.json` | Canonical-JSON test vectors. |
| `fixtures/` | The cases. |
