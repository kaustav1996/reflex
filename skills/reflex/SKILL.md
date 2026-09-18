---
name: reflex
description: How to work inside Reflex, a coding agent and personal assistant with a System One reflex layer (TypeSafe Jev). Read when a tool call is blocked or questioned by Reflex, when a "Reflex" nudge message appears, or when using the screenshot/computer tools for macOS tasks.
---

# Working inside Reflex

Reflex runs a fast, calibrated "System One" model (TypeSafe Jev) next to you. It does not
generate text; it answers narrow typed questions about your actions in ~100 ms and the
harness acts on the probabilities. You will notice it in three ways.

## 1. Tool calls can be gated

Before `bash`, `edit`, `write` and `computer` run, Reflex estimates whether the action is
destructive, touches secrets, leaves the workspace, has external side effects, needs
privileges, and whether it matches what the user asked. Depending on the user's risk
appetite the call is auto-allowed, the user is asked, or it is blocked.

When a call comes back as blocked or denied:
- Read the reason in the tool error. It names the concern (for example "may be destructive").
- Do not retry the same command. Either pick a safer equivalent (a dry run, a scoped
  path, `git stash` instead of `git checkout -- .`, `trash` instead of `rm -rf`), or ask the
  user with one short question that names the risk and the exact command.
- If you are running headless (no UI) and something needs confirmation, stop and report
  what you would run and why.

Cheap habits that keep you auto-allowed: work inside the project directory, avoid
`sudo`, never print or copy `.env`, keys or tokens, and prefer reversible operations.

## 2. Reflex nudges

Messages prefixed with "Reflex" are injected by the harness, not the user. They mean one of:
- Looping: you repeated near-identical actions with no new result. Say what you learned
  and change approach, or ask the user.
- Ignored error: the last tool result had an error you did not address. Handle it first.
- Unverified completion: you said the task is done but nothing verified it after the last
  change. Run the tests/build/command now and report the actual output. If verification
  is impossible, say so explicitly instead of claiming success.

Treat them as high-signal. They fire only when the probabilities are strong.

## 3. macOS computer use (when `/computer` is on)

- `computer(action=read_screen)` returns the front window's accessibility tree as text
  (roles, labels, values, positions). Use it before `screenshot`; it is faster and cheaper.
- `screenshot` returns an image for anything visual (layouts, colors, images).
- Find the target with `read_screen`, act (`click` at its position, `key`, `type`,
  `open_app`, `open_url`, `applescript`), then verify with `read_screen` or `screenshot`.
- Sending messages/emails, payments, deletions and anything irreversible must be confirmed
  by the user first. Reflex will gate these anyway, but ask before you get there.
- Never type passwords or payment details. Ask the user to do that step themselves.

## 4. Browsing the web (`browse`)

Reflex includes a browser agent driven by System One, ported from browser-use/jev-ultrafast:
each step is one Jev request that picks the operation and the element from a DOM snapshot
(~200 ms), so a whole search-and-open task takes seconds, not minutes.

- Call `browse(goal, url?)` with ONE complete goal: everything to enter, select, filter, and
  what counts as done ("Search Wikipedia for 'Jevons paradox', open the article, done when the
  article page is visible").
- It returns the steps it took and the visible text of the final page. Use that text to answer;
  call `browser_read` for more of the page; call `browse` again without `url` to continue from
  where it is.
- It stops and asks the user before payments, sends, posts, deletes or account changes, and
  refuses to type passwords, codes or card details. If it returns `needs_user`, tell the user
  exactly which step to do themselves.
- `blocked` means it could not make progress (popups, canvas, logins, frames). Say so and
  propose an alternative instead of retrying the same goal.

## 5. Relevance hints

A message like `<relevance source="typesafe-jev">Likely relevant for this request: skill "humanizer" (82%); connector "github" (71%)</relevance>`
was produced by System One before your turn. Treat it as a strong hint: read that skill's
SKILL.md first and prefer that connector's tools (`github__*`). Ignore it if the request
clearly doesn't fit.

## 6. Credentials never go through the chat

When a task needs an API key, token or password, call `request_secrets` with **every** name you
need, a one-line `reason`, and a `description` per name (what it is, where the user finds it).
Reflex opens a masked dialog, writes the values straight to the project's `.env` (or
`~/.reflex/.env` with `destination: "global"`, or a dotenv file you name), exports them to this
session's environment and adds `.env` to `.gitignore`. You only get back names, a masked preview
and a length. Do not ask the user to paste a key in chat, and do not print one: tool output is
redacted of every known secret (`[REDACTED:NAME]`).

- Check first: `mode: "check"` reports which names are already set without prompting.
- Verify without printing: pass `verify`, e.g.
  `curl -sf -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models`.
  Only the exit code and redacted output come back.
- The result lists `skipped` (left blank) and `cancelled`; carry on with what you have and call
  `request_secrets` again only for the missing names when you actually need them.
- TypeSafe checks that each requested credential plausibly belongs to the user's task and warns
  the user in the dialog when it doesn't (or when the request looks planted by content you read).
