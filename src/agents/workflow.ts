/**
 * Workflow steps for agents, in priority order of what should do the work:
 *   1. shell   — deterministic code: a command whose stdout/exit code become variables
 *   2. decide  — TypeSafe Jev answers narrow typed questions over the state; code routes on the numbers
 *   3. llm     — a headless Reflex session, only for work code and Jev cannot do
 *   +  call    — run another agent (chain) and wait for its output
 *   +  end     — finish with a status/output
 * Routing is data, not code: `route: [{ when: "verdict.severity.score >= 2", next: "escalate" }]`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createKeyResolver, loadDotEnv, loadReflexConfig } from "../config.js";
import type { Question } from "../extensions/typesafe/client.js";
import { createJevClient } from "../extensions/typesafe/provider.js";
import { piStoredApiKey } from "../extensions/typesafe/state.js";
import { type AgentDefinition, emptyCost, type RunCheckpoint, type RunCost, type RunLimits } from "./store.js";

export interface RouteRule {
	/** `<path> <op> <value>` with op in == != >= <= > < contains matches; or "default". Paths index into variables, e.g. tests.exitCode, verdict.is_bug.noul. */
	when: string;
	next: string;
}
interface StepBase {
	id?: string;
	/** Variable name to store the step result under (default: id or step index). */
	as?: string;
	next?: string;
	route?: RouteRule[];
}
export interface ShellStep extends StepBase {
	type: "shell";
	run: string;
	cwd?: string;
	timeoutSec?: number;
	/** Continue even when the exit code is non-zero (then route on `<as>.ok`). */
	allowFailure?: boolean;
	/** Read `<as>.json` from this file (relative to the step's folder) instead of from stdout. */
	jsonFile?: string;
}

/**
 * The JSON a command printed. Pure JSON stdout is the normal case; a command that logs a few lines
 * and then prints its JSON is common enough to accept too: the JSON block that ends the output
 * (starting at the last line that begins with `[` or `{` and parses through to the end) wins.
 */
export function parseJsonOutput(stdout: string): unknown {
	const text = stdout.trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!/^\s*[[{]/.test(lines[i])) continue;
		try {
			return JSON.parse(lines.slice(i).join("\n"));
		} catch {}
	}
	return undefined;
}

/** Why `path` didn't resolve to a list, in words that say how to fix the step that produced it. */
export function notAListReason(path: string, vars: Record<string, unknown>): string {
	const [head, second] = path.split(".");
	const v = vars[head] as { stdout?: string; json?: unknown } | undefined;
	if (second === "json" && v && typeof v === "object" && "stdout" in v && v.json === undefined) {
		const start = (v.stdout ?? "").trim().slice(0, 120).replace(/\s+/g, " ");
		return `step "${head}" printed no JSON that could be read (stdout starts: "${start || "(empty)"}"). Print only the JSON to stdout and send logs to stderr (>&2), or set jsonFile on that step to read it from a file`;
	}
	const got = getPath(vars, path);
	if (got && typeof got === "object" && !Array.isArray(got)) {
		const lists = Object.entries(got as Record<string, unknown>).filter(([, x]) => Array.isArray(x)).map(([k]) => `${path}.${k}`);
		if (lists.length) return `it is an object; did you mean ${lists.join(" or ")}?`;
	}
	return `got ${got === undefined ? "nothing" : Array.isArray(got) ? "a list" : typeof got}`;
}
/**
 * A decide question. Instructions and criteria are templates, rendered every time the step runs.
 * A choice can also build its options from a list variable, so the menu always reflects what
 * exists right now (workers that are available, sources just fetched, files that changed):
 *
 *   { "type": "choice", "instructions": "Which worker acts next?",
 *     "optionsFrom": "workers.json", "optionId": "name", "optionText": "{{item.description}}",
 *     "criteria": { "review": "Unclear request, or the work is complete." } }
 *
 * Static `criteria` are kept alongside the generated options (use them for escapes like "review").
 */
export type DecideQuestion = Question & {
	optionsFrom?: string;
	/** Field of each item used as the option id (default: id, then name, then the item itself when it is a string). */
	optionId?: string;
	/** Template for the option description; `{{item.<field>}}` reads the item (default: description, then the item as text). */
	optionText?: string;
};

/**
 * Ask the same question about every item of a list, in parallel, and rank the answers: the
 * "filter in code → score the rest → choose among the shortlist" pattern. The step result gets
 * `ranked` (every item with its value and confidence, best first) and `shortlist` (the top items).
 */
