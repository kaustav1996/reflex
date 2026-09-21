# Reflex roadmap

Where the reflex layer goes next. The sources are Udit Goenka's
[Jev model guide](https://uditgoenka.medium.com/typesafe-ai-jev-model-guide-89b33b74dd64), the
"Jev Engineering" 10-step article, the projects in
[awesome-jev](https://github.com/yibie/awesome-jev) and its open pull requests (as of 2026-09-21).

Every item has a GitHub issue; the pinned tracking issue [#42](https://github.com/kaustav1996/reflex/issues/42)
lists them by phase with their dependencies.

A listed project is an idea, not proof. Many awesome-jev entries are days old and unmeasured, and
the list says so itself. Every item below ships in **shadow mode first** (log the decision, change
nothing) and gets authority only after its accuracy is measured on real sessions.

## How to read an item

- **Why**: the problem it solves in Reflex today.
- **Jev asks**: the typed questions, one judgment each.
- **Code decides**: what happens at each confidence band. Jev never acts on its own.
- **Measure**: the number that says whether it works.
- **From**: the project or article the idea comes from.

Effort is S (a day or two), M (about a week) or L (more).

## Where we stand

What already matches the guide:

- State goes in as objects, not prompts. Each question asks one thing, and questions go out in
  parallel in one request (the gate asks five `Noul` checks and a risk `Score` at once).
- Confidence bands scale with the stakes (the risk setting), and protected paths always ask.
- Every Jev call is logged with answers, probabilities, latency and cost (Settings → Logs).
- Workflows use the ladder deterministic code → `decide` → `llm`, and each question carries its
  own item.
- The browser agent is a port of browser-use/jev-ultrafast.

What doesn't match yet:

- Thresholds were set by hand, not measured. There is no shadow week, no calibration table and
  no leakage split.
- Dangerous-command rules only run when Jev is unreachable, so a destructive command Jev scores
  as safe can run on Jev's word alone.
- When the router isn't sure, it stays on the previous model, which may be the cheap one. Every
  model switch also throws away the prompt cache.
- Most Jev calls make the agent safer, not cheaper. Only routing, the browser loop, voice intent
  and workflow `decide` steps actually replace LLM calls.

---

## Phase 0: make the current layer correct (1 to 2 weeks)

### 0.1 Deterministic rules first, on every call (S) · [#10](https://github.com/kaustav1996/reflex/issues/10)
- **Why:** the guide says a destructive action should never be allowed by Jev alone.
- **Code decides:** known-dangerous patterns (`rm -rf`, force push, `DROP`, credential paths) always
  ask. Known read-only commands are allowed without calling Jev, so nothing is sent for them. Only
  the gray zone goes to Jev. A Jev error or timeout means ask, never allow.
- **Measure:** the share of calls settled without Jev, and zero dangerous commands auto-allowed on
  the test set (0.5).
- **From:** jev-axi, pi-verdict, jev-engineering.

### 0.2 An unsure router steps up, never down (S) · [#2](https://github.com/kaustav1996/reflex/issues/2)
- **Code decides:** confidence below the bar means the default tier (or the strong tier for long or
  multi-file prompts), never the tier left over from the last prompt.
- **From:** the guide's confidence-gated routing.

### 0.3 Pin the Jev version and log it (S) · [#11](https://github.com/kaustav1996/reflex/issues/11)
- Thresholds only hold for the model they were measured on. Default to a pinned id (such as
  `jev-1.13.0`) with `jev-latest` as an opt-in. Record the model version and a hash of each
  question in every log line, so a model or wording change is visible in the data.
- **From:** the guide, jev-skill-router (awesome-jev PR #91).

### 0.4 Skill hints: two stages, and weak matches declined (S) · [#12](https://github.com/kaustav1996/reflex/issues/12)
- **Jev asks:** stage 1 is a `Choice` over the full skill list plus yes/no gate questions ("does
  this need a skill at all?"). Stage 2 is a `Choice` over the top three, with one fit question per
  candidate.
- **Code decides:** suggest a skill only when the gate and the fit both clear the bar (0.5), and
  only if the returned name is in the local list.
- **From:** jev-agent-skill-router, jev-skill-router (#91), TypeSafe's skill-suggestion cookbook.
- The 0.5 bar itself shipped in [#3](https://github.com/kaustav1996/reflex/issues/3).

### 0.5 A labeled test set for the gate, run in CI (M) · [#13](https://github.com/kaustav1996/reflex/issues/13)
- 100 to 300 real tool calls labeled allow, ask or block, including prompt-injection cases. The
  test runs against the live model when a key is present and fails when accuracy drops or a model
  update changes answers.
- **From:** jev-axi (44 labeled calls), jev-engineering (a public 300-call injection test).

---

## Phase 1: spend less on the LLM (3 to 5 weeks)

This is where Jev lowers the bill. The model picks a tool in the same response where it writes the
tool's arguments, so moving that choice to Jev saves nothing. The savings come from what the model
*reads* on every turn, and from LLM runs that never needed to start.

### 1.1 Trim tool output before the model reads it (M) · [#14](https://github.com/kaustav1996/reflex/issues/14)
- **Why:** long test logs, build output and `find` results get re-read on every later turn.
- **Jev asks:** for output above a size limit, split into chunks and ask one `Noul` per chunk:
  "Is this chunk needed to carry out the current task?" (state: the task, the command, the chunk).
- **Code decides:** always keep the head, the tail and every line matching error or failure
  patterns. Drop chunks below the bar and replace them with a marker (`[312 lines trimmed; run
  again with a filter to see them]`). The full output is saved to a file the model can read.
- **Hook:** Pi's `tool_result` handler, which Reflex already uses for secret redaction.
- **Measure:** tokens removed per session, and how often the model re-reads trimmed output
  (re-reads mean it trimmed too much).
- **From:** jev-pruner.

### 1.2 Compaction: prune first, summarize only if that isn't enough (M) · [#15](https://github.com/kaustav1996/reflex/issues/15)
- **Why:** a summary loses exact details. Most of a long session is stale tool output, and the
  conversation itself is small.
- **Jev asks:** one `Noul` per old tool call and its result: "Is this still needed to continue the
  task?"
- **Code decides:** keep every user and assistant message word for word, and drop tool results
  below the bar. Use Pi's own summary only when pruning can't free enough room. Filtering is not
  reconstruction (Theo's criticism), so the summary fallback stays.
- **Hooks:** `context` prunes what each LLM call sees without deleting history.
  `session_before_compact` supplies the pruned version instead of a summary.
- **Measure:** tokens per turn, how often compaction runs, and whether a task stalls after pruning.
- **From:** pi-fast-jev-compaction (a Pi extension), fast-jev-compaction, yoshi, jev-pruner.

### 1.3 Send only the tools, skills and connectors the prompt needs (M) · [#16](https://github.com/kaustav1996/reflex/issues/16)
- **Why:** every tool definition and skill description goes into every request.
- **Jev asks:** the selector's existing `Choice` questions, turned into a keep-or-drop decision
  per tool, skill and connector.
- **Code decides:** core tools (read, edit, write, bash) are always on. Add the relevant ones with
  `pi.setActiveTools`, and put anything the model asks for back on immediately.
- **Measure:** system prompt tokens per request, and how often the model needs something that was
  left out.
- **From:** omo-jevlike-router (shrinks the skill list in the system prompt), jev-agent-skill-router.

### 1.4 Routing that doesn't break the prompt cache (M) · [#17](https://github.com/kaustav1996/reflex/issues/17)
- **Why:** prompt caches are per model. Switching models mid-session re-reads the whole context at
  full price and can wipe out what routing saved.
- **Jev asks:** one `Choice` over the model and effort pairs the user actually has (from the
  System 2 settings), not separate tier and effort choices.
- **Code decides:** switch freely at the start of a session and right after compaction. Mid-session,
  switch only when the estimated saving beats the cost of losing the cache.
- **Measure:** cost per task compared with always using the default model, and task pass rate by
  tier.
- **From:** jcm-router (leaves the cached main chat untouched), Jev Auto Router (records whether
  the task still passed).

### 1.5 Triage failures before the model spends a turn on them (M) · [#18](https://github.com/kaustav1996/reflex/issues/18)
- **Jev asks:** after a failing command, a `Choice` for the category (missing dependency, flaky or
  transient, real bug, environment or config), plus a `Noul`: "Is this the same failure as the last
  attempts?"
- **Code decides:** for a missing dependency, propose the install command through the normal gate
  (never install on its own). For a flaky failure, suggest one retry. For the same failure three
  times, stop and tell the user.
- **Measure:** turns spent per failure, and LLM calls avoided.
- **From:** jev-harness (awesome-jev PR #85).

### 1.6 Check before waking a scheduled agent (S) · [#19](https://github.com/kaustav1996/reflex/issues/19)
- **Why:** cron and webhook agents start a full LLM run every time, even when nothing changed.
- **Jev asks:** a `Choice` of wake, not yet, or unrelated, over the incoming event and the agent's
  own note about what it is waiting for.
- **Code decides:** skip only when "wake" is very unlikely. Always wake on a direct user message,
  an error, a timeout, or after a limit of skipped runs.
- **Measure:** runs skipped, and runs that were skipped but should have run.
- **From:** wakegate.

### 1.7 Point the agent at the right files (M) · [#20](https://github.com/kaustav1996/reflex/issues/20)
- **Jev asks:** one `Noul` per tracked file, in parallel batches: "Is this file relevant to the
  task?" (state: the task line, the path, the first lines of the file).
- **Code decides:** inject the top handful as a hint at the start of the task. Big repos only.
- **Measure:** replay past commits (the task is the commit message, the right answer is the files
  it changed) and grade the ranking, as jev-assist does.
- **From:** jev-assist (awesome-jev PR #96).

---

## Phase 2: measure everything (the guide's "shadow week", built in) (3 to 4 weeks)

### 2.1 A decision log with outcomes (M) · [#21](https://github.com/kaustav1996/reflex/issues/21)
- Every Jev decision is logged with the model version, the question hash, the raw probabilities,
  the band it fell in and what code did. Add an `outcome` field that is filled in later.
- **From:** huncho (a JSONL log of decisions), jev-skill-router (#91).

### 2.2 Collect outcomes from things Reflex already sees (M) · [#22](https://github.com/kaustav1996/reflex/issues/22)
- Gate: your allow or deny on every "ask".
- Router: did the task pass, and did you switch the model back by hand?
- Completion check: did the verification it demanded then fail?
- Skill hints: did the model actually read the suggested skill?
- Trimming and pruning: did the model re-read something that was dropped?

### 2.3 A calibration page (M) · [#23](https://github.com/kaustav1996/reflex/issues/23)
- Settings → Logs → Calibration shows, per question: accuracy in each confidence bucket,
  expected calibration error, Brier score, and how much traffic each band handles.
- A leakage split by project, tool and prompt length, because a result carried by one field isn't
  a result (the guide's `Re:` subject-line trap).
- Separate thresholds per answer type. An independent test found `Choice` and `Score`
  overconfident and yes/no answers underconfident.
- **From:** the guide, jev-ood-calibration, ASSAY-001 (#84).

### 2.4 Replay thresholds and get suggestions (M) · [#24](https://github.com/kaustav1996/reflex/issues/24)
- "What if the gate threshold were 0.8?" is answered from the log with no new Jev calls.
- Suggest a threshold for a target accuracy, checked on a held-out split. Fail CI when a model
  update breaks a locked threshold.
- **From:** huncho (replay), jevcal (fitted thresholds, CI check).

### 2.5 Shadow mode for every new decision (S) · [#25](https://github.com/kaustav1996/reflex/issues/25)
- Each new decision type starts log-only, with a switch in Settings to give it authority once its
  calibration table looks good.

### 2.6 A savings report (S) · [#26](https://github.com/kaustav1996/reflex/issues/26)
- What routing saved compared with the default model, tokens trimmed or pruned, scheduled runs
  skipped, approval prompts you didn't have to answer, and turns saved by failure triage. It also
  shows what Jev itself cost, so the net figure is honest.
- **From:** hermes-jev-approvals (reports 4.4× fewer approval prompts).

### 2.7 Non-English states need their own thresholds (S) · [#27](https://github.com/kaustav1996/reflex/issues/27)
- A pre-registered test on Spanish found a non-English state costs 3 to 6 points of accuracy and
  roughly doubles calibration error. Writing the instructions in Spanish made no difference.
- Voice input in Indian languages (Sarvam) and non-English prompts get their own rows in the
  calibration table and stricter thresholds until measured. Questions stay in English.
- **From:** jev-acento (awesome-jev PR #100).

---

## Phase 3: guard what the model reads, not only what it runs (2 to 3 weeks)

### 3.1 Screen web, browser and connector results for prompt injection (M) · [#28](https://github.com/kaustav1996/reflex/issues/28)
- **Jev asks:** a `Noul` per result from untrusted sources: "Does this text try to instruct the
  assistant or change its task?"
- **Code decides:** above 0.7, mark the passage as untrusted data and show a warning. Very high
  scores are withheld and shown to you instead.
- **From:** JarvisCore (withholds retrieved passages above 0.70), jev-guard.

### 3.2 A pre-commit and pre-push hook template (S) · [#4](https://github.com/kaustav1996/reflex/issues/4)
- Ready-made Reflex hooks (the hooks feature already exists): block staged secrets and destructive
  changes, and flag a commit message that doesn't match the diff. Block only on a detected
  credential.
- **From:** jev-git, jev-commit.

### 3.3 Check the project's own rules after edits (M) · [#29](https://github.com/kaustav1996/reflex/issues/29)
- Turn the preferences in `AGENTS.md` / `CLAUDE.md` into yes/no rules, check each edited diff hunk,
  and send clear violations back to the agent as findings.
- **From:** jev-pref, Hunch, Abide.

### 3.4 "Is the answer backed by what the tools returned?" (S) · [#30](https://github.com/kaustav1996/reflex/issues/30)
- Add one `Noul` to the completion check: is the final answer supported by the tool output in this
  session? Code treats it as a second gate that can only make things stricter, never looser.
- **From:** JevLoop (awesome-jev PR #94).

---

## Phase 4: a better agent loop and UX (ongoing)

### 4.1 A completion check that costs nothing when it isn't needed (S) · [#31](https://github.com/kaustav1996/reflex/issues/31)
- Call Jev only when files changed and no passing check ran since. Deterministic evidence decides
  whether the check runs at all.
- **From:** jev-belay, limpet.

### 4.2 Answer the agent's open questions when it's safe (M) · [#32](https://github.com/kaustav1996/reflex/issues/32)
- When the agent ends on a question ("should I also update the docs?"), Jev picks an answer and a
  safety `Noul` checks it. Only above both bars does Reflex answer for you, always visibly.
  Otherwise the turn comes back to you.
- **From:** dsh-auto-mode (0.6 choice confidence and a 0.5 autonomy-safety check).

### 4.3 Browser and computer use (M) · [#33](https://github.com/kaustav1996/reflex/issues/33)
- Two yes/no checks ("goal reached?", "stuck?") block a premature DONE or BLOCKED.
- A parent agent hands bounded browsing tasks to the Jev loop, which hands ambiguity back.
- On the desktop, choose from the macOS accessibility tree instead of screenshots.
- **From:** Jev for Chrome, jev-agent-browser, Yappy, jev-desktop.

### 4.4 Voice turn-taking (S) · [#34](https://github.com/kaustav1996/reflex/issues/34)
- On each partial transcript: "Is the sentence complete?" and "Is this a command?", so Reflex
  answers as soon as you finish instead of waiting out a silence timer.
- **From:** jev-canvas.

### 4.5 A plain-language command palette (S) · [#35](https://github.com/kaustav1996/reflex/issues/35)
- Type "turn off routing" or "show my deploys" and one `Noul` per command or settings page ranks
  them. The top result runs only when it clears the bar and isn't destructive.
- **From:** DWIM (awesome-jev PR #87).

### 4.6 New workflow step types (M) · [#36](https://github.com/kaustav1996/reflex/issues/36)
- `trajectory`: after each step, a controller choice of continue, switch approach, verify or stop.
  From DataJev (#95).
- `grep`: semantic grep, one `Noul` per chunk ranked above a threshold. From jgrep, nlgrep.
- `rerank`: one `Noul` per candidate. Pair it with vector search: one measured study found Jev
  reranking alone did not beat vector retrieval.

---

## Phase 5: where Jev runs (as needed)

### 5.1 Any `/v1/systemone` server (S) · [#37](https://github.com/kaustav1996/reflex/issues/37)
- A third provider next to TypeSafe and OpenRouter: a custom base URL for local servers that speak
  the same API (jev-local, LitJev, Laya). Enables offline and private use. Calibration is measured
  separately for each.

### 5.2 Vercel AI Gateway and Cloudflare (S) · [#38](https://github.com/kaustav1996/reflex/issues/38)
- The other two ways in from the guide, for people who already pay for those gateways. The answer
  type `boolean` maps to `noul`.

### 5.3 What happens when Jev is down (S) · [#39](https://github.com/kaustav1996/reflex/issues/39)
- Default: the deterministic rules (0.1) and ask. Opt-in: run the same typed questions on an LLM
  through TypeSafe's system-one-adapter (#90), clearly labeled as slower and more expensive.

### 5.4 Let the model ask Jev (M) · [#40](https://github.com/kaustav1996/reflex/issues/40)
- Expose narrow Jev judgments as tools the model can call ("rank these files", "is this output an
  error?"). Code still owns thresholds and actions.
- **From:** pi-typesafe-jev, jev-use.

### 5.5 Experiment: laya-mlx as a local backend for small, frequent decisions (M) · [#41](https://github.com/kaustav1996/reflex/issues/41)
- [laya-mlx](https://github.com/mizorewww/laya-mlx) runs the open-weight Laya models (Apache-2.0) on
  Apple Silicon in 7–13 ms per question, against 550–990 ms for Jev over the network in our own call log.
- Only for decisions that fit its limits: Laya reads 512–1,024 tokens (320–768 of state) and falls off
  above about 20 options, while our gate, completion and selector states are 2,200–3,000 tokens.
  Candidates are output trimming (1.1), file relevance (1.7) and maybe routing. **The gate stays on Jev.**
- A tiny local server translating `/v1/systemone` to `laya_mlx.predict`, a per-decision backend
  setting, and a side-by-side shadow run before switching anything. Needs 5.1 and 2.5.
- OpenJEV (a frozen Qwen3-4B research preview) is out of scope: about 530 ms locally, 4–8 GB of memory
  and its own `/decide` API.

---

## Phase 6: memory, telemetry and self-improvement

Reflex forgets everything between sessions, and a workflow run starts blank. Shared memory is the base
for getting better for one user over time. The design borrows from an analysis of the Instinct
assistant's memory ([Dhravya Shah](https://x.com/DhravyaShah/status/2101745550752428340)): git-tracked
markdown files of dated facts, `[[links]]` and aliases, keyword retrieval instead of vectors, a
profile with an explicit autonomy section, nightly reconciliation, and memory the agent reads but
never writes directly.

### 6.1 A git-tracked memory store shared by sessions and workflows (M) · [#43](https://github.com/kaustav1996/reflex/issues/43)
- Markdown files under `~/.reflex/memory/` (and opt-in per project): one entity per file (profile,
  project, preference, decision, workflow, artifact), each a list of dated facts with aliases and
  `[[links]]`. Every change is a git commit. Secrets never enter memory.

### 6.2 Write path: the agent proposes, a screened inbox decides (M) · [#44](https://github.com/kaustav1996/reflex/issues/44)
- A `remember` tool and events Reflex already sees (corrections, gate answers, model switches, run
  results) feed an inbox. Jev screens each candidate: durable? contains a secret? contradicts an
  existing fact? Code drops junk and secrets; the rest waits for review or reconciliation.

### 6.3 Read path: the same context for sessions and workflow agents (M) · [#45](https://github.com/kaustav1996/reflex/issues/45)
- A short profile and a project one-pager at session start, then keyword search plus one Jev `Noul`
  per candidate file on each prompt. Workflow runs get the same context. The chat shows what was
  injected.

### 6.4 Nightly reconciliation as a built-in workflow agent (M) · [#46](https://github.com/kaustav1996/reflex/issues/46)
- Consolidate threads, generalize repeated examples into traits, replace outdated facts with dated
  corrections, process the inbox. Code gathers, Jev judges duplicates and contradictions, an LLM step
  only writes merged text. One git commit per run.

### 6.5 Memory page in reflex web (M) · [#47](https://github.com/kaustav1996/reflex/issues/47)
- Browse, search, follow links, review the inbox, edit, forget, revert from git history, turn memory off.

### 6.6 Self-improvement from outcomes (L) · [#48](https://github.com/kaustav1996/reflex/issues/48)
- Learn autonomy calibration from gate answers, working preferences from corrections, model
  preferences from switches, and what makes each workflow succeed. Shadow mode first; never loosens a
  deterministic safety rule; autonomy changes need the user's approval. Needs 6.2, 6.3, 2.2 and 2.5.

### 6.7 Share learnings about Reflex itself as issues, with approval (M) · [#49](https://github.com/kaustav1996/reflex/issues/49)
- Jev sorts learnings about Reflex from learnings about the user. Reflex drafts an issue with secrets,
  paths and personal details removed, shows the exact text, checks for duplicates, and sends only on
  an explicit click (the user's own `gh` login, or a prefilled new-issue page).

### 6.8 Observability page in Settings (M) · [#50](https://github.com/kaustav1996/reflex/issues/50)
- Graphs from the local call log: calls, cost, tokens, latency and errors over time by kind and model;
  gate, routing and nudge activity; sessions, runs and budgets. Local only, inline SVG charts.
  Optionally local spans through `@earendil-works/pi-telemetry`, with opt-in OTLP export.

### 6.9 Monitoring on the Artifacts page (M) · [#51](https://github.com/kaustav1996/reflex/issues/51)
- Uptime and response-time checks while `reflex web` runs, Render metrics and logs, Netlify deploy
  and function logs where the API allows, an opt-in page-view beacon to the artifact's own backend,
  and an `artifact_down` hook event. The user's own credentials, as for deploys.

### 6.10 Optional Agnost AI export (M) · [#52](https://github.com/kaustav1996/reflex/issues/52)
- With the user's own Agnost account: OTel `gen_ai.*` and `tool.*` spans for each session (turns,
  tool calls, Jev decisions) exported to Agnost. Metadata only by default, secrets masked, prompts and
  tool content only when the user enables them. Insights about Reflex feed 6.7.

---

## Not doing

- Letting Jev alone decide destructive actions, payments, sends or deletes.
- Moving tool choice to Jev inside a coding turn: the model has to write the arguments anyway.
- Treating vendor or project benchmarks as our accuracy. Only the calibration page counts.
- Adopting a listed project's code without checking it: several arrived as same-day batches with
  thin history.

## Suggested order

1. Phase 0 (all of it): correctness and safety.
2. 1.1 trimming, 1.2 compaction, 1.3 tool pruning: the direct cost cuts.
3. 2.1 to 2.3: the log, outcomes and calibration page, so every later item can be measured.
4. 1.4 routing, 1.6 wake check, 3.1 injection screen.
5. Phase 6, starting with the memory store (6.1) and the observability page (6.8); self-improvement
   (6.6) waits for the outcome log and shadow mode.
6. Everything else, in the order the savings report and the calibration page suggest.
