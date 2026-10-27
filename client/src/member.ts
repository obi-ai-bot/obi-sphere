// A member of a Sphere, from its own side: its key (and seal key), its owner's delegation, the
// token it exchanges them for, and the protocol's rules for what it sends and what it receives.
//
// - Joining: redeem an invitation with a card its owner signed (sphere-api.md section 4).
// - The directory: each card checked, each owner's key pinned the first time it is seen, each
//   member's highest card_seq kept, and the signing keys its trusted cards named remembered
//   (identity.md section 3, "Pinning"). The Sphere's own claims (its key lists, its key ids) are
//   never trusted on their own.
// - Sending: a request to a member whose card it trusts and that accepts the type, a reply to a
//   trusted member that keeps the exchange rules; sealed whenever the receiver's trusted card has a
//   seal key (protocol.md 9.1). Each receipt is kept, checked against the envelope sent.
// - Receiving: each delivery checked as protocol.md section 10 says, signed with a key a trusted
//   card of its sender named, its words opened and handed over as DataText.
// - The chain: verified from seq 1 with every member's key history, and against the head and the
//   own sends this member kept (sphere-api.md section 7.1).
//
// Nothing here acts on what a message says: the words are data, for the caller to show or quote.

import { verifyCard, cardParams, type AgentCard } from "./card.ts";
import { rollbackProblem, verifyChain, type AuditEntry, type ChainMemory } from "./chain.ts";
import { keyIdOf, type SigningKey } from "./crypto.ts";
import {
  CLOCK_SKEW_SECONDS, REQUEST_TYPES, exchangeMessage, exchangeProblem, isReplyType, isRequestType, newReply, newRequest, nowSeconds, seconds, signEnvelope,
  type DirectoryKey, type Envelope, type RequestType, type UnsignedEnvelope,
} from "./envelope.ts";
import { parseInviteLink, type InviteLink } from "./invite.ts";
import type { JsonObject } from "./json.ts";
import { actorAssertion } from "./jws.ts";
import type { Owner } from "./owner.ts";
import { SealKey, sealEnvelope, verifyAndOpen } from "./seal.ts";
import { SphereApi, SphereError, type Delivery, type Fetch, type Member as DirectoryMember, type SendReceipt } from "./sphere.ts";
import { DataText, cardWords, wrapWords, type DataBody } from "./text.ts";

/** A member of the directory as this member sees it: trusted only when its card verifies and its owner key is the one pinned. */
export interface Peer {
  obi: string;
  owner: string;
  status: "active" | "revoked";
  /** The key id of the owner key that signed its card: the fingerprint to compare with that person out of band. */
  fingerprint: string;
  accepts: string[];
  keyId: string;
  sealPublicKey?: string;
  cardSeq: number;
  /** Its card's issued_at. */
  issuedAt: string;
  trusted: boolean;
  /** Why it isn't trusted. */
  problem?: string;
  /** Its card's words, as data. */
  words: ReturnType<typeof cardWords>;
}

/** What a member keeps between runs, besides its keys: the pins, the chain it verified, the ids it saw, its exchanges. */
export interface MemberMemory {
  /** The owner key first seen for each owner (trust on first use). */
  owners: Record<string, string>;
  /** The highest card_seq trusted for each member. */
  cardSeq: Record<string, number>;
  /** The signing key ids each member's trusted cards named: only these sign what this member accepts from it. */
  cardKeys: Record<string, string[]>;
  chain: ChainMemory;
  /** Message ids seen, with when each expires (after that a repeat fails on expiry anyway). */
  seen: Record<string, string>;
  /** Deliveries checked and not acknowledged yet, by delivery id: the message id each carried. */
  delivered: Record<string, string>;
  /** Each exchange this member is a party to: its request and the replies so far, as sent or delivered. */
  exchanges: Record<string, { request: Envelope; replies: Envelope[] }>;
}

export const emptyMemory = (): MemberMemory => ({ owners: {}, cardSeq: {}, cardKeys: {}, chain: { head: null, sends: [] }, seen: {}, delivered: {}, exchanges: {} });

