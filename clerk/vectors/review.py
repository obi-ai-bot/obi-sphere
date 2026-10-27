#!/usr/bin/env python3
"""Writes clerk/vectors/review.json: the known-answer vectors for the review profile's tally
(spec/council/review.md, section 6): from a panel's envelopes in the chain to the clerk's count input.

Like draw.py, a third implementation in Python's standard library, written from review.md apart from the
Rust and TypeScript ones; the vectors' answers come from here. `python3 clerk/vectors/review.py` rewrites
the file; `--check` only compares.
"""

import json
import re
import sys
from pathlib import Path

MAX_INT = 2**53 - 1
SHA = re.compile(r"^[0-9a-f]{40}$|^[0-9a-f]{64}$")
RULES = {"majority", "supermajority", "unanimity"}


class TallyError(Exception):
    pass


def fail(code):
    raise TallyError(code)


def is_obj(v):
    return isinstance(v, dict)


def is_id(v):
    return isinstance(v, str) and len(v) > 0


def exact(o, keys, optional=()):
    return is_obj(o) and set(o) >= set(keys) and set(o) <= set(keys) | set(optional)


ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def same_repo(a, b):
    """Repositories compare ignoring ASCII case (protocol.md section 5.9)."""
    return isinstance(a, str) and isinstance(b, str) and a.translate(ASCII_LOWER) == b.translate(ASCII_LOWER)


def tally(inp):
    if not exact(inp, ["convener", "subject", "rule", "quorum", "veto", "seats", "envelopes"], ["verifier"]):
        fail("bad_input")
    subj = inp["subject"]
    if not (exact(subj, ["repo", "head_sha"]) and is_id(subj["repo"]) and isinstance(subj["head_sha"], str) and SHA.match(subj["head_sha"])):
        fail("bad_input")
    if not (is_id(inp["convener"]) and is_obj(inp["rule"]) and isinstance(inp["veto"], bool)):
        fail("bad_input")
    q = inp["quorum"]
    if not (isinstance(q, int) and not isinstance(q, bool) and 0 <= q <= MAX_INT):
        fail("bad_input")
    seats = inp["seats"]
    if not (isinstance(seats, list) and all(is_id(s) for s in seats)):
        fail("bad_input")
    verifier = inp.get("verifier")
    if "verifier" in inp and not is_id(verifier):
        fail("bad_input")
    envs = inp["envelopes"]
    if not (isinstance(envs, list) and all(is_obj(e) for e in envs)):
        fail("bad_input")
    for e in envs:
        if not (is_id(e.get("id")) and is_id(e.get("type")) and is_id(e.get("from")) and is_id(e.get("to")) and is_obj(e.get("body"))):
            fail("bad_input")
        if not (is_id(e.get("correlation_id"))):
            fail("bad_input")

    if inp["rule"].get("kind") not in RULES:
        fail("bad_panel")
    if not seats or len(set(seats)) != len(seats) or inp["convener"] in seats:
        fail("bad_panel")
    if verifier is not None and (verifier in seats or verifier == inp["convener"]):
        fail("bad_panel")

    def request_to(member):
        found = [
            e
            for e in envs
            if e["type"] == "review_request"
            and e["from"] == inp["convener"]
            and e["to"] == member
            and same_repo(e["body"].get("repo"), subj["repo"])
            and e["body"].get("head_sha") == subj["head_sha"]
        ]
        if len(found) > 1:
            fail("two_requests")
        return found[0] if found else None

    def ending(request, member):
        """The reply that ended the request's exchange, from its receiver: a result or a decline, or None."""
        for e in envs:
            if e["correlation_id"] == request["id"] and e["from"] == member and e["type"] in ("result", "decline"):
                return e
        return None

    def review_result(request, member):
        end = ending(request, member) if request else None
        if end is None or end["type"] != "result":
            return None
        b = end["body"]
        if b.get("for") != "review_request" or b.get("head_sha") != subj["head_sha"] or not same_repo(b.get("repo"), subj["repo"]):
            return None
        return b

    ballots, findings = [], []
    for seat in seats:
        res = review_result(request_to(seat), seat)
        if res is None or res.get("outcome") not in ("approved", "changes_requested"):
            continue
        ballots.append({"seat": seat, "vote": "approve" if res["outcome"] == "approved" else "reject"})
        for f in res.get("findings", []):
            findings.append({"id": f"{seat}/{f['id']}", "blocking": f["severity"] == "blocker", "evidence": True, "challenge": "none"})

    blocking = [f for f in findings if f["blocking"]]
    if verifier is not None and 1 <= len(blocking) <= 10:
        req = request_to(verifier)
        conds = req["body"].get("acceptance", []) if req else []
        if req and len(conds) == len(blocking) and all(c.get("kind") == "custom" for c in conds):
            res = review_result(req, verifier)
            if res is not None and res.get("outcome") in ("approved", "changes_requested"):
                met = {a["index"]: a["met"] for a in res.get("acceptance", []) if a.get("kind") == "custom"}
                for i, f in enumerate(blocking):
                    if i in met:
                        f["challenge"] = "stands" if met[i] else "refuted"

    out = {"rule": inp["rule"], "quorum": inp["quorum"], "veto": inp["veto"], "seats": seats, "ballots": ballots, "findings": findings}
    return out


