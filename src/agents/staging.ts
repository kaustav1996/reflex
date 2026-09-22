/**
 * Importing a shared agent: the bundle waits in a staging area while a session reviews it.
 *
 *   ~/.reflex/agents-staging/<id>/state.json
 *
 * A staged agent is not in the agent list, is never scheduled and can only run as a trial (under
 * the agent id `staging-<id>`, so its trial runs stay out of the list too). It becomes a real
 * agent only through `installStaged`, which the review session's tool calls behind a UI
 * confirmation and the web's "Add agent" button calls on a click.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getReflexHome } from "../config.js";
import { loadMcpConfig, McpClient } from "../extensions/mcp/client.js";
import { findPreset } from "../extensions/mcp/presets.js";
import { dotenvNames } from "../extensions/secrets/store.js";
import { type AgentBundle, applyBundle, defaultJev, riskRead, type StepRisk, suggestEffects, validateBundle } from "./bundle.js";
import { agentDiagram } from "./diagram.js";
import { runAgent } from "./runner.js";
import { type AgentDefinition, agentDir, deleteAgent, loadAgent, saveAgent, slugify } from "./store.js";
import type { StepEffect } from "./workflow.js";

export interface TrialResult {
	runId: string;
	status: string;
	error?: string;
	output?: string;
	at: number;
	steps: Array<{ id: string; ok: boolean; skipped?: string; wouldRun?: string }>;
}

export interface StagedAgent {
	id: string;
	bundle: AgentBundle;
	/** The definition under review, still with {{param.*}} placeholders; edits change this. */
	draft: AgentBundle["agent"];
	values: Record<string, string>;
	/** Bundle connector id → the importer's connector id. */
	connectorMap: Record<string, string>;
	/** Where each step's effect came from, for steps the bundle didn't tag. */
	effects: Record<string, { effect: StepEffect; source: "tag" | "jev" | "rules" }>;
	risk?: StepRisk[];
	cwd?: string;
	source?: string;
	trial?: TrialResult;
	createdAt: number;
	updatedAt: number;
}

export function stagingRoot(): string {
	return join(getReflexHome(), "agents-staging");
}
const stateFile = (id: string) => join(stagingRoot(), id, "state.json");
const ID = /^[a-z0-9][a-z0-9-]{1,32}$/;
export const trialAgentId = (id: string) => `staging-${id}`;

export function getStaged(id: string): StagedAgent | undefined {
	if (!ID.test(id)) return undefined;
	try {
		return JSON.parse(readFileSync(stateFile(id), "utf8")) as StagedAgent;
	} catch {
		return undefined;
	}
}

function saveStaged(s: StagedAgent): StagedAgent {
	s.updatedAt = Date.now();
	mkdirSync(join(stagingRoot(), s.id), { recursive: true });
	writeFileSync(stateFile(s.id), `${JSON.stringify(s, null, 2)}\n`);
	return s;
}

export function listStaged(): StagedAgent[] {
	if (!existsSync(stagingRoot())) return [];
	return readdirSync(stagingRoot())
		.map((id) => getStaged(id))
		.filter((s): s is StagedAgent => !!s)
		.sort((a, b) => b.createdAt - a.createdAt);
}

/** Put a bundle in staging: validate it, and tag untagged steps with suggested effects. */
export async function stageBundle(raw: unknown, opts: { source?: string; cwd?: string; jev?: Parameters<typeof suggestEffects>[1] } = {}): Promise<StagedAgent> {
	const bundle = (typeof raw === "string" ? JSON.parse(raw) : raw) as AgentBundle;
	const errors = validateBundle(bundle);
	if (errors.length) throw new Error(`not a usable agent bundle: ${errors.join("; ")}`);
	const id = `${slugify(bundle.meta.name).slice(0, 24).replace(/-+$/, "")}-${randomBytes(2).toString("hex")}`;
	const jev = opts.jev === undefined ? defaultJev() : opts.jev;
	const effects = await suggestEffects(bundle.agent.steps ?? [], jev);
	const draft = { ...bundle.agent, steps: bundle.agent.steps?.map((s, i) => ({ ...s, effect: s.effect ?? effects[s.id ?? `step${i + 1}`]?.effect })) };
	const staged: StagedAgent = { id, bundle, draft, values: {}, connectorMap: {}, effects, cwd: opts.cwd, source: opts.source, createdAt: Date.now(), updatedAt: Date.now() };
	staged.risk = await riskRead(draft as AgentDefinition, jev);
	for (const c of bundle.requires?.connectors ?? []) {
		const suggestion = suggestConnector(c.id, c.service);
		if (suggestion && suggestion !== c.id) staged.connectorMap[c.id] = suggestion;
	}
	if (opts.cwd) Object.assign(staged.values, await proposeValues(staged, opts.cwd));
	return saveStaged(staged);
}

