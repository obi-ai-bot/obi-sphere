// Bytes, base64url, SHA-256 and Ed25519 through WebCrypto, so the same code runs in the Worker
// (workerd) and in Node (the conformance checker and the scripted client).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function b64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * base64url without padding to bytes. Characters outside the alphabet make it throw; unused
 * low bits of the last character are ignored, as Node's Buffer does (the reference verifier's
 * decoder), so both read the same bytes.
 */
export function fromB64url(text: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    const v = LOOKUP.get(c);
    if (v === undefined) throw new Error("not base64url");
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => hex(await sha256(bytes));

/** `ed25519:` + base64url(SHA-256(raw public key)). Throws when the key is not 32 bytes. */
export async function keyIdOf(publicKey: string): Promise<string> {
  const raw = fromB64url(publicKey);
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return "ed25519:" + b64url(await sha256(raw));
}

/** The key id of `publicKey`, or null when it is not a 32-byte key. */
export async function keyIdOrNull(publicKey: string): Promise<string | null> {
  try {
    return await keyIdOf(publicKey);
  } catch {
    return null;
  }
}

const imported = new Map<string, Promise<CryptoKey>>();

function importEd25519(publicKey: string): Promise<CryptoKey> {
  let key = imported.get(publicKey);
  if (!key) {
    if (imported.size > 1000) imported.clear();
    const raw = fromB64url(publicKey);
    if (raw.length !== 32) return Promise.reject(new Error("an Ed25519 public key is 32 bytes"));
    key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    imported.set(publicKey, key);
    key.catch(() => imported.delete(publicKey));
  }
  return key;
}

/** Pure Ed25519 (RFC 8032) over `data`. False for any malformed key or signature. */
export async function verifyEd25519(publicKey: string, data: Uint8Array, signature: string): Promise<boolean> {
  try {
    const sig = fromB64url(signature);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify({ name: "Ed25519" }, await importEd25519(publicKey), sig, data);
  } catch {
    return false;
  }
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const randomToken = (n = 32): string => b64url(randomBytes(n));
export const uuid = (): string => crypto.randomUUID();

/** Compares two byte strings in time that depends only on their lengths. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
