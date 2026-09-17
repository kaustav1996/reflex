/**
 * Runs an agent: one headless `reflex --mode json` process per run, in the agent's own
 * session dir, with its instructions appended to the system prompt. Events are logged
 * to <run>.events.jsonl and fanned out to live listeners (the web run viewer).
 * Runs are serialized per agent; chain steps fire on success.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { type AgentDefinition, type AgentRun, agentSessionsDir, listAgents, loadAgent, newRun, runLogPath, saveRun } from "./store.js";
import { runWorkflow } from "./workflow.js";

export type RunListener = (run: AgentRun, event: unknown) => void;

interface LiveRun {
	run: AgentRun;
	proc: ChildProcess;
	listeners: Set<RunListener>;
	lastText: string;
}

const live = new Map<string, LiveRun>();
const queues = new Map<string, Array<() => void>>();
const busy = new Set<string>();

function cliPath(): string {
	const require = createRequire(import.meta.url);
	return resolve(dirname(require.resolve("../../package.json")), "dist", "cli.js");
}

export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

export function getLiveRun(runId: string): LiveRun | undefined {
	return live.get(runId);
}

export function cancelRun(runId: string): boolean {
	const l = live.get(runId);
	if (!l) return false;
	l.run.status = "cancelled";
	try {
		l.proc.kill("SIGTERM");
	} catch {}
	return true;
}

/** Queue a run; resolves when it finishes. */
export function runAgent(agent: AgentDefinition, trigger: AgentRun["trigger"], input?: string, onEvent?: RunListener): Promise<AgentRun> {
	const run = newRun(agent, trigger, input);
	saveRun(run);
	return new Promise<AgentRun>((resolveRun) => {
		const start = () => {
			busy.add(agent.id);
			execute(agent, run, onEvent)
				.catch((err) => {
					run.status = "failed";
					run.error = err instanceof Error ? err.message : String(err);
					run.endedAt = Date.now();
					saveRun(run);
					return run;
				})
				.then((r) => {
					busy.delete(agent.id);
					const next = queues.get(agent.id)?.shift();
					if (next) next();
					resolveRun(r);
				});
		};
		if (busy.has(agent.id)) (queues.get(agent.id) ?? queues.set(agent.id, []).get(agent.id)!).push(start);
		else start();
	});
}

async function execute(agent: AgentDefinition, run: AgentRun, onEvent?: RunListener): Promise<AgentRun> {
	const sessionsDir = agentSessionsDir(agent.id);
	mkdirSync(sessionsDir, { recursive: true });
	const cwd = existsSync(agent.cwd) ? agent.cwd : process.cwd();
	const controller = new AbortController();
	const l: LiveRun = { run, proc: { kill: () => controller.abort() } as unknown as ChildProcess, listeners: new Set(onEvent ? [onEvent] : []), lastText: "" };
	live.set(run.id, l);
	const log = runLogPath(run);
	const emit = (ev: unknown) => {
		try {
			appendFileSync(log, `${JSON.stringify(ev)}\n`);
		} catch {}
		for (const fn of l.listeners) {
			try {
				fn(run, ev);
			} catch {}
		}
	};
	run.status = "running";
	saveRun(run);

	// ── Workflow agents: shell → decide → llm steps, code owns the routing ──
	if (agent.steps?.length) {
		emit({ type: "run_start", run: { id: run.id, agentId: agent.id, trigger: run.trigger, input: run.input, prompt: `${agent.steps.length} steps` } });
		const timer = setTimeout(() => {
			run.status = "timeout";
			controller.abort();
		}, (agent.timeoutMinutes ?? 30) * 60 * 1000);
		const result = await runWorkflow(agent.steps, { input: run.input ?? "", agent: agent.name, run: run.id, now: new Date().toISOString(), cwd }, {
			cwd,
			emit,
			signal: controller.signal,
			runLlm: async (step, prompt, instructions) => {
				const r = await runLlmProcess({ ...agent, model: step.model ?? agent.model, reflex: step.reflex ?? agent.reflex, tools: step.tools ?? agent.tools, computer: step.computer ?? agent.computer, timeoutMinutes: step.timeoutMinutes ?? agent.timeoutMinutes }, run, prompt, instructions ?? agent.instructions, sessionsDir, cwd, emit, l, controller.signal);
				run.toolCalls += r.toolCalls;
				run.reflexBlocks += r.reflexBlocks;
				return r;
			},
			callAgent: async (agentId, input) => {
				const next = loadAgent(agentId);
				if (!next) return { status: "failed", error: `unknown agent ${agentId}` };
				const r = await runAgent(next, { type: "chain", from: `${agent.id}/${run.id}` }, input);
				return { status: r.status, output: r.output, error: r.error };
			},
		});
		clearTimeout(timer);
		live.delete(run.id);
		run.endedAt = Date.now();
		run.output = result.output;
		if (run.status === "running") run.status = result.status;
		run.error = result.error;
		saveRun(run);
		emit({ type: "run_end", run: { id: run.id, status: run.status, output: run.output, error: run.error, toolCalls: run.toolCalls, reflexBlocks: run.reflexBlocks, durationMs: run.endedAt - run.startedAt } });
		if (run.status === "succeeded") fireChain(agent, run);
		return run;
	}

	// ── Single-prompt agents: one headless LLM session ─────────────────────
	const prompt = renderTemplate(agent.prompt, { input: run.input ?? "", agent: agent.name, run: run.id, now: new Date().toISOString() }).trim() || run.input || "Run.";
	emit({ type: "run_start", run: { id: run.id, agentId: agent.id, trigger: run.trigger, input: run.input, prompt } });
	const timer = setTimeout(() => {
		run.status = "timeout";
		controller.abort();
	}, (agent.timeoutMinutes ?? 30) * 60 * 1000);
	const r = await runLlmProcess(agent, run, prompt, agent.instructions, sessionsDir, cwd, emit, l, controller.signal);
	clearTimeout(timer);
	live.delete(run.id);
	run.endedAt = Date.now();
	run.toolCalls = r.toolCalls;
	run.reflexBlocks = r.reflexBlocks;
	run.output = r.output;
	if (run.status === "running") {
		run.status = r.status as AgentRun["status"];
		run.error = r.error;
	}
	saveRun(run);
	emit({ type: "run_end", run: { id: run.id, status: run.status, output: run.output, error: run.error, toolCalls: run.toolCalls, reflexBlocks: run.reflexBlocks, durationMs: run.endedAt - run.startedAt } });
	if (run.status === "succeeded") fireChain(agent, run);
	return run;
}