/** A delivered message that passed every check: its words as DataText. */
export interface ReceivedMessage {
  id: string;
  type: string;
  from: string;
  to: string;
  sphere: string;
  correlation_id: string;
  in_reply_to?: string;
  created_at: string;
  expires_at: string;
  /** The sender's owner, from its trusted card (never from the message). */
  owner: string;
  /** The body, every text value a DataText. */
  body: DataBody;
  /** For a reply: the request it answers, as this member sent it. */
  request?: { id: string; type: string; to: string };
}

/** One delivery: a message that passed (`message`), or why it didn't (`problem`). Either way, acknowledge it once handled. */
export interface Received {
  delivery_id: string;
  seq: number;
  relayed_at: string;
  message?: ReceivedMessage;
  /** The library's own words, with the check's code; `detail` says more and may hold what the sender chose, so it is data. */
  problem?: { code: string; message: string; detail: DataText };
  /** The envelope exactly as delivered, for keeping: its words may be bare strings, never give them to an agent. */
  raw(): Envelope;
}

const PROBLEMS: Record<string, string> = {
  payload_too_large: "it is larger than a message may be",
  invalid_envelope: "it doesn't match the protocol's schema or rules",
  wrong_sphere: "it is for another Sphere",
  wrong_recipient: "it is addressed to another member",
  unknown_key: "it isn't signed with a key its sender's trusted card named",
  bad_signature: "its signature doesn't verify",
  expired: "it expired",
  clock_skew: "it was made in the future",
  duplicate: "a message with its id was handled before",
  seal_invalid: "its sealed words don't open for this member",
  not_sealed: "its words should have been sealed",
  untrusted_sender: "its sender's card isn't trusted",
  bad_reply: "it breaks the exchange rules, or replies to no request of this member",
};

export interface MemberOptions {
  api: SphereApi;
  sphere: string;
  obi: string;
  owner: string;
  key: SigningKey;
  sealKey?: SealKey;
  /** The owner's delegation (identity.md 4.1). */
  delegation: string;
  memory?: MemberMemory;
}

export interface JoinOptions {
  /** The invite link, or its parts. */
  link: string | InviteLink;
  owner: Owner;
  /** This member's id: a named invitation's own, or any free id for an open one. */
  obi: string;
  key: SigningKey;
  /** A seal key to publish on the card, so other members seal its words. */
  sealKey?: SealKey;
  accepts: RequestType[];
  name: string;
  description: string;
  version: string;
  scope?: string;
  fetch?: Fetch;
}

export class Member {
  readonly api: SphereApi;
  readonly sphere: string;
  readonly id: string;
  readonly owner: string;
  readonly key: SigningKey;
  readonly sealKey: SealKey | undefined;
  delegation: string;
  memory: MemberMemory;
  #token: { value: string; until: number } | null = null;
  #peers: Map<string, Peer> | null = null;
  #directory: DirectoryMember[] = [];

  constructor(o: MemberOptions) {
    this.api = o.api;
    this.sphere = o.sphere;
    this.id = o.obi;
    this.owner = o.owner;
    this.key = o.key;
    this.sealKey = o.sealKey;
    this.delegation = o.delegation;
    // A memory kept by an earlier version lacks the newer parts: they start empty.
    this.memory = { ...emptyMemory(), ...(o.memory ?? {}) };
  }

