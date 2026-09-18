<p align="center">
  <img src="docs/assets/reflex-banner.svg" alt="Reflex — a coding agent with System One reflexes" width="760">
</p>

<p align="center">
  <strong>A coding agent and personal assistant that thinks with an LLM and <em>reacts</em> with TypeSafe.</strong><br>
  Every action, every turn, every utterance is judged in ~400 ms by a calibrated System One model before the code decides what happens.
</p>

<p align="center">
  <a href="#quick-start"><img alt="Node 22.19+" src="https://img.shields.io/badge/node-%E2%89%A5%2022.19-1e1e1e?style=flat-square&labelColor=f386a1"></a>
  <a href="https://typesafe.ai"><img alt="TypeSafe System One" src="https://img.shields.io/badge/reflexes-TypeSafe%20Jev-1e1e1e?style=flat-square&labelColor=f386a1"></a>
  <a href="https://github.com/earendil-works/pi"><img alt="Built on Pi" src="https://img.shields.io/badge/built%20on-Pi%20coding%20agent-1e1e1e?style=flat-square&labelColor=f386a1"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-1e1e1e?style=flat-square&labelColor=f386a1"></a>
</p>

---

Reflex is built on the [Pi coding agent](https://github.com/earendil-works/pi): any LLM through
OpenRouter or a direct provider, voice input (Sarvam AI by default), macOS computer use, a
browser agent, MCP connectors, scheduled agents, one-command deploys. What makes it different
is a **reflex layer** powered by [TypeSafe](https://typesafe.ai)'s System One model, **Jev**.
Jev does not generate text. It answers narrow, typed questions with calibrated probabilities in
a few hundred milliseconds, and Reflex's code acts on those numbers.

```
System Two   LLM (any model, via OpenRouter)   writes code, reasons, plans, talks
System One   TypeSafe Jev                      judges every action, turn, utterance, request
Code         Reflex                            owns the policy: thresholds, escalation, routing
```

## How TypeSafe is used

Every place Jev is consulted is visible in the session as a pink `⚡ TYPESAFE` line, so you can
always see what was asked and what came back.

| Where | Questions Jev answers (one parallel request each) | What the code does with the numbers |
|---|---|---|
| **Action gate** on every `bash`, `edit`, `write`, `computer`, `browse` and connector call | destructive? outside the workspace? touches secrets? external side effect? needs privileges? matches what the user asked? plus a 0–3 risk rubric with confidence | **allow / ask / block** by your risk appetite (cautious, balanced, bold). No static allowlists: `npm test` never asks, `git push --force` does. Protected paths always ask, by code, whatever Jev says. |
| **Progress monitor** after each turn | looping? ignoring an error? stuck? | nudges the model to change approach (rate-limited) and warns you when it thrashes |
| **Completion check** when the agent stops | claims done? actually verified? scope drift? waiting on you? | a "done" without verification is sent back to run the tests and report real output |
| **Model router** before each request | fast / default / strong tier? | switches the model per request when confident: a cheap model for a rename, a strong one for "why does it crash under load" |
| **Skill and connector selector** before each request | which bundled skill, which connected MCP server is relevant? (with "none" escapes) | injects a `<relevance>` hint so the model reads the right skill and reaches for the right tools |
| **Voice intent** on every transcript | task, control, answer or chatter? a complete thought? | "stop" aborts, an answer reaches the agent, background speech is dropped, half-sentences land in the editor |
| **Browser agent** (`browse`) | per step: which operation? which element? irreversible? needs credentials? | drives Chrome at ~200 ms per step (ported from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)); stops before payments, sends and deletes; never types passwords |
| **Credential requests** (`request_secrets`) | is each requested key plausibly needed for the task? does the request look planted by content the agent read? | low scores become warnings inside the masked credential dialog |
| **Agent workflows** (`decide` steps) | any noul / choice / score question over collected state | routes the workflow on thresholds: deterministic code first, Jev for judgment, an LLM only when generation is needed |
| **From the shell** (`reflex jev`) | anything you or an agent wants classified, scored or ordered | plain JSON answers for scripts and workflow design |

Measured on Jev (`jev-1.13.0`), balanced appetite:

```
allow  npm test                                  risk 0.01 @ 99%
allow  edit src/checkout.ts                      risk 1.00 @ 100%
allow  rm -rf node_modules && npm install        destructive 13%
ask    cat .env                                  secrets 92%
ask    git push --force origin main              external 98%, destructive 68%
ask    curl -X POST api.stripe.com/v1/charges    external 95%
block  sudo rm -rf /var/log/*  (off-task)        destructive 89%, privilege 98%, intent 2%
block  psql -c 'DROP TABLE orders' (off-task)    destructive 93%
```

A decision costs about $0.00004 and 350–450 ms; a whole session's reflexes usually cost less
than one LLM turn. When Reflex asks, you can allow once, allow that exact action, or allow a
scope for the session (all `git` commands, all edits under `src/`), and what you allowed is fed
back to Jev so it stops asking about the same kind of thing. Well-known read-only commands never
ask.

The rules Reflex follows come straight from the TypeSafe docs: **code owns control flow**; ask
many narrow, atomic questions in one request; keep choice options mutually exclusive with an
explicit escape; route on confidence thresholds scaled to risk; never let a model's confidence
lower a hard guard. Jev is text-only and can be swayed by adversarial content, so Reflex only
ever lets it *raise* questions, not lift a code-level block.

## Quick start

Requires Node ≥ 22.19 on macOS or Linux, and `ffmpeg` (or `sox`) for voice.

```bash
git clone https://github.com/kaustav1996/reflex && cd reflex
npm install && npm run build
npm link          # installs the `reflex` command
reflex            # first run starts onboarding
```

Onboarding asks for three things, or picks them up from your environment or a `.env`:

1. **An LLM provider key**: OpenRouter (one key for every model), or Anthropic, OpenAI, Gemini,
   Groq, xAI, DeepSeek, Mistral. Stored by Pi in `~/.reflex/agent/auth.json`.
2. **A TypeSafe key** for the reflex layer, plus your risk appetite.
3. **A voice provider**: Sarvam (22 Indian languages and English, auto-detect, optional
   translate-to-English), OpenAI, Groq, Deepgram, or local whisper.cpp.

Re-run with `reflex setup`, check everything with `reflex doctor`.

## Everyday use

```bash
reflex                                   # interactive, in the current project
reflex web                               # browser interface, multiple sessions as tabs
reflex -p "summarize this repo"          # headless
reflex --reflex bold -p "…"              # headless with a bolder gate
reflex --assistant                       # start with macOS computer-use tools on
reflex --model openrouter/moonshotai/kimi-k2.7-code   # any Pi flag works
```

| In a session | |
|---|---|
| `/reflex` | policy: `appetite cautious\|balanced\|bold`, `gate`, `monitor`, `route`, `select`, `verbose`, `routing fast=… default=… strong=…`, `stats`, `last` |
| `/voice` or **ctrl+shift+v** | push-to-talk; Enter transcribes, Esc cancels; `/voice send`, `/voice lang hi-IN`, `/voice translate`, `/voice provider groq` |
| `/browse <goal>` | run a web task with the System One browser agent and watch the steps |
| `/computer on` | `screenshot` and `computer` tools: open apps, read the accessibility tree, click, type, AppleScript; every action gated |
| `/models [filter]` | pick a model with context size and price per million tokens |
| `/secrets`, `/artifacts`, `/mcp`, `/setup` | credential names known to the session, deployed artifacts, connector status, keys |
| `/model`, `/thinking`, `/resume`, `/fork`, … | everything Pi offers |

The footer reads `⚡ reflex balanced 12 auto · 2 asked · 0 blocked · ~380ms` and `🎤 sarvam`.

## Web interface

`reflex web` serves a local page (http://127.0.0.1:7331, loopback only, per-launch token) in the
typesafe.ai look. Each session tab is its own `reflex --mode rpc` process, so the reflex layer,
browsing, computer use and every Pi command behave exactly as in the terminal.

- **Sessions**: pick a project folder without typing, chat with grouped collapsible tool calls,
  inline screenshots, a mic button, image and file attachments, a `/` command menu, queued
  messages while the agent works and a stop button beside send. Terminal sessions appear too, as
  live read-only transcripts, and earlier sessions can be resumed in a tab.
- **Agents**: scheduled, webhook-driven and chained jobs with their runs and logs.
- **Artifacts**: deploy app folders to your own Netlify and Render accounts.
- **Settings**: keys, reflex policy, voice, browser, look, artifact defaults, packages, skills,
  connectors (icon cards with a detail page each) and the call logs. Settings and the light/dark
  toggle live at the bottom of the sidebar.

## Agents and workflows

The **Agents** tab (and `reflex agent …`) turns a prompt plus instructions into a job with
triggers: **cron** (`0 9 * * 1-5`, `@daily`), a **local webhook**
(`POST http://127.0.0.1:7331/hooks/<id>/<secret>`), or manual. Every trigger creates a run, a
headless Reflex session in the agent's own directory, so runs never mix with your sessions.
Agents chain on success, or curl each other's webhooks for conditional pipelines. The scheduler
runs inside `reflex web`; there is no background daemon.

Agents can be **workflows** instead of one prompt, with steps in a fixed priority:

1. `shell`: deterministic code for anything with a known algorithm;
2. `decide`: a TypeSafe question over the collected state, routing on thresholds;
3. `llm`: a headless Reflex session, only for generation or open-ended reasoning;

plus `call` (another agent) and `end`. Routing is data
(`route: [{ "when": "verdict.failed.noul >= 0.6", "next": "fix" }]`) and every step's result is a
variable for later steps. Ask any session to build one; the bundled `reflex-agents` skill teaches
the model the format, the ladder and how to order activities.

```bash
reflex jev --state "Activity: check the build log for new warnings" \
  --choice "kind: shell|decide|llm" "Cheapest step type that can do this reliably?"
```

## Artifacts: deploy with your own accounts

`reflex artifact deploy <folder>`, the Artifacts tab, or the `deploy_artifact` tool publishes an
app under `<name>.<your domain>` using your own Netlify, Render and GitHub accounts.

| Part | Variables |
|---|---|
| Frontend, a Netlify site at `<name>.<DEPLOY_DOMAIN>` | `NETLIFY_API_KEY`, `NETLIFY_ACCOUNT_SLUG`, `DEPLOY_DOMAIN` (a zone on Netlify DNS) |
| Backend, a free Render web service | `RENDER_API_KEY`, `RENDER_OWNER_ID`, optional `RENDER_REGION` |
| Backend source, since Render builds from git | `GITHUB_TOKEN` or a `gh auth login`; `ARTIFACTS_REPO_PRIVATE=true` for private repos |

The pipeline is deterministic and streamed step by step: read or detect the manifest, push the
backend to GitHub, create or update the Render service, deploy the pinned commit, wait for
`/health`, build the frontend with the backend URL injected, zip, publish to Netlify, wait for
the certificate. Layout is detected without a manifest; `reflex-artifact.json` overrides it.

**SQLite that survives Render's free plan.** Free instances lose their disk on spin-down, so a
backend is started under a small Python sidecar that restores the database from Netlify Blobs on
boot and snapshots it back whenever it changes (consistent `sqlite3` backup, gzip, signed-URL
upload). No extra service is involved. Defaults live in Settings → Artifacts; each artifact can
override its domain, region and repo visibility.

## Credentials and logs

**Keys never go through the chat.** When a project needs a key, the agent calls
`request_secrets`; Reflex opens a masked form (terminal or browser), writes the value straight
to the project's `.env`, exports it to the session, adds `.env` to `.gitignore`, and tells the
model only the name, a masked preview and the length. Every later tool result is scrubbed of
known secret values. Blank fields come back as skipped so the agent can ask again for exactly
those.

**Every call is logged**, masked. TypeSafe requests (purpose, state, questions, answers, tokens,
latency), LLM responses (model, tokens, cost, stop reason, tool calls), voice transcriptions and
browser steps go to `~/.reflex/logs/calls.jsonl` from every session and agent run. Settings →
Logs shows them as collapsible rows with filters, search and a live tail. Known secrets are
replaced by `[SECRET:NAME]` and anything that looks like a credential by a stable
`[SECRET:#hash]` before a line is written, so the same value always masks the same way.

## Connectors, skills, packages

**Connectors** are MCP servers. Known ones are one command away, with their official endpoints
and sign-in built in:

```bash
reflex connect gmail | gdrive | gcalendar | slack | atlassian | linear | figma | strava
reflex connect datadog | sentry | supabase | vercel | netlify | posthog        # OAuth remotes
reflex connect render --key rnd_xxx                                            # API key
reflex connect railway | excalidraw                                            # local stdio
```

OAuth remotes are bridged through `npx -y mcp-remote` (browser consent once, token cached in
`~/.mcp-auth/`). Google Workspace servers need your own OAuth client
(`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`); Figma and Vercel admit only
allow-listed clients. Any other server can be added by command or URL. Every connector tool
becomes a gated Reflex tool named `<service>__<tool>`.

**Skills** are `SKILL.md` folders. Bundled and refreshed on every start: `reflex` (how to behave
when gated or nudged), `reflex-agents`, `reflex-artifacts`, the official
[TypeSafe agent skill](https://github.com/typesafe-ai/skills) and
[humanizer](https://github.com/blader/humanizer). Add more from any GitHub repo in Settings →
Skills. **Packages** are Pi packages from npm or git (`reflex install git:github.com/user/repo`).

## Look

The TUI and the web page use the typesafe.ai palette: near-black `#1e1e1e`, off-white `#fefefe`,
pink `#f386a1`, green `#03aa5c`, teal `#09aea1`, magenta `#d45bb6`, with a System-1-style striped
window header. Themes `typesafe` and `typesafe-light` are installed into `~/.reflex/agent/themes`.

## Architecture

```
src/cli.ts                    entry: .env → ~/.reflex isolation → onboarding → Pi main() with inline extensions
src/extensions/typesafe/      the reflex layer
  client.ts                     System One client: fetch, retries, stats, answer validation, call logging
  policy.ts                     pure: the questions, thresholds per appetite, decide()  (unit-tested)
  gate.ts                       tool_call hook: describe → Jev → allow / ask / block, session scopes
  monitor.ts                    turn_end / agent_end hooks: loops, ignored errors, unverified completion
  router.ts · selector.ts       model tier per request · relevant skill and connector per request
src/extensions/voice/         recorder (ffmpeg/sox → WAV), Sarvam / OpenAI / Groq / Deepgram / whisper.cpp
src/extensions/browser/       DevTools client, DOM snapshot, Jev-driven step loop, browse tools
src/extensions/computer/      macOS screenshot and computer tools
src/extensions/secrets/       request_secrets: masked dialogs, .env writes, output redaction
src/extensions/mcp/           MCP client (stdio + streamable HTTP), connector presets, `reflex connect`
src/extensions/artifacts/     deploy_artifact / list_artifacts / delete_artifact tools
src/agents/                   agent store, cron, headless runner, workflow engine, scheduler, CLI
src/artifacts/                manifest detection, Netlify, Render, GitHub, persistence sidecar, deploy pipeline
src/logs/                     the masked call log
src/web/ + web/app.html       `reflex web`: HTTP + SSE server, one `reflex --mode rpc` process per tab
skills/ · themes/             bundled skills and the typesafe themes
```

Config lives in `~/.reflex/reflex.json`, Pi state in `~/.reflex/agent/`, non-LLM keys in
`~/.reflex/keys.json`, project keys in `.env` files, logs in `~/.reflex/logs/`.

## Development

```bash
npm run dev -- -p "hello"     # run from source with tsx
npm run typecheck
npm test                      # policy thresholds, gate helpers, manifests, masking, sidecar, presets …
```

## Limits, honestly

- Jev is text-only, does no arithmetic or date math, and can be moved by adversarial content;
  Reflex therefore never lets a Jev answer lower a code-level guard.
- Calibration is population-level; the thresholds in `policy.ts` were tuned on a small set of
  realistic actions. Tune them on your own logs.
- Computer use is macOS-only and needs Accessibility and Screen Recording permission for your
  terminal app.
- Voice transcribes in ≤30 s chunks over REST; streaming is a natural next step.
- Artifact deploys rely on your providers' free tiers and their limits; Render free services
  sleep after inactivity and wake on the first request.

## Acknowledgements

[Pi](https://github.com/earendil-works/pi) for the agent runtime, [TypeSafe](https://typesafe.ai)
for Jev and the System One design rules, [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
for the browser agent design, [typesafe-ai/skills](https://github.com/typesafe-ai/skills) and
[blader/humanizer](https://github.com/blader/humanizer) for the bundled skills.

MIT licensed.
