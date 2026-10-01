---
name: reflex-evals
description: Build an evaluation set and improve against it without fooling yourself — task design, adversarial sampling, choosing a grader (programmatic, Jev-as-judge, LLM-as-judge), train/test splits, the noise floor, and the hillclimbing loop. Use when asked to build an eval, measure a prompt, skill or agent, tune thresholds, or make something cheaper at equal quality.
---

# Evals, and climbing against them

An eval is only useful if a better system scores higher on it. Most of the work is making that
true, and most of the ways it goes wrong are listed here.

## 1. Design the set

Four things make a set worth trusting:

- **It mirrors the real thing.** Sample the tasks you actually care about, not the ones that are
  easy to generate or easy to grade.
- **A stronger model scores higher.** If a more capable model or more thinking doesn't help, the
  tasks are ambiguous or the grader is miscalibrated. Check this once, early — it is the cheapest
  test of the set itself.
- **There is headroom.** The best model at the highest effort should be clearly below 100%, and the
  gap should be real difficulty, not impossible or contradictory tasks. A task that fails every
  single run, no matter how many times you repeat it, is usually broken rather than hard.
- **Runs don't wander.** Repeat the same case; if the verdict moves, you cannot read small
  differences. Watch for state left over from an earlier run — a file, a git history, a cached
  answer — handing the agent the answer.

**Where cases come from**, best first: real transcripts (ask about retention and sensitive data
before using them), bug reports and tickets, five to ten you write by hand, then synthesised cases
anchored on the real ones.

**Adversarial sampling.** Do not fill the set with whatever today's model fails. That measures one
model's failure fingerprint, not what is intrinsically hard. Require a reason a case is hard,
written down in the case, before it goes in. And don't trust user traffic alone: people ask for
what they expect to work, so real traffic skews easy.

## 2. Pick the cheapest grader that fits

1. **Programmatic.** Exact match, a label from a fixed set, JSON against a schema, a test that
   passes. Free, exact, no judgement. Stop here whenever the output space allows it.
2. **Jev as judge.** Write the rubric as *checkable claims*, one `noul` each, all in one request —
   questions are answered in parallel and the state is charged once. Typed, calibrated, no
   generation, output tokens free. For "which of these two is better", use a `choice` over
   `first | second | tie` with the order randomised per call, and never tell the judge which is the
   baseline. `src/evals/judge.ts` has both.
3. **LLM as judge.** Only when the verdict needs reasoning a claim cannot express. Orders of
   magnitude more per case.

**Never judge a model with itself.** A Jev judge must not grade Jev's own decisions, and an LLM
judge must not be the model under test — it will agree with itself. Grade those against human
labels instead.

**Claims, not scores out of five.** "Is this a 4/5?" invites a number with nothing behind it. Each
claim must be true or false on its own, so a failure tells you which claim failed.

**Validate the grader before believing it.** Grade a handful of cases by hand and compare. Run the
grader twice on the same output and see whether the verdict moves (`judgeIsStable`). Scoring
failures are the most common way an eval is quietly wrong.

## 3. Split, and measure the noise

- **Split before you tune.** Train is what the climber may read; test is never shown to it. Split
  by a hash of the case id so it is stable across machines, not by shuffling each run.
