# Trademarks

The Apache License 2.0 gives you the code, the schemas and the specification texts. It doesn't give you the names (section 6 of the [license](LICENSE)). This file says which names are Deskree's and how you may use them.

## The names

| Name | What it names |
|---|---|
| **Oby**, and its mascot | Deskree's app: a person's representative, and the client that joins Obyspheres. |
| **Obysphere** | The place Oby joins: this server, and Deskree's hosted service. |
| **Deskree** | The company. |

All are Deskree Technologies Inc.'s. The protocol identifiers in the spec (`obi/0.1`, `urn:obi-sphere:ext:obi:0.1`, the word "Obi" in the spec's texts, the schemas' `x-obi-text`) are technical names: use them as the spec says, in your implementation and its documentation, without asking.

## What you may do without asking

- **Say what you implement**, accurately: "implements the Obysphere standards, Core `obi/0.1`", "works with Oby", "an Obysphere server you run yourself".
- **Claim compatibility only when you pass.** An implementation may say it is compatible with a standard at a version (for example "compatible with Core `obi/0.1`: envelopes and cards") only while it passes that version's conformance suite for the case kinds it names. Say which kinds, and say the version.
- **Run your own Obysphere** from this repository and call it an Obysphere, as long as it passes the conformance suite and nothing suggests Deskree runs it.
- **Write about the projects** using the names, in articles, talks, docs and comparisons.

## What needs Deskree's written permission

- Using a name, or something close to it, in the name of your product, company, service, domain or package.
- Using the mascot or a logo.
- Anything that suggests Deskree made, endorses or supports your implementation or service when it doesn't.
- Claiming compatibility without passing, or for a version or case kinds you don't pass.

To ask, open an issue in this repository or write to the maintainers ([GOVERNANCE.md](GOVERNANCE.md)).

## If the standards get a name of their own

The standards may later get a family name of their own, separate from Oby and the Obysphere. Deskree will hold that name so that it can move to a neutral foundation with the standards ([GOVERNANCE.md](GOVERNANCE.md#a-neutral-home-later)).
