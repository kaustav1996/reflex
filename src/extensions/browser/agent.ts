/**
 * The browse loop: observe → one Jev request (operation + per-operation targets +
 * Reflex safety heads) → validate → act → repeat. Bounded, observable, never retries a mutation.
 * A small LLM writes text only for TYPE_TEXT. Ported from jev-ultrafast's agent.py.
 */
import type { TypesafeClient } from "../typesafe/client.js";
import { Browser, type BrowserOptions, type PageAction, type PageState, StalePage } from "./browser.js";
import { buildBrowserRequest, type Decision, type HistoryEntry, MAX_DECISIONS, MAX_STEPS, resolveDecision, TEXT_VALUE } from "./policy.js";

export type BrowseStatus = "done" | "blocked" | "stopped" | "needs_user" | "error";

export interface BrowseResult {
	status: BrowseStatus;
	reason?: string;
	url: string;
	title: string;
	text: string;
	history: HistoryEntry[];
	decisions: number;
	textCalls: number;
	elapsedMs: number;
	jevMs: number;
}

export interface TextHelper {
	(context: { goal: string; field: { label?: string; role?: string; value?: string }; page: { title: string; text: string }; recent_actions: Array<{ action: string; text?: string }> }, signal?: AbortSignal): Promise<string | null>;
}

export interface BrowseOptions {
	goal: string;
	/** Existing browser to continue on; otherwise one is opened at `url`. */
	browser?: Browser;
	url?: string;
	browserOptions?: BrowserOptions;
	maxSteps?: number;
	signal?: AbortSignal;
	textHelper: TextHelper;
	/** Called before an action Jev flags as irreversible (payment, send, delete…). Return false to stop. */
	confirm?: (info: { decision: Decision; action: PageAction; page: PageState }) => Promise<boolean>;
	onStep?: (line: string, entry?: HistoryEntry) => void;
	/** Threshold on the `irreversible` head above which `confirm` is required. */
	irreversibleThreshold?: number;
}

export { TEXT_VALUE };

