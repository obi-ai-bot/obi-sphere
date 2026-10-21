// Reference implementation of the Obi-to-Obi protocol v0.1 checks: canonical JSON (RFC 8785),
// Ed25519 keys and signatures, envelope, agent card and audit chain verification.
// It is what the conformance runner judges fixtures with, and it is meant to be read next to
// spec/protocol.md, spec/identity.md and spec/sphere-api.md. Node >= 22, node:crypto only, plus ajv.

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign, verify } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export const PROTOCOL = "obi/0.1";
export const ENVELOPE_SIGNING_PREFIX = "obi/0.1 envelope\n";
export const AUDIT_HASH_PREFIX = "obi/0.1 audit\n";
export const CARD_EXTENSION_URI = "urn:obi-sphere:ext:obi:0.1";
export const MAX_ENVELOPE_BYTES = 65536;
export const MAX_LIFETIME_SECONDS = 2592000;
export const CLOCK_SKEW_SECONDS = 300;
export const ZERO_HASH = "0".repeat(64);
export const REQUEST_TYPES = ["review_request", "question", "handoff", "run_request", "share_offer"];
export const REPLY_TYPES = ["status", "accept", "decline", "result", "answer", "run_progress", "run_return", "run_cancel", "share_status", "share_revoke"];
export const ACTION_TYPES = [...REQUEST_TYPES, ...REPLY_TYPES];
export const TERMINAL_TYPES = ["decline", "result", "answer", "run_return", "run_cancel", "share_revoke"];
// The replies that belong only to a run_request's exchange (spec/protocol.md section 4, rule 7).
export const RUN_REPLY_TYPES = ["run_progress", "run_return", "run_cancel"];
// What a share_offer's exchange takes, and nothing else (spec/protocol.md section 4, rule 8).
export const SHARE_REPLY_TYPES = ["share_status", "share_revoke", "decline"];
// The replies a request's own sender sends, to its receiver (spec/protocol.md section 4, rule 1).
export const SENDER_REPLY_TYPES = ["run_cancel", "share_status", "share_revoke"];
export const SEVERITY_RANK = { nit: 1, minor: 2, major: 3, blocker: 4 };

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_DIR = join(here, "..", "..");
export const SCHEMA_DIR = join(SPEC_DIR, "schemas", "v0.1");
export const SCHEMA_BASE = "https://github.com/obi-ai-bot/obi-sphere/raw/main/spec/schemas/v0.1/";

// ---------------------------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme.
// Object keys are sorted by their UTF-16 code units (JavaScript's default string order), strings
// and numbers are serialized as ECMAScript's JSON.stringify does. The protocol only has integers,
// so number formatting never matters in practice; non-finite numbers are refused.

export function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("JCS: string with a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => {
      if (!k.isWellFormed()) throw new Error("JCS: key with a lone surrogate");
      return JSON.stringify(k) + ":" + canonicalize(value[k]);
    }).join(",") + "}";
  }
  throw new Error(`JCS: cannot canonicalize ${typeof value}`);
}

export const canonicalBytes = (value) => Buffer.from(canonicalize(value), "utf8");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
export const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
export const fromB64url = (text) => Buffer.from(text, "base64url");

// ---------------------------------------------------------------------------------------------
// Keys. A conformance key is derived from a public seed string: seed = SHA-256(UTF-8(string)).
// Never use a derived key for anything but tests: anyone can derive it.

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function keyFromSeed(seed32) {
  if (seed32.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const raw = fromB64url(publicKey.export({ format: "jwk" }).x);
  return { privateKey, publicKey: b64url(raw), keyId: keyIdOf(b64url(raw)) };
}

export const keyFromSeedString = (seedString) => keyFromSeed(sha256(Buffer.from(seedString, "utf8")));

// ---------------------------------------------------------------------------------------------
// The job channel (protocol.md section 13): the hello's signature, the salt, the two keys, the
// nonces and a frame. The known-answer vectors in channel-vectors.json come from these.

export const CHANNEL_HELLO_PREFIX = "obi/0.1 channel\n";
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** An X25519 key from 32 private bytes: the key object and its raw public key. */
export function x25519FromPrivate(raw32) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw32]), format: "der", type: "pkcs8" });
  return { privateKey, publicRaw: fromB64url(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}

export const x25519Shared = (privateKey, peerRaw32) =>
  diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, peerRaw32]), format: "der", type: "spki" }) });