export interface ForEachSpec {
	/** Path to the array variable, e.g. `papers.json`. */
	from: string;
	/** Field used as each item's id (default: id, then name, then its index). */
	id?: string;
	/** Question template; `{{item.<field>}}` reads the item. Score and noul questions rank by value, choice by confidence. */
	question: Question;
	/** State for each item's question (default: the item itself next to the step's state). */
	top?: number;
	/** Keep only items whose value is at least this (score level or noul probability). */
	min?: number;
}

export interface DecideStep extends StepBase {
	type: "decide";
	/** State sent to Jev: a template string or an object of template strings. */
	state: string | Record<string, unknown>;
	questions?: Record<string, DecideQuestion>;
	forEach?: ForEachSpec;
}
export interface LlmStep extends StepBase {
	type: "llm";
	prompt: string;
	instructions?: string;
	model?: string;
	reflex?: AgentDefinition["reflex"];
	tools?: string[];
	computer?: boolean;
	timeoutMinutes?: number;
}
export interface CallStep extends StepBase {
	type: "call";
	agentId: string;
	input?: string;
}
export interface EndStep extends StepBase {
	type: "end";
	status?: "succeeded" | "failed";
	output?: string;
}
export type Step = ShellStep | DecideStep | LlmStep | CallStep | EndStep;

export type Vars = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

const asText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v));

/** Render {{path}} placeholders (dotted paths into vars). */
export function render(template: string, vars: Vars): string {
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => asText(getPath(vars, p)));
}
function renderDeep(value: unknown, vars: Vars): unknown {
	if (typeof value === "string") return render(value, vars);
	if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars)]));
	return value;
}

