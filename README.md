# ⚡ Reflex

**A coding agent and personal assistant with System One reflexes.**

Reflex is built on the [Pi coding agent](https://github.com/earendil-works/pi) (any LLM through
OpenRouter or a direct provider), with voice input (Sarvam AI by default) and macOS
computer-use tools. What no other coding agent has: a **calibrated reflex layer** powered by
[TypeSafe's System One model, Jev](https://typesafe.ai). Jev doesn't generate text. It answers
narrow typed questions about what the agent is about to do in ~100–400 ms, with calibrated
probabilities, and Reflex acts on those numbers.

```
System Two (LLM via OpenRouter)      writes code, reasons, plans, talks
System One (TypeSafe Jev)            judges every action, every turn, every utterance
Code (Reflex)                        owns the policy: thresholds, escalation, routing
```

## What the reflex layer does

| Reflex | Jev questions (all in one parallel call) | What Reflex does with the numbers |
|---|---|---|
| **Action gate** on every `bash` / `edit` / `write` / `computer` call | destructive? outside workspace? secrets? external side effect? privileges? matches the user's request? + a 0–3 risk rubric with confidence | auto-allow / ask you / block, according to your *risk appetite*. No static allowlists, no permission popup for `npm test`, a real question for `git push --force`. Protected paths (`.env`, keys) always ask, by code. |
| **Progress monitor** after each turn | looping? error ignored? stuck? | nudges the model to change approach (rate-limited), warns you when it thrashes |
| **Completion check** when the agent stops | claims done? actually verified? scope drift? waiting on you? | if it claimed success without running anything: sends it back to verify and report real output |
| **Model router** (optional) | which tier does this request need: fast / default / strong? | switches the OpenRouter model per request when confident (cheap model for renames, strong model for "why does it crash under load") |
| **Voice intent** on every transcript | task / control / answer / chatter? complete thought? | "stop" aborts, an answer to the agent's question is sent, background speech is dropped, unfinished thoughts land in the editor for you to complete |
| **Browser agent** (`browse` tool, `/browse`) | per step: which operation (click / type / select / scroll / wait / done)? which element for each operation? + Reflex heads: irreversible? needs credentials? | System One drives Chrome at ~200 ms per step (ported from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)); the LLM only delegates goals and writes field text. Stops before payments/sends/deletes to ask you; never types passwords. |

Measured on real Jev (jev-1.13.0), balanced appetite:

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

Each decision costs about $0.00004 and 350–450 ms; the whole session's reflexes typically cost
less than one LLM turn.

## Install

Requires Node ≥ 22.19, macOS or Linux, and `ffmpeg` (or `sox`) for voice.

```bash
git clone <this repo> reflex && cd reflex
npm install && npm run build
npm link            # gives you the `reflex` command
reflex              # first run starts onboarding
```

Onboarding asks for:

1. **LLM provider and key** — OpenRouter (recommended, one key for every model), or Anthropic,
   OpenAI, Gemini, Groq, xAI, DeepSeek, Mistral. Stored in `~/.reflex/agent/auth.json` (0600).
2. **TypeSafe key** — enables the reflex layer. Pick a risk appetite: cautious / balanced / bold.
3. **Voice provider** — Sarvam (22 Indian languages + English, auto-detect, optional
   translate-to-English), OpenAI, Groq, Deepgram, or local whisper.cpp.

Keys already in your environment or a `.env` file (`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`,
`SARVAM_API_KEY`, …) are detected and offered. Re-run any time with `reflex setup`; check
everything with `reflex doctor`.

## Use

```bash
reflex                                   # interactive, in the current project
reflex web                               # browser interface: multiple sessions as tabs (see below)
reflex -p "summarize this repo"          # headless
reflex --reflex bold -p "…"              # headless with a bolder gate
reflex --assistant                       # start with macOS computer-use tools enabled
reflex --model openrouter/moonshotai/kimi-k2.7-code   # any Pi flag works
```

Inside the agent:

| Command | |
|---|---|
| `/reflex` | show policy · `appetite cautious|balanced|bold` · `gate on|off` · `monitor on|off` · `route on|off` · `routing fast=… default=… strong=…` · `stats` · `last` |
| `/voice` or **ctrl+shift+v** | push-to-talk. Enter stops and transcribes, Esc cancels. `/voice send` auto-sends complete tasks, `/voice lang hi-IN`, `/voice translate`, `/voice provider groq` |
| `/browse <goal>` | run a web task with the System One browser agent and watch the steps. The model gets the same power as the `browse` tool. Set `browser.headless`, `browser.attachUrl` (your own Chrome with `--remote-debugging-port`) or `browser.textModel` in `~/.reflex/reflex.json`. |
| `/computer on` | enable `screenshot` and `computer` tools (open apps, read the screen's accessibility tree, click, type, keys, AppleScript). Every action is gated by Reflex. |
| `/models [filter]` | pick a model with context size and $ per 1M tokens visible (Pi's `/model` hides prices) |
| `/reflex verbose off` | hide the per-decision `⚡ ✓ gate allow bash: npm test [auto-allow, 380ms]` lines (on by default so you can see Jev work) |
| `/setup` | add TypeSafe / voice keys without leaving the TUI (`/login` for LLM keys) |
| `/model`, `/thinking`, `/resume`, `/fork`, … | everything Pi offers |

The footer shows `⚡ reflex balanced 12 auto · 2 asked · 0 blocked · ~380ms` and `🎤 sarvam`.

## Web interface (`reflex web`)

`reflex web` starts a local server (default http://127.0.0.1:7331, loopback only, per-launch token)
and opens a page styled like typesafe.ai. Every session tab is its own `reflex --mode rpc`
process on your machine, so the reflex layer, `/browse`, `/computer` and all Pi commands work
exactly as in the terminal. Reflex's permission questions, browse confirmations and other dialogs
show up as modal dialogs; tool calls are collapsible cards; screenshots render inline; the mic
button records in the browser and transcribes through your configured voice provider.

Terminal sessions show up there too: every `reflex` you run in a terminal registers with the
web server (loopback only) and appears under **Live in terminal** as a read-only live transcript;
earlier sessions appear under **Recent** and can be resumed in a web tab. Set `REFLEX_WEB_URL`
if you run the server on another port.

```bash
reflex web --port 8080 --no-open
```

## Agents: schedules, webhooks, chains

The **Agents** tab (and `reflex agent …`) turns a prompt plus instructions into a job with
triggers: **cron** (`0 9 * * 1-5`, `@daily`, …), a **local webhook** (`POST
http://127.0.0.1:7331/hooks/<id>/<secret>`, JSON or text body becomes `{{input}}`), or manual.
Every trigger creates a run: a headless Reflex session in the agent's own session directory, so
agent runs never mix with your sessions. Each agent page shows its config, triggers, chain and
runs; click a run to watch its transcript live. Agents can **chain**: on success, call other
agents with `{{output}}`, or curl another agent's webhook from bash for conditional pipelines.
The scheduler and webhooks run inside `reflex web`.

Ask any Reflex session to build one ("create an agent that runs the tests every weekday at 9
and writes a report"): the bundled `reflex-agents` skill tells the model the `agent.json`
format, the CLI (`reflex agent create|run|runs|list|delete`) and how to test a run.

## Settings, packages, skills, connectors

`reflex web` → **Settings**: keys, reflex policy, voice, browser, look; **Packages** (Pi packages
from npm or git: extensions, prompts, themes; also `reflex install git:github.com/user/repo`);
**Skills** (add any SKILL.md folder from a GitHub repo, e.g. `typesafe-ai/skills`); **Connectors**
(MCP servers over stdio or streamable HTTP, stored in `~/.reflex/mcp.json`; every tool becomes a
gated Reflex tool `server__tool`; `/mcp` shows status in a session). The official
[TypeSafe agent skill](https://github.com/typesafe-ai/skills) and Reflex's own skills are
bundled and enabled automatically.

### Built-in connectors (`reflex connect`)

Skip the config entirely for the official, vendor-hosted remote MCP servers — Reflex knows the
endpoints and transport, so you only name the service:

```bash
reflex connect              # list presets and show what's enabled
reflex connect gmail        # Google Gmail          (OAuth, via mcp-remote bridge)
reflex connect slack        # Slack                 (OAuth)
reflex connect atlassian    # Atlassian Jira + Confluence (OAuth)
reflex connect linear       # Linear                (OAuth)
reflex connect linear-key --key lin_api_xxx   # Linear over streamable-HTTP with a personal API key
reflex connect linear --readonly             # read-only variant where supported
reflex connect remove slack # disable + delete a connector
```

The four OAuth remotes (Gmail, Slack, Atlassian, Linear) are bridged through `npx -y mcp-remote`,
which opens a browser tab on first use and caches the token in `~/.mcp-auth/`; later sessions are
silent. `linear-key` skips the bridge entirely and talks streamable-HTTP with a bearer token
(stored in `~/.reflex/keys.json`, or read from `LINEAR_API_KEY`). After enabling, start a session
and run `/mcp` to see the tools; each one is a gated Reflex tool named `<service>__<tool>`.

## Look

The TUI uses the typesafe.ai palette: near-black `#1e1e1e`, off-white `#fefefe`, pink accent
`#f386a1`, green `#03aa5c`, teal `#09aea1`, magenta `#d45bb6`, with a System-1-style striped
window header. Themes `typesafe` (default) and `typesafe-light` are installed into
`~/.reflex/agent/themes`; switch with `/settings` or `reflex --use-theme typesafe-light`.

## How it's built

```
src/cli.ts                    entry: .env → ~/.reflex isolation → onboarding → Pi main() with inline extensions
src/onboarding.ts             terminal wizard (keys, model, appetite, voice)
src/brand.ts                  rebrands Pi without a fork: a package shim (PI_PACKAGE_DIR) makes it say `reflex` and use ~/.reflex
src/web/ + web/app.html       `reflex web`: HTTP + SSE server spawning one `reflex --mode rpc` process per session tab;
                              Agents + Settings tabs, webhooks, presence of terminal sessions
src/agents/                   agent store (~/.reflex/agents), cron matcher, headless runner (--mode json), scheduler, CLI
src/extensions/mcp/           MCP client (stdio + streamable HTTP) exposing connector tools
                              presets.ts (gmail/slack/atlassian/linear presets), connect.ts (`reflex connect`)
skills/                       reflex, reflex-agents, typesafe-ai (official, MIT) — synced into ~/.reflex/agent/skills
src/extensions/typesafe/      the reflex layer
  client.ts                     minimal System One client (fetch, retries, stats, answer validation)
  policy.ts                     PURE: the questions, thresholds per appetite, decide() — unit-tested
  gate.ts                       tool_call hook: describe action → Jev → allow/ask/block, session allow-list, fallback rules
  monitor.ts                    turn_end / agent_end hooks: loops, ignored errors, unverified completion
  router.ts                     before_agent_start hook: tier classification → pi.setModel()
  index.ts                      /reflex command, --reflex flag, status line, warm-up
src/extensions/voice/         recorder (ffmpeg/sox → WAV), providers (Sarvam, OpenAI, Groq, Deepgram, whisper.cpp), /voice
src/extensions/browser/       System One browser agent: cdp.ts (zero-dep DevTools client), snapshot.ts (DOM → indexed
                              elements, ported from jev-ultrafast), policy.ts (operation + target fan-out + safety heads,
                              unit-tested), agent.ts (bounded loop), index.ts (browse / browser_read tools, /browse)
src/extensions/computer/      macOS screenshot + computer tools (osascript, screencapture, sips, optional cliclick)
themes/                       typesafe (dark) and typesafe-light themes: the typesafe.ai palette in the TUI
skills/reflex/SKILL.md        tells the model how to behave when gated or nudged
```

Design rules, straight from the TypeSafe docs: code owns control flow; ask many narrow, atomic
questions in one request; keep options mutually exclusive with explicit escapes; route on
confidence thresholds scaled to risk; never let the model's confidence override a hard rule
(protected paths, headless blocks).

Config lives in `~/.reflex/reflex.json`; Pi state (sessions, settings, auth) in
`~/.reflex/agent/`; non-LLM keys in `~/.reflex/keys.json`. Set `REFLEX_DEBUG=1` to append every
Jev decision to `~/.reflex/reflex-debug.log`.

## Development

```bash
npm run dev -- -p "hello"     # run from source with tsx
npm run typecheck
npm test                      # policy thresholds, gate helpers, WAV chunking, .env loader
```

## Limits and honest notes

- Jev is text-only, does no arithmetic or date math, and can be moved by adversarial content.
  Reflex therefore never lets a Jev answer *lower* a code-level guard, only raise questions.
- Calibration is population-level. The thresholds in `policy.ts` were tuned on a small set of
  realistic actions (see the table above); tune them on your own logs (`/reflex last`, debug log).
- Computer use is macOS-only and needs Accessibility + Screen Recording permission for your
  terminal app. `double_click` / `right_click` need `brew install cliclick`.
- Voice uses a 30 s REST call per chunk; long dictation is chunked automatically. Streaming
  (Sarvam realtime WebSocket) is a natural next step.
