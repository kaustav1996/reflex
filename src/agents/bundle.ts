/**
 * Sharing an agent as a file: a `.reflex-agent.json` bundle.
 *
 *   { reflexAgent: 1,
 *     meta:     { name, description, author, version, exportedAt, reflexVersion },
 *     params:   [{ id: "REPO_DIR", type: "dir", description, example }],
 *     requires: { connectors, clis, secrets, models, jev, agents, warnings },
 *     agent:    { …the definition, with {{param.REPO_DIR}} where the author's values were },
 *     trial:    { input } }
 *
 * Export finds the values that tie an agent to its author (home-folder paths, repo URLs, emails,
 * long ids), asks Jev which of them someone else would have to replace, and turns the chosen ones
 * into parameters. Import (see staging.ts) fills them back in on the importer's machine.
 * Secrets never go into a bundle: only their names.
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { createKeyResolver, loadDotEnv, loadReflexConfig } from "../config.js";
import { loadMcpConfig } from "../extensions/mcp/client.js";
import { findPreset } from "../extensions/mcp/presets.js";
import { noul } from "../extensions/typesafe/client.js";
import { createJevClient } from "../extensions/typesafe/provider.js";
import { piStoredApiKey } from "../extensions/typesafe/state.js";
import type { AgentDefinition } from "./store.js";
import { effectOf, type Step, type StepEffect } from "./workflow.js";

export type ParamType = "dir" | "file" | "url" | "string" | "id";

export interface BundleParam {
	/** UPPER_SNAKE name used as {{param.<id>}}. */
	id: string;
	type: ParamType;
	description: string;
	/** The author's value, shown to the importer as an example (never a secret). */
	example?: string;
}

export interface BundleRequirements {
	/** Connectors named in the steps, with the service each is for (so an importer can map a differently named one). */
	connectors: Array<{ id: string; service: string; tools: string[] }>;
	clis: Array<{ name: string; check: string }>;
	/** Environment variables the agent reads that look like credentials. Values are never included. */
	secrets: Array<{ name: string; usedBy: string[] }>;
	/** Models the author used; any capable model can replace them. */
	models: string[];
	/** Needs a TypeSafe or OpenRouter key (it has decide steps). */
	jev: boolean;
	agents: { templates: string[]; calls: string[] };
	warnings: string[];
}

export interface AgentBundle {
	reflexAgent: 1;
	meta: { name: string; description?: string; author?: string; version: string; exportedAt: string; reflexVersion?: string };
	params: BundleParam[];
	requires: BundleRequirements;
	agent: Omit<AgentDefinition, "createdAt" | "updatedAt" | "enabled" | "parent"> & { enabled?: boolean };
	trial?: { input?: string };
}

export interface ParamCandidate {
	value: string;
	type: ParamType;
	suggestedId: string;
	/** How many times it appears in the definition. */
	count: number;
	/** Text around its first appearance. */
	context: string;
	/** Jev: P(someone else would have to replace this value). */
	score?: number;
}

type Jev = { systemOne: (req: never) => Promise<{ answers: Record<string, unknown> }> };

export function defaultJev(): Jev | undefined {
	loadDotEnv(); // keys usually live in ~/.reflex/.env
	return createJevClient(loadReflexConfig(), createKeyResolver(piStoredApiKey), { timeoutMs: 15000 })?.client as unknown as Jev | undefined;
}

