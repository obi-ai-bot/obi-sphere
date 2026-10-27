// Envelopes: signing input, the checks of spec/protocol.md section 10, and the exchange rules
// (section 4). Text fields are data: nothing here reads them beyond their schema.

import { verifyEd25519, keyIdOrNull, type SigningKey } from "./crypto.ts";
import { JsonError, canonicalBytes, canonicalize, utf8, type JsonObject } from "./json.ts";
import { schemaErrors } from "./schemas.ts";

export const PROTOCOL = "obi/0.1";
export const ENVELOPE_SIGNING_PREFIX = "obi/0.1 envelope\n";
export const MAX_ENVELOPE_BYTES = 65536;
export const MAX_LIFETIME_SECONDS = 2592000;
export const CLOCK_SKEW_SECONDS = 300;
export const REQUEST_TYPES = ["review_request", "question", "handoff", "run_request", "share_offer"] as const;
export const REPLY_TYPES = ["status", "accept", "decline", "result", "answer", "run_progress", "run_return", "run_cancel", "share_status", "share_revoke"] as const;
export const TERMINAL_TYPES = ["decline", "result", "answer", "run_return", "run_cancel", "share_revoke"];
/** The replies that belong only to a run_request's exchange (protocol.md section 4, rule 7). */
export const RUN_REPLY_TYPES = ["run_progress", "run_return", "run_cancel"];
/** What a share_offer's exchange takes, and nothing else (protocol.md section 4, rule 8). */
export const SHARE_REPLY_TYPES = ["share_status", "share_revoke", "decline"];
/** The replies a request's own sender sends, to its receiver (protocol.md section 4, rule 1). */
export const SENDER_REPLY_TYPES = ["run_cancel", "share_status", "share_revoke"];
export const SEVERITY_RANK: Record<string, number> = { nit: 1, minor: 2, major: 3, blocker: 4 };

export type RequestType = (typeof REQUEST_TYPES)[number];
export const isRequestType = (t: unknown): t is RequestType => (REQUEST_TYPES as readonly unknown[]).includes(t);
export const isReplyType = (t: unknown): boolean => (REPLY_TYPES as readonly unknown[]).includes(t);

/** An envelope that matched the schema. Its body is only what its action's schema allows. */
export interface Envelope {
  protocol: string;
  id: string;
  type: string;
  from: string;
  to: string;
  sphere: string;
  correlation_id: string;
  in_reply_to?: string;
  created_at: string;
  expires_at: string;
  key_id: string;
  body: JsonObject;
  /** How the words in `body` are sealed for the receiver (protocol.md section 9.1). */
  seal?: { suite: string; key_id: string; enc: string };
  signature: string;
}

export type Verdict = { ok: true } | { ok: false; code: string; message: string };
export const OK: Verdict = { ok: true };
export const fail = (code: string, message: string): Verdict => ({ ok: false, code, message });

/** Seconds since 1970 of a protocol timestamp (NaN when it is not a date). */
export const seconds = (timestamp: string): number => Date.parse(timestamp) / 1000;

