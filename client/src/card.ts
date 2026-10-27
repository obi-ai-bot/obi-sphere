// Agent cards (spec/identity.md section 2): making and signing one with the owner's key (2.1), and
// the checks of section 2.2. `name`, `description` and the skills' words are data: never read here.

import { b64url, fromB64url, keyIdOrNull, sealKeyIdOrNull, verifyEd25519, type SigningKey } from "./crypto.ts";
import { canonicalBytes, utf8, type JsonObject } from "./json.ts";
import { CLOCK_SKEW_SECONDS, OK, fail, seconds, timestamp, type Verdict } from "./envelope.ts";
import { matches, schemaErrors } from "./schemas.ts";

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
  const errors = schemaErrors("agent-card", value);
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
  if (!matches("wire/jws-header", header) || (header as JsonObject).typ !== "JOSE") return fail("card_invalid", "the protected header must be {alg: EdDSA, kid, typ: JOSE}");
  if ((header as JsonObject).kid !== (await keyIdOrNull(params.owner_key))) return fail("card_invalid", "kid is not the owner key's id");
  if (!(await verifyEd25519(params.owner_key, cardSigningInput(card, sig.protected), sig.signature))) return fail("bad_signature", "the owner's signature does not verify");
  if (ctx.now !== undefined) {
    const now = typeof ctx.now === "number" ? ctx.now : seconds(ctx.now);
    if (seconds(params.issued_at) > now + CLOCK_SKEW_SECONDS) return fail("card_invalid", "issued in the future");
  }
  return OK;
}

// ---------------------------------------------------------------------------------------------
// Making a card: the owner's side of section 2.1.

/** What each request type's skill says, unless the card's maker says otherwise. Data, like every name. */
export const DEFAULT_SKILLS: Record<string, { name: string; description: string }> = {
  review_request: { name: "Review a change", description: "Reviews a change for its owner and answers with typed findings." },
  question: { name: "Answer a question", description: "Answers what its owner knows or decided." },
  handoff: { name: "Take on work", description: "Takes on a piece of work for its own owner and answers with a typed result." },
  run_request: { name: "Run a job", description: "Runs a job on its owner's machine." },
  share_offer: { name: "Use a shared account", description: "Uses an API account another owner shares." },
};

export interface NewCard {
  /** The Sphere's base URL, the origin its API is under: `https://sphere.example.com`. */
  base: string;
  sphere: string;
  obi_id: string;
  owner: string;
  /** The owner's public key: the key that signs the card. */
  owner_key: string;
  /** The Obi's signing key's public key and id. */
  public_key: string;
  key_id: string;
  /** The Obi's X25519 seal key and its id, both or neither (protocol.md section 9.1). */
  seal_public_key?: string;
  seal_key_id?: string;
  accepts: string[];
  card_seq: number;
  /** A timestamp; now when left out. */
  issued_at?: string;
  /** What to call the Obi, and a line about it: data, as the owner wrote them. */
  name: string;
  description: string;
  /** The implementation's version. */
  version: string;
  provider?: { organization: string; url?: string };
  documentationUrl?: string;
}

/** An unsigned card for `NewCard` (identity.md section 2). */
export function newCard(c: NewCard): Record<string, unknown> {
  const base = c.base.replace(/\/+$/, "");
  const params: Record<string, unknown> = {
    protocol: "obi/0.1", sphere: c.sphere, obi_id: c.obi_id, owner: c.owner, owner_key: c.owner_key, key_id: c.key_id, public_key: c.public_key,
    ...(c.seal_public_key !== undefined ? { seal_key_id: c.seal_key_id, seal_public_key: c.seal_public_key } : {}),
    accepts: c.accepts, card_seq: c.card_seq, issued_at: c.issued_at ?? timestamp(Date.now() / 1000),
  };
  return {
    protocolVersion: "0.3.0",
    name: c.name,
    description: c.description,
    url: `${base}/v0.1/spheres/${c.sphere}/members/${c.obi_id}`,
    preferredTransport: "HTTP+JSON",
    version: c.version,
    ...(c.provider ? { provider: c.provider } : {}),
    ...(c.documentationUrl ? { documentationUrl: c.documentationUrl } : {}),
    capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: CARD_EXTENSION_URI, required: true, params }] },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: c.accepts.map((id) => ({ id, ...(DEFAULT_SKILLS[id] ?? { name: id, description: id }), tags: ["obi-action"] })),
  };
}

/** Signs a card with the owner's key: a detached JWS over its canonical JSON (section 2.1). */
export async function signCard(unsigned: Record<string, unknown>, ownerKey: SigningKey): Promise<AgentCard> {
  const { signatures: _signatures, ...rest } = unsigned;
  const protectedHeader = b64url(canonicalBytes({ alg: "EdDSA", kid: ownerKey.keyId, typ: "JOSE" }));
  const signature = await ownerKey.sign(cardSigningInput(rest, protectedHeader));
  return { ...rest, signatures: [{ protected: protectedHeader, signature }] } as unknown as AgentCard;
}
