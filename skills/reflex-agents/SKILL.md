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
~/.reflex/agents/<id>/agent.json        definition (edit this file, or use the API)
~/.reflex/agents/<id>/runs/<runId>.json run status, input, output, timings
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

1. Create the directory and `agent.json` (ids are lowercase slugs). Or call the local API:

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
