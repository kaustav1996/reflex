/**
 * `reflex connect` — enable a built-in MCP connector preset without hand-writing config.
 *
 *   reflex connect                  list presets and show which are enabled
 *   reflex connect gmail            enable Gmail (OAuth, via mcp-remote bridge)
 *   reflex connect slack            enable Slack
 *   reflex connect atlassian        enable Atlassian (Jira + Confluence)
 *   reflex connect linear           enable Linear (OAuth)
 *   reflex connect linear-key       enable Linear with a personal API key
 *   reflex connect linear --readonly  read-only variant where supported
 *   reflex connect linear-key --key lin_api_xxx   provide the key inline
 *   reflex connect remove slack     disable + delete a connector
 *
 * OAuth connectors spawn `npx -y mcp-remote <url>`: the first run opens a browser tab to
 * authorise, the token is cached in ~/.mcp-auth/, and subsequent sessions are silent. API-key
 * connectors talk streamable-HTTP directly; the key comes from `--key`, the preset's env var,
 * or an interactive prompt, and is stored in ~/.reflex/keys.json (0600).
 */
import { createInterface } from "node:readline";
import { loadMcpConfig, saveMcpConfig, type McpServerConfig } from "./client.js";
import { loadStoredKeys, storeKey } from "../../config.js";
import { findPreset, PRESETS, type ConnectorPreset } from "./presets.js";
import { clearOAuthCache } from "./authcache.js";

export interface EnableResult {
	id: string;
	label: string;
	auth: "oauth" | "api-key" | "cli";
	endpoint: string;
	bridge?: string;
}

/** Build a preset's server config + metadata WITHOUT persisting. Resolves the API key
 * for api-key presets (and stores it in keys.json), and optionally clears the OAuth cache
 * for a fresh consent. Used by the web connect flow so we can run OAuth first and only
 * persist on success. */
export function buildPresetConfig(id: string, opts: { readOnly?: boolean; apiKey?: string; fresh?: boolean } = {}): { server: McpServerConfig; result: EnableResult } {
	const preset = findPreset(id);
	if (!preset) throw new Error(`unknown connector '${id}'`);
	const readOnly = !!opts.readOnly;
	let apiKey = opts.apiKey;
	if (preset.auth === "api-key") {
		if (!apiKey) {
			const envName = preset.envVar;
			if (envName && process.env[envName]) apiKey = process.env[envName];
			else apiKey = loadStoredKeys()[preset.id];
		}
		if (!apiKey) throw new Error(`'${preset.id}' needs a ${preset.envVar ?? "API key"}`);
		if (preset.envVar) storeKey(preset.id, apiKey);
	}
	if (preset.auth === "oauth" && opts.fresh) {
		const url = preset.build({ readOnly }).url ?? preset.build({ readOnly }).args?.slice(-1)[0] ?? "";
		if (url) clearOAuthCache(url);
	}
	const server: McpServerConfig = preset.build({ readOnly, apiKey });
	if (preset.envVar && apiKey) server.env = { ...(server.env ?? {}), [preset.envVar]: apiKey };
	return {
		server,
		result: {
			id: preset.id,
			label: preset.label,
			auth: preset.auth,
			endpoint: server.url ?? server.args?.slice(-1)[0] ?? "(stdio)",
			bridge: preset.auth === "oauth" ? `npx ${server.args?.join(" ")}` : undefined,
		},
	};
}

/** Persist a server config under `id` into ~/.reflex/mcp.json. */
export function persistServer(id: string, server: McpServerConfig): void {
	const cfg = loadMcpConfig();
	cfg.servers[id] = server;
	saveMcpConfig(cfg);
}

/**
 * Pure enable of a preset: builds the server config, persists ~/.reflex/mcp.json, and (for
 * api-key presets) stores the key in ~/.reflex/keys.json. No prompting, no live connect.
 * Used by the CLI (which resolves the key first); the web server uses buildPresetConfig +
 * a live connect so it only persists on OAuth success.
 */
export function enablePreset(id: string, opts: { readOnly?: boolean; apiKey?: string; fresh?: boolean } = {}): EnableResult {
	const { server, result } = buildPresetConfig(id, opts);
	persistServer(result.id, server);
	return result;
}

export interface RemoveResult {
	id: string;
	clearedOAuth: number;
	note?: string;
}

/**
 * Remove a connector from ~/.reflex/mcp.json and (for OAuth presets) wipe the cached
 * mcp-remote token for its URL, so reconnecting re-prompts for consent rather than silently
 * reusing a lingering credential. Note: this does NOT revoke the token at the provider —
 * the user should do that in the service's settings (we tell them so in the result).
 */
