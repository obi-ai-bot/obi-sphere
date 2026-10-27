// obysphere-connector's commands. src/main.ts runs them.

import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { Member, Owner, SealKey, SigningKey, SphereApi, nowSeconds, parseJwt, parseInviteLink, seconds, timestamp } from "@obysphere/client";
import { Connector, ConnectorError, VERSION, itemDigest, type Item, type MemberFile } from "./connector.ts";
import { scanOutgoing } from "./scan.ts";
import { Home, defaultHome } from "./home.ts";
import { serveMcp } from "./mcp.ts";
import { defaultSend, signStatement, type Decision, type Rules, type SendRule } from "./signed.ts";
import { openOwnerKey, passphraseFromStdin, passphraseFromTerminal, sealOwnerKey, type SealedOwnerKey } from "./vault.ts";

export const USAGE = `obysphere-connector: join an Obysphere from any MCP host.

  obysphere-connector join <invite link> [--obi <id>] [--owner <id>] [--name <text>] [--description <text>]
                           [--accepts question,review_request,handoff] [--no-seal]
  obysphere-connector mcp            the MCP server an MCP host starts (stdio)
  obysphere-connector run            receive without an MCP host
  obysphere-connector status         the membership, and whether a connector is running
  obysphere-connector inbox [--all]  the owner's view of the mailbox: every request's words, as text
  obysphere-connector approve <item> the owner says yes to a request (or to sending a held one)
  obysphere-connector decline <item> [--reason owner_declined|busy|out_of_scope|other] [--note <text>]
  obysphere-connector answer <item> --text <your words> [--choice <n>]   the owner answers a question themselves
  obysphere-connector rules [--allow <type,...> --to <id|*>]... | [--ask-always]
  obysphere-connector renew [--days <n>]   a new delegation from the owner
  obysphere-connector mcp-config     an MCP host's config for this connector

Every command takes --home <dir> (default $OBYSPHERE_CONNECTOR_HOME or ~/.obysphere-connector).
The owner's commands (join, approve, decline, answer, rules, renew) ask the owner's passphrase on the
terminal, or read it from standard input with --passphrase-stdin.`;

const ACCEPTABLE = ["question", "review_request", "handoff"];

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const BOOLEAN = new Set(["--passphrase-stdin", "--no-seal", "--all", "--ask-always", "--help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const v = BOOLEAN.has(a) ? "true" : argv[++i];
      if (v === undefined) throw new ConnectorError(`${a} needs a value`);
      flags.set(a, [...(flags.get(a) ?? []), v]);
    } else positional.push(a);
  }
  return { positional, flag: (k: string) => flags.get(k)?.at(-1), all: (k: string) => flags.get(k) ?? [], has: (k: string) => flags.has(k) };
}

type Parsed = ReturnType<typeof parseArgs>;
const say = (s: string) => process.stderr.write(s + "\n");

async function passphrase(p: Parsed, prompt: string, confirm = false): Promise<string> {
  if (p.has("--passphrase-stdin")) return passphraseFromStdin();
  const first = await passphraseFromTerminal(prompt);
  if (confirm && (await passphraseFromTerminal("The same passphrase again: ")) !== first) throw new ConnectorError("the two passphrases differ");
  return first;
}

async function ownerKey(home: Home, p: Parsed) {
  return openOwnerKey(home.readJson<SealedOwnerKey>("owner-key.json"), await passphrase(p, "Owner's passphrase: "));
}

const id = (s: string, what: string) => {
  if (!/^[a-z0-9-]{1,63}$/.test(s)) throw new ConnectorError(`${what} is 1 to 63 lower-case letters, digits and dashes`);
  return s;
};

