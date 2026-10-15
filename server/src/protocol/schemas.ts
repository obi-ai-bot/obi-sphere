// The spec's JSON Schemas (spec/schemas/v0.1), compiled ahead of time into
// validators.generated.js by scripts/gen-validators.mjs.

import * as validators from "./validators.generated.js";

export type SchemaName = keyof typeof validators;

/** The schema's complaints about `value`, at most `max` of them; empty when it matches. */
export function schemaErrors(name: SchemaName, value: unknown, max = 5): string[] {
  const validate = validators[name];
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, max).map((e) => {
    const extra = typeof e.params?.additionalProperty === "string" ? ` (${e.params.additionalProperty})` : "";
    return `${e.instancePath || "/"} ${e.message ?? "is invalid"}${extra}`;
  });
}

export const matches = (name: SchemaName, value: unknown): boolean => validators[name](value);
