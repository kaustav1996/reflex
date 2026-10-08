/**
 * What the reflex layer saved, and whether its numbers mean what they say.
 *
 * Both reports read what is already on disk — the call log (every LLM and Jev request, with tokens
 * and cost) and the decision log (every decision, with the probability each threshold was compared
 * against, and what came of it). Nothing new is recorded for them.
 *
 * Every figure here says where it comes from, because a savings report is the easiest thing in a
 * project like this to quietly inflate:
 *
 *   - Routing is priced as a *price difference on the same work*: the exact tokens a turn used,
 *     charged at the default tier's rates instead of the one that ran. It is not "savings": a
 *     cheaper model might have needed another turn, and that cannot be known from a log.
 *   - Trimming and pruning count the tokens they removed, once, at the input price of the model
 *     that was running. A trimmed result would have been re-read on every later turn too, so the
 *     real figure is larger — counting it once is the conservative choice.
 *   - Jev's own cost is subtracted. TypeSafe's API does not report a price per call, so it is
 *     estimated from input tokens at the published rate; OpenRouter's reported cost is used when
 *     present.
 */
import { readCalls } from "./calls.js";
import { type LoggedDecision, readDecisions } from "./decisions.js";

/** TypeSafe's published price, used only when the provider reports no cost of its own. */
export const JEV_USD_PER_MILLION = 0.042;

export interface ModelRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** What a turn's exact token usage would have cost on another model, per million rates. */
export function costAt(usage: Usage, perMillion: ModelRates): number {
	const m = (n: number | undefined, rate: number) => ((n ?? 0) * rate) / 1e6;
	return m(usage.input, perMillion.input) + m(usage.output, perMillion.output) + m(usage.cacheRead, perMillion.cacheRead) + m(usage.cacheWrite, perMillion.cacheWrite);
}

