# Contributing to Reflex

Thanks for looking. Bug reports, fixes and new reflexes are all welcome.

## Where to start

- Issues labelled [`good first issue`](https://github.com/kaustav1996/reflex/labels/good%20first%20issue)
  are small, self-contained, and say which files to touch and how to test the change.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) lists what's planned, with the Jev questions and the gating
  rule for each item. If you want to take one on, open an issue first so we can agree on the shape.

## Setup

Requires Node ≥ 22.19 on macOS or Linux.

```bash
git clone https://github.com/kaustav1996/reflex && cd reflex
npm install
npm test          # 70+ unit tests, about 5 seconds
npm run typecheck
npm run build     # compiles to dist/; `npm link` puts `reflex` on your PATH
```

**The tests need no API keys and no network.** Jev and every provider are faked, and `npm test`
points `REFLEX_HOME` at a fresh temporary directory, so running them never touches your real
`~/.reflex`.

To try your change by hand, run `npm run dev -- -p "hello"` (from source, one prompt) or build and
run `reflex`. That part does need a model key, and a TypeSafe or OpenRouter key for the reflex
layer. Use a throwaway `REFLEX_HOME` if you don't want to touch your own setup:

```bash
REFLEX_HOME=$(mktemp -d) npm run dev
```

For the web interface, run `reflex web --port 7333` so it doesn't collide with a copy you already
have running on 7331.

## Where things live

| Path | What it is |
| --- | --- |
| `src/extensions/typesafe/` | The reflex layer: `gate.ts` (tool-call gate), `policy.ts` (questions and thresholds, no network), `router.ts` (model routing), `selector.ts` (skill and connector hints), `monitor.ts` (loops and completion checks), `client.ts` (the Jev API client) |
| `src/agents/` | Workflow agents: steps, cron, webhooks, diagrams |
| `src/hooks/` | Session hooks (`hooks.json`) |
| `src/extensions/` | Everything else that plugs into Pi: secrets, artifacts, browser, voice, connectors, logs |
| `src/web/` + `web/app.html` | `reflex web`: a small HTTP server and a single-file frontend |
| `tests/` | `node --test` files, one per area |

## Rules for changes to the reflex layer

These keep Jev useful and keep the agent safe:

1. **Code decides, Jev advises.** Jev returns probabilities; plain code maps them to an action.
   Put thresholds in `policy.ts` (or next to the feature), not inside prompts.
2. **One judgment per question.** A question with "and" in it is two questions.
3. **Pass state as an object**, not as a prompt string.
4. **Never let Jev alone allow a destructive action.** Protected paths and dangerous commands are
   decided by deterministic code.
5. **Fail safe.** If Jev errors or times out, new code asks rather than allows. (The gate's current
   fallback still allows commands that match no dangerous pattern; roadmap item 0.1 fixes that.)
6. **Log it.** Every Jev call goes through `client.ts`, which writes to the call log with secrets
   masked. Don't call the API around it.

And for everything:

- Secrets never go through the chat, into logs unmasked, or into committed files.
- `reflex web` binds to 127.0.0.1 only.
- Add or update a test for the behaviour you changed.

## Pull requests

- One change per PR, with a short description of what changed and how you checked it.
- `npm test` and `npm run typecheck` must pass.
- AI-assisted work is fine; say so in the PR.
- Match the style of the surrounding code (tabs, small modules, comments that explain why).

## Reporting bugs

Open an issue with what you ran, what you expected and what happened. Settings → Logs in
`reflex web` (or `~/.reflex/logs/calls.jsonl`) shows every Jev and model call with secrets masked,
and a relevant line from it helps a lot. Please read it before pasting anything.

Security problems: please don't open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/kaustav1996/reflex/security/advisories/new)
instead.
