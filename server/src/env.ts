// The Worker's bindings (wrangler.jsonc).

export interface Env {
  DB: D1Database;
  /** One ChannelRelay per run_request exchange: its job channel (src/channel.ts). */
  CHANNELS: DurableObjectNamespace<import("./channel.ts").ChannelRelay>;
  /** The operator token that creates Spheres: a Worker secret, at least 32 characters. Unset: every operator call is 403. */
  SPHERE_OPERATOR_TOKEN?: string;
  /** The Google OAuth client whose ID tokens sign people in (src/signin.ts). Empty: no sign-in, every sign-in call is 403. */
  GOOGLE_CLIENT_ID?: string;
  /** The Google Workspaces, comma-separated, whose people may create a Sphere with a sign-in. Empty: only the operator creates. */
  CREATOR_WORKSPACES?: string;
}

/** What the handlers take besides the request and the bindings; tests pass their own clock. */
export interface Deps {
  /** Milliseconds since 1970: the Sphere's clock. */
  now(): number;
  /** How long a deliveries call with `wait` sleeps between looks at the queue, in milliseconds. */
  pollMs?: number;
  /** How long a write keeps retrying against concurrent writes before `429 rate_limited`, in milliseconds (src/db.ts). */
  retryBudgetMs?: number;
  /** Google's public keys (src/signin.ts); the tests pass their own. */
  google?: import("./signin.ts").KeyCache;
}