/** What a hello's signature covers: the prefix, then the canonical JSON of the hello without it. */
export function helloSigningInput(hello) {
  const { signature: _signature, ...rest } = hello;
  return Buffer.concat([Buffer.from(CHANNEL_HELLO_PREFIX, "utf8"), canonicalBytes(rest)]);
}

export const signHello = (unsigned, privateKey) => ({ ...unsigned, signature: signBytes(privateKey, helloSigningInput(unsigned)) });

/** salt = SHA-256(guest's hello bytes ‖ host's hello bytes); one 32-byte key each way. */
export function channelKeys(shared, guestHelloBytes, hostHelloBytes) {
  const salt = sha256(Buffer.concat([guestHelloBytes, hostHelloBytes]));
  const key = (info) => Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(info, "utf8"), 32));
  return { salt, guestToHost: key("obi/0.1 channel guest>host"), hostToGuest: key("obi/0.1 channel host>guest") };
}

/** 4 zero bytes, then the frame's number in its direction, big-endian 64-bit. */
export function channelNonce(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

/** A frame on the wire: ChaCha20-Poly1305 of (stream u32 BE, kind byte, payload), the tag after. */
export function sealFrame(key, counter, stream, kind, payload) {
  const plain = Buffer.alloc(5 + payload.length);
  plain.writeUInt32BE(stream, 0);
  plain[4] = kind;
  Buffer.from(payload).copy(plain, 5);
  const cipher = createCipheriv("chacha20-poly1305", key, channelNonce(counter), { authTagLength: 16 });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function openFrame(key, counter, wire) {
  const decipher = createDecipheriv("chacha20-poly1305", key, channelNonce(counter), { authTagLength: 16 });
  decipher.setAuthTag(wire.subarray(wire.length - 16));
  const plain = Buffer.concat([decipher.update(wire.subarray(0, wire.length - 16)), decipher.final()]);
  return { stream: plain.readUInt32BE(0), kind: plain[4], payload: plain.subarray(5) };
}

export function keyIdOf(publicKeyB64url) {
  const raw = fromB64url(publicKeyB64url);
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return "ed25519:" + b64url(sha256(raw));
}

export function publicKeyObject(publicKeyB64url) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, format: "jwk" });
}

export const signBytes = (privateKey, bytes) => b64url(sign(null, bytes, privateKey));

export function verifyBytes(publicKeyB64url, bytes, signatureB64url) {
  try {
    const sig = fromB64url(signatureB64url);
    if (sig.length !== 64) return false;
    return verify(null, bytes, publicKeyObject(publicKeyB64url), sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Envelope signing: Ed25519 over UTF-8("obi/0.1 envelope\n") followed by the JCS form of the
// envelope without its `signature` member.

export function envelopeSigningInput(envelope) {
  const { signature, ...unsigned } = envelope;
  return Buffer.concat([Buffer.from(ENVELOPE_SIGNING_PREFIX, "utf8"), canonicalBytes(unsigned)]);
}

export function signEnvelope(unsigned, privateKey) {
  const { signature, ...rest } = unsigned;
  return { ...rest, signature: signBytes(privateKey, envelopeSigningInput(rest)) };
}

// ---------------------------------------------------------------------------------------------
// JWS (RFC 7515) with EdDSA (RFC 8037): owner and Obi assertions (compact JWT) and the agent
// card's detached signature (A2A AgentCardSignature).

export const jwsHeader = (kid, typ) => b64url(canonicalBytes({ alg: "EdDSA", kid, typ }));

export function signJwt(claims, privateKey, kid) {
  const head = jwsHeader(kid, "JWT");
  const body = b64url(canonicalBytes(claims));
  return `${head}.${body}.${signBytes(privateKey, Buffer.from(`${head}.${body}`, "ascii"))}`;
}

export function cardSigningInput(card, protectedHeader) {
  const { signatures, ...unsigned } = card;
  return Buffer.from(`${protectedHeader}.${b64url(canonicalBytes(unsigned))}`, "ascii");
}

export function signCard(unsignedCard, ownerPrivateKey, ownerKeyId) {
  const { signatures, ...rest } = unsignedCard;
  const protectedHeader = jwsHeader(ownerKeyId, "JOSE");
  return { ...rest, signatures: [{ protected: protectedHeader, signature: signBytes(ownerPrivateKey, cardSigningInput(rest, protectedHeader)) }] };
}

// ---------------------------------------------------------------------------------------------
// Findings: the recommended stable id (spec/protocol.md, "Findings").

export function findingId(file, line, title) {
  return "f-" + sha256(Buffer.from(`${file}\n${line}\n${title}`, "utf8")).toString("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Schemas.

function schemaFiles(dir = SCHEMA_DIR) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? schemaFiles(path) : name.endsWith(".schema.json") ? [path] : [];
  });
}

export function loadSchemas() {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true, validateFormats: false });
  // The annotation keyword the spec defines: the string is data written by someone else.
  ajv.addKeyword({ keyword: "x-obi-text", metaSchema: { enum: ["data"] } });
  const schemas = {};
  for (const path of schemaFiles()) {
    const schema = JSON.parse(readFileSync(path, "utf8"));
    const name = relative(SCHEMA_DIR, path).replace(/\.schema\.json$/, "");
    if (schema.$id !== SCHEMA_BASE + relative(SCHEMA_DIR, path)) throw new Error(`${name}: $id does not match its path`);
    schemas[name] = schema;
    ajv.addSchema(schema);
  }
  const validators = {};
  for (const [name, schema] of Object.entries(schemas)) validators[name] = ajv.getSchema(schema.$id);
  return { ajv, schemas, validators };
}