# --- The vectors ---------------------------------------------------------------------------------------

REPO = "acme/app"
HEAD = "6d20146f366b1a4b5e7f8c9d0e1f2a3b4c5d6e7f"
OTHER = "aeab70f30251c0d1e2f3a4b5c6d7e8f9a0b1c2d3"
CONVENER = "obi-alice"
SEATS = ["obi-bob", "obi-carol", "obi-dan"]
VERIFIER = "obi-erin"
# Sealed words look like this in the chain: the tally never opens them.
SEALED = "q83vEjRWeJA5Z6gNmV1vXyt7lH8K0oX2u_4T-9wq0aBc"


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def env(n, typ, frm, to, body, corr=None):
    out = {"protocol": "obi/0.1", "id": uid(n), "type": typ, "from": frm, "to": to, "sphere": "e2e", "correlation_id": uid(corr or n), "body": body}
    if corr:
        out["in_reply_to"] = uid(corr)
    return out


def acceptance(n=1):
    return [{"kind": "no_blocker_findings"}] + [{"kind": "tests_pass"}] * (n - 1)


def request(n, to, head=HEAD, conds=None, repo=REPO):
    body = {"goal": SEALED, "repo": repo, "base_branch": "main", "head_branch": "feature/average", "head_sha": head, "acceptance": conds or acceptance()}
    return env(n, "review_request", CONVENER, to, body)


def finding(fid, sev, line=4):
    return {"id": fid, "severity": sev, "file": "src/average.js", "line": line, "title": SEALED, "detail": SEALED}


def result(n, req, frm, outcome, findings=(), head=HEAD, met=None):
    body = {"for": "review_request", "outcome": outcome, "repo": REPO, "head_sha": head, "findings": list(findings)}
    if outcome != "failed":
        body["acceptance"] = met if met is not None else [{"index": 0, "kind": "no_blocker_findings", "met": not any(f["severity"] == "blocker" for f in findings)}]
    return env(n, "result", frm, CONVENER, body, corr=req)


def accept(n, req, frm):
    return env(n, "accept", frm, CONVENER, {}, corr=req)


def decline(n, req, frm, reason="busy"):
    return env(n, "decline", frm, CONVENER, {"reason": reason}, corr=req)


def custom(k):
    return [{"kind": "custom", "text": SEALED} for _ in range(k)]


def met_list(values):
    return [{"index": i, "kind": "custom", "met": v} for i, v in enumerate(values)]


def base(envelopes, verifier=True, rule=None, quorum=2, veto=True, seats=SEATS):
    out = {"convener": CONVENER, "subject": {"repo": REPO, "head_sha": HEAD}, "rule": rule or {"kind": "majority"}, "quorum": quorum, "veto": veto, "seats": list(seats), "envelopes": envelopes}
    if verifier:
        out["verifier"] = VERIFIER
    return out


def panel(outcomes):
    """Three seats' requests, accepts and results; outcomes is a list of (outcome, findings) or None."""
    envs, n = [], 1
    for seat, oc in zip(SEATS, outcomes):
        envs.append(request(n, seat))
        req = n
        n += 1
        if oc is None:
            continue
        envs.append(accept(n, req, seat))
        n += 1
        if oc == "decline":
            envs.append(decline(n, req, seat))
        else:
            envs.append(result(n, req, seat, oc[0], oc[1]))
        n += 1
    return envs, n


