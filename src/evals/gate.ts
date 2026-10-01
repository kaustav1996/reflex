/**
 * A labelled set for the gate, and the two ways to run it.
 *
 *   offline  replay the Jev answers recorded with each case through `decide()`. Deterministic, free,
 *            and runs in CI: it tests the thresholds and the rules, not the model.
 *   live     ask Jev the real questions now and score those answers. Catches a model or wording
 *            change the offline run cannot see, and needs a key.
 *
 * Design rules this file enforces, because they are the ones that are easy to get wrong:
 *
 *   Split before you tune. Every case is train or test by a hash of its id, so the split is stable
 *   across runs and machines, and a threshold tuned on train can be checked against cases nothing
 *   has ever looked at. Train improving while test stays flat is the signature of overfitting.
 *
 *   Say why a case is hard, in the case. A set filled with whatever today's model gets wrong
 *   measures that model's failure fingerprint, not what is actually risky. `whyHard` is required.
 *
 *   Noise before verdicts. A live run can repeat each case; `variance` reports how far the same
 *   question moves between identical runs. A threshold change smaller than that is not a change.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RiskAppetite } from "../config.js";
import { describeAction, isReadOnlyCommand } from "../extensions/typesafe/gate.js";
import { decide, type GateDecision, type GateSignals } from "../extensions/typesafe/policy.js";

export interface GateCase {
	id: string;
	/** Why a person would call this hard or interesting. Required: see the header. */
	whyHard: string;
	/** Where it came from: a session of the user's, a hand-written probe, a known injection shape. */
	source: "production" | "handwritten" | "injection";
	tool: string;
	summary: string;
	detail: Record<string, unknown>;
	/** The request the action claims to serve, as the gate sees it. */
	userRequest: string;
	/** What a careful person says the gate should do. */
	label: GateDecision;
	appetite?: RiskAppetite;
	protectedPathHit?: string;
	readOnlyHint?: boolean;
	hasUI?: boolean;
	/** Overrides the gate's own read-only detection; normally left unset. */
	/** Jev's answers when this case was recorded, so the offline run is deterministic. */
	recorded?: GateSignals & { model?: string };
}

export type Split = "train" | "test";

/** Stable, machine-independent, and roughly a quarter held out. */
export function splitOf(id: string): Split {
	return Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 4), 16) % 4 === 0 ? "test" : "train";
}

export function casesPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "gate-cases.jsonl");
}

export function loadCases(file = casesPath()): GateCase[] {
	if (!existsSync(file)) return [];
	const out: GateCase[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim() || line.trimStart().startsWith("//")) continue;
		out.push(JSON.parse(line) as GateCase);
	}
	const seen = new Set<string>();
	for (const c of out) {
		if (seen.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
		seen.add(c.id);
		if (!c.whyHard?.trim()) throw new Error(`case ${c.id} has no whyHard: say why it is worth testing, or drop it`);
	}
	return out;
}

export interface CaseResult {
	id: string;
	split: Split;
	label: GateDecision;
	got: GateDecision;
	ok: boolean;
	rule: string;
	source: GateCase["source"];
}

export interface EvalReport {
	results: CaseResult[];
	/** Accuracy over all cases, and over each split; test is the one that counts. */
	accuracy: { all: number; train: number; test: number };
	/** 95% interval on the overall accuracy, from the normal approximation. */
	interval: [number, number];
	byDecision: Record<string, { n: number; correct: number }>;
	missingRecordings: string[];
}

export function verdictFor(c: GateCase, signals: GateSignals): { decision: GateDecision; rule: string } {
	// The read-only hint is computed by the gate itself, not supplied by the caller: a case that
	// hand-sets it would be testing the fixture rather than the rule a session actually runs.
	const readOnlyHint = c.readOnlyHint ?? isReadOnlyCommand(describeAction(c.tool, c.detail, "/Users/you/project"));
	const v = decide(signals, c.appetite ?? "balanced", { hasUI: c.hasUI ?? true, protectedPathHit: c.protectedPathHit, readOnlyHint });
	return { decision: v.decision, rule: v.rule };
}

/** Score cases against the answers recorded with them. No network, no key, no variance. */
export function scoreOffline(cases: GateCase[]): EvalReport {
	const results: CaseResult[] = [];
	const missing: string[] = [];
	for (const c of cases) {
		if (!c.recorded) {
			missing.push(c.id);
			continue;
		}
		const { decision, rule } = verdictFor(c, c.recorded);
		results.push({ id: c.id, split: splitOf(c.id), label: c.label, got: decision, ok: decision === c.label, rule, source: c.source });
	}
	return report(results, missing);
}

export function report(results: CaseResult[], missingRecordings: string[] = []): EvalReport {
	const acc = (rows: CaseResult[]) => (rows.length ? rows.filter((r) => r.ok).length / rows.length : 1);
	const byDecision: EvalReport["byDecision"] = {};
	for (const r of results) {
		byDecision[r.label] ??= { n: 0, correct: 0 };
		byDecision[r.label].n++;
		if (r.ok) byDecision[r.label].correct++;
	}
	const p = acc(results);
	const n = Math.max(results.length, 1);
	const half = 1.96 * Math.sqrt((p * (1 - p)) / n);
	return {
		results,
		accuracy: { all: p, train: acc(results.filter((r) => r.split === "train")), test: acc(results.filter((r) => r.split === "test")) },
		interval: [Math.max(0, p - half), Math.min(1, p + half)],
		byDecision,
		missingRecordings,
	};
}

/**
 * How far the same question moves between identical runs, per signal. Any threshold change smaller
 * than this is noise, and so is any eval improvement smaller than it.
 */
export function variance(runs: GateSignals[][]): Record<string, { maxSpread: number; meanSpread: number }> {
	const keys: Array<keyof GateSignals> = ["destructive", "outsideWorkspace", "secrets", "externalSideEffect", "privilege", "intentMatch", "risk"];
	const out: Record<string, { maxSpread: number; meanSpread: number }> = {};
	for (const k of keys) {
		const spreads: number[] = [];
		for (let i = 0; i < (runs[0]?.length ?? 0); i++) {
			const values = runs.map((r) => r[i]?.[k]).filter((v): v is number => typeof v === "number");
			if (values.length > 1) spreads.push(Math.max(...values) - Math.min(...values));
		}
		out[k] = {
			maxSpread: spreads.length ? Math.max(...spreads) : 0,
			meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0,
		};
	}
	return out;
}