let loaded;
export const schemas = () => (loaded ??= loadSchemas());

export function schemaErrors(name, value) {
  const validate = schemas().validators[name];
  if (!validate) throw new Error(`no schema ${name}`);
  return validate(value) ? [] : validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`);
}

// ---------------------------------------------------------------------------------------------
// Envelope verification (spec/protocol.md, "Verifying a message").

const seconds = (timestamp) => Date.parse(timestamp) / 1000;
const fail = (code, message) => ({ ok: false, code, message });
const OK = { ok: true };

// Checks that need more than one field. The schema has run already.
export function semanticProblems(env) {
  const problems = [];
  const t = env.type;
  if (Number.isNaN(seconds(env.created_at)) || Number.isNaN(seconds(env.expires_at))) problems.push("a timestamp is not a real date");
  if (new Date(seconds(env.created_at) * 1000).toISOString().replace(".000Z", "Z") !== env.created_at) problems.push("created_at is not a real date");
  if (new Date(seconds(env.expires_at) * 1000).toISOString().replace(".000Z", "Z") !== env.expires_at) problems.push("expires_at is not a real date");
  if (!(seconds(env.expires_at) > seconds(env.created_at))) problems.push("expires_at must be after created_at");
  if (seconds(env.expires_at) - seconds(env.created_at) > MAX_LIFETIME_SECONDS) problems.push(`a message may live at most ${MAX_LIFETIME_SECONDS} seconds`);
  if (env.from === env.to) problems.push("from and to must differ");
  if (REQUEST_TYPES.includes(t) && env.correlation_id !== env.id) problems.push("a request's correlation_id must equal its id");
  if (REPLY_TYPES.includes(t) && env.in_reply_to !== env.correlation_id) problems.push("a reply's in_reply_to must equal its correlation_id");
  const body = env.body;
  if (t === "result") problems.push(...resultProblems(body));
  problems.push(...refProblems(body));
  for (const finding of body.findings ?? []) {
    if (finding.end_line !== undefined && finding.end_line < finding.line) problems.push(`finding ${finding.id}: end_line before line`);
  }
  return problems;
}

// The references in one list are distinct, repositories compared ignoring ASCII case
// (spec/protocol.md section 5.9): `Acme/App` and `acme/app` name the same repository.
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
export function refProblems(body) {
  const problems = [];
  for (const list of ["about", "refs"]) {
    const seen = new Set();
    for (const ref of body[list] ?? []) {
      const key = canonicalize({ ...ref, repo: asciiLower(ref.repo) });
      if (seen.has(key)) problems.push(`${list}: the same reference twice`);
      seen.add(key);
    }
  }
  return problems;
}

export function resultProblems(body) {
  const problems = [];
  const findings = body.findings ?? [];
  const ids = new Set();
  for (const f of findings) {
    if (ids.has(f.id)) problems.push(`finding id ${f.id} appears twice`);
    ids.add(f.id);
  }
  const acceptance = body.acceptance ?? [];
  const indexes = new Set();
  for (const a of acceptance) {
    if (indexes.has(a.index)) problems.push(`acceptance index ${a.index} appears twice`);
    indexes.add(a.index);
    if (body.for === "review_request") {
      if (a.kind === "no_blocker_findings" && a.met !== !findings.some((f) => f.severity === "blocker")) problems.push("no_blocker_findings: met disagrees with the findings");
      if (a.kind === "no_findings_at_or_above" && a.met !== !findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[a.severity])) problems.push("no_findings_at_or_above: met disagrees with the findings");
    }
  }
  const allMet = acceptance.length > 0 && acceptance.every((a) => a.met);
  if (body.outcome === "approved" && !allMet) problems.push("approved needs every acceptance condition met");
  if (body.outcome === "changes_requested" && allMet) problems.push("changes_requested needs an acceptance condition not met");
  if (body.for === "handoff" && body.outcome === "done" && !allMet) problems.push("done needs every acceptance condition met");
  return problems;
}

// ctx: { now, sphere, receiver, keys: { [key_id]: { obi, public_key, valid_from_seq?, valid_until_seq? } },
//        seq?, seen_ids?: [] }
// receiver is the obi_id of the Obi judging the message: a message addressed to another Obi is
// rejected, however well it is signed (a Sphere that misroutes, or relays a captured message).
// seq is the message's audit seq (a delivery's `seq`). A key with a validity range must be valid at
// seq; without seq (a message not yet recorded, as the Sphere sees one at send) it must be current.
export function keyValidAt(key, seq) {
  if (key.valid_from_seq === undefined && key.valid_until_seq === undefined) return true;
  if (seq === undefined || seq === null) return key.valid_until_seq === null || key.valid_until_seq === undefined;
  return seq >= (key.valid_from_seq ?? 1) && (key.valid_until_seq === null || key.valid_until_seq === undefined || seq <= key.valid_until_seq);
}

export function verifyEnvelope(env, ctx) {
  let size;
  try {
    size = canonicalBytes(env).length;
  } catch (e) {
    return fail("invalid_envelope", e.message);
  }
  if (size > MAX_ENVELOPE_BYTES) return fail("payload_too_large", `${size} bytes canonical, the most is ${MAX_ENVELOPE_BYTES}`);
  const errors = schemaErrors("envelope", env);
  if (errors.length) return fail("invalid_envelope", errors.slice(0, 5).join("; "));
  const problems = semanticProblems(env);
  if (problems.length) return fail("invalid_envelope", problems.join("; "));
  if (env.sphere !== ctx.sphere) return fail("wrong_sphere", `for ${env.sphere}, not ${ctx.sphere}`);
  if (typeof ctx.receiver !== "string") return fail("wrong_recipient", "the context names no receiver");
  if (env.to !== ctx.receiver) return fail("wrong_recipient", `addressed to ${env.to}, not ${ctx.receiver}`);
  const key = ctx.keys?.[env.key_id];
  if (!key || key.obi !== env.from) return fail("unknown_key", `${env.key_id} is not a key of ${env.from}`);
  if (keyIdOf(key.public_key) !== env.key_id) return fail("unknown_key", "the directory's key does not hash to key_id");
  if (!keyValidAt(key, ctx.seq)) return fail("unknown_key", ctx.seq === undefined ? `${env.key_id} is not ${env.from}'s current key` : `${env.key_id} was not valid at seq ${ctx.seq}`);
  if (!verifyBytes(key.public_key, envelopeSigningInput(env), env.signature)) return fail("bad_signature", "the signature does not verify");
  const now = seconds(ctx.now);
  if (!(seconds(env.expires_at) > now)) return fail("expired", `expired at ${env.expires_at}`);
  if (seconds(env.created_at) > now + CLOCK_SKEW_SECONDS) return fail("clock_skew", `created_at is more than ${CLOCK_SKEW_SECONDS} seconds ahead`);
  if ((ctx.seen_ids ?? []).includes(env.id)) return fail("duplicate", `${env.id} was seen before`);
  return OK;
}

