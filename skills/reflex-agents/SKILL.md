---
name: reflex-agents
description: How to build, schedule, trigger and chain Reflex agents (scheduled or webhook-driven automations that run headless Reflex sessions). Use when the user asks to automate something on a schedule, react to a webhook, build a workflow/pipeline of agents, or manage existing agents.
---

# Reflex agents

An **agent** is a saved job: a prompt template plus instructions, a working directory, a model,
a Reflex risk appetite, and **triggers** (manual, cron, webhook). Every trigger creates a **run**:
a headless Reflex session (`reflex --mode json`) whose transcript is stored under the agent, not
in the user's session list. Runs, triggers and config are visible in the web UI's **Agents** tab
(`reflex web`). The scheduler and webhooks are served by `reflex web`, so it must be running for
cron and webhook triggers to fire.

## Where things live

```
~/.reflex/agents/<id>/agent.json        definition (change it with create_agent, not by hand)
~/.reflex/agents/<id>/runs/<runId>.json run status, input, output, timings
~/.reflex/agents/<id>/runs/<runId>.state.json   resume checkpoint of a workflow run
~/.reflex/agents/<id>/runs/<runId>.events.jsonl   full event log of the run
~/.reflex/agents/<id>/sessions/         Pi session files for the runs
```

## agent.json

```json
{
  "name": "Nightly test report",
  "description": "Runs the test suite and writes a summary",
  "cwd": "/Users/me/projects/shop-api",
  "instructions": "You are a CI reporter. Never modify files. Summarize failures with file:line.",
  "prompt": "Run `npm test`, then write a short markdown report of failures to reports/{{now}}.md. Input: {{input}}",
  "model": "openrouter/anthropic/claude-sonnet-4.6",
  "reflex": "balanced",
  "tools": ["read", "bash", "grep", "find", "ls", "write"],
  "computer": false,
  "timeoutMinutes": 20,
  "triggers": [
    { "type": "cron", "schedule": "0 2 * * 1-5", "input": "nightly" },
    { "type": "webhook", "secret": "<generated>" },
    { "type": "manual" }
  ],
  "chain": [ { "agentId": "notify-slack", "input": "Test report:\n{{output}}" } ],
  "enabled": true
}
```

- `{{input}}` in `prompt` is the trigger payload (webhook body, cron `input`, or the text given
  to a manual run). `{{now}}`, `{{agent}}`, `{{run}}` are also available.
- `reflex`: headless runs cannot ask the user, so anything Reflex would ask about is **blocked**
  and reported in the run. Use `bold` only for agents that must act autonomously and are safe.
- `tools`: give agents the minimum. Read-only: `["read","grep","find","ls"]`.
- Cron is 5-field local time (`m h dom mon dow`) or `@hourly`, `@daily` (09:00), `@weekly`,
  `@weekdays`.

## Creating and testing an agent (as the coding agent)

1. Create or update it with the **`create_agent` tool** (pass the same `id` to update). It writes
   valid JSON for you. Don't write or patch `agent.json` with `edit`, `write` or shell commands:
   long shell commands full of quotes and HTML entities break the JSON easily, and an agent whose
   file doesn't parse disappears from the Agents tab and never runs. Outside a session, the local
   API does the same:

```bash
curl -s -X POST http://127.0.0.1:7331/api/agents -H 'Content-Type: application/json' \
  -H "x-reflex-token: $REFLEX_WEB_TOKEN" -d @agent.json
```

2. Run it once and read the result:

```bash
reflex agent run <id> --input "test payload"
```

This prints the run id, status, tool-call count, Reflex blocks and the final answer. The full
transcript is under `~/.reflex/agents/<id>/runs/`. Fix the prompt/instructions until a manual run
does the right thing, then add the cron or webhook trigger.

3. Webhooks: each webhook trigger gets a local URL, shown in the Agents tab:

```
POST http://127.0.0.1:7331/hooks/<id>/<secret>
```

Body: JSON (`{"input": "..."}` or any JSON, passed as text) or plain text. The response contains
the run id. Use webhooks to **chain agents**: an agent's `chain` list calls other agents with its
output on success, or an agent can `curl` another agent's webhook from bash for conditional
branching.

## Rules for building agents