export function removeConnector(id: string): RemoveResult {
	const cfg = loadMcpConfig();
	if (!cfg.servers[id]) return { id, clearedOAuth: 0, note: "not configured" };
	let cleared = 0;
	const preset = findPreset(id);
	if (preset?.auth === "oauth") {
		const url = preset.build({}).url ?? preset.build({}).args?.slice(-1)[0] ?? "";
		if (url) cleared = clearOAuthCache(url);
	}
	delete cfg.servers[id];
	saveMcpConfig(cfg);
	const note = cleared > 0 ? `cleared local OAuth token; revoke access at the provider for full disconnect` : undefined;
	return { id, clearedOAuth: cleared, note };
}

export async function runConnectCli(args: string[]): Promise<void> {
	const sub = args[0];

	if (!sub || sub === "list") {
		printList();
		return;
	}
	if (sub === "remove" || sub === "disable" || sub === "delete") {
		const id = args[1];
		if (!id) return die(`usage: reflex connect remove <id>`);
		if (!loadMcpConfig().servers[id]) return warn(`connector '${id}' is not configured`);
		const r = removeConnector(id);
		console.log(`✓ removed connector '${r.id}'` + (r.clearedOAuth ? ` · cleared local OAuth token (${r.clearedOAuth} file(s))` : ""));
		if (r.note) console.log(`  note: ${r.note}`);
		return;
	}

	// enabling a preset
	const preset = findPreset(sub);
	if (!preset) return die(`unknown connector '${sub}'. Run 'reflex connect' to see options.`);

	const flags = parseFlags(args.slice(1));
	const readOnly = !!flags["readonly"] || !!flags["ro"];

	let apiKey: string | undefined;
	if (preset.auth === "api-key") {
		apiKey = await resolveApiKey(preset, flags);
		if (!apiKey) return die(`'${preset.id}' needs a ${preset.envVar}. Set it in your env, pass --key, or run interactively.`);
	}

	const result = enablePreset(sub, { readOnly, apiKey, fresh: true });
	const how = result.auth === "oauth" ? "OAuth — a browser tab will open on first connect (cached token cleared)" : result.auth === "cli" ? "local server; uses the vendor CLI's own login" : `API key (stored in ~/.reflex/keys.json)`;
	console.log(`✓ enabled connector '${result.id}' — ${result.label}`);
	console.log(`  ${how}`);
	console.log(`  endpoint: ${result.endpoint}`);
	if (result.bridge) console.log(`  bridge: ${result.bridge} (cached in ~/.mcp-auth/)`);
	console.log(`  check with: reflex connect`);
}

async function resolveApiKey(preset: ConnectorPreset, flags: Record<string, string | boolean>): Promise<string | undefined> {
	if (typeof flags["key"] === "string" && flags["key"]) return flags["key"];
	const envName = preset.envVar;
	if (envName && process.env[envName]) return process.env[envName];
	const stored = loadStoredKeys()[preset.id];
	if (stored) return stored;
	if (process.stdin.isTTY) {
		return await promptHidden(`${preset.envVar ?? "API key"}: `);
	}
	return undefined;
}

function parseFlags(args: string[]): Record<string, string | boolean> {
	const out: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--readonly" || a === "--ro") out["readonly"] = true;
		else if (a === "--key") out["key"] = args[++i];
		else if (a.startsWith("--key=")) out["key"] = a.slice(6);
	}
	return out;
}

function printList(): void {
	const cfg = loadMcpConfig();
	const lines: string[] = ["Built-in MCP connectors:"];
	for (const p of PRESETS) {
		const enabled = cfg.servers[p.id]?.enabled !== false && cfg.servers[p.id] !== undefined;
		const mark = enabled ? "✓" : "·";
		const auth = p.auth === "oauth" ? "OAuth" : "API key";
		lines.push(`  ${mark} ${p.id.padEnd(12)} ${p.label.padEnd(24)} ${auth.padEnd(7)} ${p.description}`);
	}
	lines.push("", "Enable with: reflex connect <id>", "Remove with: reflex connect remove <id>");
	console.log(lines.join("\n"));
}

function promptHidden(query: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		// Mask the typed secret by silencing readline's per-char echo while keeping Enter handling.
		const stdout = process.stdout;
		const origWrite = stdout.write.bind(stdout);
		let masking = false;
		stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
			if (masking && typeof chunk === "string" && !chunk.includes("\r") && !chunk.includes("\n")) return true;
			return (origWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof stdout.write;
		rl.question(query, (ans) => {
			stdout.write = origWrite;
			rl.close();
			process.stdout.write("\n");
			resolve(ans.trim() || undefined);
		});
		masking = true;
	});
}

function die(msg: string): void {
	console.error(`reflex connect: ${msg}`);
	process.exitCode = 1;
}
function warn(msg: string): void {
	console.error(`reflex connect: ${msg}`);
}