// ---------------------------------------------------------------------------------------------
// Agent card verification (spec/identity.md, "Verifying a card").
// ctx: { now, bound_owner_key?: <public key the Sphere bound for this owner> }

export function verifyCard(card, ctx) {
  const errors = schemaErrors("agent-card", card);
  if (errors.length) return fail("card_invalid", errors.slice(0, 5).join("; "));
  const params = card.capabilities.extensions[0].params;
  if (keyIdOf(params.public_key) !== params.key_id) return fail("card_invalid", "key_id does not match public_key");
  if (params.owner_key === params.public_key) return fail("card_invalid", "the Obi's key must not be its owner's key");
  const skills = card.skills.map((s) => s.id).sort().join(",");
  if (skills !== [...params.accepts].sort().join(",")) return fail("card_invalid", "skills and accepts differ");
  const urlTail = `/v0.1/spheres/${params.sphere}/members/${params.obi_id}`;
  if (!card.url.endsWith(urlTail)) return fail("card_invalid", `url must end with ${urlTail}`);
  if (ctx.bound_owner_key && ctx.bound_owner_key !== params.owner_key) return fail("card_invalid", "signed by another key than the owner's bound key");
  const sig = card.signatures[0];
  let header;
  try {
    header = JSON.parse(fromB64url(sig.protected).toString("utf8"));
  } catch {
    return fail("card_invalid", "the protected header is not JSON");
  }
  const headerErrors = schemaErrors("wire/jws-header", header);
  if (headerErrors.length || header.typ !== "JOSE") return fail("card_invalid", "the protected header must be {alg: EdDSA, kid, typ: JOSE}");
  if (header.kid !== keyIdOf(params.owner_key)) return fail("card_invalid", "kid is not the owner key's id");
  if (!verifyBytes(params.owner_key, cardSigningInput(card, sig.protected), sig.signature)) return fail("bad_signature", "the owner's signature does not verify");
  if (ctx.now && seconds(params.issued_at) > seconds(ctx.now) + CLOCK_SKEW_SECONDS) return fail("card_invalid", "issued in the future");
  return OK;
}

