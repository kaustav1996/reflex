/**
 * Running a user's own eval: produce an answer per case, grade it, and report with the split and
 * the interval. Repeats are how the noise floor is measured — run the set unchanged twice and the
 * spread is the smallest difference worth acting on.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Split } from "./gate.js";
import { fill, type EvalCase, type EvalSpec, type Grader, type Runner } from "./spec.js";
import { judgeWithJev } from "./judge.js";
import { jevForEval } from "./run.js";

export function splitOf(id: string): Split {
	return Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 4), 16) % 4 === 0 ? "test" : "train";
}

function sh(command: string, args: string[], opts: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((res) => {
		const child = execFile(command, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120000, maxBuffer: 8 * 1024 * 1024, shell: true }, (err, stdout, stderr) => {
			res({ stdout: String(stdout), stderr: String(stderr), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
		});
		if (opts.stdin !== undefined) {
			child.stdin?.write(opts.stdin);
			child.stdin?.end();
		}
	});
}

export async function produce(spec: EvalSpec, c: EvalCase): Promise<{ output: string; error?: string }> {
	const run = spec.run as Runner;
	if (run.kind === "session") {
		const prompt = fill(run.prompt, { id: c.id, input: c.input, expected: c.expected });
		const args = ["--mode", "text", "--reflex", run.reflex ?? "balanced"];
		if (run.model) args.push("--model", run.model);
		if (run.tools?.length) args.push("--tools", run.tools.join(","));
		args.push("-p", JSON.stringify(prompt));
		const r = await sh(process.execPath, [process.argv[1], ...args], { cwd: spec.dir, timeoutMs: run.timeoutMs ?? 300000 });
		return { output: r.stdout.trim(), error: r.code === 0 ? undefined : r.stderr.slice(0, 300) };
	}
	const command = fill(run.command, { id: c.id, input: c.input, expected: c.expected });
	const args = (run.args ?? []).map((a) => fill(a, { id: c.id, input: c.input, expected: c.expected }));
	const stdin = run.stdin === undefined ? undefined : fill(run.stdin, { id: c.id, input: c.input, expected: c.expected });
	const r = await sh(command, args, { cwd: run.cwd ?? spec.dir, stdin, timeoutMs: run.timeoutMs });
	return { output: r.stdout.trim(), error: r.code === 0 ? undefined : r.stderr.slice(0, 300) || `exit ${r.code}` };
}

export interface GradeResult {
	pass: boolean;
	/** 0–1. Programmatic graders are 0 or 1; a claims rubric is the fraction that held. */
	score: number;
	detail?: string;
}