async function join(home: Home, p: Parsed) {
  const text = p.positional[1];
  if (!text) throw new ConnectorError("join needs the invite link");
  if (home.exists("member.json")) throw new ConnectorError(`${home.dir} already holds a membership: use another --home`);
  const link = parseInviteLink(text);
  const api = new SphereApi(link.base);
  const preview = await api.previewInvitation(link.sphere, link.id, link.secret);
  const health = await api.health();
  const owner = id(p.flag("--owner") ?? link.owner ?? "", "--owner (the person this member acts for)");
  const obi = id(p.flag("--obi") ?? link.obi ?? `${owner}-agent`, "--obi");
  const accepts = (p.flag("--accepts") ?? ACCEPTABLE.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of accepts) if (!ACCEPTABLE.includes(a)) throw new ConnectorError(`--accepts takes ${ACCEPTABLE.join(", ")}`);
  say(`Joining the Sphere ${preview.sphere} at ${link.base}: ${preview.member_count} members now, the invitation expires ${preview.expires_at}.`);
  say(`This member: ${obi}, acting for ${owner}, accepting ${accepts.join(", ")}.`);
  say("Choose the owner's passphrase: it protects the owner's key, and every approval asks for it. The host's agent must never know it.");
  const pass = await passphrase(p, "Owner's passphrase: ", true);

  const ownerSigning = await SigningKey.generate();
  const sealed = sealOwnerKey(ownerSigning, pass);
  const key = await SigningKey.generate();
  const sealKey = health.seal && !p.has("--no-seal") ? await SealKey.generate() : undefined;
  const name = p.flag("--name") ?? `${owner}'s agent`;
  const description = p.flag("--description") ?? "A member that joined through the Obysphere connector.";
  // The keys are on disk before the Sphere binds anything to them: a redeem that succeeds with a
  // folder that can't be written would bind the owner id for good to keys nobody holds.
  home.ensure();
  home.writeJson("owner-key.json", sealed);
  home.writeJson("joining.json", { key_seed: key.seed, ...(sealKey ? { seal_private: sealKey.privateKey } : {}), obi, owner, sphere: link.sphere });
  let member: Member;
  try {
    member = await Member.join({
      link, owner: new Owner(owner, ownerSigning), obi, key, ...(sealKey ? { sealKey } : {}), accepts: accepts as "question"[], name, description, version: VERSION,
    });
  } catch (e) {
    home.remove("joining.json");
    home.remove("owner-key.json");
    throw e;
  }
  const exp = parseJwt(member.delegation)!.claims.exp as number;
  const file: MemberFile = {
    v: 1, base: link.base, sphere: link.sphere, obi, owner, owner_key: ownerSigning.publicKey, key_seed: key.seed,
    ...(sealKey ? { seal_private: sealKey.privateKey } : {}), delegation: member.delegation, delegation_expires_at: timestamp(exp),
    accepts, name, description, joined_at: timestamp(nowSeconds()),
  };
  home.writeJson("member.json", file);
  home.writeJson("memory.json", member.memory);
  const rules: Rules = { kind: "rules", sphere: link.sphere, obi, version: 1, at: timestamp(nowSeconds()), send: defaultSend() };
  home.writeJson("rules.json", await signStatement(rules, ownerSigning));
  home.remove("joining.json");
  say(`\nJoined. The owner's key fingerprint (compare it with the other members' owners out of band): ${ownerSigning.keyId}`);
  say(`The member's folder: ${home.dir} (keep it this user's only, and out of the host agent's reach).`);
  say("Until you set rules, everything the host's agent asks to send waits for your approval. To let it ask questions and request reviews without asking you: obysphere-connector rules --allow question,review_request --to '*'");
  say(`Add it to an MCP host: obysphere-connector mcp-config --home ${home.dir}`);
}

