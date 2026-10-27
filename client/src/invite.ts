// Invite links: `<base>/join#<fragment>` (spec/sphere-api.md section 4, "Invite links").
//
// The fragment is `key=value` pairs joined by `&`, each value percent-encoded (RFC 3986): split on
// `&` and on the first `=`, then percent-decode; `+` is a plus, never a space. `sphere`, `id` and
// `secret` are required and non-empty; `for` and `obi` come together (a named invitation) or not at
// all; `name`, `by` and `domain` are only what the link says (the preview is the truth); unknown
// keys are ignored and the first occurrence of a key wins. The fragment never reaches the server:
// the secret goes in the body of the preview and the redeem.

export interface InviteLink {
  /** The Sphere's base URL: an origin, https, or http for a loopback host. */
  base: string;
  sphere: string;
  /** The invitation's id. */
  id: string;
  /** The invitation's secret: whoever holds it may redeem the invitation. */
  secret: string;
  /** What the link says about itself: data, until the preview confirms it. */
  name?: string;
  by?: string;
  /** For a named invitation: the owner and the Obi it is for. */
  owner?: string;
  obi?: string;
  domain?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
  const required = (key: string) => {
    const v = items.get(key);
    if (!v) throw new InviteLinkError(`the link has no ${key}`);
    return v;
  };
  const optional = (key: string) => (items.get(key) ? items.get(key) : undefined);
  const link: InviteLink = { base, sphere: required("sphere"), id: required("id"), secret: required("secret") };
  const owner = items.get("for");
  const obi = items.get("obi");
  if ((owner === undefined) !== (obi === undefined)) throw new InviteLinkError("a named invitation's link has both `for` and `obi`");
  if (owner !== undefined && (!owner || !obi)) throw new InviteLinkError("`for` and `obi` are not empty");
  if (owner !== undefined) Object.assign(link, { owner, obi });
  for (const key of ["name", "by", "domain"] as const) {
    const v = optional(key);
    if (v !== undefined) link[key] = v;
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
