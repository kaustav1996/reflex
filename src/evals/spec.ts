/**
 * An eval anyone can write for their own work: cases, how to produce an answer, how to grade it.
 *
 * Lives in the project as JSON (`reflex-eval.json`, or any path you pass), so it is reviewable in a
 * diff and runs in CI. The shape is deliberately small — the hard part of an eval is the cases and
 * the grader, not the file format.
 *
 *   {
 *     "name": "support-router",
 *     "run":  { "command": "node route.mjs", "stdin": "{{input}}" },
 *     "grade": { "kind": "exact", "expect": "{{expected}}" },
 *     "cases": [{ "id": "refund-1", "whyHard": "…", "input": "…", "expected": "billing" }]
 *   }
 *
 * `whyHard` is required on every case: a set assembled from whatever the model currently fails
 * measures that model's weak spots, not what matters. Writing the reason first is the cheapest
 * guard against it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface EvalCase {
	id: string;
	/** Why a person would call this hard or worth testing. Required. */
	whyHard: string;
	/** What the system under test is given. A string, or anything your command can read as JSON. */
	input: unknown;
	/** For graders that compare against a known answer. */
	expected?: unknown;
	/** Overrides the eval's grader for this case. */
	grade?: Grader;
}

/** How an answer is produced for a case. */
export type Runner =
	/** Run a command; the case is substituted into argv and/or stdin, and stdout is the answer. */
	| { kind?: "command"; command: string; args?: string[]; stdin?: string; cwd?: string; timeoutMs?: number }
	/** Ask a Reflex session, headless, in the project. The answer is its final reply. */
	| { kind: "session"; prompt: string; model?: string; reflex?: "cautious" | "balanced" | "bold" | "off"; tools?: string[]; timeoutMs?: number };

/** How an answer is scored. Cheapest first: programmatic, then Jev, then a full model. */
export type Grader =
	| { kind: "exact"; expect?: string; trim?: boolean; caseInsensitive?: boolean }
	| { kind: "contains"; expect?: string; caseInsensitive?: boolean }
	| { kind: "regex"; pattern: string; flags?: string }
	| { kind: "json-schema"; require: string[] }
	/** A command that exits 0 for a pass; the answer arrives on stdin. */
	| { kind: "command"; command: string; args?: string[]; timeoutMs?: number }
	/** The rubric as checkable claims, one noul each, in a single Jev request. */
	| { kind: "jev-claims"; claims: Array<{ id: string; claim: string; required?: boolean; threshold?: number }> }
	/** A full model reads the answer against a rubric. The slowest and most expensive option. */
	| { kind: "llm-judge"; rubric: string; model?: string };

export interface EvalSpec {
	name: string;
	run: Runner;
	grade: Grader;
	cases: EvalCase[];
	/** Runs per case. More than one is how the noise floor gets measured. */
	repeats?: number;
	/** Where the file lives, so relative commands and case files resolve against it. */
	dir?: string;
}

const KINDS = new Set(["exact", "contains", "regex", "json-schema", "command", "jev-claims", "llm-judge"]);

export function validateSpec(raw: unknown, dir = process.cwd()): EvalSpec {
	const s = raw as Partial<EvalSpec>;
	const bad = (msg: string) => {
		throw new Error(`eval spec: ${msg}`);
	};
	if (!s || typeof s !== "object") bad("not an object");
	if (!s.name) bad("needs a name");
	if (!s.run) bad("needs a `run`: how to produce an answer for a case");
	if (!s.grade || !KINDS.has((s.grade as Grader).kind)) bad(`needs a \`grade.kind\`: one of ${[...KINDS].join(", ")}`);
	if (!Array.isArray(s.cases) || !s.cases.length) bad("needs cases");
	const seen = new Set<string>();
	for (const c of s.cases!) {
		if (!c.id) bad("every case needs an id");
		if (seen.has(c.id)) bad(`duplicate case id ${c.id}`);
		seen.add(c.id);
		if (!c.whyHard?.trim()) bad(`case ${c.id} has no whyHard — say why it is worth testing, or drop it`);
	}
	if ((s.grade as Grader).kind === "jev-claims" && !(s.grade as { claims?: unknown[] }).claims?.length) bad("jev-claims needs claims");
	return { repeats: 1, ...(s as EvalSpec), dir };
}

/** Load a spec, following `casesFile` (a .jsonl of cases) when the spec uses one. */
export function loadSpec(file: string): EvalSpec {
	const path = resolve(file);
	if (!existsSync(path)) throw new Error(`no eval spec at ${path}`);
	const raw = JSON.parse(readFileSync(path, "utf8")) as EvalSpec & { casesFile?: string };
	if (raw.casesFile) {
		const cf = resolve(dirname(path), raw.casesFile);
		if (!existsSync(cf)) throw new Error(`casesFile not found: ${cf}`);
		raw.cases = readFileSync(cf, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.trimStart().startsWith("//"))
			.map((l) => JSON.parse(l) as EvalCase);
	}
	return validateSpec(raw, dirname(path));
}

/** `{{input}}`, `{{expected}}`, `{{id}}` and `{{output}}` filled from a case. */
export function fill(template: string, vars: { id?: string; input?: unknown; expected?: unknown; output?: string }): string {
	const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
	return template
		.replace(/\{\{id\}\}/g, vars.id ?? "")
		.replace(/\{\{input\}\}/g, str(vars.input))
		.replace(/\{\{expected\}\}/g, str(vars.expected))
		.replace(/\{\{output\}\}/g, vars.output ?? "");
}
