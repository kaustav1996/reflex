/**
 * Running a hook's action.
 *
 * An agent action starts `reflex agent run <id>` as a detached process, so the run outlives the
 * session that triggered it (a session_end hook must not die with its session). The run is recorded
 * under the agent like any other and shows up in the Agents tab with trigger "hook".
 *
 * A command action gets the payload as JSON on stdin and as REFLEX_* env vars. For before_tool the
 * command is awaited, and exit code 2 blocks the tool call with the command's output as the reason.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { type HookDef, type HookPayload, defaultAgentInput, renderTemplate } from "./store.js";

export interface HookOutcome {
	hook: string;
	action: "agent" | "command";
	ok: boolean;
	/** before_tool only: the command asked to block the tool call. */
	block?: boolean;
	detail: string;
	ms: number;
}

function cliPath(): string {
	const require = createRequire(import.meta.url);
	return resolve(dirname(require.resolve("../../package.json")), "dist", "cli.js");
}

export function hookEnv(p: HookPayload, hookId: string): Record<string, string> {
	return {
		REFLEX_HOOK: hookId,
		REFLEX_HOOK_EVENT: p.event,
		REFLEX_CWD: p.cwd,
		REFLEX_SESSION: p.session ?? "",
		REFLEX_TOOL: p.tool ?? "",
		REFLEX_TOOL_INPUT: JSON.stringify(p.toolInput ?? {}),
		REFLEX_COMMAND: p.command ?? "",
		REFLEX_PATH: p.path ?? "",
		REFLEX_PROMPT: (p.prompt ?? "").slice(0, 8000),
		REFLEX_IS_ERROR: p.isError ? "1" : "",
		REFLEX_MODEL: p.model ?? "",
	};
}

/** Start a workflow agent without waiting for it. */
export function startAgent(agentId: string, input: string, p: HookPayload, hookId: string): { pid?: number } {
	const child = spawn(process.execPath, [cliPath(), "agent", "run", agentId, "--input", input, "--trigger", "hook", "--from", `${hookId}@${p.session || p.cwd}`], {
		cwd: p.cwd,
		detached: true,
		stdio: "ignore",
		env: { ...process.env, ...hookEnv(p, hookId), REFLEX_FROM_HOOK: "1" },
	});
	child.unref();
	return { pid: child.pid };
}

export function runCommand(hook: HookDef, p: HookPayload, wait: boolean): Promise<{ code: number | null; output: string; timedOut: boolean }> {
	const run = hook.run as { command: string; timeoutSec?: number; cwd?: string };
	const timeoutMs = Math.min(run.timeoutSec ?? 30, 600) * 1000;
	return new Promise((resolveRun) => {
		const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", renderTemplate(run.command, p)], {
			cwd: run.cwd ? renderTemplate(run.cwd, p) : p.cwd,
			env: { ...process.env, ...hookEnv(p, hook.id) },
			stdio: ["pipe", "pipe", "pipe"],
			detached: !wait,
		});
		let out = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout?.on("data", (d) => (out += d));
		child.stderr?.on("data", (d) => (out += d));
		child.on("error", (err) => {
			clearTimeout(timer);
			resolveRun({ code: 127, output: String(err.message), timedOut });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolveRun({ code, output: out.trim().slice(-2000), timedOut });
		});
		try {
			child.stdin?.end(JSON.stringify(p));
		} catch {}
		if (!wait) {
			child.unref();
			// Fire and forget: report that it started; its exit is still logged through the promise above.
		}
	});
}

/** Execute one hook. `await`ed fully only when the hook must wait (before_tool, or wait: true). */
export async function executeHook(hook: HookDef, p: HookPayload): Promise<HookOutcome> {
	const t0 = Date.now();
	if ("agent" in hook.run) {
		const input = hook.run.input ? renderTemplate(hook.run.input, p) : defaultAgentInput(p);
		try {
			const { pid } = startAgent(hook.run.agent, input, p, hook.id);
			return { hook: hook.id, action: "agent", ok: true, detail: `started agent ${hook.run.agent}${pid ? ` (pid ${pid})` : ""}`, ms: Date.now() - t0 };
		} catch (err) {
			return { hook: hook.id, action: "agent", ok: false, detail: `could not start agent ${hook.run.agent}: ${err instanceof Error ? err.message : err}`, ms: Date.now() - t0 };
		}
	}
	const mustWait = p.event === "before_tool" || hook.wait === true;
	const pending = runCommand(hook, p, mustWait);
	if (!mustWait) return { hook: hook.id, action: "command", ok: true, detail: "command started", ms: Date.now() - t0 };
	const r = await pending;
	const block = p.event === "before_tool" && r.code === 2;
	return { hook: hook.id, action: "command", ok: r.code === 0 || block, block, detail: r.timedOut ? "timed out" : `exit ${r.code}${r.output ? ` · ${r.output.split("\n").slice(-3).join(" ⏎ ").slice(0, 300)}` : ""}`, ms: Date.now() - t0 };
}