// ---------------------------------------------------------------------------------------------
// Audit chain (spec/sphere-api.md, "Audit chain").

export function entryHash(entry) {
  const { hash, ...rest } = entry;
  return sha256(Buffer.concat([Buffer.from(AUDIT_HASH_PREFIX, "utf8"), canonicalBytes(rest)])).toString("hex");
}

export function appendEntry(entries, sphere, envelope, recordedAt) {
  const prev = entries.length ? entries[entries.length - 1].hash : ZERO_HASH;
  const entry = { sphere, seq: entries.length + 1, prev, recorded_at: recordedAt, envelope };
  return [...entries, { ...entry, hash: entryHash(entry) }];
}

// The exchange rules (spec/protocol.md section 4), as the Sphere applies them at send
// (sphere-api.md section 6.1, check 12) and a chain's verifier at each reply (section 7.1, check 7).
// reply: the reply envelope; request: the envelope its in_reply_to names, or undefined;
// earlier: the replies to that request that came before it, in order. Answers why the reply
// breaks the rules, or null when it doesn't.
export function exchangeProblem(reply, request, earlier) {
  if (!request || !REQUEST_TYPES.includes(request.type)) return "replies to no earlier request";
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
  // At most one accept per exchange; a status may come before it or after it.
  if (reply.type === "accept" && accepted) return "accepted twice";
  if (reply.type === "result") {
    if (reply.body.for !== request.type) return `a result for ${reply.body.for} answers a ${request.type}`;
    // A result (for a review_request or a handoff) comes only after the accept.
    if (!accepted) return `a ${request.type} is answered by a result only after an accept`;
  }
  // A run_return comes back only from a job that was accepted.
  if (reply.type === "run_return" && !accepted) return "a run_request is answered by a run_return only after an accept";
  // An answer answers a question, and nothing else; an accept before it is allowed, not needed.
  if (reply.type === "answer" && request.type !== "question") return `an answer answers a question, not a ${request.type}`;
  // No words in a guest job's or a share's exchange: a decline there has no note, and a guest job's takes no status.
  if (reply.type === "status" && request.type === "run_request") return "a run_request takes no status";
  if (reply.type === "decline" && ["run_request", "share_offer"].includes(request.type) && reply.body?.note !== undefined) return `a decline of a ${request.type} has no note`;
  // Nor why its host declined, which would say when its owner is at the Mac or what its rules are.
  const runDeclineReasons = ["unavailable", "expired", "out_of_scope", "share_used"];
  if (reply.type === "decline" && request.type === "run_request" && (!runDeclineReasons.includes(reply.body?.reason) || reply.body?.by_rule !== undefined))
    return `a decline of a run_request says only ${runDeclineReasons.join(", ")}, with no by_rule`;
  return null;
}

