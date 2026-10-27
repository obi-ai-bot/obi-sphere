# Proposals

Status: every text here is a **Draft** ([spec/README.md, "Statuses"](../README.md#the-standards-by-instrument)). A proposal may change in any way, and nothing should depend on it. It changes nothing in what an `obi/0.1` implementation must do.

A proposal is where a change that the version rule ([spec/README.md, "Versions"](../README.md#versions)) doesn't allow under the current protocol constant is designed before it is made: breaking changes, gathered so that implementers migrate once. A proposal has schema sketches, not schemas, and no conformance cases. Once the maintainers accept it, its text moves into the standards under a new protocol constant, with schemas, fixtures and a CHANGELOG entry of its own, and the documents of the old constant stay as they were.

| Proposal | Status | Covers |
|---|---|---|
| [The next protocol version](next-version/README.md) | Draft | Neutral identifiers on the wire ([#51](https://github.com/obi-ai-bot/oby-sphere/issues/51)), a domain-neutral Core with profiles ([#52](https://github.com/obi-ai-bot/oby-sphere/issues/52)), organisations and projects as owners ([#61](https://github.com/obi-ai-bot/oby-sphere/issues/61)), and an open list of agent runtimes ([#54](https://github.com/obi-ai-bot/oby-sphere/issues/54)). |