/** A protocol timestamp: UTC, whole seconds, `Z`. */
export const timestamp = (secondsSince1970: number): string => new Date(Math.floor(secondsSince1970) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const realDate = (ts: string): boolean => !Number.isNaN(seconds(ts)) && timestamp(seconds(ts)) === ts;

export function envelopeSigningInput(envelope: object): Uint8Array {
  const { signature: _signature, ...unsigned } = envelope as Record<string, unknown>;
  const body = canonicalBytes(unsigned);
  const prefix = utf8(ENVELOPE_SIGNING_PREFIX);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

interface Finding {
  id: string;
  severity: string;
  line: number;
  end_line?: number;
}
interface AcceptanceResult {
  index: number;
  kind: string;
  severity?: string;
  met: boolean;
}

/** A result that contradicts itself (protocol.md section 5.7). */
export function resultProblems(body: JsonObject): string[] {
  const problems: string[] = [];
  const findings = (body.findings ?? []) as unknown as Finding[];
  const ids = new Set<string>();
  for (const f of findings) {
    if (ids.has(f.id)) problems.push(`finding id ${f.id} appears twice`);
    ids.add(f.id);
  }
  const acceptance = (body.acceptance ?? []) as unknown as AcceptanceResult[];
  const indexes = new Set<number>();
  for (const a of acceptance) {
    if (indexes.has(a.index)) problems.push(`acceptance index ${a.index} appears twice`);
    indexes.add(a.index);
    if (body.for === "review_request") {
      if (a.kind === "no_blocker_findings" && a.met !== !findings.some((f) => f.severity === "blocker")) problems.push("no_blocker_findings: met disagrees with the findings");
      if (a.kind === "no_findings_at_or_above" && a.met !== !findings.some((f) => SEVERITY_RANK[f.severity]! >= SEVERITY_RANK[a.severity!]!)) problems.push("no_findings_at_or_above: met disagrees with the findings");
    }
  }
  const allMet = acceptance.length > 0 && acceptance.every((a) => a.met);
  if (body.outcome === "approved" && !allMet) problems.push("approved needs every acceptance condition met");
  if (body.outcome === "changes_requested" && allMet) problems.push("changes_requested needs an acceptance condition not met");
  if (body.for === "handoff" && body.outcome === "done" && !allMet) problems.push("done needs every acceptance condition met");
  return problems;
}

/**
 * The references in one list are distinct, repositories compared ignoring ASCII case
 * (protocol.md section 5.9): `Acme/App` and `acme/app` name the same repository.
 */
export function refProblems(body: JsonObject): string[] {
  const problems: string[] = [];
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const list of ["about", "refs"]) {
    const seen = new Set<string>();
    for (const ref of (Array.isArray(body[list]) ? body[list] : []) as JsonObject[]) {
      const key = canonicalize({ ...ref, repo: lower(ref.repo as string) });
      if (seen.has(key)) problems.push(`${list}: the same reference twice`);
      seen.add(key);
    }
  }
  return problems;
}

/** protocol.md section 10, check 3: the rules no schema can say. Runs after the schema matched. */
export function semanticProblems(env: Envelope): string[] {
  const problems: string[] = [];
  if (!realDate(env.created_at)) problems.push("created_at is not a real date");
  if (!realDate(env.expires_at)) problems.push("expires_at is not a real date");
  const created = seconds(env.created_at);
  const expires = seconds(env.expires_at);
  if (!(expires > created)) problems.push("expires_at must be after created_at");
  if (expires - created > MAX_LIFETIME_SECONDS) problems.push(`a message may live at most ${MAX_LIFETIME_SECONDS} seconds`);
  if (env.from === env.to) problems.push("from and to must differ");
  if (isRequestType(env.type) && env.correlation_id !== env.id) problems.push("a request's correlation_id must equal its id");
  if (isReplyType(env.type) && env.in_reply_to !== env.correlation_id) problems.push("a reply's in_reply_to must equal its correlation_id");
  if (env.type === "result") problems.push(...resultProblems(env.body));
  problems.push(...refProblems(env.body));
  for (const f of (env.body.findings ?? []) as unknown as Finding[]) {
    if (f.end_line !== undefined && f.end_line < f.line) problems.push(`finding ${f.id}: end_line before line`);
  }
  return problems;
}

/**
 * Checks 1 to 3 of protocol.md section 10: size, schema, and the rules no schema says.
 * Returns the envelope typed when they pass.
 */
export function checkEnvelopeShape(value: unknown): { ok: true; envelope: Envelope } | { ok: false; code: string; message: string } {
  let size: number;
  try {
    size = canonicalBytes(value).length;
  } catch (e) {
    return { ok: false, code: "invalid_envelope", message: e instanceof JsonError ? e.message : "not canonical JSON" };
  }
  if (size > MAX_ENVELOPE_BYTES) return { ok: false, code: "payload_too_large", message: `${size} bytes canonical, the most is ${MAX_ENVELOPE_BYTES}` };
  // A sealed envelope's words are sealed_text: the sealed schema checks their size, never what they say.
  const sealed = typeof value === "object" && value !== null && Object.hasOwn(value, "seal");
  const errors = schemaErrors(sealed ? "sealed/envelope" : "envelope", value);
  if (errors.length) return { ok: false, code: "invalid_envelope", message: errors.join("; ") };
  const env = value as Envelope;
  const problems = semanticProblems(env);
  if (problems.length) return { ok: false, code: "invalid_envelope", message: problems.join("; ") };
  return { ok: true, envelope: env };
}

/** A directory key: `valid_from_seq` and `valid_until_seq` may be absent (a key with no range). */
export interface DirectoryKey {
  obi: string;
  public_key: string;
  valid_from_seq?: number | null;
  valid_until_seq?: number | null;
}

/**
 * Whether `key` may sign the message at audit seq `seq`; with no seq (a message not recorded
 * yet) the key must be current. A key without a range is always valid.
 */
export function keyValidAt(key: DirectoryKey, seq: number | null | undefined): boolean {
  if (key.valid_from_seq === undefined && key.valid_until_seq === undefined) return true;
  const open = key.valid_until_seq === null || key.valid_until_seq === undefined;
  if (seq === undefined || seq === null) return open;
  return seq >= (key.valid_from_seq ?? 1) && (open || seq <= key.valid_until_seq!);
}

export const verifyEnvelopeSignature = (env: Envelope, publicKey: string): Promise<boolean> =>
  verifyEd25519(publicKey, envelopeSigningInput(env), env.signature);

export interface ReceiverContext {
  now: string | number;
  sphere: string;
  receiver: string;
  keys: Record<string, DirectoryKey>;
  seq?: number | null;
  seen_ids?: string[];
}

/** The whole of protocol.md section 10, as the receiving Obi `ctx.receiver` judges a message. */
export async function verifyEnvelope(value: unknown, ctx: ReceiverContext): Promise<Verdict> {
  const shape = checkEnvelopeShape(value);
  if (!shape.ok) return fail(shape.code, shape.message);
  const env = shape.envelope;
  if (env.sphere !== ctx.sphere) return fail("wrong_sphere", `for ${env.sphere}, not ${ctx.sphere}`);
  if (typeof ctx.receiver !== "string") return fail("wrong_recipient", "the context names no receiver");
  if (env.to !== ctx.receiver) return fail("wrong_recipient", `addressed to ${env.to}, not ${ctx.receiver}`);
  const key = Object.hasOwn(ctx.keys ?? {}, env.key_id) ? ctx.keys[env.key_id] : undefined;
  if (!key || key.obi !== env.from) return fail("unknown_key", `${env.key_id} is not a key of ${env.from}`);
  if ((await keyIdOrNull(key.public_key)) !== env.key_id) return fail("unknown_key", "the directory's key does not hash to key_id");
  if (!keyValidAt(key, ctx.seq)) return fail("unknown_key", ctx.seq === undefined || ctx.seq === null ? `${env.key_id} is not ${env.from}'s current key` : `${env.key_id} was not valid at seq ${ctx.seq}`);
  if (!(await verifyEnvelopeSignature(env, key.public_key))) return fail("bad_signature", "the signature does not verify");
  const now = typeof ctx.now === "number" ? ctx.now : seconds(ctx.now);
  if (!(seconds(env.expires_at) > now)) return fail("expired", `expired at ${env.expires_at}`);
  if (seconds(env.created_at) > now + CLOCK_SKEW_SECONDS) return fail("clock_skew", `created_at is more than ${CLOCK_SKEW_SECONDS} seconds ahead`);
  if ((ctx.seen_ids ?? []).includes(env.id)) return fail("duplicate", `${env.id} was seen before`);
  return OK;
}

/** The parts of an envelope the exchange rules look at. */
export interface ExchangeMessage {
  type: string;
  from: string;
  to: string;
  result_for?: string | undefined;
  /** Whether the message's body has a `note` (a decline's words, rule 9). */
  has_note?: boolean | undefined;
  /** A decline's `reason`, and whether it names a remembered decision (`by_rule`): rule 9. */
  reason?: string | undefined;
  has_by_rule?: boolean | undefined;
}

/** The reasons a decline in a run_request's exchange may give (rule 9): the guest's own doing, or nothing about the host. */
export const RUN_DECLINE_REASONS = ["unavailable", "expired", "out_of_scope", "share_used"];

/**
 * The exchange rules (protocol.md section 4): why `reply` breaks them, given the request its
 * `in_reply_to` names (undefined when there is none) and the replies to it recorded before it,
 * in order; null when it keeps them.
 */
export function exchangeProblem(reply: ExchangeMessage, request: ExchangeMessage | undefined, earlier: ExchangeMessage[]): string | null {
  if (!request || !isRequestType(request.type)) return "replies to no earlier request";
  // run_cancel, share_status and share_revoke are the replies the request's own sender sends, to its receiver.
  if (SENDER_REPLY_TYPES.includes(reply.type)) {
    if (request.from !== reply.from || request.to !== reply.to) return `only the request's sender sends a ${reply.type}, to its receiver`;
  } else if (request.from !== reply.to || request.to !== reply.from) return "only the request's receiver replies, to its sender";
  if (RUN_REPLY_TYPES.includes(reply.type) && request.type !== "run_request") return `a ${reply.type} belongs to a run_request, not a ${request.type}`;
  // A share_offer's exchange takes share_status, share_revoke and decline, and they belong to it alone (decline to any request).
  if (request.type === "share_offer" ? !SHARE_REPLY_TYPES.includes(reply.type) : SHARE_REPLY_TYPES.includes(reply.type) && reply.type !== "decline")
    return request.type === "share_offer" ? `a share_offer takes no ${reply.type}` : `a ${reply.type} belongs to a share_offer, not a ${request.type}`;
  if (earlier.some((e) => TERMINAL_TYPES.includes(e.type))) return "the exchange already ended";
  const accepted = earlier.some((e) => e.type === "accept");
  if (reply.type === "accept" && accepted) return "accepted twice";
  if (reply.type === "result") {
    if (reply.result_for !== request.type) return `a result for ${reply.result_for} answers a ${request.type}`;
    if (!accepted) return `a ${request.type} is answered by a result only after an accept`;
  }
  // A run_return comes back only from a job that was accepted.
  if (reply.type === "run_return" && !accepted) return "a run_request is answered by a run_return only after an accept";
  // An answer answers a question, and nothing else; an accept before it is allowed, not needed.
  if (reply.type === "answer" && request.type !== "question") return `an answer answers a question, not a ${request.type}`;
  // No words in a guest job's or a share's exchange: a decline there has no note, and a guest
  // job's takes no status, whose states and note would say when its host's owner is there (rule 9).
  if (reply.type === "status" && request.type === "run_request") return "a run_request takes no status";
  if (reply.type === "decline" && (request.type === "run_request" || request.type === "share_offer") && reply.has_note) return `a decline of a ${request.type} has no note`;
  // Nor why its host declined, which would say when its owner is at the Mac or what its rules are.
  if (reply.type === "decline" && request.type === "run_request" && !RUN_DECLINE_REASONS.includes(reply.reason ?? ""))
    return `a decline of a run_request says only ${RUN_DECLINE_REASONS.join(", ")}`;
  // Nor whether a rule or its owner in person answered.
  if (request.type === "run_request" && reply.has_by_rule) return `no reply to a run_request names a rule (by_rule)`;
  return null;
}

/**
 * A request's repository, as policy matches it (sphere-api.md section 5): the body's `repo`, or for
 * a question the one repository its `about` references name (protocol.md section 5.2). Undefined
 * when it has none: a question about nothing, or about more than one repository.
 */
export function requestRepo(env: Envelope): string | undefined {
  if (env.type !== "question") return typeof env.body.repo === "string" ? env.body.repo : undefined;
  const repos = (Array.isArray(env.body.about) ? env.body.about : []).map((ref) => (ref as JsonObject).repo as string);
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return repos.length > 0 && repos.every((r) => lower(r) === lower(repos[0]!)) ? repos[0] : undefined;
}

export const exchangeMessage = (env: Envelope): ExchangeMessage => ({
  type: env.type,
  from: env.from,
  to: env.to,
  result_for: env.type === "result" ? (env.body.for as string) : undefined,
  has_note: env.body.note !== undefined,
  reason: env.type === "decline" ? (env.body.reason as string) : undefined,
  has_by_rule: env.body.by_rule !== undefined,
});

// ---------------------------------------------------------------------------------------------
// Making messages: the sender's side of sections 3 and 9.

/** An envelope before it is signed. */
export type UnsignedEnvelope = Omit<Envelope, "signature">;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** How long a message the library makes lives when the caller doesn't say: one day. */
export const DEFAULT_LIFETIME_SECONDS = 86400;

/** Signs an envelope with the sender's key: Ed25519 over the prefix and the canonical JSON of every other member (section 9). */
export async function signEnvelope(unsigned: UnsignedEnvelope, key: SigningKey): Promise<Envelope> {
  const { signature: _signature, ...rest } = unsigned as UnsignedEnvelope & { signature?: string };
  if (rest.key_id !== key.keyId) throw new Error(`the envelope names ${rest.key_id}, and the key is ${key.keyId}`);
  return { ...rest, signature: await key.sign(envelopeSigningInput(rest)) };
}

export interface MessageOptions {
  sphere: string;
  /** The sender's obi_id. */
  from: string;
  /** The sender's current key id. */
  keyId: string;
  /** Seconds since 1970; now when left out. */
  now?: number;
  /** Seconds from `now` until it expires: 1 to 2,592,000. */
  expiresIn?: number;
}

function lifetime(opts: MessageOptions): { created_at: string; expires_at: string } {
  const now = opts.now ?? nowSeconds();
  const expiresIn = opts.expiresIn ?? DEFAULT_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_LIFETIME_SECONDS) throw new Error(`expiresIn is 1 to ${MAX_LIFETIME_SECONDS} seconds`);
  return { created_at: timestamp(now), expires_at: timestamp(now + expiresIn) };
}

