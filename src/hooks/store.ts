/**
 * Session hooks: "when a session does X, run Y", as configuration.
 *
 *   ~/.reflex/hooks.json            global hooks (yours; always trusted)
 *   <project>/.reflex/hooks.json    project hooks (run only after you approve that exact file)
 *
 *   { "hooks": [ {
 *       "id": "report-on-stop",
 *       "event": "agent_end",
 *       "match": { "tool": "bash", "command": "^npm (test|run build)", "path": "src/**", "prompt": "deploy", "error": true },
 *       "if":    { "question": "Did this turn change source code?", "min": 0.6 },
 *       "run":   { "agent": "test-report", "input": "Session in {{cwd}} stopped. Last reply: {{lastAssistant}}" },
 *       "enabled": true
 *   } ] }
 *
 * Events: session_start, session_end, prompt, before_tool, after_tool, turn_end, agent_end,
 *         model_change, compact.
 * Actions: run a workflow agent (detached, so it outlives the session), or a shell command that
 *          gets the payload as JSON on stdin and as REFLEX_* env vars. A before_tool command that
 *          exits with code 2 blocks the tool call; its output becomes the reason the model sees.
 * `if` asks Jev one yes/no question about the payload and fires only at or above `min`.
 *
 * A project file is a supply-chain risk (cloning a repo must never run its commands), so project
 * hooks are inert until the user approves the file; the approval is bound to its content hash.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { minimatch } from "minimatch";
import { getReflexHome } from "../config.js";

export const HOOK_EVENTS = ["session_start", "session_end", "prompt", "before_tool", "after_tool", "turn_end", "agent_end", "model_change", "compact"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const EVENT_HELP: Record<HookEvent, string> = {
	session_start: "a session starts, resumes or forks",
	session_end: "a session shuts down",
	prompt: "you send a prompt, before the agent starts",
	before_tool: "a tool is about to run (a command can block it)",
	after_tool: "a tool finished",
	turn_end: "one model turn ended",
	agent_end: "the agent stopped and is waiting for you",
	model_change: "the model changed",
	compact: "the session was compacted",
};

export interface HookMatch {
	/** Tool name, a list of names, or a glob (`computer*`). before_tool / after_tool. */
	tool?: string | string[];
	/** Regex on the bash command. */
	command?: string;
	/** Glob on the file path of read / edit / write calls (relative to the project, or absolute). */
	path?: string;
	/** Regex on the user's prompt. prompt event. */
	prompt?: string;
	/** after_tool: only failed (true) or only successful (false) results. */
	error?: boolean;
}

export type HookAction = { agent: string; input?: string } | { command: string; timeoutSec?: number; cwd?: string };

export interface HookDef {
	id: string;
	event: HookEvent;
	match?: HookMatch;
	/** A Jev yes/no question over the payload; the hook fires only when P(yes) >= min (default 0.6). */
	if?: { question: string; min?: number };
	run: HookAction;
	/** Wait for a command to finish (always true for before_tool). */
	wait?: boolean;
	enabled?: boolean;
	description?: string;
}

export interface LoadedHook extends HookDef {
	source: "global" | "project";
	file: string;
}

/** What an event carries; also what templates and commands can read. */
export interface HookPayload {
	event: HookEvent;
	cwd: string;
	session?: string;
	tool?: string;
	toolInput?: Record<string, unknown>;
	command?: string;
	path?: string;
	prompt?: string;
	result?: string;
	isError?: boolean;
	lastAssistant?: string;
	model?: string;
	reason?: string;
}

export function globalHooksPath(): string {
	return join(getReflexHome(), "hooks.json");
}
export function projectHooksPath(cwd: string): string {
	return join(cwd, ".reflex", "hooks.json");
}
function trustPath(): string {
	return join(getReflexHome(), "hooks-trust.json");
}

const ID = /^[a-z0-9][a-z0-9-_]{0,60}$/;

/** Validate and normalize one hook; throws with a message a person can act on. */
export function validateHook(raw: unknown): HookDef {
	const h = (raw ?? {}) as Partial<HookDef>;
	const id = String(h.id ?? "").trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
	if (!ID.test(id)) throw new Error("hook id: 1–61 lowercase letters, digits, dashes or underscores");
	if (!HOOK_EVENTS.includes(h.event as HookEvent)) throw new Error(`event must be one of ${HOOK_EVENTS.join(", ")}`);
	const run = h.run as Record<string, unknown> | undefined;
	const isAgent = typeof run?.agent === "string" && run.agent.trim() !== "";
	const isCommand = typeof run?.command === "string" && run.command.trim() !== "";
	if (isAgent === isCommand) throw new Error("run needs exactly one of `agent` or `command`");
	for (const key of ["command", "prompt"] as const) {
		const v = h.match?.[key];
		if (v) {
			try {
				new RegExp(v);
			} catch (e) {
				throw new Error(`match.${key} is not a valid regex: ${e instanceof Error ? e.message : e}`);
			}
		}
	}
	if (h.if && !String(h.if.question ?? "").trim()) throw new Error("`if` needs a question");
	const match: HookMatch | undefined = h.match && Object.values(h.match).some((v) => v !== undefined && v !== "") ? { ...h.match } : undefined;
	return {
		id,
		event: h.event as HookEvent,
		match,
		if: h.if ? { question: String(h.if.question).trim(), min: typeof h.if.min === "number" ? Math.min(1, Math.max(0, h.if.min)) : undefined } : undefined,
		run: isAgent ? { agent: String(run!.agent).trim(), input: typeof run!.input === "string" ? run!.input : undefined } : { command: String(run!.command), timeoutSec: typeof run!.timeoutSec === "number" ? run!.timeoutSec : undefined, cwd: typeof run!.cwd === "string" ? run!.cwd : undefined },
		wait: h.wait === true ? true : undefined,
		enabled: h.enabled === false ? false : true,
		description: h.description ? String(h.description) : undefined,
	};
}

