"""SZZ-style mining: for each fix or revert commit on origin/dev, blame the lines it removed or changed in its
parent, and report the earlier squash-merged pull requests that wrote them."""
import re, subprocess, sys, json, collections
repo = sys.argv[1]
def git(*a):
    return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True).stdout
CODE = re.compile(r"\.(rs|ts|tsx|mjs|js|swift|py|sh)$")
SKIP = re.compile(r"(^|/)(tests?|e2e|fixtures?|docs?)/|_test\.|\.test\.|Tests?/|spikes/|design/")
out = []
for line in git("log", "--format=%H\t%s", "origin/dev").splitlines():
    sha, subj = line.split("\t", 1)
    if not re.match(r"(fix|revert)", subj, re.I):
        continue
    m = re.search(r"\(#(\d+)\)\s*$", subj)
    fix_pr = int(m.group(1)) if m else None
    diff = git("diff", "-U0", f"{sha}^", sha)
    files, cur, removed = {}, None, collections.defaultdict(list)
    for d in diff.splitlines():
        if d.startswith("--- a/"):
            cur = d[6:]
        elif d.startswith("--- /dev/null"):
            cur = None
        elif d.startswith("@@") and cur:
            mm = re.match(r"@@ -(\d+)(?:,(\d+))? ", d)
            start, n = int(mm.group(1)), int(mm.group(2) or 1)
            if n > 0:
                removed[cur].append((start, start + n - 1))
    code = {f: r for f, r in removed.items() if CODE.search(f) and not SKIP.search(f)}
    nlines = sum(b - a + 1 for r in code.values() for a, b in r)
    if not code or nlines > 40:
        continue
    blamed = collections.Counter()
    for f, ranges in code.items():
        args = ["blame", "--porcelain"]
        for a, b in ranges:
            args += ["-L", f"{a},{b}"]
        bl = git(*args, f"{sha}^", "--", f)
        for bline in bl.splitlines():
            mm = re.match(r"^([0-9a-f]{40}) \d+ \d+", bline)
            if mm:
                blamed[mm.group(1)] += 1
    for intro, count in blamed.most_common():
        isubj = git("log", "-1", "--format=%s", intro).strip()
        im = re.search(r"\(#(\d+)\)\s*$", isubj)
        if not im or (fix_pr and int(im.group(1)) == fix_pr):
            continue
        stat = git("show", "--shortstat", "--format=", intro).strip()
        out.append({"fix": sha[:10], "fix_subject": subj, "fix_lines": nlines, "intro": intro[:10], "intro_subject": isubj, "blamed_lines": count, "intro_stat": stat})
json.dump(out, sys.stdout, indent=1)