- **Measure the noise floor first.** Run the set twice unchanged and see how far the score and the
  underlying numbers move. An improvement smaller than that is not an improvement, and neither is a
  threshold change smaller than it. For Reflex's gate this is measured: `reflex eval --live
  --repeats 2` reports it (at the time of writing, signals move by at most ~0.08 between identical
  runs).
- If no single change could gain more than the noise, add cases or repeats instead of climbing.

## 4. Climb, one change at a time

Each round: read the failures in **train** only, make **one** change that fixes a cause rather than
rewording a symptom, re-run, then decide.

- Train up, test up → keep it.
- Train up, test flat → **overfitting; revert.**
- Anything down → revert.

Rules that keep the climb honest:

- Never paste a failing case's content into the prompt, skill or instructions. That is the eval
  leaking into the system, and it will not transfer.
- Climb on cheap, revertible surfaces: prompts, skill text, question wording, thresholds, model and
  effort. Open-ended harness edits are hard to attribute and easy to overfit.
- Pick a surface the metric is actually coupled to. If you are tuning a skill's description, measure
  how often the skill triggers — not something three steps downstream.
- When the score stalls for two or three rounds, stop editing and sort every remaining failure by
  cause. Some will be flawed cases or a bad grader; fix those instead of climbing against them.
- If the set is near saturation, aim at **cost** instead: same decisions, fewer or cheaper calls.
- Finish on the version that did best on **test**, and report the gain with its interval. If the
  gain is inside the noise, say so and recommend against shipping it.

## 5. Your own eval, in your own project

Describe it in a JSON file (`reflex-eval.json`, or any path), so it lives in the repo and runs in CI:

```json
{
  "name": "support-router",
  "run":   { "command": "node route.mjs", "stdin": "{{input}}" },
  "grade": { "kind": "exact" },
  "cases": [
    { "id": "refund", "whyHard": "A refund request that never says the word billing",
      "input": "I was charged twice for March", "expected": "billing" }
  ]
}
```

- `run` is either a **command** (the case is substituted into argv and stdin; stdout is the answer)
  or a **session** (`{"kind":"session","prompt":"…{{input}}…"}`, a headless Reflex session in the
  project). `casesFile` points at a `.jsonl` when the cases outgrow the file.
- `grade` is `exact`, `contains`, `regex`, `json-schema`, `command` (exit 0 passes), or
  **`jev-claims`** — the rubric as checkable claims, one `noul` each, in a single Jev request.
- `{{input}}`, `{{expected}}`, `{{id}}` and `{{output}}` are filled from the case.

```bash
reflex eval my-eval.json --repeats 2      # score, held-out split, interval, and the noise floor
reflex eval my-eval.json --split test     # the held-out cases only
reflex hillclimb my-eval.json --surface prompts/system.md --rounds 5 \
  --notes "how the file is actually used, so a change can take effect"
```

The climb measures the noise floor first, then each round: shows a Reflex session **only the train
failures** (ids, why each is hard, what the grader objected to — never the case text), lets it change
the surfaces you nominated, re-runs, and then decides in code. It keeps a round only when train and
held-out both improve by more than the noise; it reverts a regression, reverts a train-only gain as
overfitting, and reverts any patch that copied case text into a surface. The surface files are
restored on every revert, so a failed round leaves nothing behind. Pass `--notes` describing how your
surface is consumed, or the climber may write something your system never reads.

Worked example, from this repo's own test run: given a keyword router, the climber added rules that
took train from 40% to 100% while the held-out cases never moved. All three rounds were reverted.
That is the tool working, not failing — those rules fit the cases it could see and nothing else.

## 6. In this repo

```bash
reflex eval                          # replay recorded answers: offline, free, runs in CI
reflex eval --live --repeats 2       # ask Jev now, and measure the noise between identical runs
reflex eval --live --record          # refresh the recordings after a wording or model change
reflex eval --split test             # the held-out cases only
reflex decisions --source gate --with-outcome   # real decisions and what came of them
```

- Cases: `tests/fixtures/gate-cases.jsonl`, one JSON object per line, each with a `whyHard`.
- Harness: `src/evals/gate.ts` (cases, split, scoring, noise), `src/evals/run.ts` (live runs),
  `src/evals/judge.ts` (Jev-as-judge).
- CI floor: `tests/gate-eval.test.ts`. Raise the floor when a change earns it. Never lower it to
  make a red test green — that is the one move that makes the whole set worthless.
- New cases are welcome from the decision log, but a case needs a stated reason it is hard, and a
  label a careful person would defend, not just whatever the gate did at the time.