- One job per agent; chain agents for pipelines instead of one huge prompt.
- Put facts the agent needs (paths, commands, formats) in `instructions`; keep `prompt` short.
- Never store secrets in `agent.json`; use environment variables available to `reflex web`.
- Tell the user the webhook URL and the schedule you configured, and how to disable it
  (`"enabled": false` or the toggle in the Agents tab).

## Design rule: deterministic → TypeSafe → LLM

When you build an agent, prefer **workflow steps** over a single prompt, and choose the
cheapest capable step type for every activity, in this order:

1. **`shell`** — deterministic code: commands, scripts, `jq`, `git`, `curl`. Use it for anything
   with a known algorithm: collecting data, running tests, formatting, validation, notifications.
2. **`decide`** — a TypeSafe Jev question over the collected state, when the next step depends
   on a judgment (is this a bug? which category? how severe? which of these files matters?).
   ~100 ms, calibrated probabilities, routes by thresholds you set. Never for generation or math.
3. **`llm`** — a headless Reflex session, only for work that needs generation or open-ended
   reasoning (write the fix, draft the report, investigate an unknown failure). Give it the
   narrowest prompt and tool set; feed it the facts from earlier steps.

`call` runs another agent (chain) and `end` finishes. Routing is data: `route: [{ "when":
"verdict.failed.noul >= 0.6", "next": "fix" }, { "when": "default", "next": "end" }]`.
Variables: each step's result is stored under its `id` (or `as`) — `shell` gives
`{stdout, stderr, exitCode, ok}`, `decide` gives the raw Jev answers, `llm` gives
`{status, output, toolCalls, reflexBlocks}` — and any `{{path.to.value}}` can be used in later
steps' `run`, `state`, `prompt`.

```json
"steps": [
  { "id": "tests", "type": "shell", "run": "npm test 2>&1 | tail -80", "allowFailure": true },
  { "id": "verdict", "type": "decide",
    "state": { "test_output": "{{tests.stdout}}", "exit_code": "{{tests.exitCode}}" },
    "questions": {
      "failed": { "type": "noul", "instructions": "Did at least one test fail?" },
      "flaky": { "type": "noul", "instructions": "Do the failures look like timeouts or network flakiness rather than logic errors?" },
      "severity": { "type": "score", "instructions": "How severe are the failures?", "criteria": ["No failures", "A few isolated failures", "Core functionality broken"] }
    },
    "route": [
      { "when": "verdict.failed.noul < 0.5", "next": "ok" },
      { "when": "verdict.flaky.noul >= 0.7", "next": "retry" },
      { "when": "default", "next": "fix" }
    ] },
  { "id": "retry", "type": "shell", "run": "npm test 2>&1 | tail -80", "next": "end" },
  { "id": "fix", "type": "llm", "tools": ["read", "grep", "find", "ls", "edit", "bash"],
    "prompt": "These tests failed (severity {{verdict.severity.score}}/2):\n{{tests.stdout}}\nFind the cause and fix it. Run the tests again before finishing." },
  { "id": "ok", "type": "end", "output": "all green: {{tests.stdout}}" }
]
```

### Decide steps that lead somewhere

Jev never sees a question's id, so put the requirement in `instructions` and describe every
option in `criteria`. Give it evidence in the `state` (findings, sources, remaining gaps), in
fields separate from the original request. Questions that read the same state go in ONE decide
step: they are answered in parallel and cannot see each other's answers, so anything that needs a
fresh result belongs after the step that produces it.

**Route to review when Jev is unsure.** A choice answer has `choice` and `confidence`; a score has
`score` and `confidence`; a noul is a probability where ~0.5 means "don't know". Confidence is not
accuracy, so start strict and tune on real runs:

```json
"route": [
  { "when": "next.worker.confidence < 0.85", "next": "review" },
  { "when": "next.worker.choice == research", "next": "research" },
  { "when": "next.worker.choice == write", "next": "write" },
  { "when": "default", "next": "review" }
]
```

**Rebuild the menu every time.** Options must reflect what exists now, not what existed when the
agent was written. A `shell` step that prints JSON exposes it as `<id>.json`; a choice can build
its options from that list on every execution (static `criteria` stay as escapes).