function reflexVersion(): string | undefined {
	try {
		return (createRequire(import.meta.url)("../../package.json") as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/** Every string in a value, with the path it sits at. */
function strings(value: unknown, path = "", out: Array<{ path: string; text: string }> = []): Array<{ path: string; text: string }> {
	if (typeof value === "string") out.push({ path, text: value });
	else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
	else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
	return out;
}

/** The same value with every string passed through `fn`. */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
	if (typeof value === "string") return fn(value) as T;
	if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
	return value;
}

const LOCAL_REFLEX_URL = /https?:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}(?=\/api|\/hooks|["'\s)]|$)/g;
const PATH_CHAR = "[^\\s\"'`),;|&<>]";

function definitionPart(agent: AgentDefinition): Record<string, unknown> {
	const { createdAt: _c, updatedAt: _u, enabled: _e, parent: _p, ...rest } = agent;
	return rest as Record<string, unknown>;
}

/**
 * Values that probably tie the agent to its author. Paths are grouped by folder (the agent's own
 * folder first), so one parameter covers every file under it.
 */
export function findParamCandidates(agent: AgentDefinition, home = homedir()): ParamCandidate[] {
	const all = strings(definitionPart(agent)).map((s) => ({ ...s, text: s.text.replace(LOCAL_REFLEX_URL, "") }));
	const joined = all.map((s) => s.text).join("\n");
	const homeRoots = [home, "/Users/", "/home/"].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pathRe = new RegExp(`(?:${homeRoots.join("|")})${PATH_CHAR}*`, "g");
	const out: ParamCandidate[] = [];
	const seen = new Set<string>();
	const add = (value: string, type: ParamType, suggestedId: string) => {
		if (seen.has(value) || value.length < 4) return;
		seen.add(value);
		const idx = joined.indexOf(value);
		out.push({ value, type, suggestedId, count: joined.split(value).length - 1, context: idx >= 0 ? joined.slice(Math.max(0, idx - 60), idx + value.length + 60).replace(/\s+/g, " ") : "" });
	};
	// Folders: the agent's own folder, then the deepest folder of every other home path not under a chosen one.
	const dirs: string[] = [];
	const cwd = agent.cwd?.replace(/\/+$/, "");
	// The agent's own folder is machine-specific wherever it is.
	if (cwd && cwd.startsWith("/") && cwd.split("/").filter(Boolean).length >= 2) dirs.push(cwd);
	for (const m of joined.matchAll(pathRe)) {
		let p = m[0].replace(/[.:]+$/, "").replace(/\/+$/, "");
		if (dirs.some((d) => p === d || p.startsWith(`${d}/`))) continue;
		if (/\.[A-Za-z0-9]{1,6}$/.test(p.split("/").pop() ?? "")) p = p.slice(0, p.lastIndexOf("/")); // a file: take its folder
		if (p.split("/").filter(Boolean).length < 3) continue; // /Users/<name> alone is too broad
		if (!dirs.some((d) => p === d || p.startsWith(`${d}/`))) dirs.push(p);
	}
	dirs.forEach((d, i) => add(d, "dir", i === 0 && d === cwd ? "WORKDIR" : `${(d.split("/").pop() ?? "DIR").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_DIR`));
	// Values that only appear inside a chosen folder's path are covered by it.
	const rest = dirs.reduce((t, d) => t.split(d).join(" "), joined);
	for (const m of rest.matchAll(/git@[\w.-]+:[\w./-]+?(?:\.git)?(?=[\s"'`),]|$)/g)) add(m[0], "url", "GIT_REPO");
	for (const m of rest.matchAll(/https?:\/\/[^\s"'`)<>,]+/g)) {
		const u = m[0].replace(/[.,;:]+$/, "");
		const host = u.replace(/^https?:\/\//, "").split("/")[0];
		add(u.split("/").length > 3 ? u : `https://${host}`, "url", `${host.split(".")[0].replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_URL`);
	}
	for (const m of rest.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) if (!m[0].startsWith("git@")) add(m[0], "string", "EMAIL");
	for (const m of rest.matchAll(/(?<![\w.-])\d{7,}(?![\w.-])/g)) add(m[0], "id", "ID");
	// UUIDs are usually an organisation's own ids (a cloud or site id, a workspace).
	for (const m of rest.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) add(m[0], "id", "UUID");
	// Unique ids.
	const used = new Map<string, number>();
	for (const c of out) {
		const n = used.get(c.suggestedId) ?? 0;
		used.set(c.suggestedId, n + 1);
		if (n) c.suggestedId = `${c.suggestedId}_${n + 1}`;
	}
	return out;
}

/** Jev: would someone else have to replace each value? One request, one question per value. */
export async function judgeCandidates(agent: AgentDefinition, candidates: ParamCandidate[], jev: Jev | undefined = defaultJev()): Promise<ParamCandidate[]> {
	const fallback = (c: ParamCandidate) => (c.type === "dir" || c.type === "file" || c.type === "string" ? 0.9 : c.type === "url" ? 0.7 : 0.5);
	if (!jev || !candidates.length) return candidates.map((c) => ({ ...c, score: c.score ?? fallback(c) }));
	try {
		const questions = Object.fromEntries(
			candidates.slice(0, 60).map((c, i) => [
				`v${i}`,
				noul({
					question: "Would another person who installs this agent on their own computer have to replace this value with their own (it names the author's machine, folders, account, organisation, repository, project or document)?",
					judge_only_this_value: { value: c.value, kind: c.type, appears_in: c.context },
				}),
			]),
		);
		const res = await jev.systemOne({ purpose: "share:params", state: { agent: agent.name, description: agent.description ?? "" }, questions } as never);
		return candidates.map((c, i) => ({ ...c, score: (res.answers[`v${i}`] as { noul?: number } | undefined)?.noul ?? fallback(c) }));
	} catch {
		return candidates.map((c) => ({ ...c, score: fallback(c) }));
	}
}

const KNOWN_CLIS = ["git", "gh", "glab", "jq", "yq", "curl", "wget", "terraform", "tofu", "kubectl", "helm", "aws", "gcloud", "az", "docker", "podman", "npm", "npx", "pnpm", "yarn", "bun", "node", "python3", "pip", "uv", "uvx", "make", "psql", "mysql", "redis-cli", "rg", "fd", "gpg", "openssl", "ssh", "rsync", "ffmpeg", "sqlite3", "netlify", "render", "vercel", "flyctl", "railway"];
const SECRETY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|EMAIL|USER(NAME)?|AUTH)$/;

function stepText(step: Step): string {
	return JSON.stringify(step);
}

/** What the agent needs on the importer's machine, read from its definition. */
export function collectRequirements(agent: AgentDefinition): BundleRequirements {
	const steps = agent.steps ?? [];
	const everything = JSON.stringify(definitionPart(agent));
	// Connectors: tool names are <connector>__<tool>.
	const tools = new Map<string, Set<string>>();
	for (const m of everything.matchAll(/\b([a-z0-9][a-z0-9_-]*?)__([A-Za-z][A-Za-z0-9_]*)\b/g)) {
		if (!tools.has(m[1])) tools.set(m[1], new Set());
		tools.get(m[1])!.add(m[2]);
	}
	const servers = loadMcpConfig().servers;
	const connectors = [...tools].map(([id, set]) => {
		const s = servers[id];
		const service = findPreset(id)?.label ?? (s?.url ? new URL(s.url).host : s?.args?.slice(-1)[0] ?? s?.command ?? id);
		return { id, service, tools: [...set].sort() };
	});
	// CLIs and secrets from shell steps (and the single-prompt agent's text, for mentions).
	const shell = steps.filter((s) => s.type === "shell").map((s) => ({ id: s.id ?? "", run: (s as { run: string }).run }));
	// LLM steps with bash run commands too: count the CLIs their prompts name.
	const bashPrompts = steps.filter((s) => s.type === "llm" && (!(s as { tools?: string[] }).tools?.length || (s as { tools?: string[] }).tools!.includes("bash"))).map((s) => ({ id: s.id ?? "", run: (s as { prompt: string }).prompt }));
	const clis = KNOWN_CLIS.filter((c) => [...shell, ...bashPrompts].some((s) => new RegExp(`(^|[\\s;|&(\`$])${c.replace("-", "\\-")}(?=\\s|$)`, "m").test(s.run))).map((name) => ({ name, check: `command -v ${name}` }));
	const secrets = new Map<string, string[]>();
	for (const s of shell) {
		const assigned = new Set([...s.run.matchAll(/(?:^|[\s;])(?:export\s+)?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
		for (const m of s.run.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})/g)) {
			if (assigned.has(m[1]) || !SECRETY.test(m[1]) || m[1] === "REFLEX_WEB_TOKEN") continue;
			secrets.set(m[1], [...(secrets.get(m[1]) ?? []), s.id].filter((v, i, a) => a.indexOf(v) === i));
		}
	}
	const models = [...new Set([agent.model, ...steps.map((s) => (s as { model?: string }).model)].filter(Boolean) as string[])];
	const calls = [...new Set([...steps.filter((s) => s.type === "call").map((s) => (s as { agentId: string }).agentId), ...(agent.chain ?? []).map((c) => c.agentId)])];
	const warnings: string[] = [];
	if (LOCAL_REFLEX_URL.test(everything)) warnings.push("It calls Reflex's local API directly (a URL like http://127.0.0.1:7331/api/…). Replace that with a spawn step so it works on another machine.");
	LOCAL_REFLEX_URL.lastIndex = 0;
	if (calls.length) warnings.push(`It runs other agents that aren't in this bundle: ${calls.join(", ")}. The importer needs agents with those ids.`);
	if (agent.reflex === "off") warnings.push("The author ran it with the reflex gate off; an import starts with the gate on balanced.");
	return {
		connectors,
		clis,
		secrets: [...secrets].map(([name, usedBy]) => ({ name, usedBy })),
		models,
		jev: steps.some((s) => s.type === "decide"),
		agents: { templates: Object.keys(agent.templates ?? {}), calls },
		warnings,
	};
}

const EXTERNAL_HINT = /\bgit\s+push\b|\bglab\s+(mr|issue|release)\b|\bgh\s+(pr|issue|release|api)\b|\bcurl\b[^\n]*-X\s*(POST|PUT|PATCH|DELETE)|\bcurl\b[^\n]*--data|\bkubectl\s+(apply|delete|rollout)|\bterraform\s+apply\b|\bdeploy\b|\bnetlify\s+deploy|\bsendmail\b/i;
const LOCAL_HINT = /\bgit\s+(commit|checkout|switch|branch|reset|merge|rebase|pull|fetch|clone)\b|(^|[^>])>{1,2}\s*\S|\btee\b|\btouch\b|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\bsed\s+-i\b|\bnpm\s+(install|ci)\b/m;
const WRITE_TOOL = /__(add|create|update|delete|post|send|comment|transition|edit|write|merge|close|assign|move|archive|publish|upload|set)/i;

/** A deterministic guess at one step's effect, used alone without Jev and as a floor with it. */
export function guessEffect(step: Step): StepEffect {
	switch (step.type) {
		case "decide":
		case "end":
			return "read";
		case "spawn":
		case "call":
			return "external";
		case "shell":
			return EXTERNAL_HINT.test(step.run) ? "external" : LOCAL_HINT.test(step.run) ? "local" : "read";
		case "llm": {
			const tools = step.tools ?? [];
			if (!tools.length || tools.some((t) => WRITE_TOOL.test(t))) return "external";
			if (tools.includes("bash")) return EXTERNAL_HINT.test(step.prompt) ? "external" : "local";
			return tools.some((t) => t === "edit" || t === "write") ? "local" : "read";
		}
	}
}

/**
 * Effects for steps that don't have one: Jev reads each command or prompt, and a deterministic
 * "external" is never lowered (a push is external whatever the model thinks).
 */
export async function suggestEffects(steps: Step[], jev: Jev | undefined = defaultJev()): Promise<Record<string, { effect: StepEffect; source: "tag" | "jev" | "rules" }>> {
	const out: Record<string, { effect: StepEffect; source: "tag" | "jev" | "rules" }> = {};
	const ask: Array<{ id: string; step: Step }> = [];
	steps.forEach((s, i) => {
		const id = s.id ?? `step${i + 1}`;
		if (s.effect) out[id] = { effect: s.effect, source: "tag" };
		else if (s.type === "shell" || s.type === "llm") ask.push({ id, step: s });
		else out[id] = { effect: guessEffect(s), source: "rules" };
	});
	let answers: Record<string, unknown> = {};
	if (jev && ask.length) {
		try {
			const questions: Record<string, ReturnType<typeof noul>> = {};
			ask.slice(0, 30).forEach(({ step }, i) => {
				const what = step.type === "shell" ? { shell_command: step.run.slice(0, 1500) } : { llm_prompt: (step as { prompt: string }).prompt.slice(0, 1500), tools: (step as { tools?: string[] }).tools ?? "all" };
				questions[`x${i}`] = noul({ question: "Does this step change anything other people can see or that lives outside this machine: push to a remote, open or update a merge request, ticket or document, send a message, call a write API, deploy?", judge_only_this_step: what });
				questions[`l${i}`] = noul({ question: "Does this step change files on this machine: edit, write, create, delete, move, install, or commit locally?", judge_only_this_step: what });
			});
			answers = (await jev.systemOne({ purpose: "share:effects", state: "Workflow steps of an agent being shared; judge each step on its own.", questions } as never)).answers;
		} catch {
			answers = {};
		}
	}
	ask.forEach(({ id, step }, i) => {
		const floor = guessEffect(step);
		const x = (answers[`x${i}`] as { noul?: number } | undefined)?.noul;
		const l = (answers[`l${i}`] as { noul?: number } | undefined)?.noul;
		if (x === undefined || l === undefined) return void (out[id] = { effect: floor, source: "rules" });
		const byJev: StepEffect = x >= 0.5 ? "external" : l >= 0.5 ? "local" : "read";
		const rank = { read: 0, local: 1, external: 2 };
		out[id] = { effect: rank[floor] > rank[byJev] ? floor : byJev, source: "jev" };
	});
	return out;
}

export interface StepRisk {
	step: string;
	type: Step["type"];
	effect: StepEffect;
	destructive?: number;
	secrets?: number;
	external?: number;
}

/** Jev's risk read on each shell and LLM step, for the import review. */
export async function riskRead(agent: Pick<AgentDefinition, "steps">, jev: Jev | undefined = defaultJev()): Promise<StepRisk[]> {
	const steps = (agent.steps ?? []).map((s, i) => ({ id: s.id ?? `step${i + 1}`, s }));
	const rows: StepRisk[] = steps.map(({ id, s }) => ({ step: id, type: s.type, effect: effectOf(s) }));
	const judged = steps.filter(({ s }) => s.type === "shell" || s.type === "llm").slice(0, 20);
	if (!jev || !judged.length) return rows;
	try {
		const questions: Record<string, ReturnType<typeof noul>> = {};
		judged.forEach(({ s }, i) => {
			const what = s.type === "shell" ? { shell_command: s.run.slice(0, 1500) } : { llm_prompt: (s as { prompt: string }).prompt.slice(0, 1500), tools: (s as { tools?: string[] }).tools ?? "all" };
			questions[`d${i}`] = noul({ question: "Could this step destroy or irreversibly change data (delete files, drop tables, force-push, overwrite history)?", judge_only_this_step: what });
			questions[`s${i}`] = noul({ question: "Does this step read, print or send credentials or other secrets?", judge_only_this_step: what });
			questions[`e${i}`] = noul({ question: "Does this step reach outside this machine in a way others can see (push, post, comment, message, deploy)?", judge_only_this_step: what });
		});
		const a = (await jev.systemOne({ purpose: "share:risk", state: "Workflow steps of an agent someone shared; judge each step on its own.", questions } as never)).answers as Record<string, { noul?: number }>;
		judged.forEach(({ id }, i) => {
			const row = rows.find((r) => r.step === id)!;
			row.destructive = a[`d${i}`]?.noul;
			row.secrets = a[`s${i}`]?.noul;
			row.external = a[`e${i}`]?.noul;
		});
	} catch {}
	return rows;
}

export interface ExportChoices {
	params: Array<BundleParam & { value: string }>;
	effects?: Record<string, StepEffect>;
	meta?: { author?: string; version?: string; description?: string };
	trialInput?: string;
}

/** The bundle for an agent and the author's choices. Returns warnings about anything personal left in it. */
export function buildBundle(agent: AgentDefinition, choices: ExportChoices, home = homedir()): { bundle: AgentBundle; warnings: string[] } {
	const requires = collectRequirements(agent);
	let def = JSON.parse(JSON.stringify(definitionPart(agent))) as AgentBundle["agent"];
	def.triggers = (def.triggers ?? [{ type: "manual" }]).map((t) => (t.type === "webhook" ? { ...t, secret: "" } : t));
	if (choices.effects) def.steps = def.steps?.map((s, i) => ({ ...s, effect: choices.effects?.[s.id ?? `step${i + 1}`] ?? s.effect }));
	def = mapStrings(def, (s) => s.replace(LOCAL_REFLEX_URL, "{{reflex.url}}"));
	for (const p of [...choices.params].sort((a, b) => b.value.length - a.value.length)) def = mapStrings(def, (s) => s.split(p.value).join(`{{param.${p.id}}}`));
	const bundle: AgentBundle = {
		reflexAgent: 1,
		meta: { name: agent.name, description: choices.meta?.description ?? agent.description, author: choices.meta?.author, version: choices.meta?.version ?? "1.0.0", exportedAt: new Date().toISOString(), reflexVersion: reflexVersion() },
		params: choices.params.map(({ value, ...p }) => ({ ...p, example: p.example ?? value })),
		requires,
		agent: def,
		...(choices.trialInput ? { trial: { input: choices.trialInput } } : {}),
	};
	const warnings = [...requires.warnings];
	const left = JSON.stringify(def).match(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"\\s]*|/Users/[^/"\\s]+[^"\\s]*|/home/[^/"\\s]+[^"\\s]*`, "g"));
	if (left?.length) warnings.push(`Still contains paths from this machine: ${[...new Set(left)].slice(0, 5).join(", ")}`);
	return { bundle, warnings };
}

const PARAM_ID = /^[A-Z][A-Z0-9_]{0,40}$/;

/** Problems that make a file unusable as a bundle (empty = fine). */
export function validateBundle(raw: unknown): string[] {
	const b = raw as Partial<AgentBundle> | undefined;
	const errors: string[] = [];
	if (!b || typeof b !== "object") return ["not a JSON object"];
	if (b.reflexAgent !== 1) errors.push("not a Reflex agent bundle (reflexAgent: 1 missing)");
	if (!b.meta?.name) errors.push("meta.name missing");
	if (!b.agent || typeof b.agent !== "object" || !b.agent.name) errors.push("agent definition missing");
	const params = Array.isArray(b.params) ? b.params : [];
	for (const p of params) if (!PARAM_ID.test(p?.id ?? "")) errors.push(`bad parameter id "${p?.id}" (UPPER_SNAKE)`);
	const ids = new Set(params.map((p) => p.id));
	const used = [...JSON.stringify(b.agent ?? {}).matchAll(/\{\{param\.([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]);
	for (const u of new Set(used)) if (!ids.has(u)) errors.push(`{{param.${u}}} is used but not declared`);
	return errors;
}

/** The agent definition for this machine: parameters and the local Reflex URL filled in, connectors renamed. */
export function applyBundle(bundle: AgentBundle, opts: { values: Record<string, string>; reflexUrl: string; connectorMap?: Record<string, string>; id?: string; agent?: AgentBundle["agent"] }): Omit<AgentDefinition, "createdAt" | "updatedAt"> {
	const missing = bundle.params.filter((p) => !opts.values[p.id]?.trim()).map((p) => p.id);
	if (missing.length) throw new Error(`parameters without a value: ${missing.join(", ")}`);
	let def = JSON.parse(JSON.stringify(opts.agent ?? bundle.agent)) as AgentBundle["agent"];
	def = mapStrings(def, (s) =>
		s.replace(/\{\{param\.([A-Za-z0-9_]+)\}\}/g, (m, k: string) => opts.values[k] ?? m).replace(/\{\{reflex\.url\}\}/g, opts.reflexUrl.replace(/\/$/, "")),
	);
	for (const [from, to] of Object.entries(opts.connectorMap ?? {})) if (from !== to && to) def = mapStrings(def, (s) => s.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}__`, "g"), `${to}__`));
	return {
		...def,
		id: opts.id ?? def.id,
		enabled: false,
		reflex: !def.reflex || def.reflex === "off" ? "balanced" : def.reflex,
		triggers: (def.triggers ?? [{ type: "manual" }]).map((t) => (t.type === "webhook" ? { ...t, secret: "" } : t)),
	} as Omit<AgentDefinition, "createdAt" | "updatedAt">;
}
