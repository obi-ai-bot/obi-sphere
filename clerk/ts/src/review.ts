// The review profile's tally (spec/council/review.md, section 6): from a panel's envelopes in the chain to the
// clerk's count input. It reads only what stays readable when the words are sealed (types, members, outcomes,
// commit ids, finding ids and severities, acceptance kinds and results), so anyone holding the chain can count
// again without a key. The known-answer vectors in clerk/vectors/review.json pin it down, and the Rust crate in
// clerk/rust gives the same answers.

import type { Json } from "./index.ts";

export type TallyErrorCode = "bad_input" | "bad_panel" | "two_requests";

export class TallyError extends Error {
  readonly code: TallyErrorCode;
  constructor(code: TallyErrorCode) {
    super(code);
    this.code = code;
  }
}

type Obj = { [key: string]: Json };

const fail = (code: TallyErrorCode): never => {
  throw new TallyError(code);
};

const isObj = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: Json | undefined): v is string => typeof v === "string" && v.length > 0;
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const exact = (o: Json | undefined, keys: string[], optional: string[] = []): o is Obj =>
  isObj(o) && keys.every((k) => has(o, k)) && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k));
// Repositories compare ignoring ASCII case (protocol.md section 5.9).
const sameRepo = (a: Json | undefined, b: Json | undefined) =>
  typeof a === "string" && typeof b === "string" && a.replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.replace(/[A-Z]/g, (c) => c.toLowerCase());

const RULES = ["majority", "supermajority", "unanimity"];

/** The clerk's count input for a review panel, from its envelopes in chain order (review.md section 6). */
export function reviewTally(input: Json): Obj {
  if (!exact(input, ["convener", "subject", "rule", "quorum", "veto", "seats", "envelopes"], ["verifier"])) return fail("bad_input");
  const subject = input.subject;
  if (!exact(subject, ["repo", "head_sha"]) || !isId(subject.repo) || typeof subject.head_sha !== "string" || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(subject.head_sha))
    return fail("bad_input");
  if (!isId(input.convener) || !isObj(input.rule) || typeof input.veto !== "boolean") fail("bad_input");
  const q = input.quorum;
  if (typeof q !== "number" || !Number.isInteger(q) || q < 0 || q > Number.MAX_SAFE_INTEGER) fail("bad_input");
  if (!Array.isArray(input.seats) || !input.seats.every(isId)) fail("bad_input");
  if (has(input, "verifier") && !isId(input.verifier)) fail("bad_input");
  if (!Array.isArray(input.envelopes) || !input.envelopes.every(isObj)) fail("bad_input");
  const envelopes = input.envelopes as Obj[];
  for (const e of envelopes) {
    if (!isId(e.id) || !isId(e.type) || !isId(e.from) || !isId(e.to) || !isObj(e.body) || !isId(e.correlation_id)) fail("bad_input");
  }

  const convener = input.convener as string;
  const seats = input.seats as string[];
  const verifier = has(input, "verifier") ? (input.verifier as string) : null;
  if (!RULES.includes((input.rule as Obj).kind as string)) fail("bad_panel");
  if (seats.length === 0 || new Set(seats).size !== seats.length || seats.includes(convener)) fail("bad_panel");
  if (verifier !== null && (seats.includes(verifier) || verifier === convener)) fail("bad_panel");

  const body = (e: Obj) => e.body as Obj;
  const requestTo = (member: string): Obj | null => {
    const found = envelopes.filter(
      (e) =>
        e.type === "review_request" &&
        e.from === convener &&
        e.to === member &&
        sameRepo(body(e).repo, subject.repo) &&
        body(e).head_sha === subject.head_sha,
    );
    if (found.length > 1) fail("two_requests");
    return found[0] ?? null;
  };
  // The review's result, when the reply that ended the request's exchange is one, for the subject's commit.
  const reviewResult = (request: Obj | null, member: string): Obj | null => {
    if (request === null) return null;
    const end = envelopes.find((e) => e.correlation_id === request.id && e.from === member && (e.type === "result" || e.type === "decline"));
    if (end === undefined || end.type !== "result") return null;
    const b = body(end);
    if (b.for !== "review_request" || b.head_sha !== subject.head_sha || !sameRepo(b.repo, subject.repo)) return null;
    return b;
  };
  const counted = (b: Obj | null): b is Obj => b !== null && (b.outcome === "approved" || b.outcome === "changes_requested");

  const ballots: Obj[] = [];
  const findings: { id: string; blocking: boolean; evidence: boolean; challenge: string }[] = [];
  for (const seat of seats) {
    const result = reviewResult(requestTo(seat), seat);
    if (!counted(result)) continue;
    ballots.push({ seat, vote: result.outcome === "approved" ? "approve" : "reject" });
    for (const f of (result.findings as Obj[] | undefined) ?? []) {
      findings.push({ id: `${seat}/${f.id as string}`, blocking: f.severity === "blocker", evidence: true, challenge: "none" });
    }
  }

  const blocking = findings.filter((f) => f.blocking);
  if (verifier !== null && blocking.length >= 1 && blocking.length <= 10) {
    const request = requestTo(verifier);
    const conditions = request === null ? [] : ((body(request).acceptance as Obj[] | undefined) ?? []);
    if (request !== null && conditions.length === blocking.length && conditions.every((c) => c.kind === "custom")) {
      const result = reviewResult(request, verifier);
      if (counted(result)) {
        const met = new Map<number, boolean>();
        for (const a of (result.acceptance as Obj[] | undefined) ?? []) if (a.kind === "custom") met.set(a.index as number, a.met as boolean);
        blocking.forEach((f, i) => {
          if (met.has(i)) f.challenge = met.get(i) ? "stands" : "refuted";
        });
      }
    }
  }

  return { rule: input.rule, quorum: q as number, veto: input.veto, seats, ballots, findings };
}
