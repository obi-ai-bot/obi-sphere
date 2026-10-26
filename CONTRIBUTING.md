# Contributing

Thank you for helping. This repository holds the Obysphere's standards ([`spec/`](spec/)) and its reference server ([`server/`](server/)). How a standard changes, and who decides, is in [GOVERNANCE.md](GOVERNANCE.md).

The repository is under the Apache License 2.0 ([LICENSE](LICENSE)).

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
