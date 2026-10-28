# The Council's evaluation: results

The question: do panels of independent reviewers find more of the bugs a later fix confirmed than a single reviewer does, at what cost, and does reviewing blind beat reviewing with the others' findings in view? [README.md](README.md) says how the cases were chosen, how a seat runs and how it is scored. Nothing here is judged by a model: a finding catches a bug when it points within 5 lines of what the later fix changed, and the clerk counts every panel's verdict.

**Scope of this run.**

- **Four cases.** Pull requests in obi-ai-bot/oby whose bug a later commit fixed: #120 (fixed by #129), #94 (#109), #1526 (#1527) and #113 (#140).
- **Seats.** Every seat runs Anthropic's Claude Sonnet through `claude -p`, with read-only tools and a $1.50 cap per seat.
- **Conditions.**
  - Single seats against panels of three and five, all blind: five blind seats per case, with every subset of three and the set of five.
  - Blind against open: three blind seats against three where each sees the earlier seats' findings.
- **One vendor against mixed vendors: pending.** The second vendor's seats (`cursor-agent` with a non-Anthropic model) wait for the owner's Cursor subscription. A second Claude model isn't a second vendor, and nothing below counts one.

## The comparisons

| Comparison | Status |
|---|---|
| One seat against panels of three and five | Run: four cases, five blind Claude Sonnet seats each. |
| Blind against open | Run: three blind seats against three open ones, per case. |
| One vendor against mixed vendors | **Pending.** It needs seats on a second vendor's models: `cursor-agent` with a non-Anthropic model, which waits for the owner's Cursor subscription. Running a second Claude model in its place would test one vendor twice, so this row stays open until those runs exist. |

## The numbers

From `node eval/score.mjs`, on the records in [runs/](runs/):

#### Caught, per case (a finding within 5 lines of the fixed lines)

