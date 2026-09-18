/**
 * Browser-use extension: System One drives the browser (~200 ms per step), the LLM only
 * delegates goals and writes field text.
 *
 *   browse(goal, url?)      tool for the model: run a bounded goal, return what happened + page text
 *   browser_read()          tool: current page text and interactive elements
 *   browser_close()         tool
 *   /browse <goal>          run a goal yourself and watch the steps
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ReflexConfig } from "../../config.js";
import { clip } from "../typesafe/context.js";
import { parseModelRef } from "../typesafe/router.js";
import type { ReflexState } from "../typesafe/state.js";
import { type BrowseResult, runBrowse, type TextHelper } from "./agent.js";
import { Browser } from "./browser.js";
import { actionSpace, parseFieldText, TEXT_VALUE } from "./policy.js";

const DEFAULT_START = "https://duckduckgo.com/";

export function createBrowserExtension(config: ReflexConfig, getReflex: () => ReflexState | undefined): (pi: ExtensionAPI) => void {
	return (pi) => {
		let current: Browser | undefined;

		const browserOptions = () => ({
			headless: process.env.REFLEX_BROWSER_HEADLESS === "1" || config.browser.headless,
			attachUrl: config.browser.attachUrl,
		});

		/** Text helper: the configured cheap model, else the session model, called through Pi's auth. */
		function makeTextHelper(ctx: ExtensionContext): TextHelper {
			return async (context, signal) => {
				const ref = config.browser.textModel ? parseModelRef(config.browser.textModel) : undefined;
				const model = (ref && ctx.modelRegistry.find(ref.provider, ref.id)) ?? ctx.model;
				if (!model) throw new Error("No LLM available for the text helper (set a model with /model).");
				const auth = await ctx.modelRegistry.getProviderAuth(model.provider);
				const msg = await completeSimple(
					model,
					{ systemPrompt: TEXT_VALUE, messages: [{ role: "user", content: JSON.stringify(context), timestamp: Date.now() }] },
					{ apiKey: auth?.auth.apiKey, headers: auth?.auth.headers, signal, reasoning: "off" } as never,
				);
				const raw = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
				if (msg.stopReason === "error") throw new Error(`text helper failed: ${msg.errorMessage ?? raw}`);
				return parseFieldText(raw);
			};
		}

		async function confirmIrreversible(ctx: ExtensionContext, label: string, irreversible: number, url: string): Promise<boolean> {
			if (!ctx.hasUI) return false;
			return ctx.ui.confirm("⚡ Reflex: consequential web action", `Jev thinks the next step is irreversible (${Math.round(irreversible * 100)}%):\n\n  ${label}\n  on ${url}\n\nAllow it?`);
		}

		async function browse(ctx: ExtensionContext, goal: string, url: string | undefined, maxSteps: number | undefined, onStep: (line: string, entry?: unknown) => void): Promise<BrowseResult> {
			const reflex = getReflex();
			if (!reflex?.client) throw new Error("browse needs the TypeSafe reflex layer (TYPESAFE_API_KEY / reflex setup): System One drives the browser.");
			const startUrl = url ?? (current ? undefined : DEFAULT_START);
			const { result, browser } = await runBrowse(reflex.client, {
				goal,
				browser: current,
				url: startUrl,
				browserOptions: browserOptions(),
				maxSteps: maxSteps ?? config.browser.maxSteps,
				signal: ctx.signal,
				textHelper: makeTextHelper(ctx),
				confirm: ({ decision, action, page }) => confirmIrreversible(ctx, action.label, decision.irreversible, page.url),
				onStep: (line, entry) => {
					reflex.record("browse", line);
					onStep(line, entry);
				},
			});
			current = browser;
			reflex.record("browse", `${result.status} after ${result.history.length} steps · ${result.decisions} jev calls · ${result.elapsedMs}ms · "${clip(goal, 60)}"${result.reason ? ` · ${clip(result.reason, 200)}` : ""}`);
			return result;
		}

		function summarize(result: BrowseResult, goal: string): string {
			const lines = [
				`browse ${result.status}${result.reason ? `: ${result.reason}` : ""}`,
				`goal: ${goal}`,
				`page: ${result.title} — ${result.url}`,
				`steps: ${result.history.length} · jev decisions: ${result.decisions} (${result.jevMs}ms) · text calls: ${result.textCalls} · total ${result.elapsedMs}ms`,
			];
			if (result.history.length) lines.push("", ...result.history.map((h) => `${h.step}. ${h.kind}${h.text !== undefined ? ` "${h.text}"` : ""} → ${h.action}${h.page_changed === false ? " (no change)" : ""}`));
			lines.push("", "visible page text:", clip(result.text, 3000));
			return lines.join("\n");
		}

		pi.registerTool({
			name: "browse",
			label: "Browse",
			description:
				"Delegate a web task to the System One browser agent. Give ONE complete goal in natural language (what to search, fill, select, open, and when it is done). It navigates, clicks, types and selects on its own at ~200ms per step, stops before payments/sends/deletes to ask the user, never types passwords, and returns the steps taken plus the visible text of the final page. Continues on the current page when url is omitted.",
			promptSnippet: "Run a web task (search, forms, navigation) with the fast System One browser agent",
			promptGuidelines: [
				"Use browse for anything on the web instead of curl-scraping or the computer tool: include every requirement in the goal (values to enter, filters, what counts as done).",
				"After browse returns, read its visible page text to answer the user; call browser_read for more of the current page, or browse again with a follow-up goal (url omitted) to continue.",
			],
			parameters: Type.Object({
				goal: Type.String({ description: "Complete task, e.g. 'Search Wikipedia for the Jevons paradox and open the article'" }),
				url: Type.Optional(Type.String({ description: "Where to start (default: continue current page, or DuckDuckGo)" })),
				maxSteps: Type.Optional(Type.Number({ description: "Step budget (default from config, max 200)" })),
			}),
			async execute(_id, params, _signal, onUpdate, ctx) {
				const steps: string[] = [];
				const result = await browse(ctx, params.goal, params.url, params.maxSteps, (line) => {
					steps.push(line);
					onUpdate?.({ content: [{ type: "text", text: steps.join("\n") }], details: { steps } });
				});
				if (result.status === "error") throw new Error(summarize(result, params.goal));
				return { content: [{ type: "text", text: summarize(result, params.goal) }], details: { status: result.status, steps, url: result.url, title: result.title } };
			},
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold("browse "))}${theme.fg("accent", clip(String((args as { goal?: string }).goal ?? ""), 90))}`, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				const d = (result.details ?? {}) as { status?: string; steps?: string[]; url?: string; title?: string };
				const steps = d.steps ?? [];
				if (isPartial) return new Text(`${theme.fg("warning", "● browsing")} ${theme.fg("dim", steps[steps.length - 1] ?? "observing…")}`, 0, 0);
				const icon = d.status === "done" ? theme.fg("success", "✓") : d.status === "blocked" || d.status === "error" ? theme.fg("error", "✗") : theme.fg("warning", "■");
				const head = `${icon} ${d.status ?? ""} · ${steps.length} steps · ${theme.fg("dim", clip(`${d.title ?? ""} ${d.url ?? ""}`, 80))}`;
				return new Text(expanded ? [head, ...steps.map((s) => theme.fg("dim", `  ${s}`))].join("\n") : head, 0, 0);
			},
		});

		pi.registerTool({
			name: "browser_read",
			label: "Browser read",
			description: "Read the current browser page: URL, title, visible text and the interactive elements (index, role, label, value).",
			promptSnippet: "Read the current browser page text and controls",
			parameters: Type.Object({ maxChars: Type.Optional(Type.Number({ description: "Text budget (default 6000)" })) }),
			async execute(_id, params) {
				if (!current) throw new Error("No browser page open. Call browse first.");
				const page = await current.observe();
				const { elements } = actionSpace(page.actions);
				const rows = elements.slice(0, 120).map((e) => `[${e.index}] ${e.role ?? ""} ${e.label}${e.value ? ` = "${clip(e.value, 40)}"` : ""}${e.checked !== undefined ? ` checked=${e.checked}` : ""}`);
				const text = `${page.title} — ${page.url}\n\n${clip(page.text, params.maxChars ?? 6000)}\n\nelements (${elements.length}):\n${rows.join("\n")}`;
				return { content: [{ type: "text", text }], details: { url: page.url } };
			},
		});

		pi.registerTool({
			name: "browser_close",
			label: "Browser close",
			description: "Close the Reflex browser tab.",
			parameters: Type.Object({}),
			async execute() {
				await current?.close();
				current = undefined;
				return { content: [{ type: "text", text: "browser closed" }], details: {} };
			},
		});

		pi.registerCommand("browse", {
			description: "Run a web goal with the System One browser agent and watch it: /browse <goal> [--url <start>]",
			handler: async (args, ctx) => {
				let goal = args.trim();
				let url: string | undefined;
				const m = goal.match(/\s--url\s+(\S+)/);
				if (m) {
					url = m[1];
					goal = goal.replace(m[0], "").trim();
				}
				if (!goal) return ctx.ui.notify("usage: /browse <goal> [--url https://…]", "warning");
				const lines: string[] = [ctx.ui.theme.fg("accent", `⚡ browsing: ${clip(goal, 70)}`)];
				ctx.ui.setWidget("browse", lines);
				try {
					const result = await browse(ctx, goal, url, undefined, (line) => {
						lines.push(ctx.ui.theme.fg("dim", line));
						ctx.ui.setWidget("browse", lines.slice(-8));
					});
					ctx.ui.notify(`browse ${result.status} in ${result.history.length} steps / ${(result.elapsedMs / 1000).toFixed(1)}s${result.reason ? ` — ${result.reason}` : ""}`, result.status === "done" ? "info" : "warning");
					pi.sendMessage({ customType: "reflex-browse", content: summarize(result, goal), display: true }, { deliverAs: "nextTurn" });
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				} finally {
					setTimeout(() => ctx.ui.setWidget("browse", undefined), 8000);
				}
			},
		});

		pi.registerMessageRenderer("reflex-browse", (message, { expanded }, theme) => {
			const content = typeof message.content === "string" ? message.content : "";
			const first = content.split("\n")[0] ?? "";
			return new Text(expanded ? `${theme.fg("accent", "⚡ ")}${content}` : `${theme.fg("accent", "⚡ ")}${first}`, 0, 0);
		});

		pi.on("session_shutdown", async () => {
			await current?.close();
			current = undefined;
		});
	};
}
