/**
 * Climbing against an eval without fooling yourself.
 *
 * Each round: read the failures on the *train* split, let a Reflex session make one change to the
 * surfaces you nominated (a prompt, a skill, a config), re-run, and decide. The deciding is done
 * here, in code, not by the thing proposing the change:
 *
 *   train up and test up        keep
 *   train up and test flat/down OVERFITTING — revert
 *   train down                  revert
 *   gain inside the noise       revert, and say the set is too small or too noisy to tell
 *
 * Two guards the loop enforces rather than hopes for:
 *
 *   Test is never shown. The proposer is given failures from train only — ids, the stated reason
 *   each case is hard, and what the grader objected to. Held-out cases are not named.
 *
 *   No case content in the surface. After each patch the surface is checked for verbatim fragments
 *   of any case, including held-out ones. That is the eval leaking into the system: it scores well
 *   and transfers nothing. A patch that leaks is reverted even if the score went up.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { EvalCase, EvalSpec } from "./spec.js";
import { type ProjectReport, runEval } from "./project.js";

export interface RoundDecision {
	keep: boolean;
	reason: string;
}

/** The whole policy of the climb, as one pure function: easy to read, easy to test, hard to fudge. */
export function decideRound(baseline: ProjectReport, candidate: ProjectReport, noise: number): RoundDecision {
	const dTrain = candidate.score.train - baseline.score.train;
	const dTest = candidate.score.test - baseline.score.test;
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	if (dTrain < -1e-9) return { keep: false, reason: `train fell ${pct(-dTrain)} — revert` };
	if (dTest < -1e-9) return { keep: false, reason: `held-out fell ${pct(-dTest)} — revert, whatever train did` };
	if (dTrain <= noise && dTest <= noise) return { keep: false, reason: `moved less than the noise floor (${pct(noise)}): not a change` };
	if (dTrain > noise && dTest <= 1e-9) return { keep: false, reason: `train up ${pct(dTrain)} but held-out flat — that is what overfitting looks like` };
	return { keep: true, reason: `train +${pct(dTrain)}, held-out +${pct(dTest)}` };
}

/** Verbatim fragments of a case that must not appear in a surface file. */
export function leakFragments(c: EvalCase, min = 24): string[] {
	const out: string[] = [];
	for (const v of [c.input, c.expected]) {
		const text = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
		const trimmed = text.trim();
		if (trimmed.length >= min) out.push(trimmed.slice(0, 160));
	}
	return out;
}

export function findLeaks(surfaceText: string, cases: EvalCase[]): Array<{ id: string; fragment: string }> {
	const hay = surfaceText.toLowerCase();
	const found: Array<{ id: string; fragment: string }> = [];
	for (const c of cases) {
		for (const f of leakFragments(c)) {
			if (hay.includes(f.toLowerCase())) found.push({ id: c.id, fragment: f.slice(0, 60) });
		}
	}
	return found;
}

export interface Surface {
	path: string;
	backup: string;
}

export function snapshot(paths: string[]): Surface[] {
	const dir = mkdtempSync(join(tmpdir(), "reflex-climb-"));
	return paths.map((p) => {
		const path = resolve(p);
		if (!existsSync(path)) throw new Error(`surface not found: ${path}`);
		const backup = join(dir, `${basename(path)}.${Math.random().toString(36).slice(2, 8)}`);
		copyFileSync(path, backup);
		return { path, backup };
	});
}

export function restore(surfaces: Surface[]): void {
	for (const s of surfaces) copyFileSync(s.backup, s.path);
}

export function surfaceText(surfaces: Surface[]): string {
	return surfaces.map((s) => readFileSync(s.path, "utf8")).join("\n");
}

export function changed(surfaces: Surface[]): boolean {
	return surfaces.some((s) => readFileSync(s.path, "utf8") !== readFileSync(s.backup, "utf8"));
}

/**
 * What the proposer is told about the last round. Train only, and never the case content: the id,
 * the stated reason it is hard, and the grader's objection.
 */
export function failureBrief(spec: EvalSpec, report: ProjectReport, limit = 12): string {
	const byId = new Map(spec.cases.map((c) => [c.id, c]));
	const failures = report.results.filter((r) => r.split === "train" && !r.pass).slice(0, limit);
	if (!failures.length) return "No failures on the train split.";
	return failures
		.map((f) => {
			const c = byId.get(f.id);
			return `- ${f.id}: hard because ${c?.whyHard ?? "(no reason given)"}\n  grader said: ${f.detail ?? f.error ?? "failed"}`;
		})
		.join("\n");
}

