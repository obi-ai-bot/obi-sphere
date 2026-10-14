// The Worker's bindings (wrangler.jsonc).

export interface Env {
  DB: D1Database;
  /** The operator token that creates Spheres: a Worker secret, at least 32 characters. Unset: every operator call is 403. */
  SPHERE_OPERATOR_TOKEN?: string;
}

/** What the handlers take besides the request and the bindings; tests pass their own clock. */
export interface Deps {
  /** Milliseconds since 1970: the Sphere's clock. */
  now(): number;
  /** How long a deliveries call with `wait` sleeps between looks at the queue, in milliseconds. */
  pollMs?: number;
  /** How long a write keeps retrying against concurrent writes before `429 rate_limited`, in milliseconds (src/db.ts). */
  retryBudgetMs?: number;
}