export function reportedCost(usage: Usage): number {
	const c = usage.cost;
	if (!c) return 0;
	if (typeof c.total === "number") return c.total;
	return (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
}

export interface SavingsReport {
	from?: number;
	to?: number;
	/** Turns whose model was chosen by routing, and the price difference against the default tier. */
	routing: { turns: number; spent: number; atDefault: number; difference: number; priced: number; unpriced: number };
	/** Every model call re-priced at the default tier, however the model was chosen. Context, not credit. */
	allTurns: { calls: number; spent: number; atDefault: number; difference: number };
	trimming: { calls: number; tokens: number; usd: number };
	pruning: { calls: number; tokens: number; usd: number };
	gate: { allowed: number; asked: number; blocked: number };
	triage: { hints: number; stops: number };
	screening: { marked: number };
	tools: { requests: number; toolsLeftOut: number };
	jev: { calls: number; inputTokens: number; usd: number; estimated: boolean };
	/** Price difference plus token savings, less what Jev cost. */
	net: number;
	notes: string[];
}

export interface SavingsInput {
	/** Per-million rates by `provider/model`, for pricing the counterfactual. */
	rates: Record<string, ModelRates>;
	/** The model routing would have used without an answer: the default tier. */
	defaultModel?: string;
	since?: number;
}

export function savingsReport(input: SavingsInput): SavingsReport {
	const calls = readCalls({ limit: 100000, since: input.since });
	const decisions = readDecisions({ limit: 100000, since: input.since });
	const notes: string[] = [];
	const at = (d: { at: number }) => d.at;

	const llm = calls.filter((c) => c.kind === "llm" && c.ok);
	const jevCalls = calls.filter((c) => c.kind === "typesafe");

	// Routing: the same tokens, charged at the default tier's rates — but only for the turns routing
	// actually decided. Re-pricing every call would credit routing with models the user chose, which
	// is the easiest way for a report like this to flatter itself.
	const defaultRates = input.defaultModel ? input.rates[input.defaultModel] : undefined;
	let spent = 0;
	let atDefault = 0;
	let priced = 0;
	let unpriced = 0;
	const routed = decisions.filter((d) => d.source === "route" && d.action.startsWith("switch:"));
	const used = new Set<number>();
	for (const decision of routed) {
		// The turn a routing decision produced: the next model call in the same session.
		const call = llm.find((c, i) => !used.has(i) && c.session === decision.session && c.at >= decision.at && c.at - decision.at < 5 * 60 * 1000);
		if (!call) continue;
		used.add(llm.indexOf(call));
		const detail = call.detail as { model?: string; provider?: string; usage?: Usage } | undefined;
		const usage = detail?.usage;
		if (!usage) continue;
		const mine = reportedCost(usage);
		spent += mine;
		const ref = `${detail?.provider ?? ""}/${detail?.model ?? ""}`;
		if (defaultRates && input.rates[ref]) {
			atDefault += costAt(usage, defaultRates);
			priced++;
		} else {
			atDefault += mine;
			unpriced++;
		}
	}
	// Everything else, re-priced the same way, as context rather than credit.
	let allSpent = 0;
	let allAtDefault = 0;
	for (const call of llm) {
		const detail = call.detail as { model?: string; provider?: string; usage?: Usage } | undefined;
		const usage = detail?.usage;
		if (!usage) continue;
		const mine = reportedCost(usage);
		allSpent += mine;
		const ref = `${detail?.provider ?? ""}/${detail?.model ?? ""}`;
		allAtDefault += defaultRates && input.rates[ref] ? costAt(usage, defaultRates) : mine;
	}
	if (unpriced) notes.push(`${unpriced} of ${routed.length} routed turns could not be re-priced (no rates for that model); they are counted as costing the same either way.`);
	if (routed.length && priced < routed.length) notes.push(`${routed.length - priced - unpriced} routing decisions could not be matched to a model call, and are not counted.`);
	if (!defaultRates) notes.push("No default-tier model is configured, so routing shows no price difference.");

	const sum = (d: LoggedDecision[], key: string) => d.reduce((n, x) => n + Number((x.detail as Record<string, unknown> | undefined)?.[key] ?? 0), 0);
	const trims = decisions.filter((d) => d.source === "trim");
	const prunes = decisions.filter((d) => d.source === "prune" && d.action.startsWith("left-out:"));
	const trimTokens = sum(trims, "savedTokens");
	const pruneTokens = sum(prunes, "savedTokens");

	// Those tokens would have been charged as input. Price them at the rate actually in use.
	const inputRate = (() => {
		const counts = new Map<string, number>();
		for (const c of llm) {
			const d = c.detail as { model?: string; provider?: string } | undefined;
			const ref = `${d?.provider ?? ""}/${d?.model ?? ""}`;
			if (input.rates[ref]) counts.set(ref, (counts.get(ref) ?? 0) + 1);
		}
		const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
		return common ? input.rates[common].input : undefined;
	})();
	if (!inputRate && (trimTokens || pruneTokens)) notes.push("Tokens removed are counted, but not priced: no rates were available for the models in this window.");
	const usdFor = (tokens: number) => ((inputRate ?? 0) * tokens) / 1e6;

	const gate = decisions.filter((d) => d.source === "gate");
	const triage = decisions.filter((d) => d.source === "triage");
	const screen = decisions.filter((d) => d.source === "screen");
	const toolPlans = decisions.filter((d) => d.source === "select" && d.action.startsWith("tools:"));

	let jevUsd = 0;
	let jevTokens = 0;
	let anyReported = false;
	for (const c of jevCalls) {
		const usage = (c.detail as { usage?: { input_tokens?: number; cost?: number } } | undefined)?.usage;
		jevTokens += usage?.input_tokens ?? 0;
		if (typeof usage?.cost === "number") {
			jevUsd += usage.cost;
			anyReported = true;
		} else jevUsd += ((usage?.input_tokens ?? 0) * JEV_USD_PER_MILLION) / 1e6;
	}
	if (!anyReported && jevCalls.length) notes.push(`Jev's cost is estimated at $${JEV_USD_PER_MILLION} per million input tokens: TypeSafe's API does not report a price per call.`);
	if (trims.length || prunes.length) notes.push("Trimmed and pruned tokens are counted once. The same output would have been re-read on every later turn, so the real saving is larger.");
	if (routed.length) notes.push("Routing is a price difference on the same work, not a saving: a cheaper model might have needed another turn, which a log cannot show.");

	const difference = atDefault - spent;
	return {
		from: calls[0] ? at(calls[0]) : undefined,
		to: calls[calls.length - 1] ? at(calls[calls.length - 1]) : undefined,
		routing: { turns: routed.length, spent, atDefault, difference, priced, unpriced },
		allTurns: { calls: llm.length, spent: allSpent, atDefault: allAtDefault, difference: allAtDefault - allSpent },
		trimming: { calls: trims.length, tokens: trimTokens, usd: usdFor(trimTokens) },
		pruning: { calls: prunes.length, tokens: pruneTokens, usd: usdFor(pruneTokens) },
		gate: { allowed: gate.filter((d) => d.action === "allow").length, asked: gate.filter((d) => d.action === "ask").length, blocked: gate.filter((d) => d.action === "block").length },
		triage: { hints: triage.filter((d) => d.action.startsWith("hint:")).length, stops: triage.filter((d) => d.action === "stop:repeat").length },
		screening: { marked: screen.filter((d) => d.action.startsWith("mark:")).length },
		tools: { requests: toolPlans.length, toolsLeftOut: toolPlans.reduce((n, d) => n + Number((d.detail as { heldBack?: unknown[] } | undefined)?.heldBack?.length ?? 0), 0) },
		jev: { calls: jevCalls.length, inputTokens: jevTokens, usd: jevUsd, estimated: !anyReported },
		net: difference + usdFor(trimTokens + pruneTokens) - jevUsd,
		notes,
	};
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Which outcomes are evidence about which questions.
 *
 * An outcome belongs to a decision, but a decision has several signals, and they are not all spoken
 * about by the same outcome: "the model read the suggested skill" says nothing about whether the
 * connector choice was right. A signal with no outcome that measures it is counted and shown, but
 * never scored — a number nothing can check is not calibration, it is decoration.
 */
const MEASURED: Record<string, { good: string[]; bad: string[]; signals?: RegExp }> = {
	// The gate's verdict comes from all of its signals together, so the user's answer measures them all.
	gate: { good: ["user-allowed", "user-allowed-session"], bad: ["user-denied"] },
	route: { good: ["turn-clean"], bad: ["turn-needed-nudge", "user-overrode-model"], signals: /^tier$/ },
	select: { good: ["skill-read"], bad: ["skill-not-read"], signals: /^(skill|skill_needed|fit:)/ },
	// Asking for a verification that then failed was the right call; one that passed was a false alarm.
	completion: { good: ["verification-failed"], bad: ["verification-passed", "verification-not-run"] },
	trim: { good: [], bad: ["full-output-re-read"], signals: /^chunk_/ },
};

function verdictFor(source: string, signal: string, label: string): "good" | "bad" | undefined {
	const m = MEASURED[source];
	if (!m || (m.signals && !m.signals.test(signal))) return undefined;
	if (m.good.includes(label)) return "good";
	if (m.bad.includes(label)) return "bad";
	return undefined;
}

export interface Bucket {
	/** The probability range this bucket covers, as a label. */
	range: string;
	n: number;
	withOutcome: number;
	borneOut: number;
	/** Of the decisions in this bucket that got an outcome, the share that was borne out. */
	rate?: number;
}

export interface QuestionCalibration {
	source: string;
	signal: string;
	/** The question wording's fingerprint, so a rewording shows up as a separate row. */
	qhash?: string;
	n: number;
	withOutcome: number;
	threshold?: number;
	buckets: Bucket[];
	/** Outcome labels seen, with counts, for the ones this source cannot score as good or bad. */
	outcomes: Record<string, number>;
}

export interface CalibrationReport {
	questions: QuestionCalibration[];
	/** Sources where decisions exist but nothing has closed them out yet. */
	withoutOutcomes: Array<{ source: string; n: number }>;
	total: number;
}

const BUCKETS: Array<[number, number, string]> = [
	[0, 0.2, "0–20%"],
	[0.2, 0.4, "20–40%"],
	[0.4, 0.6, "40–60%"],
	[0.6, 0.8, "60–80%"],
	[0.8, 1.01, "80–100%"],
];

/**
 * For each question, how often the decisions it drove were borne out, split by how sure it was.
 * A well-calibrated question is right more often in its high buckets than its low ones; a flat
 * profile means the number carries no information, whatever its average looks like.
 */
export function calibrationReport(opts: { since?: number; minSamples?: number } = {}): CalibrationReport {
	const decisions = readDecisions({ limit: 100000, since: opts.since });
	const rows = new Map<string, QuestionCalibration>();
	const noOutcome = new Map<string, number>();

	for (const d of decisions) {
		for (const [signal, s] of Object.entries(d.signals ?? {})) {
			const key = `${d.source}|${signal}|${d.qhash ?? ""}`;
			let row = rows.get(key);
			if (!row) {
				row = { source: d.source, signal, qhash: d.qhash, n: 0, withOutcome: 0, threshold: s.threshold, buckets: BUCKETS.map(([, , range]) => ({ range, n: 0, withOutcome: 0, borneOut: 0 })), outcomes: {} };
				rows.set(key, row);
			}
			row.n++;
			const b = row.buckets[BUCKETS.findIndex(([lo, hi]) => s.value >= lo && s.value < hi)] ?? row.buckets[row.buckets.length - 1];
			b.n++;
			const verdict = d.outcome ? verdictFor(d.source, signal, d.outcome.label) : undefined;
			if (d.outcome && verdict) {
				row.withOutcome++;
				b.withOutcome++;
				row.outcomes[d.outcome.label] = (row.outcomes[d.outcome.label] ?? 0) + 1;
				if (verdict === "good") b.borneOut++;
			}
		}
		if (!d.outcome) noOutcome.set(d.source, (noOutcome.get(d.source) ?? 0) + 1);
	}

	const min = opts.minSamples ?? 1;
	for (const row of rows.values()) for (const b of row.buckets) if (b.withOutcome >= min) b.rate = b.borneOut / b.withOutcome;
	return {
		questions: [...rows.values()].sort((a, b) => b.withOutcome - a.withOutcome || b.n - a.n),
		withoutOutcomes: [...noOutcome].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n),
		total: decisions.length,
	};
}