// chain: { sphere, entries }, ctx: { keys: { [key_id]: { obi, public_key, valid_from_seq, valid_until_seq } } }
export function verifyChain(chain, ctx) {
  if (!chain || typeof chain.sphere !== "string" || !Array.isArray(chain.entries)) return fail("bad_request", "a chain is {sphere, entries}");
  let prev = ZERO_HASH;
  let lastTime = -Infinity;
  const byId = new Map();
  for (const [i, entry] of chain.entries.entries()) {
    const at = `entry ${i + 1}`;
    const errors = schemaErrors("audit-entry", entry);
    if (errors.length) return fail("invalid_envelope", `${at}: ${errors.slice(0, 3).join("; ")}`);
    if (entry.seq !== i + 1) return fail("conflict", `${at}: seq is ${entry.seq}`);
    if (entry.sphere !== chain.sphere) return fail("wrong_sphere", `${at}: sphere ${entry.sphere}`);
    if (entry.prev !== prev) return fail("conflict", `${at}: prev does not link to the entry before`);
    if (entryHash(entry) !== entry.hash) return fail("conflict", `${at}: hash does not match its content`);
    const time = seconds(entry.recorded_at);
    if (time < lastTime) return fail("conflict", `${at}: recorded_at goes back in time`);
    lastTime = time;
    const env = entry.envelope;
    const problems = semanticProblems(env);
    if (problems.length) return fail("invalid_envelope", `${at}: ${problems.join("; ")}`);
    if (env.sphere !== chain.sphere) return fail("wrong_sphere", `${at}: envelope for ${env.sphere}`);
    if (seconds(env.created_at) > time + CLOCK_SKEW_SECONDS) return fail("clock_skew", `${at}: created after it was recorded`);
    if (!(seconds(env.expires_at) > time)) return fail("expired", `${at}: recorded after it expired`);
    const key = ctx.keys?.[env.key_id];
    if (!key || key.obi !== env.from || keyIdOf(key.public_key) !== env.key_id) return fail("unknown_key", `${at}: ${env.key_id} is not a key of ${env.from}`);
    if (!keyValidAt(key, entry.seq)) return fail("unknown_key", `${at}: ${env.key_id} was not valid at seq ${entry.seq}`);
    if (!verifyBytes(key.public_key, envelopeSigningInput(env), env.signature)) return fail("bad_signature", `${at}: the sender's signature does not verify`);
    if (byId.has(env.id)) return fail("duplicate", `${at}: ${env.id} is in the chain twice`);
    if (REPLY_TYPES.includes(env.type)) {
      const problem = exchangeProblem(env, byId.get(env.in_reply_to), [...byId.values()].filter((e) => REPLY_TYPES.includes(e.type) && e.in_reply_to === env.in_reply_to));
      if (problem) return fail("bad_reply", `${at}: ${problem}`);
    }
    byId.set(env.id, env);
    prev = entry.hash;
  }
  return OK;
}

// ---------------------------------------------------------------------------------------------
// One conformance case, as the runner hands it to an implementation on stdin.

export function judge(testCase) {
  switch (testCase.case) {
    case "envelope":
      return verifyEnvelope(testCase.input, testCase.context);
    case "card":
      return verifyCard(testCase.input, testCase.context);
    case "audit":
      return verifyChain(testCase.input, testCase.context);
    default:
      return fail("bad_request", `unknown case kind ${testCase.case}`);
  }
}