function readFile(file: string): HookDef[] {
	try {
		if (!existsSync(file)) return [];
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { hooks?: unknown[] };
		const out: HookDef[] = [];
		for (const raw of parsed.hooks ?? []) {
			try {
				out.push(validateHook(raw));
			} catch {}
		}
		return out;
	} catch {
		return [];
	}
}

export function listGlobalHooks(): HookDef[] {
	return readFile(globalHooksPath());
}

export function saveGlobalHook(raw: unknown): HookDef {
	const hook = validateHook(raw);
	const all = listGlobalHooks().filter((h) => h.id !== hook.id);
	all.push(hook);
	mkdirSync(dirname(globalHooksPath()), { recursive: true });
	writeFileSync(globalHooksPath(), `${JSON.stringify({ hooks: all }, null, 2)}\n`);
	return hook;
}

export function deleteGlobalHook(id: string): void {
	const all = listGlobalHooks().filter((h) => h.id !== id);
	writeFileSync(globalHooksPath(), `${JSON.stringify({ hooks: all }, null, 2)}\n`);
}

// ---- project hooks are inert until this exact file content is approved ----

export function fileHash(file: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return undefined;
	}
}

function readTrust(): Record<string, string> {
	try {
		return JSON.parse(readFileSync(trustPath(), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

export function isProjectFileTrusted(file: string): boolean {
	const h = fileHash(file);
	return !!h && readTrust()[file] === h;
}

export function trustProjectFile(file: string): void {
	const h = fileHash(file);
	if (!h) return;
	const t = readTrust();
	t[file] = h;
	mkdirSync(dirname(trustPath()), { recursive: true });
	writeFileSync(trustPath(), `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
}

/** Global hooks plus the project's, the latter only when its file is approved. */
export function loadHooks(cwd: string): { hooks: LoadedHook[]; untrusted?: { file: string; hooks: HookDef[] } } {
	const hooks: LoadedHook[] = listGlobalHooks().map((h) => ({ ...h, source: "global" as const, file: globalHooksPath() }));
	const pf = projectHooksPath(cwd);
	const project = readFile(pf);
	if (!project.length) return { hooks };
	if (!isProjectFileTrusted(pf)) return { hooks, untrusted: { file: pf, hooks: project } };
	return { hooks: [...hooks, ...project.map((h) => ({ ...h, source: "project" as const, file: pf }))] };
}

// ---- matching and templating (pure) ----

export function matches(hook: HookDef, p: HookPayload): boolean {
	if (hook.enabled === false || hook.event !== p.event) return false;
	const m = hook.match;
	if (!m) return true;
	if (m.tool !== undefined) {
		const names = Array.isArray(m.tool) ? m.tool : [m.tool];
		if (!p.tool || !names.some((n) => n === p.tool || minimatch(p.tool!, n))) return false;
	}
	if (m.command !== undefined && !(p.command !== undefined && new RegExp(m.command).test(p.command))) return false;
	if (m.path !== undefined) {
		if (!p.path) return false;
		const rel = p.path.startsWith(`${p.cwd}/`) ? p.path.slice(p.cwd.length + 1) : p.path;
		if (!minimatch(rel, m.path, { dot: true }) && !minimatch(p.path, m.path, { dot: true })) return false;
	}
	if (m.prompt !== undefined && !(p.prompt !== undefined && new RegExp(m.prompt, "i").test(p.prompt))) return false;
	if (m.error !== undefined && !!p.isError !== m.error) return false;
	return true;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** `{{name}}` reads the payload; long values are clipped so an input stays a sensible size. */
export function renderTemplate(template: string, p: HookPayload): string {
	const vars: Record<string, string> = {
		event: p.event,
		cwd: p.cwd,
		session: p.session ?? "",
		tool: p.tool ?? "",
		command: p.command ?? "",
		path: p.path ?? "",
		prompt: clip(p.prompt ?? "", 4000),
		result: clip(p.result ?? "", 4000),
		isError: String(!!p.isError),
		lastAssistant: clip(p.lastAssistant ?? "", 4000),
		model: p.model ?? "",
		reason: p.reason ?? "",
		toolInput: clip(JSON.stringify(p.toolInput ?? {}), 2000),
	};
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

export function defaultAgentInput(p: HookPayload): string {
	const bits = [`hook event: ${p.event}`, `project: ${p.cwd}`];
	if (p.tool) bits.push(`tool: ${p.tool}${p.command ? ` · ${clip(p.command, 300)}` : p.path ? ` · ${p.path}` : ""}`);
	if (p.prompt) bits.push(`prompt: ${clip(p.prompt, 1500)}`);
	if (p.result) bits.push(`result${p.isError ? " (error)" : ""}: ${clip(p.result, 1500)}`);
	if (p.lastAssistant) bits.push(`last reply: ${clip(p.lastAssistant, 1500)}`);
	return bits.join("\n");
}
