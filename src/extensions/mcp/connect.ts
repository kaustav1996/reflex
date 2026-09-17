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

export async function runConnectCli(args: string[]): Promise<void> {
	const sub = args[0];

	if (!sub || sub === "list") {
		printList();
		return;
	}
	if (sub === "remove" || sub === "disable" || sub === "delete") {
		const id = args[1];
		if (!id) return die(`usage: reflex connect remove <id>`);
		const cfg = loadMcpConfig();
		if (!cfg.servers[id]) return warn(`connector '${id}' is not configured`);
		delete cfg.servers[id];
		saveMcpConfig(cfg);
		console.log(`✓ removed connector '${id}'`);
		return;
	}

	// enabling a preset
	const preset = findPreset(sub);
	if (!preset) return die(`unknown connector '${sub}'. Run 'reflex connect' to see options.`);

	const flags = parseFlags(args.slice(1));
	const readOnly = !!flags["readonly"] || !!flags["ro"];

	const cfg = loadMcpConfig();
	let apiKey: string | undefined;
	if (preset.auth === "api-key") {
		apiKey = await resolveApiKey(preset, flags);
		if (!apiKey) return die(`'${preset.id}' needs a ${preset.envVar}. Set it in your env, pass --key, or run interactively.`);
		if (preset.envVar) storeKey(preset.id, apiKey);
	}

	const server = preset.build({ readOnly, apiKey });
	// carry the env var through to the spawned bridge / http client
	if (preset.envVar && apiKey) {
		server.env = { ...(server.env ?? {}), [preset.envVar]: apiKey };
	}
	cfg.servers[preset.id] = server;
	saveMcpConfig(cfg);

	const how = preset.auth === "oauth" ? "OAuth — a browser tab will open on first connect" : `API key (stored in ~/.reflex/keys.json)`;
	console.log(`✓ enabled connector '${preset.id}' — ${preset.label}`);
	console.log(`  ${how}`);
	console.log(`  endpoint: ${server.url ?? server.args?.slice(-1)[0] ?? "(stdio)"}`);
	if (preset.auth === "oauth") console.log(`  bridge: npx ${server.args?.join(" ")} (cached in ~/.mcp-auth/)`);
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
