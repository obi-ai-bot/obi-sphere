// Agent cards (spec/identity.md section 2): the owner's detached JWS over the card, and the
// checks of section 2.2. `name`, `description` and the skills' words are data: never read here.

import { fromB64url, keyIdOrNull, sealKeyIdOrNull, verifyEd25519 } from "./crypto.ts";
import { canonicalBytes, utf8, type JsonObject } from "./json.ts";
import { CLOCK_SKEW_SECONDS, OK, fail, seconds, type Verdict } from "./envelope.ts";
import { matches, schemaErrors } from "./schemas.ts";
import { b64url } from "./crypto.ts";
import { FEATURES } from "./features.ts";

export const CARD_EXTENSION_URI = "urn:obi-sphere:ext:obi:0.1";

export interface CardParams {
  protocol: string;
  sphere: string;
  obi_id: string;
  owner: string;
  owner_key: string;
  key_id: string;
  public_key: string;
  /** The X25519 key the Obi's words are sealed for (protocol.md section 9.1), and its id: both or neither. */
  seal_key_id?: string;
  seal_public_key?: string;
  accepts: string[];
  card_seq: number;
  issued_at: string;
  /** The additions the agent takes, and what its owner declares runs it (identity.md section 2.3). */
  features?: string[];
  runtime?: { id: string; version: string };
  vendors?: string[];
  /** The conformance classes its member claims (identity.md section 2.3). */
  classes?: string[];
  /** What its member can help with (identity.md section 2.3). */
  topics?: string[];
}

export interface AgentCard {
  url: string;
  skills: { id: string }[];
  capabilities: { extensions: { params: CardParams }[] };
  signatures: { protected: string; signature: string }[];
  [key: string]: unknown;
}

/** The Obi extension's params of a card that matched the schema. */
export const cardParams = (card: AgentCard): CardParams => card.capabilities.extensions[0]!.params;

/** The feature a card's `features`, `runtime` and `vendors` come with (identity.md section 2.3). */
export const CARD_RUNTIME = "card_runtime";

/** The feature a card's `classes` come with (identity.md section 2.3). */
export const CARD_CLASSES = "card_classes";

/** The additions a card's own members need its readers to take (identity.md section 2.3). */
export function featuresUsed(p: CardParams): string[] {
  const used: string[] = [];
  if (p.features !== undefined || p.runtime !== undefined || p.vendors !== undefined || p.classes !== undefined || p.topics !== undefined) used.push(CARD_RUNTIME);
  if (p.classes !== undefined) used.push(CARD_CLASSES);
  if (p.topics !== undefined) used.push("card_topics");
  if (p.accepts.includes("introduction")) used.push("introduction");
  return used;
}

/** The feature a message uses, when it uses one (protocol.md sections 5.17 to 5.19): readers of
 *  the chain from before can't verify it, so it goes only where every active member takes it. */
export function messageFeatures(type: string, body: Record<string, unknown>): string[] {
  const used: string[] = [];
  if (type === "cancel") used.push("cancel");
  if (type === "introduction") used.push("introduction");
  if (body.follows !== undefined) used.push("follow_up");
  return used;
}

/** The additions a card says its agent takes: its `features`, and `card_runtime` when its
 *  `version`'s build metadata (after the first `+`, split at `.`) has `card-runtime`. */
export function featuresTaken(card: AgentCard): Set<string> {
  const taken = new Set(cardParams(card).features ?? []);
  const version = typeof card.version === "string" ? card.version : "";
  const plus = version.indexOf("+");
  if (plus >= 0 && version.slice(plus + 1).split(".").includes("card-runtime")) taken.add(CARD_RUNTIME);
  return taken;
}

/** Why a card can't be published yet ("Publishing a card with an addition"): the first member of
 *  `others` (the other active members' cards, by agent id) that doesn't take an addition it uses. */