export async function runBrowse(client: TypesafeClient, opts: BrowseOptions): Promise<{ result: BrowseResult; browser: Browser }> {
	const maxSteps = Math.min(opts.maxSteps ?? MAX_STEPS, 200);
	const started = performance.now();
	const history: HistoryEntry[] = [];
	let decisions = 0;
	let textCalls = 0;
	let jevMs = 0;
	let pendingText: { key: string; text: string | null } | undefined;
	const browser = opts.browser ?? (await Browser.open(opts.url ?? "about:blank", opts.browserOptions));
	if (opts.browser && opts.url) await browser.navigate(opts.url);

	const finish = (status: BrowseStatus, page: PageState | undefined, reason?: string): { result: BrowseResult; browser: Browser } => ({
		browser,
		result: {
			status,
			reason,
			url: page?.url ?? browser.url,
			title: page?.title ?? "",
			text: page?.text ?? "",
			history,
			decisions,
			textCalls,
			elapsedMs: Math.round(performance.now() - started),
			jevMs: Math.round(jevMs),
		},
	});

	let page: PageState;
	try {
		page = await browser.observe();
	} catch (err) {
		return finish("error", undefined, err instanceof Error ? err.message : String(err));
	}

	while (true) {
		if (opts.signal?.aborted) return finish("stopped", page, "aborted");
		if (decisions >= MAX_DECISIONS) return finish("blocked", page, `decision budget (${MAX_DECISIONS}) reached`);
		if (history.length >= maxSteps) return finish("blocked", page, `step budget (${maxSteps}) reached`);

		if (!(await browser.fresh(page))) page = await browser.observe();

		// ── predict ──────────────────────────────────────────────────────
		const built = buildBrowserRequest(page, opts.goal, history);
		let decision: Decision;
		const t0 = performance.now();
		try {
			const res = await client.systemOne({ purpose: "browse", state: built.state, questions: built.questions, signal: opts.signal, timeoutMs: 12000 });
			jevMs += res.latencyMs;
			decision = resolveDecision(res.answers as never, built, Math.round(res.latencyMs), res.model);
		} catch (err) {
			return finish("error", page, `Jev: ${err instanceof Error ? err.message : String(err)}`);
		}
		decisions++;
		const pct = (x: number) => `${Math.round(x * 100)}%`;

		// ── terminal choices ─────────────────────────────────────────────
		if (decision.choice === "DONE" || decision.choice === "BLOCKED") {
			if (!(await browser.fresh(page))) {
				page = await browser.observe();
				continue;
			}
			opts.onStep?.(`${decision.choice.toLowerCase()} (${pct(decision.confidence)}, ${Math.round(performance.now() - t0)}ms)`);
			return finish(decision.choice === "DONE" ? "done" : "blocked", page, decision.choice === "BLOCKED" ? "Jev found no supported operation that makes progress" : undefined);
		}
		const action = page.actions.find((a) => a.id === decision.choice);
		if (!action) {
			page = await browser.observe();
			continue;
		}

		// ── Reflex safety heads ──────────────────────────────────────────
		if (decision.needsCredentials >= 0.7 && (action.kind === "fill" || action.kind === "click")) {
			return finish("needs_user", page, `this step needs a password, code, or payment details (${pct(decision.needsCredentials)}). Reflex never types those; please complete it yourself.`);
		}
		if (decision.irreversible >= (opts.irreversibleThreshold ?? 0.6) && action.kind !== "wait" && action.kind !== "scroll") {
			const ok = opts.confirm ? await opts.confirm({ decision, action, page }) : false;
			if (!ok) return finish("stopped", page, `stopped before a consequential action: "${action.label}" (irreversible ${pct(decision.irreversible)})`);
		}

		// ── text helper for TYPE_TEXT ────────────────────────────────────
		let text: string | undefined;
		if (action.kind === "fill") {
			if (!(await browser.fresh(page))) {
				page = await browser.observe();
				continue;
			}
			const context = {
				goal: opts.goal,
				field: { label: action.label, role: action.role, value: action.value },
				page: { title: page.title, text: page.text.slice(0, 6000) },
				recent_actions: history.slice(-6).map((h) => ({ action: h.action, text: h.text })),
			};
			const key = JSON.stringify(context);
			let value: string | null;
			if (pendingText && pendingText.key === key) value = pendingText.text;
			else {
				try {
					value = await opts.textHelper(context, opts.signal);
				} catch (err) {
					return finish("error", page, err instanceof Error ? err.message : String(err));
				}
				textCalls++;
				pendingText = { key, text: value };
			}
			if (value === null) return finish("needs_user", page, `the field "${action.label}" needs a value that is not in the goal. Tell me what to enter.`);
			text = value;
		}

		// ── act (consume the decision; never retried) ────────────────────
		try {
			await browser.act(action, page, text);
		} catch (err) {
			if (err instanceof StalePage) {
				page = await browser.observe();
				continue;
			}
			return finish("error", page, err instanceof Error ? err.message : String(err));
		}
		pendingText = undefined;
		const entry: HistoryEntry = {
			step: history.length + 1,
			action: action.label,
			kind: action.kind,
			choice: decision.choice,
			text,
			url: page.url,
			latency_ms: decision.latencyMs,
			confidence: decision.confidence,
		};
		history.push(entry);
		const before = page.fingerprint;
		try {
			page = await browser.observe();
		} catch (err) {
			return finish("error", page, err instanceof Error ? err.message : String(err));
		}
		entry.page_changed = page.fingerprint !== before;
		entry.url = page.url;
		opts.onStep?.(`${entry.step}. ${action.kind}${text !== undefined ? ` "${text.slice(0, 40)}"` : ""} → ${action.label.slice(0, 50)} (${pct(decision.probability)}, ${decision.latencyMs}ms${entry.page_changed ? "" : ", no change"})`, entry);

		const recent = history.slice(-3);
		if (recent.length === 3 && recent.every((h) => h.page_changed === false && h.kind !== "wait")) {
			return finish("blocked", page, "three consecutive actions changed nothing");
		}
	}
}
