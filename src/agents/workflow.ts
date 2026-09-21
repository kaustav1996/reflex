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
import { createKeyResolver, loadDotEnv, loadReflexConfig } from "../config.js";
import type { Question } from "../extensions/typesafe/client.js";
import { createJevClient } from "../extensions/typesafe/provider.js";
import { piStoredApiKey } from "../extensions/typesafe/state.js";
import type { AgentDefinition } from "./store.js";

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
}
export interface DecideStep extends StepBase {
	type: "decide";
	/** State sent to Jev: a template string or an object of template strings. */
	state: string | Record<string, unknown>;
	questions: Record<string, Question>;
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
	/** Runs an LLM step as a headless Reflex session; returns its result. */
	runLlm: (step: LlmStep, prompt: string, instructions: string | undefined) => Promise<{ status: string; output?: string; toolCalls: number; reflexBlocks: number; error?: string }>;
	/** Runs another agent and waits. */
	callAgent: (agentId: string, input: string) => Promise<{ status: string; output?: string; error?: string }>;
	signal?: AbortSignal;
	cwd: string;
}

export async function runWorkflow(steps: Step[], initialVars: Vars, hooks: WorkflowHooks): Promise<{ status: "succeeded" | "failed"; output?: string; vars: Vars; error?: string }> {
	const vars: Vars = { ...initialVars };
	const ids = steps.map((s, i) => s.id ?? `step${i + 1}`);
	loadDotEnv(hooks.cwd); // the agent's project .env (and ~/.reflex/.env) may hold TYPESAFE_API_KEY
	const keys = createKeyResolver(piStoredApiKey);
	const jev = createJevClient(loadReflexConfig(), keys, { timeoutMs: 12000 })?.client;
	let i = 0;
	let guard = 0;
	let lastOutput: string | undefined;
	while (i >= 0 && i < steps.length) {
		if (++guard > 200) return { status: "failed", vars, error: "workflow exceeded 200 step executions (loop?)" };
		if (hooks.signal?.aborted) return { status: "failed", vars, error: "cancelled" };
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
					vars[as] = r;
					lastOutput = r.stdout.trim() || lastOutput;
					if (!r.ok && !step.allowFailure && !step.route?.length) {
						emitEnd(false, r);
						return { status: "failed", vars, output: lastOutput, error: `${id}: exit ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(-500)}` };
					}
					const next = pickNext(step, vars);
					emitEnd(r.ok, { exitCode: r.exitCode, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 500) }, next);
					i = advance(ids, i, next);
					break;
				}
				case "decide": {
					if (!jev) throw new Error("decide step needs Jev: set TYPESAFE_API_KEY or OPENROUTER_API_KEY");
					const state = renderDeep(step.state, vars) as string | Record<string, unknown>;
					hooks.emit({ type: "step_start", index: i, id, stepType: "decide", summary: Object.keys(step.questions).join(", ") });
					const res = await jev.systemOne({ purpose: `workflow:${step.id}`, state, questions: step.questions, signal: hooks.signal });
					vars[as] = res.answers;
					const next = pickNext(step, vars);
					emitEnd(true, { answers: res.answers, latencyMs: Math.round(res.latencyMs) }, next);
					i = advance(ids, i, next);
					break;
				}
				case "llm": {
					const prompt = render(step.prompt, vars);
					hooks.emit({ type: "step_start", index: i, id, stepType: "llm", summary: prompt.slice(0, 200) });
					const r = await hooks.runLlm(step, prompt, step.instructions ? render(step.instructions, vars) : undefined);
					vars[as] = r;
					if (r.output) lastOutput = r.output;
					const ok = r.status === "succeeded";
					const next = pickNext(step, vars);
					emitEnd(ok, { status: r.status, output: (r.output ?? "").slice(0, 2000), toolCalls: r.toolCalls, reflexBlocks: r.reflexBlocks, error: r.error }, next);
					if (!ok && !step.route?.length) return { status: "failed", vars, output: lastOutput, error: `${id}: ${r.error ?? r.status}` };
					i = advance(ids, i, next);
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
