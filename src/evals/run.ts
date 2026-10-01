/**
 * Running the gate set against a live Jev, and recording its answers back into the cases.
 *
 * The offline run in gate.ts replays those recordings, so this is the only place a key is needed.
 * Use it to refresh recordings after a model or wording change, and to measure the noise floor
 * before believing any improvement.
 */
import { writeFileSync } from "node:fs";
import { createKeyResolver, loadDotEnv, loadReflexConfig } from "../config.js";
import { piStoredApiKey } from "../extensions/typesafe/state.js";
import { buildGateQuestions } from "../extensions/typesafe/policy.js";
import type { GateSignals } from "../extensions/typesafe/policy.js";
import { createJevClient } from "../extensions/typesafe/provider.js";
import { casesPath, type CaseResult, type EvalReport, type GateCase, report, splitOf, variance, verdictFor } from "./gate.js";

export function jevForEval(timeoutMs = 20000) {
	loadDotEnv();
	const config = loadReflexConfig();
	return createJevClient(config, createKeyResolver(piStoredApiKey), { timeoutMs });
}

/** The state the gate sends, rebuilt from a case so a live run asks exactly what a session would. */
export function stateFor(c: GateCase): Record<string, unknown> {
	return {
		action: { tool: c.tool, ...c.detail },
		workspace: { cwd: "/Users/you/project", git_repo: true, protected_paths: [".env", "**/.env*", "**/*.pem", "**/id_rsa*", "~/.ssh/**", "~/.aws/**"] },
		user_request: c.userRequest,
		earlier_requests: [],
		recent_context: [],
		user_previously_allowed_this_session: [],
	};
}

export async function askOnce(c: GateCase, client: NonNullable<ReturnType<typeof jevForEval>>["client"]): Promise<GateSignals & { model?: string }> {
	const res = await client.systemOne({ purpose: "eval:gate", state: stateFor(c), questions: buildGateQuestions() });
	const a = res.answers;
	return {
		destructive: a.destructive.noul,
		outsideWorkspace: a.outside_workspace.noul,
		secrets: a.secrets.noul,
		externalSideEffect: a.external_side_effect.noul,
		privilege: a.privilege.noul,
		intentMatch: a.intent_match.noul,
		risk: a.risk.score,
		riskConfidence: a.risk.confidence,
		model: res.model,
	};
}

export interface LiveRun {
	report: EvalReport;
	signals: Map<string, GateSignals & { model?: string }>;
	/** Present when repeats > 1: how far each signal moved between identical runs. */
	noise?: ReturnType<typeof variance>;
	errors: Array<{ id: string; error: string }>;
}

/** Ask Jev for every case, `repeats` times. The last run's answers are the ones scored. */
export async function runLive(cases: GateCase[], opts: { repeats?: number; onCase?: (id: string, n: number) => void } = {}): Promise<LiveRun> {
	const made = jevForEval();
	if (!made) throw new Error("no TypeSafe or OpenRouter key: a live run needs one (the offline run doesn't)");
	const repeats = Math.max(1, opts.repeats ?? 1);
	const runs: GateSignals[][] = [];
	const errors: LiveRun["errors"] = [];
	const latest = new Map<string, GateSignals & { model?: string }>();
	for (let n = 0; n < repeats; n++) {
		const thisRun: GateSignals[] = [];
		for (const c of cases) {
			opts.onCase?.(c.id, n + 1);
			try {
				const s = await askOnce(c, made.client);
				thisRun.push(s);
				latest.set(c.id, s);
			} catch (err) {
				errors.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
			}
		}
		runs.push(thisRun);
	}
	const results: CaseResult[] = [];
	for (const c of cases) {
		const s = latest.get(c.id);
		if (!s) continue;
		const { decision, rule } = verdictFor(c, s);
		results.push({ id: c.id, split: splitOf(c.id), label: c.label, got: decision, ok: decision === c.label, rule, source: c.source });
	}
	return { report: report(results), signals: latest, noise: repeats > 1 ? variance(runs) : undefined, errors };
}

/** Write the live answers back into the cases file, so CI can replay them without a key. */
export function recordInto(cases: GateCase[], signals: Map<string, GateSignals & { model?: string }>, file = casesPath()): number {
	let n = 0;
	const lines = cases.map((c) => {
		const s = signals.get(c.id);
		if (s) n++;
		return JSON.stringify(s ? { ...c, recorded: s } : c);
	});
	writeFileSync(file, `${lines.join("\n")}\n`);
	return n;
}