def cases():
    out = []

    def ok(name, inp):
        out.append({"name": name, "input": inp, "output": tally(inp)})

    def err(name, inp, code):
        try:
            tally(inp)
        except TallyError as x:
            assert str(x) == code, (name, str(x))
            out.append({"name": name, "input": inp, "error": code})
            return
        raise AssertionError(name)

    envs, _ = panel([("approved", []), ("approved", [finding("f-1", "minor")]), ("changes_requested", [finding("f-2", "major")])])
    ok("three seats answer: two approve, one requests changes; no blocker", base(envs))

    envs, n = panel([("approved", []), ("approved", []), ("changes_requested", [finding("f-9", "blocker"), finding("f-3", "nit", 9)])])
    ok("a blocker and no verifier: it stands unchallenged", base(envs, verifier=False))

    envs2 = envs + [request(n, VERIFIER, conds=custom(1))]
    ok("a blocker, the verifier asked but not answering: it stands", base(envs2))

    envs3 = envs2 + [accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "changes_requested", met=met_list([False]))]
    ok("a blocker the verifier refutes", base(envs3))

    envs4 = envs2 + [accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "approved", met=met_list([True]))]
    ok("a blocker the verifier upholds", base(envs4))

    envs, n = panel([("changes_requested", [finding("f-a", "blocker"), finding("f-b", "blocker", 7)]), ("changes_requested", [finding("f-a", "blocker")]), ("approved", [])])
    envs += [request(n, VERIFIER, conds=custom(3)), accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "changes_requested", met=met_list([True, False, True]))]
    ok("three blockers from two seats, challenged in seat order: one refuted", base(envs))

    envs, n = panel([("changes_requested", [finding("f-a", "blocker")]), ("approved", []), ("approved", [])])
    envs += [request(n, VERIFIER, conds=custom(2)), accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "changes_requested", met=met_list([False, False]))]
    ok("a challenge with the wrong number of conditions doesn't count", base(envs))

    envs, n = panel([("changes_requested", [finding("f-a", "blocker")]), ("approved", []), ("approved", [])])
    envs += [request(n, VERIFIER, conds=[{"kind": "tests_pass"}]), accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "approved", met=[{"index": 0, "kind": "tests_pass", "met": True}])]
    ok("a challenge whose condition isn't custom doesn't count", base(envs))

    envs, n = panel([("changes_requested", [finding("f-a", "blocker")]), ("approved", []), ("approved", [])])
    envs += [request(n, VERIFIER, conds=custom(1)), accept(n + 1, n, VERIFIER), decline(n + 2, n, VERIFIER)]
    ok("the verifier declines after accepting: the blocker stands", base(envs))

    envs, _ = panel(["decline", ("approved", []), None])
    ok("one seat declines, one never answers: one ballot", base(envs, verifier=False, quorum=1))

    envs, _ = panel([("failed", []), ("approved", []), ("changes_requested", [])])
    ok("a failed review is absent, and its findings with it", base(envs, verifier=False))

    envs, n = panel([("approved", []), ("approved", []), None])
    envs.append(accept(n, n - 1, "obi-dan"))
    envs.append(result(n + 1, n - 1, "obi-dan", "approved", head=OTHER))
    ok("a result for another commit is absent", base(envs, verifier=False))

    envs = [request(1, "obi-bob", repo="Acme/App"), accept(2, 1, "obi-bob"), result(3, 1, "obi-bob", "approved")]
    envs += [request(4, "obi-carol", head=OTHER), accept(5, 4, "obi-carol"), result(6, 4, "obi-carol", "changes_requested", head=OTHER)]
    ok("repositories compare ignoring case; a request for another commit isn't the panel's", base(envs, verifier=False, quorum=1))

    envs, _ = panel([("approved", []), ("approved", []), ("approved", [])])
    envs.append(env(90, "result", "obi-mallory", CONVENER, {"for": "review_request", "outcome": "changes_requested", "repo": REPO, "head_sha": HEAD, "findings": [finding("f-x", "blocker")], "acceptance": [{"index": 0, "kind": "no_blocker_findings", "met": False}]}, corr=1))
    ok("a reply from anyone but the seat doesn't count", base(envs, verifier=False))

    envs, _ = panel([("approved", []), ("changes_requested", []), ("approved", [])])
    ok("a supermajority rule with no veto passes straight through", base(envs, verifier=False, rule={"kind": "supermajority", "num": 2, "den": 3}, veto=False))

    envs, n = panel([("approved", []), ("approved", []), ("approved", [])])
    envs.append(request(n, "obi-bob"))
    err("two requests to one seat for the subject", base(envs, verifier=False), "two_requests")
    err("not an object", [], "bad_input")
    err("a head_sha that isn't a commit id", {**base([], verifier=False), "subject": {"repo": REPO, "head_sha": "main"}}, "bad_input")
    err("an envelope without a body", base([{"id": uid(1), "type": "review_request", "from": CONVENER, "to": "obi-bob", "correlation_id": uid(1)}], verifier=False), "bad_input")
    err("an unknown member", {**base([], verifier=False), "note": "x"}, "bad_input")
    err("a rule the review profile doesn't take", base([], verifier=False, rule={"kind": "schulze"}), "bad_panel")
    err("no seats", base([], verifier=False, seats=[]), "bad_panel")
    err("a seat twice", base([], verifier=False, seats=["obi-bob", "obi-bob"]), "bad_panel")
    err("the convener sits", base([], verifier=False, seats=[CONVENER, "obi-bob"]), "bad_panel")
    err("the verifier sits", {**base([], verifier=False), "verifier": "obi-bob"}, "bad_panel")
    return out


def vectors():
    return {
        "description": "Known-answer vectors for the review profile's tally (spec/council/review.md, section 6): a panel's envelopes from the chain, in chain order, and the clerk's count input they give, or the error. Words are sealed (any text value may be, the tally reads none). Outputs compare as JSON values: member order doesn't matter, array order does. The answers come from clerk/vectors/review.py, written apart from both implementations; every output is a count input clerk/vectors/count.json's rules accept.",
        "version": 1,
        "tally": cases(),
    }


if __name__ == "__main__":
    path = Path(__file__).with_name("review.json")
    text = json.dumps(vectors(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if path.read_text() != text:
            sys.exit("clerk/vectors/review.json is not what review.py writes")
        print("review.json matches review.py")
    else:
        path.write_text(text)
        print(f"wrote {path}")
