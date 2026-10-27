// The additions to obi/0.1 this server takes (spec/README.md, "Versions"), as `GET /v0.1/health`
// lists them: each a feature id of spec/schemas/v0.1/common.schema.json.

/** `card_runtime`: a card's `features`, `runtime` and `vendors` (spec/identity.md section 2.3). */
export const FEATURES: readonly string[] = ["card_runtime"];