/** The importer's connector for the same service, when the bundle's id isn't configured here. */
export function suggestConnector(id: string, service: string): string | undefined {
	const servers = loadMcpConfig().servers;
	if (servers[id]) return id;
	const same = Object.keys(servers).find((name) => (findPreset(name)?.label ?? "") === service || name.includes(id) || id.includes(name));
	return same;
}

const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((res) => execFile("git", ["-C", cwd, ...args], { timeout: 5000 }, (err, out) => res(err ? undefined : out.trim())));
}

/** Values this machine suggests: the session folder for the agent's folder, its git remote for a repo URL. */
export async function proposeValues(s: StagedAgent, cwd: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const p of s.bundle.params) {
		if (s.values[p.id]) continue;
		if (p.id === "WORKDIR" || (p.type === "dir" && s.bundle.params.filter((x) => x.type === "dir").length === 1)) out[p.id] = cwd;
		else if (p.type === "url" && /git@|\.git$/.test(p.example ?? "")) {
			const remote = await git(cwd, ["remote", "get-url", "origin"]);
			if (remote) out[p.id] = remote;
		}
	}
	return out;
}

/** Problems with the values (empty = fine). Folders must exist on this machine. */
export function checkValues(s: StagedAgent): string[] {
	const problems: string[] = [];
	for (const p of s.bundle.params) {
		const v = s.values[p.id]?.trim();
		if (!v) problems.push(`${p.id}: no value yet (${p.description})`);
		else if (p.type === "dir" && !(existsSync(expandHome(v)) && statSync(expandHome(v)).isDirectory())) problems.push(`${p.id}: folder ${v} doesn't exist`);
		else if (p.type === "file" && !existsSync(expandHome(v))) problems.push(`${p.id}: file ${v} doesn't exist`);
	}
	return problems;
}

export function setStagedValues(id: string, change: { values?: Record<string, string>; connectorMap?: Record<string, string>; cwd?: string }): StagedAgent {
	const s = getStaged(id);
	if (!s) throw new Error(`no staged agent ${id}`);
	const known = new Set(s.bundle.params.map((p) => p.id));
	for (const [k, v] of Object.entries(change.values ?? {})) {
		if (!known.has(k)) throw new Error(`unknown parameter ${k}; this bundle has ${[...known].join(", ") || "none"}`);
		const param = s.bundle.params.find((p) => p.id === k)!;
		s.values[k] = param.type === "dir" || param.type === "file" ? resolve(expandHome(String(v))) : String(v);
	}
	for (const [k, v] of Object.entries(change.connectorMap ?? {})) s.connectorMap[k] = String(v);
	if (change.cwd) s.cwd = resolve(expandHome(change.cwd));
	s.trial = undefined; // a changed agent needs a new trial
	return saveStaged(s);
}

const EDITABLE = ["name", "description", "prompt", "instructions", "steps", "triggers", "model", "reflex", "tools", "limits", "templates", "timeoutMinutes", "chain", "computer"] as const;

/** Change the staged definition (e.g. "skip the Jira comment", "run weekdays at 9"). */
export function editStaged(id: string, changes: Record<string, unknown>): StagedAgent {
	const s = getStaged(id);
	if (!s) throw new Error(`no staged agent ${id}`);
	const bad = Object.keys(changes).filter((k) => !(EDITABLE as readonly string[]).includes(k));
	if (bad.length) throw new Error(`can't change ${bad.join(", ")}; editable: ${EDITABLE.join(", ")}`);
	const next = { ...s.draft, ...changes } as AgentBundle["agent"];
	agentDiagram(next as AgentDefinition); // throws on a definition it can't read
	const ids = (next.steps ?? []).map((st) => st.id).filter(Boolean);
	for (const st of next.steps ?? []) for (const r of st.route ?? []) if (r.next !== "end" && r.next !== "stop" && !ids.includes(r.next)) throw new Error(`step ${st.id} routes to unknown step "${r.next}"`);
	s.draft = next;
	s.trial = undefined;
	return saveStaged(s);
}

export function reflexUrl(): string {
	return (process.env.REFLEX_WEB_URL ?? "http://127.0.0.1:7331").replace(/\/$/, "");
}

/** The staged agent as it would run here (values filled in), under the given id. */
export function resolveStaged(s: StagedAgent, id: string): AgentDefinition {
	const def = applyBundle(s.bundle, { values: s.values, reflexUrl: reflexUrl(), connectorMap: s.connectorMap, id, agent: s.draft });
	return { ...def, cwd: def.cwd && existsSync(def.cwd) ? def.cwd : (s.cwd ?? def.cwd), createdAt: s.createdAt, updatedAt: s.updatedAt } as AgentDefinition;
}

export interface RequirementCheck {
	values: string[];
	connectors: Array<{ id: string; service: string; usesHere: string; configured: boolean; enabled: boolean; missingTools: string[]; error?: string; suggestion?: string }>;
	clis: Array<{ name: string; found: boolean }>;
	secrets: Array<{ name: string; present: boolean }>;
	jev: { needed: boolean; available: boolean };
	warnings: string[];
	ready: boolean;
}