/** A new request to `to`, unsigned: its own exchange, `correlation_id` its `id`. */
export function newRequest(opts: MessageOptions & { to: string; type: RequestType; body: JsonObject }): UnsignedEnvelope {
  const id = crypto.randomUUID();
  return {
    protocol: PROTOCOL, id, type: opts.type, from: opts.from, to: opts.to, sphere: opts.sphere, correlation_id: id,
    ...lifetime(opts), key_id: opts.keyId, body: opts.body,
  };
}

/**
 * A reply to `request`, unsigned. It goes to the request's sender, or, for the replies a request's
 * own sender sends (`run_cancel`, `share_status`, `share_revoke`), to its receiver.
 */
export function newReply(request: Pick<Envelope, "id" | "from" | "to" | "sphere">, opts: Omit<MessageOptions, "sphere"> & { type: string; body: JsonObject }): UnsignedEnvelope {
  if (!isReplyType(opts.type)) throw new Error(`${opts.type} is not a reply`);
  const to = SENDER_REPLY_TYPES.includes(opts.type) ? request.to : request.from;
  return {
    protocol: PROTOCOL, id: crypto.randomUUID(), type: opts.type, from: opts.from, to, sphere: request.sphere,
    correlation_id: request.id, in_reply_to: request.id, ...lifetime({ ...opts, sphere: request.sphere }), key_id: opts.keyId, body: opts.body,
  };
}