export const CLIMB_INSTRUCTIONS = `You are improving a system against an evaluation, one change per round.

Rules, which are checked afterwards:
- Make ONE change, to the files listed as surfaces. Fix the cause of the failures, don't reword a line.
- Never copy any evaluation case's text, inputs or expected answers into those files. A rule that
  names a specific case scores well and helps nothing in production; the change is reverted if any
  case's text appears in a surface.
- You are shown failures from the training split only. Do not try to infer or guess the held-out cases.
- Keep the change small enough that its effect could show above the evaluation's noise.
Reply with one sentence saying what you changed and why.`;

export interface RoundLog {
	round: number;
	proposal: string;
	report: ProjectReport;
	decision: RoundDecision;
	leaks: Array<{ id: string; fragment: string }>;
}

export interface ClimbResult {
	baseline: ProjectReport;
	rounds: RoundLog[];
	best: ProjectReport;
	kept: number;
}

/**
 * The loop. `propose` is injected so the driver (CLI, test, or another agent) decides how a change
 * is actually made; this file owns only the discipline around it.
 */
export async function hillclimb(
	spec: EvalSpec,
	opts: {
		surfaces: string[];
		rounds: number;
		noise: number;
		propose: (brief: string, round: number) => Promise<string>;
		onRound?: (log: RoundLog) => void;
		stallAfter?: number;
	},
): Promise<ClimbResult> {
	const baseline = await runEval(spec);
	let best = baseline;
	const logs: RoundLog[] = [];
	let stalled = 0;
	let kept = 0;
	for (let round = 1; round <= opts.rounds; round++) {
		const surfaces = snapshot(opts.surfaces);
		const proposal = await opts.propose(failureBrief(spec, best), round);
		if (!changed(surfaces)) {
			restore(surfaces);
			logs.push({ round, proposal, report: best, decision: { keep: false, reason: "nothing was changed" }, leaks: [] });
			if (++stalled >= (opts.stallAfter ?? 3)) break;
			continue;
		}
		const leaks = findLeaks(surfaceText(surfaces), spec.cases);
		if (leaks.length) {
			restore(surfaces);
			const log = { round, proposal, report: best, decision: { keep: false, reason: `the patch copied case text into a surface (${leaks.map((l) => l.id).join(", ")}) — reverted` }, leaks };
			logs.push(log);
			opts.onRound?.(log);
			stalled++;
			continue;
		}
		const report = await runEval(spec);
		const decision = decideRound(best, report, opts.noise);
		if (decision.keep) {
			best = report;
			kept++;
			stalled = 0;
		} else {
			restore(surfaces);
			stalled++;
		}
		const log = { round, proposal, report, decision, leaks: [] };
		logs.push(log);
		opts.onRound?.(log);
		if (stalled >= (opts.stallAfter ?? 3)) break;
	}
	return { baseline, rounds: logs, best, kept };
}

/** Write a short report of the climb, for the person who has to decide whether to ship it. */
export function climbReport(result: ClimbResult, noise: number): string {
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	const lines = [
		`baseline  all ${pct(result.baseline.score.all)} · train ${pct(result.baseline.score.train)} · held-out ${pct(result.baseline.score.test)}`,
		`final     all ${pct(result.best.score.all)} · train ${pct(result.best.score.train)} · held-out ${pct(result.best.score.test)}`,
		"",
	];
	for (const r of result.rounds) lines.push(`round ${r.round}: ${r.decision.keep ? "kept" : "reverted"} — ${r.decision.reason}\n  ${r.proposal.split("\n")[0].slice(0, 120)}`);
	const gain = result.best.score.test - result.baseline.score.test;
	lines.push("");
	lines.push(
		gain <= noise
			? `Held-out gain ${pct(gain)} is inside the noise floor (${pct(noise)}): this is not evidence of an improvement. Add cases or repeats before trusting a result this size.`
			: `Held-out gain ${pct(gain)}, above the noise floor (${pct(noise)}). ${result.kept} change${result.kept === 1 ? "" : "s"} kept.`,
	);
	return lines.join("\n");
}

export function writeClimbReport(file: string, result: ClimbResult, noise: number): void {
	writeFileSync(file, `${climbReport(result, noise)}\n`);
}