export async function grade(spec: EvalSpec, c: EvalCase, output: string): Promise<GradeResult> {
	const g = (c.grade ?? spec.grade) as Grader;
	const expected = typeof c.expected === "string" ? c.expected : JSON.stringify(c.expected ?? "");
	switch (g.kind) {
		case "exact": {
			const want = (g.expect ? fill(g.expect, { id: c.id, input: c.input, expected: c.expected }) : expected);
			const [a, b] = g.caseInsensitive ? [output.toLowerCase(), want.toLowerCase()] : [output, want];
			const pass = (g.trim === false ? a : a.trim()) === (g.trim === false ? b : b.trim());
			return { pass, score: pass ? 1 : 0, detail: pass ? undefined : `expected ${want.slice(0, 80)}, got ${output.slice(0, 80)}` };
		}
		case "contains": {
			const want = g.expect ? fill(g.expect, { id: c.id, input: c.input, expected: c.expected }) : expected;
			const pass = (g.caseInsensitive ? output.toLowerCase() : output).includes(g.caseInsensitive ? want.toLowerCase() : want);
			return { pass, score: pass ? 1 : 0, detail: pass ? undefined : `missing ${want.slice(0, 80)}` };
		}
		case "regex": {
			const pass = new RegExp(g.pattern, g.flags).test(output);
			return { pass, score: pass ? 1 : 0, detail: pass ? undefined : `no match for /${g.pattern}/` };
		}
		case "json-schema": {
			try {
				const parsed = JSON.parse(output) as Record<string, unknown>;
				const missing = g.require.filter((k) => parsed[k] === undefined);
				return { pass: !missing.length, score: missing.length ? 0 : 1, detail: missing.length ? `missing keys: ${missing.join(", ")}` : undefined };
			} catch {
				return { pass: false, score: 0, detail: "not JSON" };
			}
		}
		case "command": {
			const r = await sh(fill(g.command, { id: c.id, input: c.input, expected: c.expected, output }), (g.args ?? []).map((a) => fill(a, { id: c.id, input: c.input, expected: c.expected, output })), { cwd: spec.dir, stdin: output, timeoutMs: g.timeoutMs });
			return { pass: r.code === 0, score: r.code === 0 ? 1 : 0, detail: r.code === 0 ? undefined : (r.stderr || r.stdout).slice(0, 200) };
		}
		case "jev-claims": {
			const made = jevForEval();
			if (!made) throw new Error("the jev-claims grader needs a TypeSafe or OpenRouter key");
			const r = await judgeWithJev(made.client, { task: { input: c.input, expected: c.expected }, output, claims: g.claims });
			return { pass: r.pass, score: r.score, detail: r.verdicts.filter((v) => !v.holds).map((v) => `${v.id} ${(v.probability * 100).toFixed(0)}%`).join(", ") || undefined };
		}
		case "llm-judge":
			throw new Error("the llm-judge grader isn't implemented yet: use jev-claims, or a command grader that calls your own judge");
	}
}

export interface ProjectResult {
	id: string;
	split: Split;
	pass: boolean;
	score: number;
	output: string;
	detail?: string;
	error?: string;
}

export interface ProjectReport {
	name: string;
	results: ProjectResult[];
	score: { all: number; train: number; test: number };
	interval: [number, number];
	errors: number;
	/** With repeats > 1: how far the overall score moved between identical runs. */
	noise?: number;
}

export async function runEval(spec: EvalSpec, opts: { split?: Split; repeats?: number; onCase?: (id: string, round: number) => void } = {}): Promise<ProjectReport> {
	const cases = opts.split ? spec.cases.filter((c) => splitOf(c.id) === opts.split) : spec.cases;
	const repeats = Math.max(1, opts.repeats ?? spec.repeats ?? 1);
	const rounds: ProjectResult[][] = [];
	for (let n = 0; n < repeats; n++) {
		const round: ProjectResult[] = [];
		for (const c of cases) {
			opts.onCase?.(c.id, n + 1);
			const { output, error } = await produce(spec, c);
			let g: GradeResult = { pass: false, score: 0 };
			let gradeError: string | undefined;
			try {
				g = await grade(spec, c, output);
			} catch (err) {
				gradeError = err instanceof Error ? err.message : String(err);
			}
			round.push({ id: c.id, split: splitOf(c.id), pass: g.pass, score: g.score, output, detail: g.detail, error: error ?? gradeError });
		}
		rounds.push(round);
	}
	const last = rounds[rounds.length - 1];
	const mean = (rows: ProjectResult[]) => (rows.length ? rows.reduce((a, b) => a + b.score, 0) / rows.length : 1);
	const p = mean(last);
	const half = 1.96 * Math.sqrt((p * (1 - p)) / Math.max(last.length, 1));
	const totals = rounds.map(mean);
	return {
		name: spec.name,
		results: last,
		score: { all: p, train: mean(last.filter((r) => r.split === "train")), test: mean(last.filter((r) => r.split === "test")) },
		interval: [Math.max(0, p - half), Math.min(1, p + half)],
		errors: last.filter((r) => r.error).length,
		noise: rounds.length > 1 ? Math.max(...totals) - Math.min(...totals) : undefined,
	};
}