function fireChain(agent: AgentDefinition, run: AgentRun): void {
	for (const step of agent.chain ?? []) {
		const next = loadAgent(step.agentId);
		if (!next || !next.enabled) continue;
		const nextInput = renderTemplate(step.input ?? "{{output}}", { output: run.output ?? "", input: run.input ?? "", agent: agent.name });
		void runAgent(next, { type: "chain", from: `${agent.id}/${run.id}` }, nextInput);
	}
}

/** One headless `reflex --mode json` process. Streams its events through `emit`; returns the final answer. */
async function runLlmProcess(agent: Pick<AgentDefinition, "id" | "name" | "model" | "reflex" | "tools" | "computer" | "timeoutMinutes">, run: AgentRun, prompt: string, instructions: string | undefined, sessionsDir: string, cwd: string, emit: (ev: unknown) => void, l: LiveRun, signal: AbortSignal): Promise<{ status: "succeeded" | "failed" | "timeout" | "cancelled"; output?: string; toolCalls: number; reflexBlocks: number; error?: string }> {
	const args = ["--mode", "json", "--session-dir", sessionsDir, "--name", `${agent.name} · ${run.id}`, "--reflex", agent.reflex ?? "balanced"];
	if (agent.model) args.push("--model", agent.model);
	if (instructions?.trim()) args.push("--append-system-prompt", `You are running as the scheduled/triggered agent "${agent.name}" (run ${run.id}). ${instructions.trim()}`);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	if (agent.computer) args.push("--assistant");
	args.push(prompt);
	const proc = spawn(process.execPath, [cliPath(), ...args], { cwd, env: { ...process.env, REFLEX_WEB: "1", REFLEX_AGENT_ID: agent.id, REFLEX_RUN_ID: run.id }, stdio: ["ignore", "pipe", "pipe"] });
	l.proc = proc;
	run.pid = proc.pid;
	const onAbort = () => proc.kill("SIGTERM");
	signal.addEventListener("abort", onAbort, { once: true });
	let toolCalls = 0;
	let reflexBlocks = 0;
	let lastText = "";

	let buffer = "";
	let stderr = "";
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		let idx: number;
		while ((idx = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (!line) continue;
			let ev: { type?: string; message?: { role?: string; content?: unknown }; toolName?: string; isError?: boolean; result?: { content?: Array<{ type: string; text?: string }> }; sessionFile?: string } | undefined;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			if (!ev) continue;
			if (ev.type === "session" && ev.sessionFile) run.sessionFile = ev.sessionFile;
			if (ev.type === "tool_execution_start") toolCalls++;
			if (ev.type === "tool_execution_end" && ev.isError && (ev.result?.content ?? []).some((c) => c.type === "text" && /Reflex (blocked|needs user confirmation)/.test(c.text ?? ""))) reflexBlocks++;
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const text = Array.isArray(ev.message.content) ? (ev.message.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("") : "";
				if (text.trim()) lastText = text;
			}
			emit(ev);
		}
	});
	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", (d: string) => {
		stderr += d;
		if (stderr.length > 20000) stderr = stderr.slice(-20000);
	});
	const code = await new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
	signal.removeEventListener("abort", onAbort);
	if (run.status === "timeout") return { status: "timeout", output: lastText.trim() || undefined, toolCalls, reflexBlocks, error: "timed out" };
	if (run.status === "cancelled" || signal.aborted) return { status: "cancelled", output: lastText.trim() || undefined, toolCalls, reflexBlocks };
	if (code === 0) return { status: "succeeded", output: lastText.trim() || undefined, toolCalls, reflexBlocks };
	return { status: "failed", output: lastText.trim() || undefined, toolCalls, reflexBlocks, error: stderr.trim().split("\n").slice(-5).join("\n") || `exit code ${code}` };
}

export function attachRunListener(runId: string, fn: RunListener): (() => void) | undefined {
	const l = live.get(runId);
	if (!l) return undefined;
	l.listeners.add(fn);
	return () => l.listeners.delete(fn);
}

export function liveRunsForAgent(agentId: string): AgentRun[] {
	return [...live.values()].filter((l) => l.run.agentId === agentId).map((l) => l.run);
}

export function allAgentsSummary() {
	return listAgents().map((a) => ({ ...a, running: liveRunsForAgent(a.id).length }));
}