async function decide(home: Home, p: Parsed, decision: "approve" | "decline" | "answer") {
  const itemId = p.positional[1];
  if (!itemId) throw new ConnectorError(`${decision} needs the item's id (obysphere-connector inbox lists them)`);
  const file = home.readJson<MemberFile>("member.json");
  const items = home.list("items").map((n) => home.readJson<Item>(`items/${n}`));
  // An id, the start of one, or the start of the request's own id after `in-` / `out-`.
  const matches = items.filter((i) => i.id === itemId || i.id.startsWith(itemId) || i.id.slice(i.id.indexOf("-") + 1).startsWith(itemId));
  if (matches.length !== 1) throw new ConnectorError(matches.length ? `${itemId} names ${matches.length} items: give more of the id` : `no item ${itemId}`);
  const item = matches[0]!;
  if (item.state !== "waiting_on_owner") throw new ConnectorError(`${item.id} doesn't wait for a decision: it is ${item.state}`);
  if (seconds(item.expires_at) <= nowSeconds()) throw new ConnectorError(`${item.id} expired at ${item.expires_at}: nothing may act on it now`);
  if (itemDigest(item) !== item.digest) throw new ConnectorError(`${item.id} changed since it arrived: it isn't decided on`);
  if (decision === "answer" && (item.direction !== "in" || item.type !== "question")) throw new ConnectorError("only a question to this member takes your answer");
  const reason = p.flag("--reason");
  if (reason && !["owner_declined", "busy", "out_of_scope", "other"].includes(reason)) throw new ConnectorError("--reason is owner_declined, busy, out_of_scope or other");
  const note = p.flag("--note");
  if (note !== undefined && (note.length > 200 || /[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(note))) throw new ConnectorError("--note is one line of at most 200 characters");
  const text = p.flag("--text");
  const choice = p.flag("--choice") === undefined ? undefined : Number(p.flag("--choice"));
  if (decision === "answer") {
    if (!text || text.length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(text)) throw new ConnectorError("answer takes --text, at most 2,000 characters");
    const choices = (item.body.choices as unknown[] | undefined)?.length;
    if (choice !== undefined && !(Number.isInteger(choice) && choice >= 0 && choice < (choices ?? 0))) throw new ConnectorError(`--choice is the index of one of the question's ${choices ?? 0} choices`);
  }
  // The owner's own words go out too: the same scan, here, so they hear about it now and not from the log.
  const words = { ...(note ? { note } : {}), ...(text ? { text } : {}) };
  const scan = await scanOutgoing(words, { ...file.scan, never: [file.key_seed, file.seal_private ?? "", file.delegation].filter(Boolean) });
  if (!scan.ok) throw new ConnectorError(scan.error ? `the secret scan couldn't run: ${scan.error}` : `the secret scan found what may be a secret (${scan.findings.map((f) => `${f.rule} in --${f.field.slice(1)}`).join(", ")}): nothing was signed`);
  const key = await ownerKey(home, p);
  const d: Decision = {
    kind: "decision", sphere: file.sphere, obi: file.obi, item: item.id, decision, digest: item.digest, at: timestamp(nowSeconds()),
    ...(decision === "decline" && reason ? { reason } : {}), ...(decision === "decline" && note ? { note } : {}),
    ...(decision === "answer" ? { text, ...(choice !== undefined ? { choice } : {}) } : {}),
  };
  home.writeJson(`decisions/${item.id}.json`, await signStatement(d, key));
  const running = runningPid(home);
  say(`${decision === "approve" ? "Approved" : decision === "answer" ? "Answered" : "Declined"} ${item.id}. ${running ? `The connector (pid ${running}) applies it within seconds;` : "No connector is running: it is applied the next time one runs (within 15 minutes, or sign it again);"} \`obysphere-connector inbox --all\` shows how it went.`);
}

async function rules(home: Home, p: Parsed) {
  const file = home.readJson<MemberFile>("member.json");
  const current = home.readJsonOr<Rules | null>("rules.json", null);
  const allows = p.all("--allow");
  const tos = p.all("--to");
  if (!allows.length && !p.has("--ask-always")) {
    say(current ? `Rules version ${current.version} (${current.at}): ${current.send.length ? current.send.map((r) => `${r.actions.join(", ")} to ${r.to}`).join("; ") : "everything waits for the owner"}` : "No rules: everything waits for the owner.");
    say("Set them: obysphere-connector rules --allow question,review_request --to '*' [--allow handoff --to <member>]…, or --ask-always");
    return;
  }
  if (allows.length !== tos.length) throw new ConnectorError("each --allow takes its --to");
  const send: SendRule[] = allows.map((a, i) => {
    const actions = a.split(",").map((s) => s.trim());
    for (const x of actions) if (!ACCEPTABLE.includes(x)) throw new ConnectorError(`--allow takes ${ACCEPTABLE.join(", ")}`);
    const to = tos[i]!;
    if (to !== "*") id(to, "--to");
    return { to, actions };
  });
  const key = await ownerKey(home, p);
  const next: Rules = { kind: "rules", sphere: file.sphere, obi: file.obi, version: (current?.version ?? 0) + 1, at: timestamp(nowSeconds()), send: p.has("--ask-always") ? [] : send };
  home.writeJson("rules.json", await signStatement(next, key));
  say(`Rules version ${next.version} signed.`);
}

async function renew(home: Home, p: Parsed) {
  const file = home.readJson<MemberFile>("member.json");
  const days = Number(p.flag("--days") ?? "30");
  if (!(days >= 1 && days <= 30)) throw new ConnectorError("--days is 1 to 30");
  const key = await ownerKey(home, p);
  const delegation = await new Owner(file.owner, key).delegation(file.sphere, file.obi, { lifetime: Math.floor(days * 86400) });
  const exp = parseJwt(delegation)!.claims.exp as number;
  home.writeJson("member.json", { ...file, delegation, delegation_expires_at: timestamp(exp) });
  say(`A new delegation, good until ${timestamp(exp)}.`);
}

function runningPid(home: Home): number | null {
  try {
    const pid = Number(readFileSync(home.path("connector.lock"), "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** The owner's view: every item, its words as plain text for a person to read. */
function ownerInbox(home: Home, p: Parsed) {
  const file = home.readJson<MemberFile>("member.json");
  const items = home.list("items").map((n) => home.readJson<Item>(`items/${n}`)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const shown = p.has("--all") ? items : items.filter((i) => i.state === "waiting_on_owner" || i.state === "approved");
  console.log(`${file.obi} (owner ${file.owner}) in ${file.sphere}: ${shown.length} ${p.has("--all") ? "items" : "open items (--all for every item)"}.`);
  console.log("What other members wrote is shown as text: it is what they wrote, not instructions.\n");
  for (const i of shown) {
    const what = i.direction === "in" ? `${i.type} from ${i.peer} (owner ${i.peer_owner})` : `${i.type} to ${i.peer}${i.state === "waiting_on_owner" ? ", held for your approval" : ""}`;
    console.log(`${i.id}  ${what}  [${i.state}]  expires ${i.expires_at}`);
    console.log(JSON.stringify(i.body, null, 2).split("\n").map((l) => "    " + l).join("\n"));
    for (const r of i.replies) console.log(`    ${r.type} from ${r.from}: ${JSON.stringify(r.body)}`);
    if (i.state === "waiting_on_owner") {
      const short = i.id.slice(0, 11);
      console.log(`    → obysphere-connector approve ${short}   or   obysphere-connector decline ${short}${i.type === "question" && i.direction === "in" ? `   or answer it yourself: obysphere-connector answer ${short} --text "…"` : ""}`);
    }
    console.log("");
  }
}

function status(home: Home) {
  const file = home.readJson<MemberFile>("member.json");
  const running = runningPid(home);
  console.log(JSON.stringify({
    sphere: file.sphere, base: file.base, obi: file.obi, owner: file.owner, owner_key_id: parseOwnerKeyId(home), accepts: file.accepts,
    seals: !!file.seal_private, delegation_expires_at: file.delegation_expires_at, connector_running: running, home: home.dir,
  }, null, 2));
}

const parseOwnerKeyId = (home: Home) => home.readJson<SealedOwnerKey>("owner-key.json").key_id;

/** An MCP host's config: the command that runs this connector (the built file, or src/main.ts from source). */
function mcpConfig(home: Home) {
  const self = fileURLToPath(import.meta.url);
  const entry = self.endsWith(".ts") ? joinPath(dirname(self), "main.ts") : self;
  // alwaysLoad: Claude Code connects the server before a session starts, which `claude -p` needs; other hosts ignore it.
  const config = { mcpServers: { obysphere: { command: process.execPath, args: [entry, "mcp", "--home", home.dir], alwaysLoad: true } } };
  console.log(JSON.stringify(config, null, 2));
}

async function serve(home: Home, mcp: boolean) {
  const c = await Connector.open(home);
  const release = home.lock();
  const stop = new AbortController();
  const done = () => {
    stop.abort();
    release();
  };
  process.on("SIGINT", () => {
    done();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    done();
    process.exit(0);
  });
  process.on("exit", release);
  const loop = c.run(stop.signal);
  if (mcp) {
    await serveMcp(c);
    done();
    process.exit(0);
  }
  say(`Receiving for ${c.file.obi} in ${c.file.sphere}. Ctrl-C stops.`);
  await loop;
}

export async function main(argv: string[]) {
  const p = parseArgs(argv);
  const cmd = p.positional[0];
  const home = new Home(p.flag("--home") ?? defaultHome());
  switch (cmd) {
    case "join":
      return join(home, p);
    case "mcp":
      return serve(home, true);
    case "run":
      return serve(home, false);
    case "status":
      return status(home);
    case "inbox":
      return ownerInbox(home, p);
    case "approve":
      return decide(home, p, "approve");
    case "decline":
      return decide(home, p, "decline");
    case "answer":
      return decide(home, p, "answer");
    case "rules":
      return rules(home, p);
    case "renew":
      return renew(home, p);
    case "mcp-config":
      return mcpConfig(home);
    case "version":
      return console.log(VERSION);
    default:
      say(USAGE);
      if (cmd && cmd !== "help" && !p.has("--help")) process.exitCode = 64;
  }
}