/** Evaluate `path op value` against vars. No eval; a handful of operators. */
export function evalCondition(expr: string, vars: Vars): boolean {
	const e = expr.trim();
	if (e === "default" || e === "true") return true;
	const m = e.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<|contains|matches)\s*(.+)$/);
	if (!m) {
		const v = getPath(vars, e);
		return typeof v === "number" ? v !== 0 : !!v;
	}
	const [, path, op, rawRhs] = m;
	const lhs = getPath(vars, path);
	let rhs: unknown = rawRhs.trim();
	if (/^(['"]).*\1$/.test(rhs as string)) rhs = (rhs as string).slice(1, -1);
	else if (rhs === "true" || rhs === "false") rhs = rhs === "true";
	else if (!Number.isNaN(Number(rhs))) rhs = Number(rhs);
	switch (op) {
		case "==":
			return lhs == rhs; // eslint-disable-line eqeqeq
		case "!=":
			return lhs != rhs; // eslint-disable-line eqeqeq
		case ">=":
			return Number(lhs) >= Number(rhs);
		case "<=":
			return Number(lhs) <= Number(rhs);
		case ">":
			return Number(lhs) > Number(rhs);
		case "<":
			return Number(lhs) < Number(rhs);
		case "contains":
			return asText(lhs).includes(String(rhs));
		case "matches":
			try {
				return new RegExp(String(rhs)).test(asText(lhs));
			} catch {
				return false;
			}
	}
	return false;
}

export function pickNext(step: Step, vars: Vars): string | undefined {
	for (const r of step.route ?? []) if (evalCondition(r.when, vars)) return r.next;
	return step.next;
}

export interface StepEvent {
	type: "step_start" | "step_end";
	index: number;
	id: string;
	stepType: Step["type"];
	summary?: string;
	ok?: boolean;
	ms?: number;
	result?: unknown;
	next?: string;
}

export interface WorkflowHooks {
	emit: (ev: StepEvent) => void;
	/** Runs an LLM step as a headless Reflex session; returns its result (with what it cost, when known). */
	runLlm: (step: LlmStep, prompt: string, instructions: string | undefined) => Promise<{ status: string; output?: string; toolCalls: number; reflexBlocks: number; error?: string; costUsd?: number; tokens?: number }>;
	/** Hard stops for the run; checked before every step. */
	limits?: RunLimits;
	/** Running totals, shared with the caller so they end up on the run record. */
	cost?: RunCost;
	/** Called after every completed step with everything needed to continue later. */
	checkpoint?: (cp: RunCheckpoint) => void;
	/** Jev client override (tests); by default the user's chosen provider and model are used. */
	jev?: { systemOne: (req: never) => Promise<unknown> };
	/** Runs another agent and waits. */
	callAgent: (agentId: string, input: string) => Promise<{ status: string; output?: string; error?: string }>;
	signal?: AbortSignal;
	cwd: string;
}

/** USD per input token on TypeSafe's own API (no output charge); used when the provider does not report a cost. */
const JEV_USD_PER_TOKEN = 0.042 / 1e6;
const FOREACH_BATCH = 40;
const FOREACH_MAX = 400;

/** Which limit the next step would break, if any. */
export function budgetExceeded(cost: RunCost, limits: RunLimits | undefined, next: Step["type"]): string | undefined {
	const maxSteps = limits?.maxSteps ?? 200;
	if (cost.steps >= maxSteps) return `step limit reached (${maxSteps} step executions)`;
	if (limits?.maxCostUsd !== undefined && cost.totalUsd >= limits.maxCostUsd) return `spend limit reached ($${cost.totalUsd.toFixed(4)} of $${limits.maxCostUsd})`;
	if (next === "decide" && limits?.maxJevCalls !== undefined && cost.jevCalls >= limits.maxJevCalls) return `TypeSafe call limit reached (${limits.maxJevCalls})`;
	if (next === "llm" && limits?.maxLlmRuns !== undefined && cost.llmRuns >= limits.maxLlmRuns) return `LLM run limit reached (${limits.maxLlmRuns})`;
	return undefined;
}

function itemId(item: unknown, field: string | undefined, index: number): string {
	if (typeof item === "string" || typeof item === "number") return String(item);
	const o = (item ?? {}) as Record<string, unknown>;
	const v = (field ? o[field] : undefined) ?? o.id ?? o.name ?? index;
	return String(v);
}

/** Render a decide question: templates in instructions/criteria, plus options generated from a list variable. */
export function buildQuestion(q: DecideQuestion, vars: Vars): Question {
	const { optionsFrom, optionId, optionText, ...rest } = q;
	const rendered = renderDeep(rest, vars) as Question;
	if (!optionsFrom || rendered.type !== "choice") return rendered;
	const list = getPath(vars, optionsFrom);
	if (!Array.isArray(list)) throw new Error(`optionsFrom "${optionsFrom}" is not a list: ${notAListReason(optionsFrom, vars)}`);
	const generated: Record<string, unknown> = {};
	list.slice(0, 250).forEach((item, idx) => {
		const o = (typeof item === "object" && item ? item : {}) as Record<string, unknown>;
		generated[itemId(item, optionId, idx)] = optionText ? render(optionText, { ...vars, item }) : (o.description ?? (typeof item === "string" ? item : JSON.stringify(item)));
	});
	if (Object.keys(generated).length === 0 && !Object.keys(rendered.criteria ?? {}).length) throw new Error(`optionsFrom "${optionsFrom}" is empty and there are no static options`);
	return { ...rendered, criteria: { ...generated, ...((rendered.criteria as Record<string, unknown>) ?? {}) } } as Question;
}

function answerValue(a: { type: string; noul?: number; score?: number; confidence?: number }): number {
	return a.type === "noul" ? (a.noul ?? 0) : a.type === "score" ? (a.score ?? 0) : (a.confidence ?? 0);
}

export async function runWorkflow(steps: Step[], initialVars: Vars, hooks: WorkflowHooks, resume?: RunCheckpoint): Promise<{ status: "succeeded" | "failed"; output?: string; vars: Vars; error?: string }> {
	const vars: Vars = resume ? { ...initialVars, ...resume.vars } : { ...initialVars };
	const cost: RunCost = hooks.cost ?? emptyCost();
	const completed: string[] = resume ? [...resume.completed] : [];
	const ids = steps.map((s, i) => s.id ?? `step${i + 1}`);
	loadDotEnv(hooks.cwd); // the agent's project .env (and ~/.reflex/.env) may hold TYPESAFE_API_KEY
	const keys = createKeyResolver(piStoredApiKey);
	const jev = (hooks.jev as { systemOne: (req: unknown) => Promise<{ answers: Record<string, unknown>; usage?: { input_tokens?: number; cost?: number }; latencyMs: number }> } | undefined) ?? createJevClient(loadReflexConfig(), keys, { timeoutMs: 12000 })?.client;
	let i = resume ? resume.nextIndex : 0;
	let lastOutput: string | undefined = resume?.lastOutput;
	const saveProgress = (finishedId: string) => {
		completed.push(finishedId);
		hooks.checkpoint?.({ nextIndex: i, completed: [...completed], vars, lastOutput, savedAt: Date.now() });
	};
	while (i >= 0 && i < steps.length) {
		if (hooks.signal?.aborted) return { status: "failed", vars, output: lastOutput, error: "cancelled" };
		const over = budgetExceeded(cost, hooks.limits, steps[i].type);
		if (over) return { status: "failed", vars, output: lastOutput, error: `budget: ${over} before step "${ids[i]}"` };
		cost.steps++;
		const step = steps[i];
		const id = ids[i];
		const as = step.as ?? id;
		const started = performance.now();
		const emitEnd = (ok: boolean, result: unknown, next?: string) => hooks.emit({ type: "step_end", index: i, id, stepType: step.type, ok, ms: Math.round(performance.now() - started), result, next });
		try {
			switch (step.type) {
				case "shell": {
					const cmd = render(step.run, vars);
					hooks.emit({ type: "step_start", index: i, id, stepType: "shell", summary: cmd.slice(0, 200) });
					const r = await sh(cmd, step.cwd ? render(step.cwd, vars) : hooks.cwd, (step.timeoutSec ?? 300) * 1000, hooks.signal);
					// A command that prints JSON makes it available as `<as>.json` (lists feed optionsFrom / forEach).
					let parsed: unknown;
					if (step.jsonFile) {
						const dir = step.cwd ? render(step.cwd, vars) : hooks.cwd;
						const file = render(step.jsonFile, vars);
						try {
							parsed = JSON.parse(readFileSync(isAbsolute(file) ? file : join(dir, file), "utf8"));
						} catch (err) {
							if (r.ok) {
								emitEnd(false, r);
								return { status: "failed", vars, output: lastOutput, error: `${id}: jsonFile ${file} could not be read as JSON: ${err instanceof Error ? err.message : err}` };
							}
						}
					} else parsed = parseJsonOutput(r.stdout);
					vars[as] = parsed === undefined ? r : { ...r, json: parsed };
					lastOutput = r.stdout.trim() || lastOutput;
					if (!r.ok && !step.allowFailure && !step.route?.length) {
						emitEnd(false, r);
						return { status: "failed", vars, output: lastOutput, error: `${id}: exit ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-500)}` };
					}
					const next = pickNext(step, vars);
					emitEnd(r.ok, { exitCode: r.exitCode, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 500) }, next);
					i = advance(ids, i, next);
					saveProgress(id);
					break;
				}
				case "decide": {
					if (!jev) throw new Error("decide step needs Jev: set TYPESAFE_API_KEY or OPENROUTER_API_KEY");
					const state = renderDeep(step.state, vars) as string | Record<string, unknown>;
					// Questions are rebuilt from the current variables on every execution: the menu is never stale.
					const questions: Record<string, Question> = {};
					for (const [qid, q] of Object.entries(step.questions ?? {})) questions[qid] = buildQuestion(q, vars);
					let items: unknown[] = [];
					const itemKeys: string[] = [];
					if (step.forEach) {
						const list = getPath(vars, step.forEach.from);
						if (!Array.isArray(list)) throw new Error(`forEach.from "${step.forEach.from}" is not a list: ${notAListReason(step.forEach.from, vars)}`);
						items = list.slice(0, FOREACH_MAX);
						items.forEach((item, idx) => itemKeys.push(`item_${idx}`));
					}
					if (!Object.keys(questions).length && !items.length) throw new Error("decide step has no questions (and forEach found no items)");
					hooks.emit({ type: "step_start", index: i, id, stepType: "decide", summary: [...Object.keys(questions), ...(items.length ? [`forEach ${step.forEach!.from} × ${items.length}`] : [])].join(", ") });

					// One request for the fixed questions, plus batches for the per-item questions; all in flight together.
					const calls: Array<Promise<{ answers: Record<string, unknown>; usage?: { input_tokens?: number; cost?: number }; latencyMs: number }>> = [];
					if (Object.keys(questions).length) calls.push(jev.systemOne({ purpose: `workflow:${id}`, state, questions, signal: hooks.signal }) as never);
					for (let b = 0; b < items.length; b += FOREACH_BATCH) {
						const batch: Record<string, Question> = {};
						for (let k = b; k < Math.min(b + FOREACH_BATCH, items.length); k++) {
							// Jev never sees question ids, and questions cannot read each other: every generated
							// question carries the one item it judges inside its own instructions.
							const q = renderDeep(step.forEach!.question, { ...vars, item: items[k] }) as Question;
							batch[itemKeys[k]] = { ...q, instructions: { question: q.instructions, judge_only_this_item: items[k] } } as Question;
						}
						calls.push(jev.systemOne({ purpose: `workflow:${id}:each`, state, questions: batch, signal: hooks.signal }) as never);
					}
					const results = await Promise.all(calls);
					const answers: Record<string, unknown> = {};
					let latencyMs = 0;
					for (const r of results) {
						Object.assign(answers, r.answers);
						latencyMs = Math.max(latencyMs, r.latencyMs);
						cost.jevCalls++;
						cost.jevTokens += r.usage?.input_tokens ?? 0;
						cost.jevUsd += r.usage?.cost ?? (r.usage?.input_tokens ?? 0) * JEV_USD_PER_TOKEN;
					}
					cost.totalUsd = cost.jevUsd + cost.llmUsd;

					const result: Record<string, unknown> = {};
					for (const qid of Object.keys(questions)) result[qid] = answers[qid];
					if (items.length) {
						const ranked = items
							.map((item, idx) => {
								const a = answers[itemKeys[idx]] as { type: string; noul?: number; score?: number; confidence?: number; choice?: string };
								return { id: itemId(item, step.forEach!.id, idx), value: a ? answerValue(a) : 0, confidence: a?.confidence, choice: a?.choice, item };
							})
							.sort((x, y) => y.value - x.value);
						const kept = ranked.filter((r) => step.forEach!.min === undefined || r.value >= step.forEach!.min);
						result.ranked = ranked;
						result.shortlist = kept.slice(0, step.forEach!.top ?? kept.length).map((r) => r.item);
						result.count = kept.length;
					}
					vars[as] = result;
					const next = pickNext(step, vars);
					emitEnd(true, { answers: Object.fromEntries(Object.keys(questions).map((q) => [q, answers[q]])), ...(items.length ? { ranked: (result.ranked as Array<{ id: string; value: number }>).slice(0, 10).map((r) => ({ id: r.id, value: Number(r.value.toFixed(3)) })), shortlisted: (result.shortlist as unknown[]).length, of: items.length } : {}), requests: results.length, latencyMs: Math.round(latencyMs), costUsd: Number(cost.jevUsd.toFixed(6)) }, next);
					i = advance(ids, i, next);
					saveProgress(id);
					break;
				}
				case "llm": {
					const prompt = render(step.prompt, vars);
					hooks.emit({ type: "step_start", index: i, id, stepType: "llm", summary: prompt.slice(0, 200) });
					const r = await hooks.runLlm(step, prompt, step.instructions ? render(step.instructions, vars) : undefined);
					cost.llmRuns++;
					cost.llmTokens += r.tokens ?? 0;
					cost.llmUsd += r.costUsd ?? 0;
					cost.totalUsd = cost.jevUsd + cost.llmUsd;
					vars[as] = r;
					if (r.output) lastOutput = r.output;
					const ok = r.status === "succeeded";
					const next = pickNext(step, vars);
					emitEnd(ok, { status: r.status, output: (r.output ?? "").slice(0, 2000), toolCalls: r.toolCalls, reflexBlocks: r.reflexBlocks, error: r.error }, next);
					if (!ok && !step.route?.length) return { status: "failed", vars, output: lastOutput, error: `${id}: ${r.error ?? r.status}` };
					i = advance(ids, i, next);
					saveProgress(id);
					break;
				}
				case "call": {
					const input = render(step.input ?? "{{input}}", vars);
					hooks.emit({ type: "step_start", index: i, id, stepType: "call", summary: `${step.agentId} ← ${input.slice(0, 120)}` });
					const r = await hooks.callAgent(step.agentId, input);
					vars[as] = r;
					if (r.output) lastOutput = r.output;
					const next = pickNext(step, vars);
					emitEnd(r.status === "succeeded", r, next);
					i = advance(ids, i, next);
					saveProgress(id);
					break;
				}
				case "end": {
					hooks.emit({ type: "step_start", index: i, id, stepType: "end" });
					const output = step.output ? render(step.output, vars) : lastOutput;
					emitEnd(true, { status: step.status ?? "succeeded" });
					return { status: step.status ?? "succeeded", vars, output };
				}
			}
		} catch (err) {
			emitEnd(false, { error: err instanceof Error ? err.message : String(err) });
			return { status: "failed", vars, output: lastOutput, error: `${id}: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	return { status: "succeeded", vars, output: lastOutput };
}

function advance(ids: string[], i: number, next: string | undefined): number {
	if (next === undefined) return i + 1;
	if (next === "end" || next === "stop") return ids.length;
	const j = ids.indexOf(next);
	if (j < 0) throw new Error(`route to unknown step "${next}"`);
	return j;
}

function sh(cmd: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", cmd], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], signal });
		let stdout = "";
		let stderr = "";
		const cap = (s: string, d: Buffer) => (s.length > 200000 ? s : s + d.toString());
		child.stdout.on("data", (d: Buffer) => {
			stdout = cap(stdout, d);
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr = cap(stderr, d);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, exitCode: -1, stdout, stderr: `${stderr}\n${e.message}` });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0, exitCode: code ?? -1, stdout, stderr });
		});
	});
}
