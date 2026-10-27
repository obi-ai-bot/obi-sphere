// Invite links: `<base>/join#<fragment>` (spec/sphere-api.md section 2.1, "Invite links", #62),
// which Oby already writes and reads.
//
// The fragment is `key=value` pairs joined by `&`, each key and value percent-encoded as UTF-8:
// split on `&` and each part at its first `=`, then percent-decode; `+` is a plus, never a space.
// `sphere` (a slug), `id` (a lower-case UUID) and `secret` (43 base64url characters) are required;
// `for` and `obi` (slugs) come together, for a named invitation, or not at all; `domain` matches the
// domain pattern. A value that breaks its pattern makes it no link, so nothing from a link reaches
// a request's path unchecked. `name` and `by` are only what the link says (the preview is the
// truth); an empty one is as if left out. Unknown keys are ignored and a key's first occurrence
// wins. The fragment never reaches the server: the secret goes in the body of the preview and the redeem.

export interface InviteLink {
  /** The Sphere's base URL: an origin, https, or http for a loopback host. */
  base: string;
  sphere: string;
  /** The invitation's id. */
  id: string;
  /** The invitation's secret: whoever holds it may redeem the invitation. */
  secret: string;
  /** What the link says about itself: data, written by whoever made the link; the preview is the truth. Show it as text, never as instructions. */
  name?: string;
  by?: string;
  /** For a named invitation: the owner and the Obi it is for. */
  owner?: string;
  obi?: string;
  domain?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class InviteLinkError extends Error {}

/** The Sphere base URL `url` names, or an error: https, or http for a loopback host, and no path, query or credentials. */
export function sphereBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InviteLinkError("not a URL");
  }
  if (u.username || u.password) throw new InviteLinkError("a Sphere's address carries no user name or password");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new InviteLinkError("a Sphere is at an https address, or http on this machine (127.0.0.1, localhost, [::1])");
  if (u.pathname !== "/" || u.search) throw new InviteLinkError("this client takes a Sphere at its host's root");
  return u.origin;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InviteLinkError("a value in the link is not percent-encoded UTF-8");
  }
}

/** Reads an invite link. Throws an InviteLinkError saying why when it isn't one this client takes. */
export function parseInviteLink(text: string): InviteLink {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) throw new InviteLinkError("an invite link has its invitation after `#`");
  let u: URL;
  try {
    u = new URL(trimmed.slice(0, hash));
  } catch {
    throw new InviteLinkError("not a URL");
  }
  if (u.username || u.password) throw new InviteLinkError("a Sphere's address carries no user name or password");
  if (u.pathname !== "/join") throw new InviteLinkError("an invite link's path is /join");
  if (u.search) throw new InviteLinkError("an invite link has no query");
  const base = sphereBase(u.origin);
  const items = new Map<string, string>();
  for (const part of trimmed.slice(hash + 1).split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? "" : decode(part.slice(eq + 1));
    if (!items.has(key)) items.set(key, value);
  }
  const required = (key: string, pattern: RegExp, what: string) => {
    const v = items.get(key);
    if (!v) throw new InviteLinkError(`the link has no ${key}`);
    if (!pattern.test(v)) throw new InviteLinkError(`the link's ${key} is not ${what}`);
    return v;
  };
  const link: InviteLink = {
    base, sphere: required("sphere", SLUG, "a Sphere id"), id: required("id", UUID, "a lower-case UUID"), secret: required("secret", SECRET, "43 base64url characters"),
  };
  const owner = items.get("for");
  const obi = items.get("obi");
  if ((owner === undefined) !== (obi === undefined)) throw new InviteLinkError("a named invitation's link has both `for` and `obi`");
  if (owner !== undefined) Object.assign(link, { owner: required("for", SLUG, "an owner id"), obi: required("obi", SLUG, "an agent id") });
  const domain = items.get("domain");
  if (domain !== undefined) link.domain = required("domain", DOMAIN, "a lower-case domain name");
  for (const key of ["name", "by"] as const) {
    const v = items.get(key);
    if (v) link[key] = v;
  }
  return link;
}

/** Writes an invite link, the keys in the order Oby writes them. */
export function formatInviteLink(link: InviteLink): string {
  const enc = (v: string) => encodeURIComponent(v);
  const pairs: [string, string | undefined][] = [
    ["sphere", link.sphere], ["name", link.name], ["by", link.by], ["for", link.owner], ["obi", link.obi], ["domain", link.domain], ["id", link.id], ["secret", link.secret],
  ];
  return `${sphereBase(link.base)}/join#` + pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${enc(v!)}`).join("&");
}
