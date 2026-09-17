/**
 * Agents live in ~/.reflex/agents/<id>/agent.json, their runs in <id>/runs/<runId>.json,
 * and each run's transcript in <id>/sessions/ (a separate Pi session dir, so agent runs
 * never appear in the user's own session list).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReflexHome } from "../config.js";
import type { Step } from "./workflow.js";

export type TriggerKind = "manual" | "cron" | "webhook";

export interface CronTrigger {
	type: "cron";
	/** 5-field cron or @hourly/@daily/@weekly/@weekdays. Local time. */
	schedule: string;
	/** Optional input text passed as {{input}}. */
	input?: string;
	enabled?: boolean;
}
export interface WebhookTrigger {
	type: "webhook";
	/** Secret path segment; generated. POST /hooks/<agentId>/<secret> with JSON or text body. */
	secret: string;
	enabled?: boolean;
}
export interface ManualTrigger {
	type: "manual";
}
export type Trigger = CronTrigger | WebhookTrigger | ManualTrigger;

export interface ChainStep {
	/** Agent id to call when this agent's run succeeds. */
	agentId: string;
	/** Template for the next agent's input; {{output}} = this run's final answer, {{input}} = this run's input. Default "{{output}}". */
	input?: string;
}

export interface AgentDefinition {
	id: string;
	name: string;
	description?: string;
	/** Working directory for runs. */
	cwd: string;
	/** Appended to the system prompt for every run. */
	instructions?: string;
	/** Prompt template for a single-LLM-step agent; {{input}} is replaced with the trigger input. Ignored when `steps` is set. */
	prompt: string;
	/** Workflow steps (shell → decide → llm priority). When present, the run executes these instead of `prompt`. */
	steps?: Step[];
	/** Pi model ref like "openrouter/anthropic/claude-sonnet-4.6" (default: user's default). */
	model?: string;
	/** Reflex appetite for this agent's runs: cautious | balanced | bold | off. Headless runs cannot ask, so "ask" becomes block. */
	reflex?: "cautious" | "balanced" | "bold" | "off";
	/** Tool allowlist (Pi --tools), e.g. ["read","grep","find","ls"] for a read-only agent. */
	tools?: string[];
	/** Enable macOS computer-use tools (--assistant). */
	computer?: boolean;
	triggers: Trigger[];
	chain?: ChainStep[];
	timeoutMinutes?: number;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "timeout" | "cancelled";

export interface AgentRun {
	id: string;
	agentId: string;
	status: RunStatus;
	trigger: { type: TriggerKind | "chain"; from?: string };
	input?: string;
	output?: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
	sessionFile?: string;
	toolCalls: number;
	reflexBlocks: number;
	pid?: number;
}

export function agentsDir(): string {
	return join(getReflexHome(), "agents");
}
export function agentDir(id: string): string {
	return join(agentsDir(), id);
}
export function agentRunsDir(id: string): string {
	return join(agentDir(id), "runs");
}
export function agentSessionsDir(id: string): string {
	return join(agentDir(id), "sessions");
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export function slugify(name: string): string {
	const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	return ID_RE.test(s) ? s : `agent-${randomUUID().slice(0, 8)}`;
}

export function listAgents(): AgentDefinition[] {
	const dir = agentsDir();
	if (!existsSync(dir)) return [];
	const out: AgentDefinition[] = [];
	for (const id of readdirSync(dir)) {
		const a = loadAgent(id);
		if (a) out.push(a);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgent(id: string): AgentDefinition | undefined {
	const file = join(agentDir(id), "agent.json");
	if (!existsSync(file)) return undefined;
	try {
		const a = JSON.parse(readFileSync(file, "utf8")) as AgentDefinition;
		a.id = id;
		a.triggers ??= [{ type: "manual" }];
		a.enabled ??= true;
		return a;
	} catch {
		return undefined;
	}
}

export function saveAgent(input: Partial<AgentDefinition> & { name: string; prompt: string }): AgentDefinition {
	const id = input.id && ID_RE.test(input.id) ? input.id : slugify(input.name);
	const existing = loadAgent(id);
	const now = Date.now();
	const triggers = (input.triggers ?? existing?.triggers ?? [{ type: "manual" }]).map((t) => {
		if (t.type === "webhook" && !t.secret) return { ...t, secret: randomBytes(12).toString("hex") };
		return t;
	});
	if (!triggers.some((t) => t.type === "manual")) triggers.push({ type: "manual" });
	const agent: AgentDefinition = {
		...existing,
		...input,
		id,
		name: input.name,
		prompt: input.prompt,
		cwd: input.cwd ?? existing?.cwd ?? process.cwd(),
		triggers,
		enabled: input.enabled ?? existing?.enabled ?? true,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	mkdirSync(agentRunsDir(id), { recursive: true });
	mkdirSync(agentSessionsDir(id), { recursive: true });
	writeFileSync(join(agentDir(id), "agent.json"), `${JSON.stringify(agent, null, 2)}\n`);
	return agent;
}

export function deleteAgent(id: string): void {
	if (!ID_RE.test(id)) return;
	rmSync(agentDir(id), { recursive: true, force: true });
}

export function listRuns(agentId: string, limit = 50): AgentRun[] {
	const dir = agentRunsDir(agentId);
	if (!existsSync(dir)) return [];
	const runs: AgentRun[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			runs.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as AgentRun);
		} catch {}
	}
	return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export function loadRun(agentId: string, runId: string): AgentRun | undefined {
	const file = join(agentRunsDir(agentId), `${runId}.json`);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as AgentRun;
	} catch {
		return undefined;
	}
}

export function saveRun(run: AgentRun): void {
	mkdirSync(agentRunsDir(run.agentId), { recursive: true });
	writeFileSync(join(agentRunsDir(run.agentId), `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

/** Path of the run's event log (JSONL of Pi events) for later viewing. */
export function runLogPath(run: AgentRun): string {
	return join(agentRunsDir(run.agentId), `${run.id}.events.jsonl`);
}

export function newRun(agent: AgentDefinition, trigger: AgentRun["trigger"], input?: string): AgentRun {
	return { id: `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`, agentId: agent.id, status: "queued", trigger, input, startedAt: Date.now(), toolCalls: 0, reflexBlocks: 0 };
}

export function agentsLastModified(): number {
	const dir = agentsDir();
	if (!existsSync(dir)) return 0;
	let latest = 0;
	for (const id of readdirSync(dir)) {
		try {
			latest = Math.max(latest, statSync(join(dir, id, "agent.json")).mtimeMs);
		} catch {}
	}
	return latest;
}