  /** Joins with an invitation: the owner signs the card and the delegation, the member redeems it (sphere-api.md section 4). */
  static async join(o: JoinOptions): Promise<Member> {
    const link = typeof o.link === "string" ? parseInviteLink(o.link) : o.link;
    if (link.owner !== undefined && (link.owner !== o.owner.id || link.obi !== o.obi)) {
      throw new Error(`this invitation is for ${link.obi} of ${link.owner}`);
    }
    const api = new SphereApi(link.base, o.fetch ? { fetch: o.fetch } : {});
    const card = await o.owner.card({
      base: api.base, sphere: link.sphere, obi_id: o.obi, public_key: o.key.publicKey, key_id: o.key.keyId,
      ...(o.sealKey ? { seal_public_key: o.sealKey.publicKey, seal_key_id: o.sealKey.keyId } : {}),
      accepts: o.accepts, card_seq: 1, name: o.name, description: o.description, version: o.version,
    });
    await api.redeem(link.sphere, link.id, { secret: link.secret, owner_key: o.owner.key.publicKey, card });
    const memory = emptyMemory();
    memory.owners[o.owner.id] = o.owner.key.publicKey;
    memory.cardSeq[o.obi] = 1;
    memory.cardKeys[o.obi] = [o.key.keyId];
    const delegation = await o.owner.delegation(link.sphere, o.obi, o.scope ? { scope: o.scope } : {});
    return new Member({ api, sphere: link.sphere, obi: o.obi, owner: o.owner.id, key: o.key, sealKey: o.sealKey, delegation, memory });
  }

  /** An access token: the one it has while it has more than a minute left, else a new exchange. */
  async accessToken(): Promise<string> {
    if (this.#token && this.#token.until - 60 > nowSeconds()) return this.#token.value;
    const t = await this.api.token({ subject: this.delegation, actor: await actorAssertion(this.key, { obi: this.id, sphere: this.sphere }) });
    this.#token = { value: t.access_token, until: nowSeconds() + t.expires_in };
    return t.access_token;
  }

  /** The directory, every card checked and the owners pinned (identity.md section 3). */
  async directory(): Promise<Peer[]> {
    const members = await this.api.members(await this.accessToken(), this.sphere);
    this.#directory = members;
    const now = nowSeconds();
    const peers = new Map<string, Peer>();
    for (const m of members) peers.set(m.obi, await this.#judge(m, now));
    this.#peers = peers;
    return [...peers.values()];
  }

  async #judge(m: DirectoryMember, now: number): Promise<Peer> {
    const card = m.card as AgentCard;
    const verdict = await verifyCard(card, { now, bound_owner_key: m.owner_key });
    const params = verdict.ok ? cardParams(card) : undefined;
    const peer: Peer = {
      obi: m.obi, owner: m.owner, status: m.status, fingerprint: params ? await keyIdOf(params.owner_key) : "", accepts: params?.accepts ?? [],
      keyId: params?.key_id ?? "", ...(params?.seal_public_key ? { sealPublicKey: params.seal_public_key } : {}), cardSeq: params?.card_seq ?? 0,
      issuedAt: params?.issued_at ?? "", trusted: false, words: cardWords(card, { from: m.obi, owner: m.owner }),
    };
    const untrusted = (problem: string): Peer => ({ ...peer, problem });
    if (!verdict.ok || !params) return untrusted(`its card fails: ${verdict.ok ? "" : verdict.code}`);
    if (params.obi_id !== m.obi || params.owner !== m.owner || params.sphere !== this.sphere) return untrusted("its card names another member");
    if (m.status === "active" && !m.keys.some((k) => k.key_id === params.key_id && k.valid_until_seq === null)) return untrusted("its card's key is not its current key");
    const pinned = this.memory.owners[m.owner];
    if (pinned !== undefined && pinned !== params.owner_key) return untrusted(`its owner ${m.owner}'s key changed: compare fingerprints with them before trusting it`);
    const kept = this.memory.cardSeq[m.obi];
    if (kept !== undefined && params.card_seq < kept) return untrusted(`its card is older (card_seq ${params.card_seq}) than one trusted before (${kept})`);
    this.memory.owners[m.owner] = params.owner_key;
    this.memory.cardSeq[m.obi] = params.card_seq;
    const named = this.memory.cardKeys[m.obi] ?? [];
    if (!named.includes(params.key_id)) this.memory.cardKeys[m.obi] = [...named, params.key_id];
    return { ...peer, trusted: true };
  }

  async #peer(obi: string, refresh = false): Promise<Peer | undefined> {
    if (refresh || !this.#peers || !this.#peers.has(obi)) await this.directory();
    return this.#peers!.get(obi);
  }

  /** Every member's keys from the directory, as the chain's verifier takes them (sphere-api.md section 7.1). */
  #directoryKeys(): Record<string, DirectoryKey> {
    const keys: Record<string, DirectoryKey> = {};
    for (const m of this.#directory) for (const k of m.keys) keys[k.key_id] = { obi: m.obi, public_key: k.public_key, valid_from_seq: k.valid_from_seq, valid_until_seq: k.valid_until_seq };
    return keys;
  }

  /** The directory's keys that a trusted card of their member named: what a delivery may be signed with. */
  #trustedKeys(): Record<string, DirectoryKey> {
    const all = this.#directoryKeys();
    return Object.fromEntries(Object.entries(all).filter(([id, k]) => this.memory.cardKeys[k.obi]?.includes(id)));
  }

