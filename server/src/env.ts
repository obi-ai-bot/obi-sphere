// The Worker's bindings (wrangler.jsonc).

export interface Env {
  DB: D1Database;
  /** One ChannelRelay per run_request exchange: its job channel (src/channel.ts). */
  CHANNELS: DurableObjectNamespace<import("./channel.ts").ChannelRelay>;
  /** One Doorbell per Obi in a Sphere: what wakes its deliveries long poll (src/doorbell.ts). */
  DOORBELLS: DurableObjectNamespace<import("./doorbell.ts").Doorbell>;
  /** One PhoneRelay per phone relay: a Mac and its paired phones (src/relay.ts). */
  RELAYS: DurableObjectNamespace<import("./relay.ts").PhoneRelay>;
  /** The operator token that creates Spheres: a Worker secret, at least 32 characters. Unset: every operator call is 403. */
  SPHERE_OPERATOR_TOKEN?: string;
  /** The Google OAuth client whose ID tokens sign people in (src/signin.ts). Empty: no sign-in, every sign-in call is 403. */
  GOOGLE_CLIENT_ID?: string;
  /** The Google Workspaces, comma-separated, whose people may create a Sphere with a sign-in. Empty: only the operator creates. */
  CREATOR_WORKSPACES?: string;
  /** How many Spheres one account may be the admin owner of before a create with a sign-in is 429. Unset: 3. */
  SPHERE_CREATE_LIMIT?: string;
}

/** What the handlers take besides the request and the bindings; tests pass their own clock. */
export interface Deps {
  /** Milliseconds since 1970: the Sphere's clock. */
  now(): number;
  /** How long a write keeps retrying against concurrent writes before `429 rate_limited`, in milliseconds (src/db.ts). */
  retryBudgetMs?: number;
  /** Google's public keys (src/signin.ts); the tests pass their own. */
  google?: import("./signin.ts").KeyCache;
}