Keep that step's stdout JSON: send progress messages to stderr (`echo "fetched 15 issues" >&2`).
If the command logs a few lines first, the JSON block that ends the output is still read, but
nothing may follow it. When the command already saves the JSON to a file, point the step at it
with `"jsonFile": "issues.json"` (relative to the step's folder) and print whatever you like.
If the JSON is an object that holds the list, use the path to it: `fetch.json.issues`.

```json
{ "id": "workers", "type": "shell", "run": "cat workers.json" },
{ "id": "next", "type": "decide", "state": { "goal": "{{input}}", "done_so_far": "{{notes.stdout}}" },
  "questions": { "worker": { "type": "choice", "instructions": "Which available worker should act next?",
    "optionsFrom": "workers.json", "optionId": "name", "optionText": "{{item.description}}",
    "criteria": { "review": "The request is unclear, out of scope, or the work is complete." } } } }
```

`instructions` and `criteria` are templates too (`{{var.path}}`).

**Big candidate lists: filter in code, score the rest, choose among the shortlist.** `forEach`
asks one question about every item of a list in parallel batches and ranks the answers. The step
result has `ranked` (best first, each with `id`, `value`, `confidence`, `item`), `shortlist`
(the kept items) and `count`; a later choice can use `optionsFrom: "<id>.shortlist"`.

```json
{ "id": "fetch", "type": "shell", "run": "jq '[.[] | select(.year >= 2026)]' papers.json" },
{ "id": "rank", "type": "decide", "state": { "goal": "{{input}}" },
  "forEach": { "from": "fetch.json", "id": "title", "top": 5, "min": 1.2,
    "question": { "type": "score", "instructions": "How relevant is this paper to the goal?",
      "criteria": ["unrelated", "partially relevant", "directly addresses the goal"] } },
  "route": [ { "when": "rank.count < 1", "next": "nothing" }, { "when": "default", "next": "write" } ] }
```

### Limits, stopping points and resuming

Every agent that runs unattended gets `limits`; a run that would cross one ends as failed with a
`budget:` error, and its cost so far is on the run record.

```json
"limits": { "maxCostUsd": 0.25, "maxJevCalls": 50, "maxLlmRuns": 2, "maxSteps": 40 }
```

- Put a stopping point before anything irreversible: draft and save, then end at review.
  Publishing, sending and deploying need their own approval step; headless runs block what the
  reflex gate would ask about.
- A confident answer does not prove that a file was saved or a message was sent. After an `llm`
  or side-effecting step, verify with a `shell` step (the file exists, the test passes, the API
  returns the new state) before routing to `end`.
- Progress is saved after every completed step. `reflex agent resume <agent> <run>` (or the resume
  button) continues a failed, timed-out or cancelled run at the next step with its variables
  restored; completed steps are not repeated. A step that was interrupted mid-way runs again, so
  make side-effecting steps check before they act.
- Senders that retry should pass an idempotency key to the webhook (`Idempotency-Key` header,
  `?key=`, or `idempotency_key` in the JSON body): the same key returns the existing run instead
  of starting another. Cron triggers are keyed per minute automatically.
- Judge an agent by cost per completed task (`reflex agent runs <id>` shows `$` per run), not per
  call: a cheap decision that sends a worker down the wrong branch costs more than it saved.

### Session hooks: run an agent when a session does something

Besides cron, webhooks and manual runs, a workflow agent can be started by a **session hook**:
"when a session does X, run Y". Hooks live in `~/.reflex/hooks.json` (global) or
`<project>/.reflex/hooks.json` (off until the user approves that file in a session), and can be
edited in `reflex web` → Settings → Hooks. `/hooks` lists the active ones.

```json
{ "hooks": [
  { "id": "report-on-stop", "event": "agent_end",
    "if": { "question": "Did this turn change source code?", "min": 0.6 },
    "run": { "agent": "test-report", "input": "Session in {{cwd}} stopped. Last reply: {{lastAssistant}}" } },
  { "id": "no-force-push", "event": "before_tool", "match": { "tool": "bash", "command": "^git push .*--force" },
    "run": { "command": "echo 'force pushes are not allowed in this repo'; exit 2" } }
] }
```

Events: `session_start`, `session_end`, `prompt`, `before_tool`, `after_tool`, `turn_end`,
`agent_end`, `model_change`, `compact`. `match` narrows by `tool` (name, list or glob), `command`
(regex on the bash command), `path` (glob), `prompt` (regex) and `error` (after_tool). `if` asks
Jev one yes/no question about the event and fires only at or above `min`: use it so an expensive
agent runs only when it matters. An agent action starts the run detached (it outlives the
session and is listed under the agent with trigger `hook`); templates can use `{{event}}`,
`{{cwd}}`, `{{tool}}`, `{{command}}`, `{{path}}`, `{{prompt}}`, `{{result}}`, `{{lastAssistant}}`.
A command gets the payload as JSON on stdin and `REFLEX_*` env vars; on `before_tool` it is
awaited and exit code 2 blocks the tool call, with its output as the reason. Runs started by a
hook do not fire hooks themselves, so there are no loops.

### Effects and trial runs

Tag every step with what it can change: `"effect": "read"` (only reads), `"local"` (changes files
on this machine, e.g. edits or commits in a checkout) or `"external"` (anything others can see:
push, merge request, ticket comment, message, deploy). Untagged `shell`, `llm`, `call` and `spawn`
steps count as external. A **trial run** (the "trial run" button, `reflex agent run <id> --trial`)
executes read and local steps and only reports external ones with what they would have done, so
the whole workflow can be tested before it touches anything shared. Tag accurately: a step tagged
`read` that pushes would run in a trial.

### Helper agents: `spawn`, never curl the local API

When an agent needs follow-up agents (a monitor per ticket that watches an MR), keep their
definition in the agent's `templates` and create them with a `spawn` step. Don't `curl`
`http://127.0.0.1:7331/api/agents`: that ties the agent to one machine and port and can't be shared.

```json
"templates": {
  "monitor": { "name": "Monitor {{spawn.ticket}}", "prompt": "Check MR {{spawn.mr}} for review comments. {{input}}",
               "triggers": [{ "type": "cron", "schedule": "*/30 * * * *" }] }
},
"steps": [
  { "id": "watch", "type": "spawn", "effect": "external", "template": "monitor",
    "agent": "monitor-{{triage.json.key}}", "with": { "ticket": "{{triage.json.key}}", "mr": "{{push.json.url}}" } },
  { "id": "stop_watch", "type": "spawn", "action": "delete", "agent": "monitor-{{triage.json.key}}" }
]
```

Only `{{spawn.<name>}}` placeholders are filled when the helper is created; everything else
(`{{input}}`, step variables) is left for the helper's own runs. Actions: `create` (default),
`run` (`input`, `wait`), `enable`, `disable`, `delete`, and only on helpers this agent created.
Spawn steps never run in a trial.

### Sharing agents

`export_agent` (or the Share button on the agent page) writes a `.reflex-agent.json` bundle:
machine-specific values become `{{param.X}}` parameters, requirements (connectors, CLIs, secret
names, Jev) are listed, secrets are never included. Someone imports it with the Import button in
the Agents tab, by attaching it to a session, or with `reflex agent import <file>`; a session then
reviews it with them (skill `reflex-agent-import`). Build agents so they share well: tag effects,
use `spawn` for helpers, keep secrets in the environment.

### The diagram

Every agent has a workflow diagram in the Agents tab (and `reflex agent diagram <id>` prints it
as Mermaid): triggers → each step coloured by kind (green = deterministic `shell`, pink =
TypeSafe `decide`, magenta = `llm`, teal = `call`) → end → chained agents, with pink edges for
routes decided by TypeSafe answers. Use "preview diagram" in the editor while designing, and
check that expensive nodes (llm) sit behind a decide gate and side effects come last.

### Ordering activities

Order steps so the cheap and certain things run first and the expensive or consequential
things run last: gather facts (shell) → decide whether anything needs doing (decide) → act
(llm or shell) → verify (shell) → notify (shell/call). Put a `decide` gate before every `llm`
step; most runs should end before reaching one. Side effects (sending, deploying, posting)
go last and should be `shell` steps with explicit inputs, not LLM improvisation.

To classify or order activities you are unsure about, ask Jev from the shell:

```bash
reflex jev --state "Activity: check whether yesterday's build log contains new warnings" \
  --choice "kind: shell|decide|llm" "Which step type is the cheapest that can do this activity reliably?"
reflex jev --state @activities.json --score "How early in the workflow should this activity run?" --levels "first: cheap fact gathering|middle: judgment or transformation|last: side effects"
```

`reflex jev` prints the probabilities; treat < 0.6 confidence as "ask the user or pick the
more conservative option".