  async #sendSigned(unsigned: UnsignedEnvelope, recipient: Peer): Promise<{ envelope: Envelope; receipt: SendReceipt }> {
    if (!recipient.trusted) throw new Error(`${recipient.obi} is not trusted: ${recipient.problem}`);
    const sealed = recipient.sealPublicKey ? await sealEnvelope(unsigned, recipient.sealPublicKey) : unsigned;
    const envelope = await signEnvelope(sealed, this.key);
    const receipt = await this.api.send(await this.accessToken(), envelope);
    if (receipt.id !== envelope.id) throw new SphereError(202, "bad_response", "the Sphere's receipt names another message than the one sent");
    this.memory.chain.sends = [...(this.memory.chain.sends ?? []), { seq: receipt.seq, hash: receipt.entry_hash, id: envelope.id }];
    return { envelope, receipt };
  }

  /** Sends a request to `to`, a member whose card this member trusts and that accepts `type`. */
  async request(to: string, type: RequestType, body: JsonObject, o: { expiresIn?: number } = {}): Promise<{ id: string; envelope: Envelope; receipt: SendReceipt }> {
    if (!isRequestType(type)) throw new Error(`${type} is not a request`);
    const peer = await this.#peer(to, true);
    if (!peer) throw new Error(`${to} is not a member`);
    if (peer.status !== "active") throw new Error(`${to} was revoked`);
    if (!peer.trusted) throw new Error(`${to} is not trusted: ${peer.problem}`);
    if (!peer.accepts.includes(type)) throw new Error(`${to} doesn't accept ${type}`);
    const unsigned = newRequest({ sphere: this.sphere, from: this.id, to, type, body, keyId: this.key.keyId, ...(o.expiresIn ? { expiresIn: o.expiresIn } : {}) });
    const sent = await this.#sendSigned(unsigned, peer);
    this.memory.exchanges[sent.envelope.id] = { request: sent.envelope, replies: [] };
    this.#remember(sent.envelope);
    return { id: sent.envelope.id, ...sent };
  }

  ask(to: string, q: { text: string; about?: JsonObject[]; choices?: string[] }, o: { expiresIn?: number } = {}) {
    return this.request(to, "question", q as JsonObject, o);
  }

  requestReview(to: string, body: JsonObject, o: { expiresIn?: number } = {}) {
    return this.request(to, "review_request", body, o);
  }

  handOff(to: string, body: JsonObject, o: { expiresIn?: number } = {}) {
    return this.request(to, "handoff", body, o);
  }

  /** Replies to a request this member received (or, for the sender's own replies, sent): to a trusted member, keeping the exchange rules. */
  async reply(requestId: string, type: string, body: JsonObject, o: { expiresIn?: number } = {}): Promise<{ id: string; envelope: Envelope; receipt: SendReceipt }> {
    const exchange = this.memory.exchanges[requestId];
    if (!exchange) throw new Error(`no exchange ${requestId}`);
    const unsigned = newReply(exchange.request, { from: this.id, type, body, keyId: this.key.keyId, ...(o.expiresIn ? { expiresIn: o.expiresIn } : {}) });
    const problem = exchangeProblem(exchangeMessage(unsigned as Envelope), exchangeMessage(exchange.request), exchange.replies.map(exchangeMessage));
    if (problem) throw new Error(`that reply breaks the exchange rules: ${problem}`);
    const peer = await this.#peer(unsigned.to, true);
    if (!peer) throw new Error(`${unsigned.to} is not a member`);
    const sent = await this.#sendSigned(unsigned, peer);
    exchange.replies.push(sent.envelope);
    this.#remember(sent.envelope);
    return { id: sent.envelope.id, ...sent };
  }

  accept(requestId: string, o: { byRule?: string } = {}) {
    return this.reply(requestId, "accept", o.byRule ? { by_rule: o.byRule } : {});
  }

  decline(requestId: string, reason: string, o: { note?: string; byRule?: string } = {}) {
    return this.reply(requestId, "decline", { reason, ...(o.note ? { note: o.note } : {}), ...(o.byRule ? { by_rule: o.byRule } : {}) });
  }

  answer(requestId: string, a: { text: string; by?: "obi" | "owner"; refs?: JsonObject[]; choice?: number; byRule?: string }) {
    return this.reply(requestId, "answer", {
      by: a.by ?? "obi", text: a.text, ...(a.refs ? { refs: a.refs } : {}), ...(a.choice !== undefined ? { choice: a.choice } : {}), ...(a.byRule ? { by_rule: a.byRule } : {}),
    });
  }

  #remember(env: Envelope) {
    this.memory.seen[env.id] = env.expires_at;
  }

  /**
   * The deliveries waiting (sphere-api.md section 6.2), each checked: section 10 with the keys its
   * sender's trusted cards named, valid at the delivery's seq; its words opened; from a trusted
   * sender; and for a reply, the exchange rules against the request this member sent. A delivery
   * checked before and not acknowledged comes back the same (at least once, as the Sphere delivers).
   * Acknowledge each with `ack` once you have recorded what you decided.
   */
  async receive(o: { wait?: number; limit?: number } = {}): Promise<Received[]> {
    const deliveries = await this.api.deliveries(await this.accessToken(), this.sphere, o);
    const out: Received[] = [];
    for (const d of deliveries) out.push(await this.#check(d));
    this.#prune();
    return out;
  }

  async #check(d: Delivery): Promise<Received> {
    const raw = structuredClone(d.envelope);
    const base = { delivery_id: d.delivery_id, seq: d.seq, relayed_at: d.relayed_at, raw: () => structuredClone(raw) };
    const env = d.envelope;
    const from = typeof env?.from === "string" ? env.from : "";
    const reject = (code: string, detail: string): Received => ({
      ...base, problem: { code, message: PROBLEMS[code] ?? "it fails a check", detail: new DataText(detail, { from: from || "unknown", type: "verdict", field: "/" }) },
    });
    // A delivery this member checked already and didn't acknowledge: the same message again.
    const again = typeof env?.id === "string" && this.memory.delivered[d.delivery_id] === env.id && Object.hasOwn(this.memory.seen, env.id);
    const keyId = typeof env?.key_id === "string" ? env.key_id : "";
    const sender = await this.#peer(from, !Object.hasOwn(this.#trustedKeys(), keyId));
    const own = this.#peers?.get(this.id);
    // Check 11's "both seal": the sender's trusted card and this member's own card had a seal key when it was written.
    const bothSealed = !!sender?.trusted && !!sender.sealPublicKey && !!own?.sealPublicKey &&
      seconds(typeof env?.created_at === "string" ? env.created_at : "") >= Math.max(seconds(sender.issuedAt), seconds(own.issuedAt)) + CLOCK_SKEW_SECONDS;
    const verdict = await verifyAndOpen(env, {
      now: nowSeconds(), sphere: this.sphere, receiver: this.id, keys: this.#trustedKeys(), seq: d.seq,
      seen_ids: !again && typeof env?.id === "string" && Object.hasOwn(this.memory.seen, env.id) ? [env.id] : [],
      seal_keys: this.sealKey ? { [this.sealKey.keyId]: this.sealKey } : {}, sender_seals: bothSealed,
    });
    if (!verdict.ok) return reject(verdict.code, verdict.message);
    if (!sender || !sender.trusted) return reject("untrusted_sender", sender ? sender.problem ?? "not trusted" : `${from} is not in the directory`);
    const message: ReceivedMessage = {
      id: env.id, type: env.type, from: env.from, to: env.to, sphere: env.sphere, correlation_id: env.correlation_id,
      ...(env.in_reply_to ? { in_reply_to: env.in_reply_to } : {}), created_at: env.created_at, expires_at: env.expires_at,
      owner: sender.owner, body: wrapWords(env.type, verdict.body, { from: env.from, owner: sender.owner }),
    };
    if (isReplyType(env.type)) {
      const exchange = this.memory.exchanges[env.in_reply_to!];
      if (!exchange) return reject("bad_reply", "it replies to no request this member knows");
      if (!again) {
        const problem = exchangeProblem(exchangeMessage(env), exchangeMessage(exchange.request), exchange.replies.map(exchangeMessage));
        if (problem) return reject("bad_reply", problem);
        if (env.type === "answer" && typeof verdict.body.choice === "number") {
          const count = (exchange.request.body.choices as unknown[] | undefined)?.length;
          if (count === undefined || verdict.body.choice >= count) return reject("bad_reply", "its choice is not one of the question's choices");
        }
        exchange.replies.push(env);
      }
      message.request = { id: exchange.request.id, type: exchange.request.type, to: exchange.request.to };
    } else if ((REQUEST_TYPES as readonly string[]).includes(env.type) && !again) {
      this.memory.exchanges[env.id] = { request: env, replies: [] };
    }
    this.memory.seen[env.id] = env.expires_at;
    this.memory.delivered[d.delivery_id] = env.id;
    return { ...base, message };
  }

  /** Forgets seen ids and finished exchanges whose messages expired more than a day ago. */
  #prune() {
    const cutoff = nowSeconds() - 86400;
    for (const [id, expires] of Object.entries(this.memory.seen)) if (seconds(expires) < cutoff) delete this.memory.seen[id];
    for (const [id, x] of Object.entries(this.memory.exchanges)) {
      const last = [x.request, ...x.replies].reduce((t, e) => Math.max(t, seconds(e.expires_at)), 0);
      if (last < cutoff) delete this.memory.exchanges[id];
    }
    for (const [delivery, id] of Object.entries(this.memory.delivered)) if (!Object.hasOwn(this.memory.seen, id)) delete this.memory.delivered[delivery];
  }

  /** Acknowledges deliveries (sphere-api.md section 6.2): only once what was decided about each is recorded. */
  async ack(deliveryIds: string[]): Promise<number> {
    let acked = 0;
    for (let i = 0; i < deliveryIds.length; i += 100) {
      const batch = deliveryIds.slice(i, i + 100);
      acked += await this.api.ack(await this.accessToken(), this.sphere, batch);
      for (const id of batch) delete this.memory.delivered[id];
    }
    return acked;
  }

  /**
   * Verifies the whole chain (sphere-api.md section 7.1) with every member's key history, and that
   * it keeps the head this member verified before and each of its own sends. On success it keeps
   * the new head.
   */
  async verifyChain(): Promise<{ ok: true; head: { seq: number; hash: string }; entries: AuditEntry[] } | { ok: false; code: string; message: string }> {
    const token = await this.accessToken();
    const page = await this.api.auditAll(token, this.sphere);
    this.#directory = await this.api.members(token, this.sphere);
    const verdict = await verifyChain({ sphere: page.sphere, entries: page.entries }, { keys: this.#directoryKeys() });
    if (!verdict.ok) return verdict as { ok: false; code: string; message: string };
    const problem = rollbackProblem(page.entries, this.memory.chain);
    if (problem) return { ok: false, code: "conflict", message: problem };
    const last = page.entries[page.entries.length - 1];
    const head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: "0".repeat(64) };
    this.memory.chain.head = head;
    return { ok: true, head, entries: page.entries };
  }
}

export { SphereError };