| Case | Single seat (mean of blind seats) | Caught as a blocker | Panel of 3 (all subsets) | Panel of 5 | Panel of 3 stops it for the bug |
|---|---|---|---|---|---|
| secret-names (#120, fixed by #129) | 100% | 60% | 100% | 100% | 100% |
| die-with-parent (#94, fixed by #109) | 40% | 0% | 90% | 100% | 0% |
| keychain-found-time (#1526, fixed by #1527) | 80% | 0% | 100% | 100% | 0% |
| blocking-none (#113, fixed by #140) | 20% | 0% | 60% | 100% | 0% |

Best single seat (the blind seat number that caught the most cases): 3 of 4 cases.

#### Caught, by the author's reading: the finding's words describe the confirmed bug (reading.json)

| Case | Single seat | Panel of 3 (all subsets) | Panel of 5 | Blind 1–3 | Open 1–3 |
|---|---|---|---|---|---|
| secret-names | 100% | 100% | 100% | yes | yes |
| die-with-parent | 0% | 0% | 0% | no | no |
| keychain-found-time | 0% | 0% | 0% | no | no |
| blocking-none | 0% | 0% | 0% | no | no |

Best single seat, by that reading: 1 of 4 cases; the panel of five: 1 of 4.

#### Blind against open, three seats each (seat 1 is the same run in both)

| Case | Blind 1–3 caught | Open 1–3 caught | Blind repeats | Open repeats | Blind false vetoes | Open false vetoes |
|---|---|---|---|---|---|---|
| secret-names | yes | yes | 100% | 100% | 0 | 0 |
| die-with-parent | no | yes | – | 50% | 0 | 0 |
| keychain-found-time | yes | yes | 75% | 100% | 0 | 0 |
| blocking-none | yes | yes | 0% | 0% | 0 | 0 |

#### False alarms and cost

| Case | False blockers per seat | False vetoes, panel of 3 | False vetoes, panel of 5 | Cost per seat | Panel of 3 | Panel of 5 | Runs (failed) | Spent, failed runs included |
|---|---|---|---|---|---|---|---|---|
| secret-names | 0.0 | 0.0 | 0.0 | $0.48 | $1.43 | $2.38 | 7 (2) | $2.92 |
| die-with-parent | 0.0 | 0.0 | 0.0 | $0.31 | $0.94 | $1.57 | 7 (2) | $2.27 |
| keychain-found-time | 0.0 | 0.0 | 0.0 | $0.77 | $2.32 | $3.87 | 7 (4) | $5.93 |
| blocking-none | 0.0 | 0.0 | 0.0 | $1.42 | $4.27 | $7.12 | 7 (7) | $10.33 |

Total: 28 runs with an answer, 15 failed and run again, $21.45 in all.

## What it shows

1. **One model's seats share blind spots, and more of them didn't help.** By location, panels look strong: the panel of five "caught" all four bugs, and the best single seat three. But read the findings and only one bug was caught: the secret scan's loophole (#120), which every seat found.
   - On the Keychain timing bug (#1526), all ten located findings were other issues at the same lines: cache eviction, and `keychain_on()`.
   - On "Blocking: none" (#113), both were another parsing gap.

   Five independent runs of one model missed the same two bugs. So, by that reading, the best single seat caught 1 of 4 and the panel of five 1 of 4. This run does **not** show a panel finding more than its best single seat (the epic's done-when 2). It shows why rule I4 asks for more than one vendor, and that comparison is the pending row.
2. **Where one model is inconsistent, a panel does cover more.** On #94 (`--die-with-parent`), two of five blind seats saw the right cause, the missing cleanup of the bubblewrap tree, though through the runner's death rather than through Stop (`partly` in [reading.json](reading.json)). Any panel of three held such a finding 90% of the time, and the panel of five did.
3. **Severity decides the verdict, and the seats under-rated.** Every finding that described a real cause on #94 was `minor`, and every seat approved. With the veto only on blockers, every panel approved a change whose bug was later fixed. On #120, three of five seats made the catch a blocker, and every panel of three rejected it for that reason. A panel can only count what its seats call blocking: calibration (process.md step 10) has to score severity as well as location.
4. **No false alarms at blocker level.** No seat raised a blocker that wasn't the confirmed bug, so no panel was vetoed by a false finding. With this model, the risk was missing or under-rating, not crying wolf.
5. **Blind against open: no gain, some herding.** In the open panels, later seats repeated earlier seats' findings more than blind seats did: 100% against 75% on #1526. They caught nothing the blind seats didn't.
   - On #94, the open panel's catch came from its second seat, which had seen an empty list from the first.
   - The third open seat then repeated it.

   Three seats on four cases can't say more than that, but nothing here argues for showing seats each other's findings before they answer (rule I1).
6. **Cost per change grows with the change's size.**
   - One seat cost $0.31 to $1.42, a panel of three $0.94 to $4.27, and a panel of five $1.57 to $7.12.
   - On the largest change (#113, a 553-line diff), three of seven seats ran out of their $1.50 budget before answering, and counted as absent.
   - In all, the run spent $21.45, including runs repeated after the account's usage limit.

## Limits of this run

- **Four cases, one model.** Each rate is over five seats on one change; the differences are directions, not measurements with error bars. Every seat is the same model, so the panels show what independent runs of one model add, and the vendor question stays open.
- **Location matching overcounts, and the reading is a person's.** A finding counts as catching the bug when its lines come within 5 of the lines the fix changed. On two of the four cases every such finding was about something else, so the results also give the author's reading of each located finding ([reading.json](reading.json)). That reading is a judgement, kept apart from the mechanical rule: the records in [runs/](runs/) hold every finding's words, for anyone who wants to read them and disagree.
- **False alarms are an upper bound.** Every blocker that isn't the confirmed bug counts as a false alarm, though some may be real bugs nobody has fixed yet.
- **Budget.** A seat that reached the $1.50 cap without answering is absent, as a seat that runs out of its budget is in the process (process.md step 1). That happened most on the largest change (#113). A rerun after the account's usage limit is not a budget failure: those runs were repeated, and their cost is counted in "Spent".
- **No verifier.** No panel here challenges its blockers. The false vetoes are what a verifier would have to refute (review.md section 6).