export function publishingProblem(p: CardParams, others: { obi: string; card: AgentCard }[], carried: Set<string> = new Set()): string | null {
  for (const feature of featuresUsed(p).filter((f) => !carried.has(f))) {
    const behind = others.find((o) => !featuresTaken(o.card).has(feature));
    if (behind) return `${behind.obi}'s card doesn't take ${feature}: a card with its members waits until every active member's does`;
  }
  return null;
}

/** Why a message or a policy that uses `features` can't go in yet (sphere-api.md sections 5 and
 *  6.1, check 11): this Obysphere doesn't take one, or a member of `active` (every active member's
 *  card) doesn't list it, since every member verifies the chain and reads the policy. */
export function notTakenProblem(features: string[], active: { obi: string; card: AgentCard }[]): string | null {
  for (const feature of features) {
    if (!FEATURES.includes(feature)) return `this Obysphere doesn't take ${feature}`;
    const behind = active.find((m) => !featuresTaken(m.card).has(feature));
    if (behind) return `${behind.obi}'s card doesn't take ${feature}, and every member reads what uses it`;
  }
  return null;
}

/** The additions a policy's rules use: `introduction`, when a rule names it. */
export function policyFeatures(rules: { actions: string[] }[]): string[] {
  return rules.some((r) => r.actions.includes("introduction")) ? ["introduction"] : [];
}

export function cardSigningInput(card: Record<string, unknown>, protectedHeader: string): Uint8Array {
  const { signatures: _signatures, ...unsigned } = card;
  return utf8(`${protectedHeader}.${b64url(canonicalBytes(unsigned))}`);
}

export interface CardContext {
  /** The checker's clock: a timestamp or seconds since 1970. Without it, issued_at isn't checked. */
  now?: string | number;
  /** The owner key the Sphere bound for the card's owner, when there is one (check 6). */
  bound_owner_key?: string | null;
}

/** identity.md section 2.2. Codes: `card_invalid`, or `bad_signature` when only the signature fails. */
export async function verifyCard(value: unknown, ctx: CardContext): Promise<Verdict> {
  const errors = schemaErrors("agentCard", value);
  if (errors.length) return fail("card_invalid", errors.join("; "));
  const card = value as AgentCard;
  const params = cardParams(card);
  if ((await keyIdOrNull(params.public_key)) !== params.key_id) return fail("card_invalid", "key_id does not match public_key");
  if (params.owner_key === params.public_key) return fail("card_invalid", "the Obi's key must not be its owner's key");
  if (params.seal_public_key !== undefined && (await sealKeyIdOrNull(params.seal_public_key)) !== params.seal_key_id) return fail("card_invalid", "seal_key_id does not match seal_public_key");
  const skills = card.skills.map((s) => s.id).sort().join(",");
  if (skills !== [...params.accepts].sort().join(",")) return fail("card_invalid", "skills and accepts differ");
  const urlTail = `/v0.1/spheres/${params.sphere}/members/${params.obi_id}`;
  if (!card.url.endsWith(urlTail)) return fail("card_invalid", `url must end with ${urlTail}`);
  if (ctx.bound_owner_key && ctx.bound_owner_key !== params.owner_key) return fail("card_invalid", "signed by another key than the owner's bound key");
  const sig = card.signatures[0]!;
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fromB64url(sig.protected)));
  } catch {
    return fail("card_invalid", "the protected header is not JSON");
  }
  if (!matches("jwsHeader", header) || (header as JsonObject).typ !== "JOSE") return fail("card_invalid", "the protected header must be {alg: EdDSA, kid, typ: JOSE}");
  if ((header as JsonObject).kid !== (await keyIdOrNull(params.owner_key))) return fail("card_invalid", "kid is not the owner key's id");
  if (!(await verifyEd25519(params.owner_key, cardSigningInput(card, sig.protected), sig.signature))) return fail("bad_signature", "the owner's signature does not verify");
  if (ctx.now !== undefined) {
    const now = typeof ctx.now === "number" ? ctx.now : seconds(ctx.now);
    if (seconds(params.issued_at) > now + CLOCK_SKEW_SECONDS) return fail("card_invalid", "issued in the future");
  }
  return OK;
}
