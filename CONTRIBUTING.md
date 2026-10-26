# Contributing

Thank you for helping. This repository holds the Obysphere's standards ([`spec/`](spec/)) and its reference server ([`server/`](server/)). How a standard changes, and who decides, is in [GOVERNANCE.md](GOVERNANCE.md).

## Sign off every commit (DCO)

Every commit is signed off under the [Developer Certificate of Origin 1.1](https://developercertificate.org/): by signing off you certify that you wrote the change, or otherwise have the right to submit it under this repository's license. Add the line with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email are yours, as in your commit's author. A pull request with a commit that isn't signed off can't be merged; `git commit --amend -s` or `git rebase --signoff` adds the line to commits you already made.

There is no contributor license agreement. Your contribution comes in under the Apache License 2.0, the license it goes out under ([LICENSE](LICENSE), section 5).

## Before you open a pull request

- **For a change to a standard**, open an issue first that says the problem (GOVERNANCE.md, "How a standard changes"). The pull request brings the text, the schemas, the conformance cases (edit `spec/conformance/generate.mjs` and regenerate; never edit a fixture by hand) and an entry in [CHANGELOG.md](CHANGELOG.md) that says its kind: addition, breaking or clarification ([spec/README.md, "Versions"](spec/README.md#versions)).
- **Run the checks** for what you changed:

  ```sh
  make spec-check                                    # the spec: schemas, fixtures, reference verdicts
  cd server && pnpm install --frozen-lockfile
  pnpm run check && pnpm test && pnpm run conformance   # the server
  ```

- **Open it against `dev`.** `main` is what's released.
- **Never commit a secret**, a private key or a real token. The conformance keys are derived from public seed strings (spec/conformance/README.md, "Keys").

## Reporting a vulnerability

Not in an issue or a pull request: see [SECURITY.md](SECURITY.md).
