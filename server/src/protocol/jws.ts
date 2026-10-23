// Compact JWS with EdDSA (RFC 7515, RFC 8037): the owner and actor assertions of
// spec/identity.md section 4.1.

import { fromB64url, verifyEd25519 } from "./crypto.ts";
import { decodeUtf8Strict, isObject, parseStrict, utf8, type JsonObject } from "./json.ts";
import { matches } from "./schemas.ts";

export interface CompactJws {
  header: { alg: "EdDSA"; kid: string; typ: string };
  claims: JsonObject;
  signingInput: Uint8Array;
  signature: string;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Splits and decodes a compact JWS whose header is {alg: EdDSA, kid, typ: JWT}; null when it isn't one. */
export function parseJwt(token: string): CompactJws | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return null;
  const [h, c, s] = parts as [string, string, string];
  try {
    const header = parseStrict(decodeUtf8Strict(fromB64url(h)));
    const claims = parseStrict(decodeUtf8Strict(fromB64url(c)));
    if (!matches("jwsHeader", header) || (header as JsonObject).typ !== "JWT" || !isObject(claims)) return null;
    if (fromB64url(s).length !== 64) return null;
    return { header: header as CompactJws["header"], claims, signingInput: utf8(`${h}.${c}`), signature: s };
  } catch {
    return null;
  }
}

export const verifyJws = (jws: CompactJws, publicKey: string): Promise<boolean> => verifyEd25519(publicKey, jws.signingInput, jws.signature);
