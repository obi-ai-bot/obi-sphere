# Governance

How the Obysphere's standards and this repository are run: who decides, how a standard changes, and what Deskree promises about the license.

## What this covers

- **The standards** in [`spec/`](spec/): their texts, schemas and conformance suite ([spec/README.md](spec/README.md) lists them).
- **The reference server** in [`server/`](server/) and the documents in [`docs/`](docs/).

When the spec and the server disagree, the spec wins: the server changes, or the spec changes first by the process below.

## Roles

- **Contributors**: anyone who opens an issue, a discussion or a pull request. Every contribution is signed off under the Developer Certificate of Origin ([CONTRIBUTING.md](CONTRIBUTING.md)). There is no contributor license agreement, and there won't be one.
- **Maintainers**: review and merge pull requests, run the change process below, and keep this file. They are listed below.

### Maintainers

| Seat | Who |
|---|---|
| Deskree | *to be named before this file is merged* |
| Deskree | *to be named before this file is merged* |
| **From outside Deskree** | **Open.** Reserved for the first maintainer who doesn't work for Deskree. |

**The outside seat.** It is filled by someone who has shown sustained, careful work on the standards: for example, building an implementation outside Deskree that passes the conformance suite, or reviewing and contributing to the spec over many changes. Any maintainer or contributor may propose someone, including themselves, in an issue; the maintainers decide together, and the person accepts. Once filled, the seat has every right the others have. It stays reserved for someone outside Deskree: if its holder joins Deskree or steps down, it is open again.

**Adding and removing maintainers.** A new maintainer is proposed in an issue and added when every current maintainer agrees. A maintainer can step down at any time. Deskree's seats are never more than half of all maintainers plus one: when more people from outside Deskree join, the outside seats grow with them.

## How a standard changes

Every change to a standard follows the same path, whatever its size. The kinds of change (addition, breaking, clarification) and what each does to the version are in [spec/README.md, "Versions"](spec/README.md#versions).

1. **Request for discussion.** Open an issue that says the problem, who it affects and what would change. For a clarification or an obvious mistake, a pull request is enough.
2. **The proposal.** A pull request with the spec text, the schemas, the conformance cases that pin the new rule (valid and invalid), the reference code, and an entry in [CHANGELOG.md](CHANGELOG.md) that says its kind. A breaking change also says why an addition wouldn't do.
3. **Review.** It stays open until every maintainer has reviewed it or said they won't. Anyone may comment. A change no implementation outside the proposer's could follow is not ready.
4. **Decision.** Maintainers decide by consensus: a change is accepted when at least one maintainer other than its author approves and no maintainer objects. When consensus fails, a majority of maintainers decides, and the record of the vote stays on the pull request.
   - A **breaking change**, and a standard moving to **Stable**, also needs the approval of the outside maintainer once that seat is filled.
5. **Status.** A standard moves from Planned to Draft when a text lands, to Experimental when it is implemented and tested, and to Stable only after an external review and an implementation outside Deskree that passes the conformance suite.

## License pledge

The code, schemas and specification texts in this repository are under the Apache License 2.0 ([LICENSE](LICENSE)). Deskree pledges:

- **No relicensing.** Deskree will never relicense anything published here under terms more restrictive than the Apache License 2.0. What was published under it stays under it.
- **No contributor license agreement.** Contributions come in under the DCO and the same license they go out under.
- **A patent commitment for implementers** of the standards ([PATENTS.md](PATENTS.md)), which Deskree won't withdraw for a version once it is made.

## A neutral home later

The standards may move to a neutral foundation once they have implementations outside Deskree. When they do, this file changes by the process above, and the names the standards use are held so that they can move with them ([TRADEMARKS.md](TRADEMARKS.md)).