function commandExists(name: string): Promise<boolean> {
	return new Promise((res) => execFile(process.env.SHELL || "/bin/sh", ["-lc", `command -v ${name}`], { timeout: 5000 }, (err) => res(!err)));
}

/** Everything the agent needs, checked on this machine. Connectors are connected to list their tools. */
export async function checkStaged(id: string, opts: { connectTimeoutMs?: number } = {}): Promise<RequirementCheck> {
	const s = getStaged(id);
	if (!s) throw new Error(`no staged agent ${id}`);
	const req = s.bundle.requires ?? { connectors: [], clis: [], secrets: [], models: [], jev: false, agents: { templates: [], calls: [] }, warnings: [] };
	const servers = loadMcpConfig().servers;
	const connectors = await Promise.all(
		req.connectors.map(async (c) => {
			const here = s.connectorMap[c.id] ?? c.id;
			const cfg = servers[here];
			const row = { id: c.id, service: c.service, usesHere: here, configured: !!cfg, enabled: !!cfg && cfg.enabled !== false, missingTools: c.tools, error: undefined as string | undefined, suggestion: cfg ? undefined : suggestConnector(c.id, c.service) };
			if (!cfg || cfg.enabled === false) return row;
			const client = new McpClient(here, cfg);
			try {
				await client.connect(opts.connectTimeoutMs ?? 30000);
				const names = new Set(client.tools.map((t) => t.name));
				row.missingTools = c.tools.filter((t) => !names.has(t));
			} catch (err) {
				row.error = err instanceof Error ? err.message : String(err);
			} finally {
				client.close();
			}
			return row;
		}),
	);
	const envNames = new Set([...dotenvNames(join(getReflexHome(), ".env")), ...(s.cwd ? dotenvNames(join(s.cwd, ".env")) : [])]);
	const clis = await Promise.all(req.clis.map(async (c) => ({ name: c.name, found: await commandExists(c.name) })));
	const secrets = req.secrets.map((x) => ({ name: x.name, present: !!process.env[x.name] || envNames.has(x.name) }));
	const jev = { needed: req.jev, available: !!defaultJev() };
	const values = checkValues(s);
	const ready = !values.length && connectors.every((c) => c.enabled && !c.error && !c.missingTools.length) && clis.every((c) => c.found) && secrets.every((x) => x.present) && (!jev.needed || jev.available);
	return { values, connectors, clis, secrets, jev, warnings: req.warnings, ready };
}

/** A trial run of the staged agent: read and local steps run, external ones are only reported. */
export async function trialStaged(id: string, input?: string): Promise<TrialResult> {
	const s = getStaged(id);
	if (!s) throw new Error(`no staged agent ${id}`);
	const problems = checkValues(s);
	if (problems.length) throw new Error(`fill in the parameters first: ${problems.join("; ")}`);
	const def = resolveStaged(s, trialAgentId(id));
	const steps: TrialResult["steps"] = [];
	const run = await runAgent(def, { type: "manual" }, input ?? s.bundle.trial?.input, (_r, ev) => {
		const e = ev as { type?: string; id?: string; ok?: boolean; result?: { skipped?: string; wouldRun?: string } };
		if (e.type === "step_end" && e.id) steps.push({ id: e.id, ok: !!e.ok, skipped: e.result?.skipped, wouldRun: e.result?.wouldRun?.slice(0, 800) });
	}, { trial: true });
	const fresh = getStaged(id) ?? s;
	fresh.trial = { runId: run.id, status: run.status, error: run.error, output: run.output?.slice(0, 2000), at: Date.now(), steps };
	saveStaged(fresh);
	return fresh.trial;
}

/** Move the staged agent into the agent list (disabled unless `enable`). Only for a user's explicit go-ahead. */
export function installStaged(id: string, opts: { enable?: boolean } = {}): AgentDefinition {
	const s = getStaged(id);
	if (!s) throw new Error(`no staged agent ${id}`);
	const problems = checkValues(s);
	if (problems.length) throw new Error(`can't add it yet: ${problems.join("; ")}`);
	let agentId = s.draft.id && /^[a-z0-9][a-z0-9-]{1,40}$/.test(s.draft.id) ? s.draft.id : slugify(s.draft.name);
	for (let n = 2; loadAgent(agentId); n++) agentId = `${(s.draft.id ?? slugify(s.draft.name)).slice(0, 36)}-${n}`;
	const def = resolveStaged(s, agentId);
	const { createdAt: _c, updatedAt: _u, ...rest } = def;
	const agent = saveAgent({ ...rest, enabled: !!opts.enable });
	discardStaged(id);
	return agent;
}

export function discardStaged(id: string): void {
	if (!ID.test(id)) return;
	rmSync(join(stagingRoot(), id), { recursive: true, force: true });
	if (existsSync(agentDir(trialAgentId(id)))) deleteAgent(trialAgentId(id));
}
